import { describe, expect, it } from "vitest";
import { loadSample } from "@/test/samples";
import { DEFAULT_HEIGHT_M, normalizePlan, parsePlan, validatePlan } from "./normalize";
import type { RawPlan } from "./types";

describe("normalizePlan", () => {
  it("converts schema 1.0 [x, y] points and thickness_px / height_m", () => {
    const plan = normalizePlan(loadSample("newri-mitunet-geometry"));
    const w = plan.walls[0];
    expect(w.start).toEqual({ x: 394.125, y: 611.25 });
    expect(w.thickness).toBe(10);
    expect(w.height).toBe(2.7);
  });

  it("converts metre thickness to px using metadata.pixel_to_meter_ratio", () => {
    const plan = normalizePlan(loadSample("newri-reference"));
    // 0.1 m / 0.01 m-per-px = 10 px
    expect(plan.walls[0].thickness).toBeCloseTo(10);
  });

  it("leaves schema 2.0 px thickness alone and defaults height", () => {
    const plan = normalizePlan(loadSample("bungalow"));
    expect(plan.walls[0].thickness).toBe(20);
    expect(plan.walls[0].height).toBe(DEFAULT_HEIGHT_M);
  });

  it("is idempotent: a second pass does not divide metres again", () => {
    const once = normalizePlan(loadSample("newri-reference"));
    const twice = normalizePlan(once);
    expect(twice.walls[0].thickness).toBeCloseTo(10);
    expect(twice).toBe(once);
  });

  it("does not mutate its input", () => {
    const raw = loadSample("newri-mitunet-geometry");
    const before = JSON.stringify(raw);
    normalizePlan(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("converts room polygons", () => {
    const raw: RawPlan = {
      walls: [],
      rooms: [{ id: "r", polygon: [[0, 0], [10, 0], [10, 10]] }],
    };
    expect(normalizePlan(raw).rooms?.[0].polygon[2]).toEqual({ x: 10, y: 10 });
  });

  it("returns non-plan input unchanged", () => {
    expect(normalizePlan(null)).toBeNull();
    expect(normalizePlan({ foo: 1 })).toEqual({ foo: 1 });
  });
});

describe("validatePlan", () => {
  it("accepts every bundled sample", () => {
    for (const name of ["bungalow", "cubicasa", "newri-mitunet-geometry", "newri-reference"]) {
      expect(validatePlan(normalizePlan(loadSample(name)))).toBeNull();
    }
  });

  it.each([
    [[], "top-level JSON must be an object"],
    [{}, 'missing a "walls" array'],
    [{ walls: [{ start: { x: 0, y: 0 }, end: { x: Infinity, y: 0 } }] }, "walls[0] needs finite"],
    [{ walls: [], rooms: {} }, '"rooms" must be an array'],
  ])("rejects %j", (input, message) => {
    expect(validatePlan(input)).toContain(message);
  });

  it("rejects more walls than gap closure accepts", () => {
    const walls = Array.from({ length: 5001 }, () => ({
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
    }));
    expect(validatePlan({ walls })).toContain("exceeds the 5000 limit");
  });

  it("parsePlan throws a user-facing message", () => {
    expect(() => parsePlan({})).toThrow(/not a usable plan/);
  });
});
