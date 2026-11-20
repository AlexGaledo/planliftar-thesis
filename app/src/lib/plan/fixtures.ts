/**
 * Fixture normalisation: turns the server's door/window icons into clean
 * openings that sit on a host wall (docs/research/TEXTURES_ASSETS.md §1, P0.2).
 *
 * What the raw fixture data really means (backend/planliftar_engine/cubicasa.py):
 *  - `position` is the icon centre in plan px (same space as the walls).
 *  - `scale.width` is `width_px * 0.01`, a placeholder ratio, NOT metres. The
 *    real width is `(scale.width / 0.01) / ppm` metres.
 *  - `scale.height`, `scale.depth` are hardcoded constants; ignored here.
 *  - `rotation_degrees` is only ever 0 or 90; orientation comes from the host
 *    wall instead.
 *  - Duplicates (identical icons) and fragments (one door split into several
 *    narrow icons a few px apart) both occur in the bundled samples.
 *
 * Steps, all in plan px:
 *  1. Dedupe: icons of one type within DEDUPE_PX of each other are one icon
 *     (handled by the merge in step 4, which keeps the union of their extents).
 *  2. Host: nearest wall whose centre line passes within max(thickness, w/2) of
 *     the icon. The icon may sit INSIDE the wall's extent (window, uncarved door)
 *     or in a gap just past its end (a door the server already carved out).
 *  3. Snap: the opening is projected onto the host line and, where an edge lies
 *     in a gap, stretched to the adjacent collinear wall end so no sliver of gap
 *     is left beside the door.
 *  4. Merge: overlapping/touching openings of the same type on the same line
 *     become one (fragmented doors, overlapping window icons).
 *  5. Drop openings narrower than MIN_OPENING_M (detector noise).
 *
 * Pure data: no three.js, so it is unit-tested directly.
 */
import type { Fixture, Plan, PlanPoint, Wall } from "./types";

export type OpeningKind = "door" | "window";

/** `scale.width` is width_px times this placeholder ratio (cubicasa.py). */
export const FIXTURE_WIDTH_RATIO = 0.01;
/** Icons of the same type closer than this are one icon (px); see tryMerge. */
export const DEDUPE_PX = 5;
/** Openings narrower than this after merging are detector noise (metres). */
export const MIN_OPENING_M = 0.3;
/** Two lines count as parallel below this angle (sin of ~4 degrees). */
const PARALLEL_SIN = 0.07;

/** A door or window placed on its host wall's centre line. */
export interface Opening {
  /** ids of the source fixtures, joined with "+" when merged */
  id: string;
  kind: OpeningKind;
  sourceIds: string[];
  hostWallId: string;
  /** a point on the host wall's centre line (plan px) */
  origin: PlanPoint;
  /** unit direction of the host wall (plan px space) */
  dir: PlanPoint;
  /** opening extent along `dir` from `origin`, s0 < s1 (px) */
  s0: number;
  s1: number;
  /** host wall thickness (px) */
  thicknessPx: number;
}

export interface DroppedFixture {
  id: string;
  reason: string;
}

export interface FixtureReport {
  openings: Opening[];
  dropped: DroppedFixture[];
}

/** Opening centre in plan px. */
export function openingCenter(o: Opening): PlanPoint {
  const s = (o.s0 + o.s1) / 2;
  return { x: o.origin.x + o.dir.x * s, y: o.origin.y + o.dir.y * s };
}

export function openingWidthPx(o: Opening): number {
  return o.s1 - o.s0;
}

/** Real fixture width in px from the placeholder `scale.width`. */
export function fixtureWidthPx(f: Fixture): number {
  const w = Number(f.scale?.width);
  return w > 0 && Number.isFinite(w) ? w / FIXTURE_WIDTH_RATIO : 0;
}

interface Line {
  wall: Wall;
  a: PlanPoint;
  dir: PlanPoint;
  len: number;
  t: number;
}

function lineOf(w: Wall): Line | null {
  const dx = w.end.x - w.start.x;
  const dy = w.end.y - w.start.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  return { wall: w, a: w.start, dir: { x: dx / len, y: dy / len }, len, t: Number(w.thickness) || 4 };
}

/** Along-line coordinate and perpendicular distance of p relative to a line. */
function project(l: { a: PlanPoint; dir: PlanPoint }, p: PlanPoint): { s: number; perp: number } {
  const rx = p.x - l.a.x;
  const ry = p.y - l.a.y;
  return { s: rx * l.dir.x + ry * l.dir.y, perp: Math.abs(-rx * l.dir.y + ry * l.dir.x) };
}

function isParallel(a: PlanPoint, b: PlanPoint): boolean {
  return Math.abs(a.x * b.y - a.y * b.x) < PARALLEL_SIN;
}

/**
 * Walls lying on the same centre line as `o` (parallel, offset within half the
 * thicker wall), with their extent [lo, hi] in o's along-line coordinates.
 */
export function collinearWalls(walls: Wall[], o: Pick<Opening, "origin" | "dir" | "thicknessPx">) {
  const out: { wall: Wall; lo: number; hi: number }[] = [];
  for (const w of walls) {
    const l = lineOf(w);
    if (!l || !isParallel(l.dir, o.dir)) continue;
    const pa = project({ a: o.origin, dir: o.dir }, w.start);
    const pb = project({ a: o.origin, dir: o.dir }, w.end);
    if (Math.max(pa.perp, pb.perp) > Math.max(l.t, o.thicknessPx) / 2 + 1) continue;
    out.push({ wall: w, lo: Math.min(pa.s, pb.s), hi: Math.max(pa.s, pb.s) });
  }
  return out;
}

