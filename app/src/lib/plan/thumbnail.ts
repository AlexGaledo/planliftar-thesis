/**
 * Plan thumbnail as a tiny standalone SVG string (ink line drawing).
 *
 * Stored on each project so the library renders instantly from IndexedDB without
 * re-running normalisation and gap closure for every card. SVG rather than PNG:
 * it is a few KB, stays crisp at any size, and inherits `currentColor`, so the
 * same thumbnail works in light and dark mode.
 */
import { computeBounds } from "./geometry";
import type { Plan } from "./types";

/** viewBox padding as a fraction of the plan's longest side. */
const PADDING_FRACTION = 0.06;

const round = (n: number) => Math.round(n * 10) / 10;

export function planThumbnailSvg(plan: Plan): string {
  const b = computeBounds(plan);
  const longest = Math.max(b.widthPx, b.heightPx, 1);
  const pad = longest * PADDING_FRACTION;
  const viewBox = [b.minX - pad, b.minY - pad, b.widthPx + 2 * pad, b.heightPx + 2 * pad]
    .map(round)
    .join(" ");

  const rooms = (plan.rooms || [])
    .filter((r) => (r.polygon || []).length >= 3)
    .map((r) => `<polygon points="${r.polygon.map((p) => `${round(p.x)},${round(p.y)}`).join(" ")}"/>`)
    .join("");

  // Thickness is clamped to a minimum share of the drawing so thin walls do not
  // vanish when a big plan is shrunk to card size.
  const minStroke = longest / 140;
  const walls = plan.walls
    .map((w) => {
      const sw = round(Math.max(minStroke, w.thickness || 4));
      return `<line x1="${round(w.start.x)}" y1="${round(w.start.y)}" x2="${round(w.end.x)}" y2="${round(w.end.y)}" stroke-width="${sw}"/>`;
    })
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">` +
    `<g fill="currentColor" fill-opacity="0.06" stroke="none">${rooms}</g>` +
    `<g stroke="currentColor" stroke-linecap="square" fill="none">${walls}</g>` +
    `</svg>`
  );
}
