/**
 * Plan schema normalisation and validation.
 *
 * TypeScript port of `normalizePlan` from deliverables/livemap/plan_ops.js and
 * `validatePlan` from deliverables/livemap/index.html. The behaviour is kept
 * identical (the Python reference, deliverables/plan_ops.py, is parity-tested
 * against the JS copy), with one deliberate difference: this version copies its
 * input instead of mutating it, so React state and IndexedDB records are never
 * changed behind your back.
 *
 * Three coordinate conventions exist across the project's own files:
 *
 *   schema 1.0  "start": [x, y]  + thickness_px            (mitunet_geometry.json)
 *   forked      "start": {x, y}  + thickness in METRES      (sample_response.json)
 *   schema 2.0  "start": {x, y}  + thickness in px          (our export)
 *
 * Everything downstream expects `{x, y}` objects and a px thickness, so convert
 * once here. Metre thicknesses are converted only when the file states its own
 * ratio (metadata.pixel_to_meter_ratio); guessing a scale would invent geometry.
 */
import type { Plan, PlanPoint, RawPlan, RawPoint, RawRoom, RawWall } from "./types";

/** Default real-world wall height in metres when a file does not say. */
export const DEFAULT_HEIGHT_M = 2.7;

/**
 * Above this many walls, gap closure refuses to run (plan_ops.js
 * MAX_WALLS_FOR_CLOSURE). validatePlan rejects such files up front so the user
 * learns why instead of seeing a plan whose walls were never joined.
 */
export const MAX_WALLS_FOR_CLOSURE = 5000;

function toPoint(value: unknown): unknown {
  // `+v[0]` mirrors the JS port: strings like "12" become numbers, junk becomes NaN
  // (and NaN is then rejected by validatePlan / dropped by gap closure).
  return Array.isArray(value) && value.length >= 2 ? { x: +value[0], y: +value[1] } : value;
}

/**
 * Bring any of the three schemas to the normalised form.
 *
 * Idempotent via the `_plan_ops_normalized` marker. It has to be: the
 * metre-to-px division is destructive, so a second pass over an already
 * converted plan would turn a 0.10 m wall into 1000 px instead of 10.
 *
 * Returns the input unchanged when it is not even plan-shaped (no walls array);
 * call validatePlan() to find out why.
 */
export function normalizePlan(data: RawPlan): Plan;
export function normalizePlan(data: unknown): unknown;
export function normalizePlan(data: unknown): unknown {
  if (!data || typeof data !== "object" || !Array.isArray((data as RawPlan).walls)) return data;
  const plan = data as RawPlan;
  if (plan._plan_ops_normalized) return plan;

  const ratio = Number(plan.metadata?.pixel_to_meter_ratio) || 0;

  const walls = plan.walls.map((w: RawWall) => {
    if (!w || typeof w !== "object") return w;
    const out: Record<string, unknown> = { ...w, start: toPoint(w.start), end: toPoint(w.end) };
    if (typeof out.thickness !== "number") {
      if (typeof w.thickness_px === "number") out.thickness = w.thickness_px;
    } else if (ratio > 0) {
      out.thickness = (out.thickness as number) / ratio; // metres -> px
    }
    if (typeof out.height !== "number") {
      // schema 1.0 spells it height_m; both are real-world metres
      out.height = typeof w.height_m === "number" ? w.height_m : DEFAULT_HEIGHT_M;
    }
    return out;
  });

  const rooms = Array.isArray(plan.rooms)
    ? plan.rooms.map((r: RawRoom) =>
        r && Array.isArray(r.polygon) ? { ...r, polygon: r.polygon.map(toPoint) } : r,
      )
    : plan.rooms;

  return { ...plan, walls, rooms, _plan_ops_normalized: true };
}

function isFinitePoint(p: unknown): p is PlanPoint {
  const pt = p as PlanPoint | undefined;
  return !!pt && Number.isFinite(pt.x) && Number.isFinite(pt.y);
}

/**
 * Check a (normalised) plan is drawable. Returns a human-readable problem, or
 * null when the plan is usable. Port of index.html's validatePlan().
 *
 * Number.isFinite, not typeof === "number": JSON has no NaN literal but 1e400
 * parses to Infinity, which is a number and would poison every distance
 * comparison downstream.
 */
export function validatePlan(data: unknown): string | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return "top-level JSON must be an object";
  }
  const plan = data as RawPlan;
  if (!Array.isArray(plan.walls)) return 'missing a "walls" array';
  if (plan.walls.length > MAX_WALLS_FOR_CLOSURE) {
    return `${plan.walls.length} walls exceeds the ${MAX_WALLS_FOR_CLOSURE} limit`;
  }
  for (let i = 0; i < plan.walls.length; i++) {
    const w = plan.walls[i];
    if (!w || !isFinitePoint(w.start as RawPoint) || !isFinitePoint(w.end as RawPoint)) {
      return `walls[${i}] needs finite numeric start.x/start.y/end.x/end.y`;
    }
  }
  // Rooms are optional (a plan can be walls-only) but must be the right shape.
  if (plan.rooms !== undefined && !Array.isArray(plan.rooms)) {
    return '"rooms" must be an array when present';
  }
  return null;
}

/**
 * Parse + normalise + validate in one step, for file imports and API results.
 * Throws an Error whose message is safe to show to the user.
 */
export function parsePlan(input: unknown): Plan {
  const normalized = normalizePlan(input);
  const problem = validatePlan(normalized);
  if (problem) throw new Error(`This is not a usable plan: ${problem}.`);
  return normalized as Plan;
}
