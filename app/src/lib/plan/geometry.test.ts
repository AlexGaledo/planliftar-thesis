import { describe, expect, it } from "vitest";
import { loadSample } from "@/test/samples";
import {
  boundsCenter,
  computeBounds,
  localToPlan,
  planToLocal,
  polygonArea,
  polygonCentroid,
  sourceImageSize,
} from "./geometry";
import { normalizePlan } from "./normalize";
import {
  clampRealLongest,
  formatLength,
  fromDisplayLength,
  initialPpm,
  ppmFromReference,
  toDisplayLength,
} from "./scale";
import { planThumbnailSvg } from "./thumbnail";

describe("plan <-> local mapping", () => {
  it("round-trips through planToLocal and localToPlan", () => {
    const c = { x: 600, y: 400 };
    const local = planToLocal(820, 130, c, 37.5);
    const back = localToPlan(local.x, local.z, c, 37.5);
    expect(back.x).toBeCloseTo(820);
    expect(back.y).toBeCloseTo(130);
  });

  it("maps plan +Y (down the image) to local -Z", () => {
    const local = planToLocal(0, 100, { x: 0, y: 0 }, 100);
    expect(local.x).toBe(0);
    expect(local.z).toBe(-1);
  });
});

describe("bounds", () => {
  it("measures the bungalow footprint", () => {
    const b = computeBounds(normalizePlan(loadSample("bungalow")));
    expect(b.widthPx).toBe(1200);
    expect(boundsCenter(b).x).toBe(600);
  });

  it("returns a zero box for an empty plan", () => {
    expect(computeBounds({ walls: [], rooms: [] }).widthPx).toBe(0);
  });

  it("reads the source image size from either schema", () => {
    expect(sourceImageSize(loadSample("cubicasa"))).toEqual({ width: 2730, height: 2048 });
    expect(sourceImageSize(loadSample("newri-reference"))).toEqual({ width: 719, height: 1020 });
  });
});

describe("polygons", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  it("computes area and centroid", () => {
    expect(polygonArea(square)).toBe(100);
    expect(polygonCentroid(square)).toEqual({ x: 5, y: 5 });
  });
});

describe("scale", () => {
  it("uses the file's stated ratio, else 100 px/m", () => {
    expect(initialPpm(loadSample("newri-reference"))).toBeCloseTo(100);
    expect(initialPpm(loadSample("bungalow"))).toBe(100);
    expect(initialPpm({ walls: [], metadata: { pixel_to_meter_ratio: 0.02 } })).toBeCloseTo(50);
  });

  it("derives ppm from one reference dimension", () => {
    expect(ppmFromReference(1200, 12)).toBe(100);
    expect(ppmFromReference(1200, 0)).toBeNull();
    expect(ppmFromReference(Number.NaN, 3)).toBeNull();
  });

  it("clamps building length to the protocol range", () => {
    expect(clampRealLongest(0.1)).toBe(0.5);
    expect(clampRealLongest(900)).toBe(500);
  });

  it("converts units both ways", () => {
    expect(fromDisplayLength(toDisplayLength(3, "imperial"), "imperial")).toBeCloseTo(3);
    expect(formatLength(3.048, "imperial")).toBe("10.0 ft");
    expect(formatLength(2.5, "metric")).toBe("2.5 m");
  });
});

describe("planThumbnailSvg", () => {
  it("draws one line per wall and one polygon per room", () => {
    const plan = normalizePlan(loadSample("bungalow"));
    const svg = planThumbnailSvg(plan);
    expect(svg.match(/<line /g)).toHaveLength(plan.walls.length);
    expect(svg.match(/<polygon /g)).toHaveLength(plan.rooms?.length ?? 0);
    expect(svg.startsWith("<svg")).toBe(true);
  });
});
