/**
 * Plan JSON types.
 *
 * Two shapes exist on purpose:
 *  - `RawPlan` is whatever arrives from the server, a file, or a sample. Three
 *    coordinate conventions exist across this project's own files (see
 *    normalize.ts), so it is deliberately loose.
 *  - `Plan` is the normalised form every renderer consumes: points are `{x, y}`
 *    objects in plan pixels, wall thickness is in pixels, wall height in metres.
 *
 * Plan coordinates are image pixels: X right, Y DOWN. Nothing here knows the
 * real-world size; that comes from the user's one reference dimension (scale.ts).
 */

/** A point in plan pixels. */
export interface PlanPoint {
  x: number;
  y: number;
}

/** Any of the three point spellings the repo uses: `{x, y}` or `[x, y]`. */
export type RawPoint = PlanPoint | [number, number] | number[];

export interface RawWall {
  id?: string;
  start?: RawPoint;
  end?: RawPoint;
  /** px in schema 2.0, metres in the "forked" schema (see metadata.pixel_to_meter_ratio) */
  thickness?: number;
  /** schema 1.0 spelling */
  thickness_px?: number;
  height?: number;
  /** schema 1.0 spelling */
  height_m?: number;
  exterior?: boolean;
  between?: unknown;
  generated?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface RawRoom {
  id?: string;
  type?: string;
  name?: string;
  polygon?: RawPoint[];
  area_px?: number;
  [key: string]: unknown;
}

export interface Fixture {
  id?: string;
  /** "door" | "window" | other icon classes */
  type?: string;
  position?: PlanPoint;
  scale?: { width?: number; depth?: number; height?: number };
  rotation_degrees?: number;
  [key: string]: unknown;
}

export interface Acceptance {
  accepted?: boolean;
  reject_reasons?: string[];
  notes?: string[];
  [key: string]: unknown;
}

export interface RawPlan {
  schema_version?: string;
  source?: { image_width_px?: number; image_height_px?: number; [key: string]: unknown };
  metadata?: {
    original_width_px?: number;
    original_height_px?: number;
    pixel_to_meter_ratio?: number;
    [key: string]: unknown;
  };
  scale?: Record<string, unknown>;
  walls: RawWall[];
  rooms?: RawRoom[];
  fixtures?: Fixture[];
  acceptance?: Acceptance;
  /** Idempotency marker set by normalizePlan(). */
  _plan_ops_normalized?: boolean;
  gapFill?: GapFillReport;
  [key: string]: unknown;
}

/** A wall after normalisation: object points, px thickness, metre height. */
export interface Wall extends RawWall {
  id?: string;
  start: PlanPoint;
  end: PlanPoint;
  thickness?: number;
  height: number;
}

export interface Room extends RawRoom {
  polygon: PlanPoint[];
}

export interface Plan extends RawPlan {
  walls: Wall[];
  rooms?: Room[];
  _plan_ops_normalized: true;
}

/** What gap closure did, for the UI and for debugging. Mirrors plan_ops.js. */
export interface GapFillReport {
  added: string[];
  skipped: string[];
  enabled: boolean;
  tMed?: number;
  join?: number;
}

/** Axis-aligned bounding box of a plan, in plan px. */
export interface PlanBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  widthPx: number;
  heightPx: number;
}
