import { describe, expect, it } from "vitest";
import { layoutPipeline } from "./pipelineLayout";
import { normaliseToBase, toRows, viz } from "./vizData";

describe("layoutPipeline", () => {
  it("puts every edge's target on a lower row than its source", () => {
    const { pos, rows } = layoutPipeline(viz.pipeline.nodes, viz.pipeline.edges);
    expect(pos.size).toBe(viz.pipeline.nodes.length);
    for (const [a, b] of viz.pipeline.edges) expect(pos.get(b)!.y).toBeGreaterThan(pos.get(a)!.y);
    expect(rows).toBeGreaterThan(1);
  });
});

describe("chart transforms", () => {
  it("merges uneven series, leaving missing cells null", () => {
    const chart = viz.charts.find((c) => c.id === "kaggle_run_consensus")!;
    const rows = toRows(chart);
    expect(rows.map((r) => r.x)).toEqual(["v6", "v7", "v8", "v9"]);
    expect(rows[0]["after watershed virtual split"]).toBeNull();
    expect(rows[2]["after watershed virtual split"]).toBe(0.27);
  });

  it("normalises the resolution test to the 1x run", () => {
    const chart = viz.charts.find((c) => c.id === "resolution_invariance")!;
    const { rows, seriesNames } = normaliseToBase(chart);
    expect(seriesNames).toEqual(["0.5x", "1x", "2x"]);
    for (const r of rows) {
      expect(r["1x"]).toBe(1);
      expect(Math.abs((r["2x"] as number) - 1)).toBeLessThan(0.1);
    }
  });
});
