/**
 * Wall, opening and fixture layout as plain boxes (docs/research/TEXTURES_ASSETS.md
 * §4, P0.3). No three.js objects here, only numbers, so it is unit-tested and the
 * builder turns each box into a BoxGeometry merged per material.
 *
 * Everything is a box on purpose: boxes merge into one geometry per material,
 * keep scaleBoxUVs' one-tile-per-metre mapping, and need no CSG library.
 *
 *   door:    wall cut over the opening, lintel from DOOR_HEIGHT_M to the wall top,
 *            frame (2 jambs + head) and a closed leaf
 *   window:  wall cut, sill box from the floor to SILL_HEIGHT_M, header from
 *            WINDOW_HEAD_M to the wall top, frame (4 members) and one glass pane
 *   walls:   every remaining piece gets a skirting strip along its base
 *
 * Coordinates: the box centre is in local metres (see lib/plan/geometry.ts), the
 * box is (thickness, height, length) before `yaw` turns its +Z (length) axis
 * onto the wall direction, exactly like the original single-box walls.
 */
import { planToLocal } from "@/lib/plan/geometry";
import { collinearWalls, type Opening, type OpeningKind } from "@/lib/plan/fixtures";
import type { PlanPoint, Wall } from "@/lib/plan/types";
import type { SurfaceKind } from "./surfaceTheme";

export const DOOR_HEIGHT_M = 2.1;
export const SILL_HEIGHT_M = 0.9;
export const WINDOW_HEAD_M = 2.1;
export const FRAME_M = 0.05;
export const DOOR_LEAF_M = 0.04;
export const WINDOW_FRAME_DEPTH_M = 0.07;
export const GLASS_M = 0.008;
export const SKIRTING_HEIGHT_M = 0.08;
export const SKIRTING_PROUD_M = 0.01;
/** Walls thinner than this (metres) are thickened so they stay visible. */
export const MIN_WALL_THICKNESS_M = 0.02;
/** Below this a box is not worth a draw (metres). */
const MIN_BOX_M = 0.005;

export interface BoxSpec {
  kind: SurfaceKind;
  /** centre, local metres */
  x: number;
  y: number;
  z: number;
  thickness: number;
  height: number;
  length: number;
  /** rotation about +Y that aligns the box's +Z with the run direction */
  yaw: number;
}

export interface LayoutOptions {
  ppm: number;
  wallHeightM: number;
  /** footprint centre in plan px (the model origin) */
  center: PlanPoint;
  /**
   * Opening kinds whose frame/leaf/glass boxes are left out because a kit model
   * fills them instead; the wall cut, lintel, sill and header stay.
   * See fixtureSlots() for where the model goes.
   */
  kitKinds?: ReadonlySet<OpeningKind>;
}

/** The hole a kit fixture fills: centre of its base, size in metres, wall yaw. */
export interface FixtureSlot {
  kind: OpeningKind;
  openingId: string;
  /** bottom centre, local metres */
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  /** host wall thickness (metres) */
  thickness: number;
  yaw: number;
}

interface Piece {
  a: PlanPoint;
  b: PlanPoint;
  t: number;
}

/**
 * Drop exact duplicate walls (A->B and B->A, same thickness): coincident boxes
 * z-fight. Same key as the original builder.
 */
