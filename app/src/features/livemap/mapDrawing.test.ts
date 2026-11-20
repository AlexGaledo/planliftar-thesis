import { describe, expect, it } from "vitest";
import { normalizePlan } from "@/lib/plan";
import { MARGIN_FRACTION, fitTransform, toCanvas, withAlpha } from "./mapDrawing";

const plan = normalizePlan({
  walls: [
    { start: { x: 100, y: 100 }, end: { x: 500, y: 100 } },
    { start: { x: 500, y: 100 }, end: { x: 500, y: 300 } },
  ],
});

describe("fitTransform", () => {
  it("fits the plan inside the margin and centres it, without flipping Y", () => {
    const t = fitTransform(plan, 1000, 1000);
    const [x0, y0] = toCanvas({ x: 100, y: 100 }, t);
    const [x1, y1] = toCanvas({ x: 500, y: 300 }, t);
    expect(x0).toBeCloseTo(1000 * MARGIN_FRACTION);
    expect(x1).toBeCloseTo(1000 * (1 - MARGIN_FRACTION));
    expect(y1).toBeGreaterThan(y0); // plan +Y is canvas down
    expect((y0 + y1) / 2).toBeCloseTo(500);
  });
});

describe("withAlpha", () => {
  it("handles hex and rgb() colours", () => {
    expect(withAlpha("#13804b", 0.5)).toBe("rgba(19, 128, 75, 0.5)");
    expect(withAlpha("rgb(1 2 3)", 1)).toBe("rgba(1, 2, 3, 1)");
  });
});
