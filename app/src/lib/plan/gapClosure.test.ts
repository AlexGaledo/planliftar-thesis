import { describe, expect, it } from "vitest";
import vizData from "@/content/model_viz_data.json";
import { loadSample } from "@/test/samples";
import { closeWallGaps, nearestOnSegment, preparePlan } from "./gapClosure";
import { normalizePlan } from "./normalize";
import type { RawPlan } from "./types";

/** Expected results, read from the companion data the Learn page charts. */
function expected(seriesName: string, label: string): number {
  const chart = vizData.charts.find((c) => c.id === "gap_closure_per_plan");
  const series = chart?.series.find((s) => s.name === seriesName);
  const point = series?.data.find((d) => d[0] === label);
  return Number(point?.[1]);
}

describe("closeWallGaps against the bundled plans (parity with plan_ops.py)", () => {
  it.each([
    ["cubicasa", "cubicasa (rooms-first)"],
    ["bungalow", "bungalow"],
    ["newri-mitunet-geometry", "newri-mitunet-geometry (line-first)"],
    ["newri-reference", "newri-reference"],
  ])("%s", (file, label) => {
    const raw = loadSample(file);
    const inputWalls = raw.walls.length;
    const plan = preparePlan(raw);
    expect(inputWalls).toBe(expected("input walls", label));
    expect(plan.gapFill?.added.length).toBe(expected("connectors added", label));
    expect(plan.gapFill?.skipped.length).toBe(
      expected("gaps left open (door / no evidence)", label),
    );
    expect(plan.walls.length).toBe(inputWalls + (plan.gapFill?.added.length ?? 0));
  });
});

describe("closeWallGaps rules", () => {
  const corner = (): RawPlan => ({
    walls: [
      { id: "a", start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, thickness: 10 },
      { id: "b", start: { x: 110, y: 10 }, end: { x: 110, y: 100 }, thickness: 10 },
    ],
  });

  it("fills a clipped corner as a junction", () => {
    const plan = preparePlan(corner());
    const fills = plan.walls.filter((w) => w.generated);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((w) => w.reason === "junction")).toBe(true);
  });

  it("leaves a doorway open", () => {
    const raw = corner();
    raw.fixtures = [{ id: "d1", type: "door", position: { x: 105, y: 2 } }];
    const plan = preparePlan(raw);
    expect(plan.walls.some((w) => w.generated)).toBe(false);
    expect(plan.gapFill?.skipped[0]).toContain("doorway d1");
  });

  it("spans a long gap only with window evidence", () => {
    const raw: RawPlan = {
      walls: [
        { id: "a", start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, thickness: 10 },
        { id: "b", start: { x: 200, y: 0 }, end: { x: 300, y: 0 }, thickness: 10 },
      ],
    };
    expect(preparePlan(raw).walls.some((w) => w.generated)).toBe(false);
    raw.fixtures = [{ id: "win", type: "window", position: { x: 150, y: 0 } }];
    const withWindow = preparePlan(raw);
    expect(withWindow.walls.filter((w) => w.generated).map((w) => w.reason)).toContain(
      "span/fixture",
    );
  });

  it("is not re-run on an already closed plan", () => {
    const once = preparePlan(corner());
    expect(closeWallGaps(once)).toBe(once);
  });

  it("can be disabled", () => {
    const plan = preparePlan(corner(), { closeGaps: false });
    expect(plan.gapFill).toEqual({ added: [], skipped: [], enabled: false });
    expect(plan.walls).toHaveLength(2);
  });

  it("drops non-finite walls and reports them", () => {
    const raw = corner();
    raw.walls.push({ id: "bad", start: { x: NaN, y: 0 }, end: { x: 1, y: 1 } });
    const plan = closeWallGaps(normalizePlan(raw));
    expect(plan.gapFill?.skipped.join(" ")).toContain("1 wall(s) dropped");
  });

  it("does not mutate the input plan", () => {
    const input = normalizePlan(corner());
    closeWallGaps(input);
    expect(input.walls).toHaveLength(2);
    expect(input.gapFill).toBeUndefined();
  });
});

describe("nearestOnSegment", () => {
  it("clamps to the segment ends", () => {
    expect(nearestOnSegment([-5, 0], [0, 0], [10, 0])).toEqual({ q: [0, 0], d: 5 });
    expect(nearestOnSegment([5, 3], [0, 0], [10, 0]).d).toBe(3);
  });
});
