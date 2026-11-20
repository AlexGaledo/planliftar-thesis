/**
 * Pure drawing functions for the live map canvas. Port of the draw code in
 * deliverables/livemap/index.html, kept framework-free so it is easy to test
 * and reason about.
 *
 * Plan coordinates are image pixels, X right, Y DOWN. Canvas 2D is also
 * X right, Y down, so plan -> canvas is a uniform scale + offset with NO flip
 * (flipping would mirror the plan).
 */
import { computeBounds, type Plan, type PlanPoint } from "@/lib/plan";
import type { PoseMessage } from "@/lib/hub/protocol";

export interface FitTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface MapColors {
  paper: string;
  ink: string;
  roomFill: string;
  roomStroke: string;
  live: string;
}

/** Empty margin around the plan, as a fraction of the canvas on each side. */
export const MARGIN_FRACTION = 0.08;
export const TRAIL_MAX = 200;
const PULSE_PERIOD_MS = 1500;

/** Fit the plan's bounding box into the canvas, centred, with a margin. */
export function fitTransform(plan: Plan, canvasW: number, canvasH: number): FitTransform {
  const b = computeBounds(plan);
  if (!Number.isFinite(b.minX)) return { scale: 1, offsetX: 0, offsetY: 0 };
  const planW = Math.max(1, b.widthPx);
  const planH = Math.max(1, b.heightPx);
  const scale = Math.min((canvasW * (1 - MARGIN_FRACTION * 2)) / planW, (canvasH * (1 - MARGIN_FRACTION * 2)) / planH);
  return {
    scale,
    offsetX: (canvasW - planW * scale) / 2 - b.minX * scale,
    offsetY: (canvasH - planH * scale) / 2 - b.minY * scale,
  };
}

export function toCanvas(p: PlanPoint, t: FitTransform): [number, number] {
  return [p.x * t.scale + t.offsetX, p.y * t.scale + t.offsetY];
}

/** "#13804b" or "rgb(19 128 75)" -> "rgba(19, 128, 75, a)". */
export function withAlpha(color: string, alpha: number): string {
  const m = color.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  const h = color.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The plan itself (rooms then walls). Drawn once into an offscreen canvas. */
export function drawPlan(ctx: CanvasRenderingContext2D, plan: Plan, t: FitTransform, c: MapColors): void {
  ctx.fillStyle = c.paper;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const room of plan.rooms ?? []) {
    const poly = room.polygon;
    if (poly.length < 3) continue;
    ctx.beginPath();
    poly.forEach((p, i) => {
      const [x, y] = toCanvas(p, t);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = c.roomFill;
    ctx.fill();
    ctx.strokeStyle = c.roomStroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  // Each wall keeps its own thickness, scaled by the fit, so relative
  // thickness is preserved.
  ctx.strokeStyle = c.ink;
  ctx.lineCap = "round";
  for (const w of plan.walls) {
    const [x1, y1] = toCanvas(w.start, t);
    const [x2, y2] = toCanvas(w.end, t);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineWidth = Math.max(1.5, (w.thickness ?? 4) * t.scale);
    ctx.stroke();
  }
}

/**
 * The live layer: fading trail, heading cone, glow, dot and pulsing ring.
 * `dpr` keeps marker sizes constant in CSS pixels on high-density screens.
 */
export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  trail: PlanPoint[],
  latest: PoseMessage | null,
  t: FitTransform,
  c: MapColors,
  dpr: number,
  nowMs: number,
): void {
  if (trail.length > 1) {
    trail.forEach((p, i) => {
      const alpha = (i + 1) / trail.length;
      const [x, y] = toCanvas(p, t);
      ctx.beginPath();
      ctx.arc(x, y, 2.5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(c.live, 0.35 * alpha);
      ctx.fill();
    });
  }
  if (!latest) return;

  const [x, y] = toCanvas(latest, t);
  const yaw = ((latest.yaw_deg || 0) * Math.PI) / 180;
  // yaw 0 -> "up" on screen (plan -Y); yaw 90 -> "right" (plan +X).
  const dirX = Math.sin(yaw);
  const dirY = -Math.cos(yaw);
  const coneLen = 22 * dpr;
  const coneHalf = 9 * dpr;
  const perpX = -dirY;
  const perpY = dirX;
  ctx.beginPath();
  ctx.moveTo(x + dirX * coneLen, y + dirY * coneLen);
  ctx.lineTo(x + perpX * coneHalf, y + perpY * coneHalf);
  ctx.lineTo(x - perpX * coneHalf, y - perpY * coneHalf);
  ctx.closePath();
  ctx.fillStyle = withAlpha(c.live, 0.55);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, 13 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(c.live, 0.18);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, 6 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = c.live;
  ctx.strokeStyle = c.paper;
  ctx.lineWidth = 2 * dpr;
  ctx.fill();
  ctx.stroke();

  // Pulsing locator ring so the position is unmissable at a glance.
  const pulse = (nowMs % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
  ctx.beginPath();
  ctx.arc(x, y, (14 + pulse * 22) * dpr, 0, Math.PI * 2);
  ctx.strokeStyle = withAlpha(c.live, 0.55 * (1 - pulse));
  ctx.lineWidth = 2.5 * dpr;
  ctx.stroke();
}
