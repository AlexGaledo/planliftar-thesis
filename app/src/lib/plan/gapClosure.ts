/**
 * Wall-gap closure: welds dangling wall endpoints with short connector walls.
 *
 * Faithful TypeScript port of `closeWallGaps` / `preparePlan` from
 * deliverables/livemap/plan_ops.js (itself a port of deliverables/plan_ops.py,
 * the reference implementation the GLB builder uses). Results must match the
 * JS/Python versions; the tests check the connector counts per bundled plan
 * against the numbers in docs/research/model_viz_data.json.
 *
 * Why it exists: line-first detectors emit walls that look tidy in 2D but do
 * not meet. Extruded to 3D that reads as a wall teleporting sideways, and the
 * model has no enclosed interior. Three rules decide each gap, so nothing is
 * invented without evidence from the plan itself:
 *
 *   junction  gap <= 3 x tMed           -> fill (a clipped corner / T-junction)
 *   doorway   a DOOR fixture on the gap -> leave open (you must walk through it)
 *   span      longer gap                -> fill ONLY if a WINDOW sits on the line
 *
 * All tolerances are multiples of the median wall thickness (tMed), so the same
 * numbers hold at any image resolution.
 *
 * The only change from the JS: inputs are not mutated. A new plan is returned.
 */
import { DEFAULT_HEIGHT_M, MAX_WALLS_FOR_CLOSURE, normalizePlan } from "./normalize";
import type { Fixture, GapFillReport, Plan, RawPlan, Wall } from "./types";

const SNAP_T_MED_FRAC = 0.5; // endpoints this close are already the same node
const JOIN_T_MED_FRAC = 3.0; // corner / jog / T-junction closure range
const ONLINE_T_MED_FRAC = 1.0; // a fixture this close counts as "on" a line
// Beyond this a dangling endpoint has nothing to connect to (widest legitimate gap
// in this project's plans is 30x tMed, and only because two windows sit on it).
const SEARCH_T_MED_FRAC = 40.0;
// Uploaded plans are untrusted: a deliberately disconnected file once froze a tab
// for 42 s, so the whole pass has a wall-clock budget.
const CLOSURE_BUDGET_MS = 2000;

type Vec2 = [number, number];
interface Segment {
  id: string;
  s: Vec2;
  e: Vec2;
  t: number;
  h: number;
}
type EndKey = "s" | "e";
/** Heap entry: [distance, wallIndex, endKey(0=s,1=e), targetIndex, closestPoint] */
type HeapEntry = [number, number, number, number, Vec2];

// ---------------------------------------------------------------------------
// Minimal binary heap. Gaps are closed shortest-first and JS has no built-in
// priority queue. Entries compare on their first four fields, which reproduces
// the visiting order of the original exhaustive scan, so results are unchanged.
// ---------------------------------------------------------------------------
function heapLess(a: HeapEntry, b: HeapEntry): boolean {
  for (let k = 0; k < 4; k++) {
    if (a[k] !== b[k]) return (a[k] as number) < (b[k] as number);
  }
  return false;
}
function heapPush(h: HeapEntry[], v: HeapEntry): void {
  h.push(v);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(h[i], h[p])) break;
    [h[i], h[p]] = [h[p], h[i]];
    i = p;
  }
}
function heapPop(h: HeapEntry[]): HeapEntry {
  const top = h[0];
  const last = h.pop() as HeapEntry;
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && heapLess(h[l], h[m])) m = l;
      if (r < h.length && heapLess(h[r], h[m])) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }
  return top;
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Closest point on segment ab to p, plus that distance. Clamping the projection
 * to [0, 1] makes this a segment, not an infinite line; otherwise a dangling end
 * would "connect" to a wall's imaginary extension.
 */
export function nearestOnSegment(p: Vec2, a: Vec2, b: Vec2): { q: Vec2; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return { q: a, d: dist(p, a) };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  const q: Vec2 = [a[0] + t * dx, a[1] + t * dy];
  return { q, d: dist(p, q) };
}

/**
 * Close gaps between wall ends. `enabled = false` records an empty report and
 * returns the plan otherwise untouched (used by the "raw walls" comparison).
 */
