/**
 * Real-world scale from ONE reference dimension (the locked project decision).
 *
 * Plans are unitless ("units": "relative_px", "user_scale_required": true), so
 * the user tells us one real length and everything else follows:
 *
 *   ppm = reference length in plan px / reference length in metres
 *
 * The reference is either the building's longest side (ar.html's "Building
 * length" field, `real_longest_m` in PROTOCOL.md) or one wall the user knows.
 * Both produce the same thing: a single ppm. The 1:N miniature factor is a
 * separate concept (see geometry.ts) and never touches ppm.
 */
import type { RawPlan } from "./types";

/** ar.html's default: 100 plan px per metre. */
export const DEFAULT_PPM = 100;
/** PROTOCOL.md clamps real_longest_m to this range. */
export const REAL_LONGEST_MIN_M = 0.5;
export const REAL_LONGEST_MAX_M = 500;

export type Units = "metric" | "imperial";
const METRES_PER_FOOT = 0.3048;

/**
 * Starting ppm for a plan the user has not measured yet. A file that states its
 * own pixel_to_meter_ratio (e.g. newri-reference: 0.01 m/px) gets that, so it
 * lands at its true size; anything else gets the 100 px/m placeholder.
 */
export function initialPpm(plan: RawPlan): number {
  const ratio = Number(plan.metadata?.pixel_to_meter_ratio);
  return ratio > 0 && Number.isFinite(ratio) ? 1 / ratio : DEFAULT_PPM;
}

/** ppm from a reference: `px` long in the plan is `meters` long in reality. */
export function ppmFromReference(px: number, meters: number): number | null {
  if (!(px > 0) || !(meters > 0) || !Number.isFinite(px) || !Number.isFinite(meters)) return null;
  return px / meters;
}

/** Clamp a "building length" input to the protocol's range. */
export function clampRealLongest(meters: number): number {
  return Math.min(REAL_LONGEST_MAX_M, Math.max(REAL_LONGEST_MIN_M, meters));
}

/** Metres to the user's display unit (number only). */
export function toDisplayLength(meters: number, units: Units): number {
  return units === "imperial" ? meters / METRES_PER_FOOT : meters;
}

/** A value typed in the user's display unit, back to metres. */
export function fromDisplayLength(value: number, units: Units): number {
  return units === "imperial" ? value * METRES_PER_FOOT : value;
}

/** Short unit suffix for inputs. */
export function unitSuffix(units: Units): string {
  return units === "imperial" ? "ft" : "m";
}

/** "12.4 m" / "40.7 ft" with one decimal. */
export function formatLength(meters: number, units: Units, digits = 1): string {
  if (!Number.isFinite(meters)) return "unknown";
  return `${toDisplayLength(meters, units).toFixed(digits)} ${unitSuffix(units)}`;
}

/** "8.1 × 11.0 m" footprint text. */
export function formatFootprint(wM: number, dM: number, units: Units): string {
  const s = unitSuffix(units);
  return `${toDisplayLength(wM, units).toFixed(1)} × ${toDisplayLength(dM, units).toFixed(1)} ${s}`;
}
