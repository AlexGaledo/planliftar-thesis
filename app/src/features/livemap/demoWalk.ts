/**
 * A simulated walk for the live map, so the map can be shown without a phone
 * or a server (demo mode, a projector at a thesis defence).
 *
 * The "walker" visits every room's centre in nearest-neighbour order and loops
 * back to the start. It is a straight-line tour, so it may cut through a wall;
 * the page labels it as a demo walk, never as a real phone.
 */
import { computeBounds, polygonCentroid, type Plan, type PlanPoint } from "@/lib/plan";
import type { PoseMessage } from "@/lib/hub/protocol";

/** Room centres in a walkable order; a small square around the middle if there are fewer than two rooms. */
export function demoWaypoints(plan: Pick<Plan, "walls" | "rooms">): PlanPoint[] {
  const centres = (plan.rooms ?? [])
    .filter((r) => r.polygon.length >= 3)
    .map((r) => polygonCentroid(r.polygon));
  if (centres.length < 2) {
    const b = computeBounds(plan);
    const cx = b.minX + b.widthPx / 2;
    const cy = b.minY + b.heightPx / 2;
    const r = Math.min(b.widthPx, b.heightPx) / 4 || 1;
    return [
      { x: cx - r, y: cy - r },
      { x: cx + r, y: cy - r },
      { x: cx + r, y: cy + r },
      { x: cx - r, y: cy + r },
    ];
  }
  const order = [centres[0]];
  const left = centres.slice(1);
  while (left.length) {
    const last = order[order.length - 1];
    let best = 0;
    for (let i = 1; i < left.length; i++) {
      if (
        Math.hypot(left[i].x - last.x, left[i].y - last.y) <
        Math.hypot(left[best].x - last.x, left[best].y - last.y)
      )
        best = i;
    }
    order.push(left.splice(best, 1)[0]);
  }
  return order;
}

/**
 * One closed loop of poses through the waypoints, `stepPx` apart, with the
 * heading along the direction of travel (same convention as the phone:
 * 0 degrees = up the plan, clockwise positive).
 */
export function demoWalkPoses(waypoints: PlanPoint[], stepPx: number): PoseMessage[] {
  const poses: PoseMessage[] = [];
  if (waypoints.length < 2 || !(stepPx > 0)) return poses;
  for (let i = 0; i < waypoints.length; i++) {
    const a = waypoints[i];
    const b = waypoints[(i + 1) % waypoints.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const yaw = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const steps = Math.max(1, Math.round(len / stepPx));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      poses.push({ x: a.x + dx * t, y: a.y + dy * t, yaw_deg: yaw });
    }
  }
  return poses;
}