export function closeWallGaps(input: Plan, enabled = true): Plan {
  const walls: Wall[] = [...(input.walls || [])];
  // Already closed: re-running would duplicate fill ids.
  if (walls.some((w) => w && w.generated)) return input;
  const data: Plan = { ...input, walls };
  data.gapFill = { added: [], skipped: [], enabled };
  if (!enabled || walls.length < 2) return data;

  if (walls.length > MAX_WALLS_FOR_CLOSURE) {
    data.gapFill = {
      added: [],
      enabled: false,
      skipped: [
        `${walls.length} walls exceeds MAX_WALLS_FOR_CLOSURE=${MAX_WALLS_FOR_CLOSURE}; closure skipped`,
      ],
    };
    return data;
  }

  // Sanitation, not decoration: Infinity/NaN coordinates poison every comparison
  // below (NaN fails every < test silently) and an Infinity endpoint would make
  // the spatial grid enumerate an unbounded number of cells. Drop those walls.
  const seg: Segment[] = [];
  let dropped = 0;
  walls.forEach((w, i) => {
    if (!w || typeof w !== "object" || !w.start || !w.end) return;
    const s: Vec2 = [+w.start.x, +w.start.y];
    const e: Vec2 = [+w.end.x, +w.end.y];
    const t = Number(w.thickness) || 4;
    const h = Number(w.height) || DEFAULT_HEIGHT_M;
    if (
      !isFinite(s[0]) || !isFinite(s[1]) || !isFinite(e[0]) || !isFinite(e[1]) ||
      !isFinite(t) || !isFinite(h) || t <= 0
    ) {
      dropped++;
      return;
    }
    seg.push({ id: w.id || `w${i}`, s, e, t, h });
  });
  if (seg.length < 2) {
    if (dropped) data.gapFill.skipped.push(`${dropped} wall(s) dropped: non-finite or non-positive values`);
    return data;
  }

  const ts = seg.map((w) => w.t).sort((a, b) => a - b);
  const tMed = ts[ts.length >> 1] || 4;
  const snap = SNAP_T_MED_FRAC * tMed;
  const join = JOIN_T_MED_FRAC * tMed;
  const online = ONLINE_T_MED_FRAC * tMed;

  const fixtures = (data.fixtures || []).filter(
    (f): f is Fixture & { position: { x: number; y: number } } =>
      !!f && !!f.position && typeof f.position.x === "number",
  );
  const fixturesOn = (p: Vec2, q: Vec2, kind: string): string[] =>
    fixtures
      .filter((f) => f.type === kind && nearestOnSegment([f.position.x, f.position.y], p, q).d <= online)
      .map((f) => String(f.id));

  // Object.create(null), not {}: keys are wall ids from an uploaded file, and a
  // plain object would consult Object.prototype on lookup ("constructor", ...).
  const done: Record<string, boolean> = Object.create(null);
  const searchR = SEARCH_T_MED_FRAC * tMed;

  // Uniform grid over segment bounding boxes, so "which walls are near this
  // point" is a few bucket lookups instead of a scan of every wall (the naive
  // version was roughly n^4: 21.5 s for 100 disconnected walls).
  const cell = Math.max(2 * tMed, 1e-6);
  const grid = new Map<string, number[]>();
  const indexSeg = (idx: number): void => {
    const a = seg[idx].s;
    const b = seg[idx].e;
    const x0 = Math.floor(Math.min(a[0], b[0]) / cell);
    const x1 = Math.floor(Math.max(a[0], b[0]) / cell);
    const y0 = Math.floor(Math.min(a[1], b[1]) / cell);
    const y1 = Math.floor(Math.max(a[1], b[1]) / cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = `${cx}:${cy}`;
        const bucket = grid.get(k);
        if (bucket) bucket.push(idx);
        else grid.set(k, [idx]);
      }
    }
  };
  for (let gi = 0; gi < seg.length; gi++) indexSeg(gi);

  const near = (p: Vec2, radius: number): Set<number> => {
    const out = new Set<number>();
    const x0 = Math.floor((p[0] - radius) / cell);
    const x1 = Math.floor((p[0] + radius) / cell);
    const y0 = Math.floor((p[1] - radius) / cell);
    const y1 = Math.floor((p[1] + radius) / cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = grid.get(`${cx}:${cy}`);
        if (bucket) for (const n of bucket) out.add(n);
      }
    }
    return out;
  };

  const isJoined = (i: number, p: Vec2): boolean => {
    for (const j of near(p, snap)) {
      if (j !== i && nearestOnSegment(p, seg[j].s, seg[j].e).d <= snap) return true;
    }
    return false;
  };

  // Nearest connectable wall to seg[i][key], or null. The radius grows from
  // `join` outward so most endpoints resolve cheaply; a hit at radius r is only
  // provably nearest if it lies within r.
  const candidate = (i: number, key: EndKey): { d: number; j: number; q: Vec2 } | null => {
    const a = seg[i];
    const p = a[key];
    let radius = join;
    for (;;) {
      let best: { d: number; j: number; q: Vec2 } | null = null;
      const idx = Array.from(near(p, radius)).sort((x, y) => x - y);
      for (const j of idx) {
        if (j === i) continue;
        const b = seg[j];
        // sharing a node already: joining again just overlays wall a
        if (Math.min(dist(a.s, b.s), dist(a.s, b.e), dist(a.e, b.s), dist(a.e, b.e)) <= snap) continue;
        const hit = nearestOnSegment(p, b.s, b.e);
        let q = hit.q;
        let d = hit.d;
        for (const end of [b.s, b.e]) {
          // a target within join range of b's own end IS that corner
          if (dist(q, end) <= join) {
            q = end;
            d = dist(p, end);
            break;
          }
        }
        if (!best || d < best.d) best = { d, j, q };
      }
      if (best && best.d <= radius) return best;
      if (radius >= searchR) return best; // widest scan done
      radius = Math.min(radius * 2, searchR);
    }
  };

  const heap: HeapEntry[] = [];
  const push = (i: number, key: EndKey): void => {
    if (done[seg[i].id + key]) return;
    const c = candidate(i, key);
    if (c) heapPush(heap, [c.d, i, key === "s" ? 0 : 1, c.j, c.q]);
  };

  // The deadline starts here, not at the loop: seeding alone costs one
  // nearest-wall search per endpoint.
  const deadline = Date.now() + CLOSURE_BUDGET_MS;
  let timedOut = false;
  for (let si = 0; si < seg.length; si++) {
    if ((si & 0x3f) === 0 && Date.now() > deadline) {
      timedOut = true;
      break;
    }
    push(si, "s");
    push(si, "e");
  }

  const added: string[] = [];
  const skipped: string[] = [];
  // `decisions` counts endpoints actually resolved; `pops` bounds queue churn
  // (stale entries popped and discarded must not starve long-gap endpoints).
  let decisions = 4 * seg.length;
  let pops = 64 * seg.length + 1000;
  while (heap.length && decisions > 0 && pops > 0 && !timedOut) {
    pops--;
    if ((pops & 0x3f) === 0 && Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const [d, i, keyn, j, q] = heapPop(heap);
    const key: EndKey = keyn === 0 ? "s" : "e";
    const a = seg[i];
    const p = a[key];
    if (done[a.id + key]) continue;
    if (isJoined(i, p)) {
      done[a.id + key] = true;
      continue;
    }
    const fresh = candidate(i, key);
    if (!fresh) {
      done[a.id + key] = true;
      continue;
    }
    if (Math.abs(fresh.d - d) > 1e-9 || fresh.j !== j) {
      // a later insertion changed this endpoint's nearest wall
      heapPush(heap, [fresh.d, i, keyn, fresh.j, fresh.q]);
      continue;
    }
    const b = seg[j];
    done[a.id + key] = true;
    decisions--;

    // The connector turns exactly one corner. Reject the corner whose first leg
    // runs back along wall a over itself; keep the one that leaves a's far end.
    const far = key === "s" ? a.e : a.s;
    const opts = ([[p[0], q[1]], [q[0], p[1]]] as Vec2[]).filter(
      (c) => dist(far, c) >= dist(far, p) - 1e-6,
    );
    const doors = fixturesOn(p, q, "door");
    const windows = fixturesOn(p, q, "window");

    let why: string | null = null;
    if (!opts.length) why = "corner backtracks";
    else if (doors.length) why = `doorway ${doors.join(",")}`;
    else if (d > join && !windows.length) why = "no fixture evidence";
    if (why) {
      skipped.push(`${a.id}.${key}->${b.id} ${d.toFixed(1)}px: ${why}`);
      continue;
    }

    const c = opts.reduce((best, x) =>
      dist(p, x) + dist(x, q) < dist(p, best) + dist(best, q) ? x : best,
    );
    const thickness = Math.min(a.t, b.t);
    const reason = d <= join ? "junction" : "span/fixture";
    const legs: [Vec2, Vec2][] = [
      [p, c],
      [c, q],
    ];
    for (const [u, v] of legs) {
      if (dist(u, v) <= snap) continue;
      const wid = `fill_${String(added.length + 1).padStart(3, "0")}`;
      walls.push({
        id: wid,
        start: { x: u[0], y: u[1] },
        end: { x: v[0], y: v[1] },
        thickness,
        height: a.h,
        generated: true,
        reason,
      });
      seg.push({ id: wid, s: u, e: v, t: thickness, h: a.h });
      indexSeg(seg.length - 1);
      added.push(`${wid} ${a.id}->${b.id} ${dist(u, v).toFixed(1)}px [${reason}]`);
      // This connector may now be the nearest wall to another dangling end.
      const touched = near(u, searchR);
      near(v, searchR).forEach((k) => touched.add(k));
      touched.forEach((k) => {
        if (k < seg.length) {
          push(k, "s");
          push(k, "e");
        }
      });
    }
  }

  if (timedOut) {
    skipped.push(
      `closure stopped after ${(CLOSURE_BUDGET_MS / 1000).toFixed(1)}s (CLOSURE_BUDGET_MS); remaining gaps left open`,
    );
  }
  if (dropped) skipped.push(`${dropped} wall(s) dropped: non-finite or non-positive values`);
  const report: GapFillReport = { added, skipped, enabled: true, tMed, join };
  data.gapFill = report;
  return data;
}

/** normalizePlan + closeWallGaps. What every renderer should call. */
export function preparePlan(data: RawPlan, opts: { closeGaps?: boolean } = {}): Plan {
  return closeWallGaps(normalizePlan(data), opts.closeGaps !== false);
}