/** Steps 2 and 3 for one fixture. Returns a reason string when it has no host. */
function placeOnHost(f: Fixture & { position: PlanPoint }, kind: OpeningKind, lines: Line[], walls: Wall[]): Opening | string {
  const widthPx = fixtureWidthPx(f);
  if (!(widthPx > 0)) return "no usable scale.width";
  const half = widthPx / 2;

  let best: { line: Line; score: number } | null = null;
  for (const l of lines) {
    const { s, perp } = project(l, f.position);
    if (perp > Math.max(l.t, half)) continue;
    // How far the icon centre lies outside the wall's extent (0 = inside).
    const out = s < 0 ? -s : s > l.len ? s - l.len : 0;
    if (out > 0 && out > half + l.t) continue;
    // A carved doorway puts the wall end about half a width away: score only
    // the part of the gap the opening itself does not explain.
    const score = perp + Math.max(0, out - half);
    if (!best || score < best.score) best = { line: l, score };
  }
  if (!best) return "no host wall within reach";

  const l = best.line;
  const { s } = project(l, f.position);
  const o: Opening = {
    id: String(f.id ?? ""),
    kind,
    sourceIds: [String(f.id ?? "")],
    hostWallId: String(l.wall.id ?? ""),
    origin: { ...l.a },
    dir: { ...l.dir },
    s0: s - half,
    s1: s + half,
    thicknessPx: l.t,
  };

  // Snap edges that sit in a gap out to the neighbouring wall end.
  const coll = collinearWalls(walls, o);
  const inside = (x: number) => coll.some((c) => x > c.lo + 0.5 && x < c.hi - 0.5);
  const tol = l.t;
  if (!inside(o.s0)) {
    const ends = coll.map((c) => c.hi).filter((h) => h <= o.s0 + 0.5 && h >= o.s0 - tol);
    if (ends.length) o.s0 = Math.min(o.s0, Math.max(...ends));
  }
  if (!inside(o.s1)) {
    const ends = coll.map((c) => c.lo).filter((lo) => lo >= o.s1 - 0.5 && lo <= o.s1 + tol);
    if (ends.length) o.s1 = Math.max(o.s1, Math.min(...ends));
  }
  return o;
}

/** Step 4: merge `b` into `a` when they share a line and overlap or touch. */
function tryMerge(a: Opening, b: Opening): boolean {
  if (a.kind !== b.kind || !isParallel(a.dir, b.dir)) return false;
  const cb = openingCenter(b);
  const p = project({ a: a.origin, dir: a.dir }, cb);
  if (p.perp > Math.max(a.thicknessPx, b.thicknessPx) / 2 + 1) return false;
  // b's extent in a's coordinates (directions may be opposite).
  const half = openingWidthPx(b) / 2;
  const lo = p.s - half;
  const hi = p.s + half;
  const tol = Math.max(DEDUPE_PX, Math.min(a.thicknessPx, b.thicknessPx) / 2);
  if (lo > a.s1 + tol || hi < a.s0 - tol) return false;
  a.s0 = Math.min(a.s0, lo);
  a.s1 = Math.max(a.s1, hi);
  a.sourceIds.push(...b.sourceIds);
  a.id = a.sourceIds.join("+");
  return true;
}

/**
 * Normalise a plan's fixtures into host-wall openings. `ppm` is only used for
 * the minimum-width check; all geometry stays in plan px.
 */
export function normalizeFixtures(plan: Pick<Plan, "walls" | "fixtures">, ppm: number): FixtureReport {
  const walls = (plan.walls || []).filter((w) => w && w.start && w.end);
  const lines = walls.map(lineOf).filter((l): l is Line => l !== null);
  const dropped: DroppedFixture[] = [];

  // 1. Usable doors/windows. Duplicates (icons within DEDUPE_PX) are kept here
  // on purpose: they always overlap, so step 4 folds them into one opening and
  // a near-duplicate that is slightly offset still widens it correctly.
  const kept: (Fixture & { position: PlanPoint; type: OpeningKind })[] = [];
  (plan.fixtures || []).forEach((f, i) => {
    if (!f || (f.type !== "door" && f.type !== "window")) return;
    const id = String(f.id ?? `${f.type}_${i}`);
    const pos = f.position;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      dropped.push({ id, reason: "no position" });
      return;
    }
    kept.push({ ...f, id, position: pos, type: f.type });
  });

  // 2-3. Host and snap.
  const placed: Opening[] = [];
  for (const f of kept) {
    const r = placeOnHost(f, f.type, lines, walls);
    if (typeof r === "string") dropped.push({ id: String(f.id), reason: r });
    else placed.push(r);
  }

  // 4. Merge until stable (a merge can make an opening reach a third one).
  const openings: Opening[] = [];
  for (const o of placed) {
    let target = openings.find((m) => tryMerge(m, o));
    while (target) {
      const t = target;
      const idx = openings.findIndex((m) => m !== t && tryMerge(t, m));
      if (idx < 0) break;
      openings.splice(idx, 1);
      target = t;
    }
    if (!target) openings.push(o);
  }

  // 5. Minimum width.
  const minPx = MIN_OPENING_M * ppm;
  const result = openings.filter((o) => {
    if (openingWidthPx(o) >= minPx) return true;
    dropped.push({ id: o.id, reason: `narrower than ${MIN_OPENING_M} m after merging` });
    return false;
  });
  return { openings: result, dropped };
}