export function dedupeWalls(walls: Wall[]): Wall[] {
  const seen = new Set<string>();
  const endKey = (p: PlanPoint) => `${Math.round(p.x)},${Math.round(p.y)}`;
  return walls.filter((w) => {
    if (!w || !w.start || !w.end) return false;
    const a = endKey(w.start);
    const b = endKey(w.end);
    const key = (a < b ? `${a}|${b}` : `${b}|${a}`) + `|${Math.round((w.thickness || 4) * 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Cut [s0, s1] of opening `o` out of every collinear piece it overlaps. */
export function cutOpening(pieces: Piece[], o: Opening, minPx: number): Piece[] {
  const asWalls = pieces.map((p, i) => ({ id: String(i), start: p.a, end: p.b, thickness: p.t, height: 0 }) as Wall);
  const hits = new Map<Wall, { lo: number; hi: number }>();
  for (const c of collinearWalls(asWalls, o)) hits.set(c.wall, c);
  const out: Piece[] = [];
  pieces.forEach((p, i) => {
    const hit = hits.get(asWalls[i]);
    if (!hit || hit.hi <= o.s0 + 0.5 || hit.lo >= o.s1 - 0.5) {
      out.push(p);
      return;
    }
    // Work in the piece's own parameter so its ends stay on its own centre line.
    const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
    const ux = (p.b.x - p.a.x) / len;
    const uy = (p.b.y - p.a.y) / len;
    const param = (s: number) => (o.origin.x + o.dir.x * s - p.a.x) * ux + (o.origin.y + o.dir.y * s - p.a.y) * uy;
    const c0 = Math.min(param(o.s0), param(o.s1));
    const c1 = Math.max(param(o.s0), param(o.s1));
    const at = (u: number): PlanPoint => ({ x: p.a.x + ux * u, y: p.a.y + uy * u });
    if (c0 >= minPx) out.push({ a: p.a, b: at(Math.min(c0, len)), t: p.t });
    if (len - c1 >= minPx) out.push({ a: at(Math.max(c1, 0)), b: p.b, t: p.t });
  });
  return out;
}

/** Lay out all wall, opening and fixture boxes for a plan. */
export function layoutWalls(walls: Wall[], openings: Opening[], opts: LayoutOptions): BoxSpec[] {
  const { ppm, wallHeightM: H, center, kitKinds } = opts;
  const boxes: BoxSpec[] = [];
  const thick = (px: number) => Math.max(MIN_WALL_THICKNESS_M, px / ppm);

  /** A box spanning plan points a..b, from y0 to y1, `t` metres thick. */
  const run = (kind: SurfaceKind, a: PlanPoint, b: PlanPoint, t: number, y0: number, y1: number) => {
    const la = planToLocal(a.x, a.y, center, ppm);
    const lb = planToLocal(b.x, b.y, center, ppm);
    const dx = lb.x - la.x;
    const dz = lb.z - la.z;
    const length = Math.hypot(dx, dz);
    const height = y1 - y0;
    if (height < MIN_BOX_M || t < MIN_BOX_M) return;
    boxes.push({
      kind,
      x: (la.x + lb.x) / 2,
      y: (y0 + y1) / 2,
      z: (la.z + lb.z) / 2,
      thickness: t,
      height,
      // Zero-length wall guard, as before.
      length: Math.max(0.0001, length),
      yaw: Math.atan2(dx, dz),
    });
  };
  const skirting = (a: PlanPoint, b: PlanPoint, t: number) =>
    run("skirting", a, b, t + 2 * SKIRTING_PROUD_M, 0, Math.min(SKIRTING_HEIGHT_M, H));

  const usable = usableOpenings(openings, H);

  let pieces: Piece[] = dedupeWalls(walls).map((w) => ({ a: w.start, b: w.end, t: w.thickness || 4 }));
  const minPx = Math.max(0.5, 0.02 * ppm);
  for (const o of usable) pieces = cutOpening(pieces, o, minPx);

  for (const p of pieces) {
    const t = thick(p.t);
    run("wall", p.a, p.b, t, 0, H);
    skirting(p.a, p.b, t);
  }

  for (const o of usable) {
    const t = thick(o.thicknessPx);
    const pt = (s: number): PlanPoint => ({ x: o.origin.x + o.dir.x * s, y: o.origin.y + o.dir.y * s });
    const a = pt(o.s0);
    const b = pt(o.s1);
    const widthM = (o.s1 - o.s0) / ppm;
    const f = FRAME_M * ppm; // frame member width in px
    const inner = (s0: number, s1: number) => [pt(s0), pt(s1)] as const;

    if (o.kind === "door") {
      const top = Math.min(DOOR_HEIGHT_M, H);
      run("wall", a, b, t, top, H); // lintel
      const frameDepth = t + 0.01;
      if (widthM > 2 * FRAME_M + 0.1 && !kitKinds?.has("door")) {
        run("window_frame", ...inner(o.s0, o.s0 + f), frameDepth, 0, top);
        run("window_frame", ...inner(o.s1 - f, o.s1), frameDepth, 0, top);
        run("window_frame", ...inner(o.s0 + f, o.s1 - f), frameDepth, top - FRAME_M, top);
        run("door", ...inner(o.s0 + f, o.s1 - f), Math.min(DOOR_LEAF_M, t), 0.01, top - FRAME_M);
      }
    } else {
      const head = Math.min(WINDOW_HEAD_M, H);
      run("wall", a, b, t, 0, SILL_HEIGHT_M); // sill
      skirting(a, b, t);
      run("wall", a, b, t, head, H); // header
      const depth = Math.min(WINDOW_FRAME_DEPTH_M, t);
      if (widthM > 2 * FRAME_M + 0.05 && head - SILL_HEIGHT_M > 2 * FRAME_M + 0.05 && !kitKinds?.has("window")) {
        run("window_frame", ...inner(o.s0, o.s0 + f), depth, SILL_HEIGHT_M, head);
        run("window_frame", ...inner(o.s1 - f, o.s1), depth, SILL_HEIGHT_M, head);
        run("window_frame", ...inner(o.s0 + f, o.s1 - f), depth, SILL_HEIGHT_M, SILL_HEIGHT_M + FRAME_M);
        run("window_frame", ...inner(o.s0 + f, o.s1 - f), depth, head - FRAME_M, head);
        run("glass", ...inner(o.s0 + f, o.s1 - f), GLASS_M, SILL_HEIGHT_M + FRAME_M, head - FRAME_M);
      }
    }
  }
  return boxes;
}

/** Windows need room for a sill below and some glass above it. */
function usableOpenings(openings: Opening[], H: number): Opening[] {
  return openings.filter((o) => o.kind === "door" || H > SILL_HEIGHT_M + 0.2);
}

/**
 * Where kit fixtures go: one slot per usable opening, the full hole between
 * the wall cut ends, from the floor (door) or sill (window) to the lintel or
 * header. Same size gates as the box fixtures in layoutWalls().
 */
export function fixtureSlots(openings: Opening[], opts: Omit<LayoutOptions, "kitKinds">): FixtureSlot[] {
  const { ppm, wallHeightM: H, center } = opts;
  const slots: FixtureSlot[] = [];
  for (const o of usableOpenings(openings, H)) {
    const s = (o.s0 + o.s1) / 2;
    const c = planToLocal(o.origin.x + o.dir.x * s, o.origin.y + o.dir.y * s, center, ppm);
    const width = (o.s1 - o.s0) / ppm;
    const thickness = Math.max(MIN_WALL_THICKNESS_M, o.thicknessPx / ppm);
    // Plan +Y is local -Z, so the plan direction (dx, dy) is local (dx, -dy).
    const yaw = Math.atan2(o.dir.x, -o.dir.y);
    if (o.kind === "door") {
      const top = Math.min(DOOR_HEIGHT_M, H);
      if (width > 2 * FRAME_M + 0.1) slots.push({ kind: "door", openingId: o.id, x: c.x, y: 0, z: c.z, width, height: top, thickness, yaw });
    } else {
      const head = Math.min(WINDOW_HEAD_M, H);
      if (width > 2 * FRAME_M + 0.05 && head - SILL_HEIGHT_M > 2 * FRAME_M + 0.05)
        slots.push({ kind: "window", openingId: o.id, x: c.x, y: SILL_HEIGHT_M, z: c.z, width, height: head - SILL_HEIGHT_M, thickness, yaw });
    }
  }
  return slots;
}
