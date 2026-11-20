/**
 * Plan geometry helpers shared by the 2D map, the overlay, the 3D builder and AR.
 *
 * Ported from ar.html / index.html (collectPlanPoints, computeFootprintBounds,
 * planToLocal, localToPlan). The plan <-> local mapping is the contract the live
 * map depends on, so read this before changing it:
 *
 *   plan (px, py) -> local metres, relative to the model origin (footprint centre):
 *       localX =  (px - centre.x) / ppm
 *       localZ = -(py - centre.y) / ppm
 *   World Y is up; the plan lies flat on XZ. The inverse (localToPlan) turns the
 *   phone's position back into plan px for the pose stream.
 *
 * The miniature factor (1:N) is NEVER part of this mapping. It is a uniform group
 * scale only; three.js worldToLocal() already undoes it. Dividing by it here
 * too would double-apply it and drag the live dot toward the plan centre.
 */
import type { Plan, PlanBounds, PlanPoint, RawPlan } from "./types";

/** Every wall endpoint and room vertex, in plan px. */
export function collectPlanPoints(plan: Pick<Plan, "walls" | "rooms">): PlanPoint[] {
  const points: PlanPoint[] = [];
  for (const w of plan.walls || []) {
    if (w.start) points.push(w.start);
    if (w.end) points.push(w.end);
  }
  for (const r of plan.rooms || []) for (const p of r.polygon || []) points.push(p);
  return points;
}

const EMPTY_BOUNDS: PlanBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0, widthPx: 0, heightPx: 0 };

/** Bounding box of walls + rooms. Empty plans give a zero box rather than Infinity. */
export function computeBounds(plan: Pick<Plan, "walls" | "rooms">): PlanBounds {
  const pts = collectPlanPoints(plan);
  if (pts.length === 0) return { ...EMPTY_BOUNDS };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, widthPx: maxX - minX, heightPx: maxY - minY };
}

/** Centre of the footprint: where the model origin sits, and where AR anchors. */
export function boundsCenter(b: PlanBounds): PlanPoint {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/** Longest side of the footprint in plan px (what "building length" refers to). */
export function longestSidePx(b: PlanBounds): number {
  return Math.max(b.widthPx, b.heightPx);
}

/** plan px -> local metres (x, z), recentred on `center`. */
export function planToLocal(px: number, py: number, center: PlanPoint, ppm: number) {
  return { x: (px - center.x) / ppm, z: -(py - center.y) / ppm };
}

/** Inverse of planToLocal: local metres (x, z) -> plan px. */
export function localToPlan(localX: number, localZ: number, center: PlanPoint, ppm: number): PlanPoint {
  return { x: localX * ppm + center.x, y: -localZ * ppm + center.y };
}

/** Length of a wall in plan px. */
export function wallLengthPx(w: { start: PlanPoint; end: PlanPoint }): number {
  return Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
}

/**
 * The pixel size of the image the plan coordinates refer to, when the file says.
 * Used to line the overlay up with the uploaded image.
 */
export function sourceImageSize(plan: RawPlan): { width: number; height: number } | null {
  const w = Number(plan.source?.image_width_px ?? plan.metadata?.original_width_px);
  const h = Number(plan.source?.image_height_px ?? plan.metadata?.original_height_px);
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** Shoelace area of a polygon, px^2 (always positive). */
export function polygonArea(poly: PlanPoint[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(a / 2);
}

/** Area-weighted centroid of a polygon, falling back to the vertex mean. */
export function polygonCentroid(poly: PlanPoint[]): PlanPoint {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    a += f;
    cx += (poly[j].x + poly[i].x) * f;
    cy += (poly[j].y + poly[i].y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return {
      x: poly.reduce((s, p) => s + p.x, 0) / n,
      y: poly.reduce((s, p) => s + p.y, 0) / n,
    };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}
