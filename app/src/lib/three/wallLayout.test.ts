import { describe, expect, it } from "vitest";
import type { Opening } from "@/lib/plan/fixtures";
import type { Wall } from "@/lib/plan/types";
import { DOOR_HEIGHT_M, SILL_HEIGHT_M, WINDOW_HEAD_M, cutOpening, dedupeWalls, layoutWalls, type BoxSpec } from "./wallLayout";

const PPM = 100;
const center = { x: 0, y: 0 };
const wall = (x0: number, y0: number, x1: number, y1: number, thickness = 20): Wall => ({
  start: { x: x0, y: y0 },
  end: { x: x1, y: y1 },
  thickness,
  height: 2.7,
});
const opening = (kind: "door" | "window", s0: number, s1: number): Opening => ({
  id: kind,
  kind,
  sourceIds: [kind],
  hostWallId: "w",
  origin: { x: 0, y: 0 },
  dir: { x: 1, y: 0 },
  s0,
  s1,
  thicknessPx: 20,
});
const of = (boxes: BoxSpec[], kind: string) => boxes.filter((b) => b.kind === kind);
const top = (b: BoxSpec) => b.y + b.height / 2;
const bottom = (b: BoxSpec) => b.y - b.height / 2;

describe("dedupeWalls", () => {
  it("drops reversed exact duplicates only", () => {
    expect(dedupeWalls([wall(0, 0, 100, 0), wall(100, 0, 0, 0), wall(0, 0, 100, 0, 30)])).toHaveLength(2);
  });
});

describe("cutOpening", () => {
  it("splits a wall around the opening and leaves other walls alone", () => {
    const pieces = [
      { a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, t: 20 },
      { a: { x: 0, y: 0 }, b: { x: 0, y: 300 }, t: 20 },
    ];
    const out = cutOpening(pieces, opening("window", 100, 180), 1);
    expect(out).toHaveLength(3);
    expect(out).toContainEqual({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, t: 20 });
    expect(out).toContainEqual({ a: { x: 180, y: 0 }, b: { x: 400, y: 0 }, t: 20 });
  });

  it("cuts every overlapping collinear copy (near-duplicate reversed walls)", () => {
    const pieces = [
      { a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, t: 20 },
      { a: { x: 390, y: 1 }, b: { x: 5, y: 1 }, t: 20 },
    ];
    expect(cutOpening(pieces, opening("window", 100, 180), 1)).toHaveLength(4);
  });

  it("drops slivers shorter than the minimum", () => {
    const out = cutOpening([{ a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, t: 20 }], opening("door", 1, 100), 2);
    expect(out).toHaveLength(1);
  });
});

describe("layoutWalls", () => {
  it("a plain wall is one full-height box plus skirting, in metres", () => {
    const boxes = layoutWalls([wall(0, 0, 400, 0)], [], { ppm: PPM, wallHeightM: 2.5, center });
    expect(of(boxes, "wall")).toHaveLength(1);
    const w = of(boxes, "wall")[0];
    expect(w.length).toBeCloseTo(4);
    expect(w.thickness).toBeCloseTo(0.2);
    expect(w.height).toBeCloseTo(2.5);
    expect(of(boxes, "skirting")).toHaveLength(1);
    expect(of(boxes, "skirting")[0].thickness).toBeCloseTo(0.22);
  });

  it("door: wall split, lintel from door height to the top, frame and leaf inside the opening", () => {
    const boxes = layoutWalls([wall(0, 0, 400, 0)], [opening("door", 100, 190)], { ppm: PPM, wallHeightM: 2.5, center });
    const walls = of(boxes, "wall");
    expect(walls).toHaveLength(3); // left, right, lintel
    const lintel = walls.find((b) => bottom(b) > 0.01)!;
    expect(bottom(lintel)).toBeCloseTo(DOOR_HEIGHT_M);
    expect(top(lintel)).toBeCloseTo(2.5);
    expect(lintel.length).toBeCloseTo(0.9);
    expect(lintel.x).toBeCloseTo(1.45);
    expect(of(boxes, "window_frame")).toHaveLength(3);
    const leaf = of(boxes, "door");
    expect(leaf).toHaveLength(1);
    expect(leaf[0].length).toBeCloseTo(0.8);
    expect(top(leaf[0])).toBeLessThanOrEqual(DOOR_HEIGHT_M);
    // no skirting across the doorway
    expect(of(boxes, "skirting")).toHaveLength(2);
    // nothing of the door sticks out of the opening
    for (const b of [...leaf, ...of(boxes, "window_frame")]) {
      expect(b.x - b.length / 2).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(b.x + b.length / 2).toBeLessThanOrEqual(1.9 + 1e-9);
    }
  });

  it("door: no lintel when the wall is not taller than the door", () => {
    const boxes = layoutWalls([wall(0, 0, 400, 0)], [opening("door", 100, 190)], { ppm: PPM, wallHeightM: 2.0, center });
    expect(of(boxes, "wall")).toHaveLength(2);
    expect(Math.max(...of(boxes, "door").map(top))).toBeLessThanOrEqual(2.0);
  });

  it("window: wall split, sill, header, 4 frame members and one glass pane", () => {
    const boxes = layoutWalls([wall(0, 0, 400, 0)], [opening("window", 100, 220)], { ppm: PPM, wallHeightM: 2.5, center });
    const walls = of(boxes, "wall");
    expect(walls).toHaveLength(4); // left, right, sill, header
    const sill = walls.find((b) => bottom(b) < 0.01 && Math.abs(b.length - 1.2) < 1e-6)!;
    expect(top(sill)).toBeCloseTo(SILL_HEIGHT_M);
    const header = walls.find((b) => bottom(b) > 0.01)!;
    expect(bottom(header)).toBeCloseTo(WINDOW_HEAD_M);
    expect(top(header)).toBeCloseTo(2.5);
    expect(of(boxes, "window_frame")).toHaveLength(4);
    const glass = of(boxes, "glass");
    expect(glass).toHaveLength(1);
    expect(bottom(glass[0])).toBeGreaterThan(SILL_HEIGHT_M);
    expect(top(glass[0])).toBeLessThan(WINDOW_HEAD_M);
    // skirting continues under the window (left, right, sill)
    expect(of(boxes, "skirting")).toHaveLength(3);
  });

  it("window: skipped (wall stays solid) when the wall is too low for a sill", () => {
    const boxes = layoutWalls([wall(0, 0, 400, 0)], [opening("window", 100, 220)], { ppm: PPM, wallHeightM: 1.0, center });
    expect(of(boxes, "wall")).toHaveLength(1);
    expect(of(boxes, "glass")).toHaveLength(0);
  });

  it("orients boxes along the host wall (plan +Y is local -Z)", () => {
    const boxes = layoutWalls([wall(0, 0, 0, 400)], [], { ppm: PPM, wallHeightM: 2.5, center });
    const w = of(boxes, "wall")[0];
    expect(Math.abs(Math.sin(w.yaw))).toBeCloseTo(0);
    expect(w.z).toBeCloseTo(-2);
  });
});
