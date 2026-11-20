/**
 * Message types for the live-map hub. Mirrors deliverables/livemap/PROTOCOL.md,
 * which is FROZEN: change that file and every client together, never one alone.
 *
 * Key rules:
 *  - The first message tags the connection: {"role":"phone"} or {"role":"viewer"}.
 *  - A message with NO `type` field is a pose. (Keeps the Unity PoseStreamer.cs
 *    client working untouched.)
 *  - Unknown `type` values are ignored silently, so the protocol can grow.
 */

export type HubRole = "phone" | "viewer";

/** Phone -> viewers. x/y in plan px; yaw 0 = plan -Y ("up"), clockwise. ~10 Hz. */
export interface PoseMessage {
  x: number;
  y: number;
  yaw_deg: number;
}

/** Keys a viewer may change on the phone (all optional, phone clamps). */
export interface ControlPatch {
  real_longest_m?: number; // 0.5..500
  model_denom?: number; // 1..200 (PROTOCOL.md says 5..200; ar.html allows 1 = life-size)
  auto_fit?: boolean;
  wall_height_m?: number; // 0.1..10
  wall_opacity?: number; // 0.05..1
  rotation_deg?: number; // wrapped to 0..360
  reset_placement?: true;
}

export type XrStatus = "idle" | "active" | "fake" | "unsupported";

/** The phone's authoritative view of itself. Viewers render from this. */
export interface PhoneState {
  real_longest_m: number;
  model_denom: number;
  auto_fit: boolean;
  wall_height_m: number;
  wall_opacity: number;
  rotation_deg: number;
  placed: boolean;
  plan_w_m: number;
  plan_d_m: number;
  model_w_cm: number;
  model_d_cm: number;
  xr: XrStatus;
}

export type HubMessage =
  | { kind: "pose"; pose: PoseMessage }
  | { kind: "state"; state: PhoneState }
  | { kind: "control"; patch: ControlPatch }
  | { kind: "hello" }
  | { kind: "diag"; data: Record<string, unknown> }
  | { kind: "ignored" };

/**
 * Parse one raw socket message into a typed message. Never throws: anything
 * malformed or unknown becomes { kind: "ignored" }.
 */
export function parseHubMessage(raw: unknown): HubMessage {
  let msg: unknown;
  try {
    msg = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { kind: "ignored" };
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { kind: "ignored" };
  const m = msg as Record<string, unknown>;

  // No "type" => pose. Anything typed must never reach the pose path, or the dot
  // would be corrupted with garbage.
  if (!("type" in m)) {
    if (typeof m.x === "number" && typeof m.y === "number" && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      const yaw = typeof m.yaw_deg === "number" && Number.isFinite(m.yaw_deg) ? m.yaw_deg : 0;
      return { kind: "pose", pose: { x: m.x, y: m.y, yaw_deg: yaw } };
    }
    return { kind: "ignored" };
  }
  switch (m.type) {
    case "state":
      return m.state && typeof m.state === "object" ? { kind: "state", state: m.state as PhoneState } : { kind: "ignored" };
    case "control":
      return m.patch && typeof m.patch === "object" ? { kind: "control", patch: m.patch as ControlPatch } : { kind: "ignored" };
    case "hello":
      return { kind: "hello" };
    case "diag":
      return { kind: "diag", data: m };
    default:
      return { kind: "ignored" };
  }
}
