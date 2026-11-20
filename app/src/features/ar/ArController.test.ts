import { describe, expect, it } from "vitest";
import { normalizePlan } from "@/lib/plan";
import { ArController, type ArUiState } from "./ArController";

// 1000 x 500 px footprint
const plan = normalizePlan({
  walls: [
    { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } },
    { start: { x: 1000, y: 0 }, end: { x: 1000, y: 500 } },
  ],
});

function make() {
  let ui: ArUiState | null = null;
  const ppmChanges: number[] = [];
  const c = new ArController({ plan, ppm: 100, wallHeightM: 2.5, hubUrl: "ws://127.0.0.1:1/ws", fake: false, onUi: (u) => (ui = u), onPpmChange: (p) => ppmChanges.push(p) });
  return { c, ui: () => ui!, ppmChanges };
}

describe("ArController control patches (PROTOCOL.md)", () => {
  it("reports the footprint from ppm", () => {
    const { c } = make();
    const s = c.currentState();
    expect(s.plan_w_m).toBe(10);
    expect(s.plan_d_m).toBe(5);
    expect(s.real_longest_m).toBe(10);
    expect(s.model_denom).toBe(50);
  });

  it("clamps every value and wraps rotation", () => {
    const { c, ui, ppmChanges } = make();
    c.applyControlPatch({ model_denom: 999, wall_height_m: 50, wall_opacity: 0, rotation_deg: -350, real_longest_m: 0.01 });
    const s = ui().phone;
    expect(s.model_denom).toBe(200);
    expect(s.wall_height_m).toBe(10);
    expect(s.wall_opacity).toBe(0.05);
    expect(s.rotation_deg).toBe(10);
    expect(s.real_longest_m).toBeCloseTo(0.5);
    expect(ppmChanges.at(-1)).toBeCloseTo(2000);
  });

  it("ignores non-numeric values", () => {
    const { c } = make();
    c.applyControlPatch({ model_denom: "x" as unknown as number, auto_fit: false });
    expect(c.currentState().model_denom).toBe(50);
    expect(c.currentState().auto_fit).toBe(false);
  });

  it("presets match ar.html", () => {
    const { c } = make();
    c.setLifeSize();
    expect(c.currentState()).toMatchObject({ model_denom: 1, auto_fit: false, wall_opacity: 1 });
    c.setTabletop();
    expect(c.currentState()).toMatchObject({ model_denom: 50, auto_fit: true });
  });
});
