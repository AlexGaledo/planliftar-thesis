/**
 * Coach text shown while aiming, from ar.html's trackingHint()/gateHint().
 * Plain language for non-technical users: say what to DO, not what failed.
 */
import type { SurfaceGate, TrackingState } from "./arCore";

export function trackingHint(state: TrackingState): string {
  if (state === "emulated" || state === "rotation-only") {
    return "The phone is only tracking rotation, so the model would follow you. Move the phone slowly side to side and point it at a well-lit, textured area.";
  }
  return "Tracking lost. Point at a well-lit, textured area and move slowly.";
}

export function gateHint(gate: Pick<SurfaceGate, "level" | "reason">): string {
  switch (gate.level) {
    case "blocked":
      return trackingHint(gate.reason as TrackingState);
    case "weak":
      if (gate.reason === "points") {
        return "Almost. Keep sweeping slowly over the floor until the ring turns green. A rug or textured spot helps.";
      }
      if (gate.reason === "settling") return "Hold on that spot for a moment…";
      return "Take a step or sweep the phone side to side first, so it can see the room from a few angles.";
    case "good":
      return "Floor found. Tap Place.";
    default:
      return "Point at the floor and sweep slowly. Good light helps.";
  }
}
