import { describe, expect, it } from "vitest";
import { gateHint, trackingHint } from "./hints";

describe("AR coach hints", () => {
  it("tells the user to tap Place only when the surface is good", () => {
    expect(gateHint({ level: "good", reason: "" })).toMatch(/Tap Place/);
    expect(gateHint({ level: "weak", reason: "points" })).toMatch(/ring turns green/);
    expect(gateHint({ level: "weak", reason: "parallax" })).toMatch(/Take a step/);
  });
  it("explains rotation-only tracking", () => {
    expect(trackingHint("rotation-only")).toMatch(/only tracking rotation/);
    expect(gateHint({ level: "blocked", reason: "lost" })).toMatch(/Tracking lost/);
  });
});
