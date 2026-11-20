import { describe, expect, it } from "vitest";
import { loadSample } from "@/test/samples";
import { initialPpm } from "./scale";
import { preparePlan } from "./gapClosure";
import { fixtureWidthPx, normalizeFixtures, openingCenter, openingWidthPx } from "./fixtures";
import type { Fixture, Plan, Wall } from "./types";

const wall = (id: string, x0: number, y0: number, x1: number, y1: number, thickness = 20): Wall => ({
  id,
  start: { x: x0, y: y0 },
  end: { x: x1, y: y1 },
  thickness,
  height: 2.7,
});
const fx = (id: string, type: string, x: number, y: number, widthPx: number, rotation = 0): Fixture => ({
  id,
  type,
  position: { x, y },
  scale: { width: widthPx * 0.01, depth: 0.1, height: 2.1 },
  rotation_degrees: rotation,
});
const plan = (walls: Wall[], fixtures: Fixture[]) => ({ walls, fixtures }) as Pick<Plan, "walls" | "fixtures">;

describe("fixtureWidthPx", () => {
  it("undoes the 0.01 placeholder ratio", () => {
    expect(fixtureWidthPx({ scale: { width: 0.78 } })).toBeCloseTo(78);
    expect(fixtureWidthPx({ scale: {} })).toBe(0);
  });
});

describe("normalizeFixtures", () => {
  it("hosts a window inside a wall and takes orientation from the wall, not rotation_degrees", () => {
    const r = normalizeFixtures(plan([wall("w", 0, 0, 400, 0)], [fx("win", "window", 200, 3, 80, 90)]), 100);
    expect(r.openings).toHaveLength(1);
    const o = r.openings[0];
    expect(o.hostWallId).toBe("w");
    expect(Math.abs(o.dir.x)).toBeCloseTo(1);
    expect(openingWidthPx(o)).toBeCloseTo(80);
    // snapped onto the wall centre line
    expect(openingCenter(o)).toEqual({ x: 200, y: 0 });
  });

  it("works on diagonal walls", () => {
    const r = normalizeFixtures(plan([wall("d", 0, 0, 300, 300)], [fx("win", "window", 152, 148, 60)]), 100);
    expect(r.openings[0].hostWallId).toBe("d");
    const c = openingCenter(r.openings[0]);
    expect(c.x).toBeCloseTo(150);
    expect(c.y).toBeCloseTo(150);
  });

  it("hosts a door in a gap the server already carved, and snaps edges to the wall ends", () => {
    // Wall ends at 100 and resumes at 200; the door icon is 90 px wide in the middle.
    const walls = [wall("a", 0, 0, 100, 0), wall("b", 200, 0, 400, 0)];
    const r = normalizeFixtures(plan(walls, [fx("d1", "door", 150, 0, 90)]), 100);
    expect(r.openings).toHaveLength(1);
    expect(r.openings[0].s0).toBeCloseTo(100);
    expect(r.openings[0].s1).toBeCloseTo(200);
  });

  it("does not stretch a window that sits inside a wall", () => {
    const r = normalizeFixtures(plan([wall("w", 0, 0, 400, 0)], [fx("win", "window", 30, 0, 40)]), 100);
    expect(r.openings[0].s0).toBeCloseTo(10);
    expect(r.openings[0].s1).toBeCloseTo(50);
  });

  it("drops (and reports) fixtures with no wall within reach", () => {
    const r = normalizeFixtures(plan([wall("w", 0, 0, 400, 0)], [fx("far", "window", 200, 150, 60)]), 100);
    expect(r.openings).toHaveLength(0);
    expect(r.dropped).toEqual([{ id: "far", reason: "no host wall within reach" }]);
  });

  it("ignores other icon classes", () => {
    const r = normalizeFixtures(plan([wall("w", 0, 0, 400, 0)], [fx("x", "toilet", 200, 0, 60)]), 100);
    expect(r.openings).toHaveLength(0);
    expect(r.dropped).toHaveLength(0);
  });

  it("dedupes identical icons and merges overlapping fragments into one opening", () => {
    const walls = [wall("w", 0, 0, 600, 0)];
    const fixtures = [
      fx("a", "door", 300, 0, 22),
      fx("b", "door", 308, 0, 22),
      fx("c", "door", 292, 0, 22),
      fx("dup", "door", 300, 0, 22),
      fx("win", "window", 100, 0, 80),
    ];
    const r = normalizeFixtures(plan(walls, fixtures), 50); // 0.3 m = 15 px
    const doors = r.openings.filter((o) => o.kind === "door");
    expect(doors).toHaveLength(1);
    expect(doors[0].sourceIds.sort()).toEqual(["a", "b", "c", "dup"]);
    expect(doors[0].s0).toBeCloseTo(281);
    expect(doors[0].s1).toBeCloseTo(319);
    expect(r.openings.filter((o) => o.kind === "window")).toHaveLength(1);
  });

  it("does not merge a door with a window, or openings on parallel walls", () => {
    const walls = [wall("w1", 0, 0, 400, 0), wall("w2", 0, 100, 400, 100)];
    const r = normalizeFixtures(
      plan(walls, [fx("d", "door", 200, 0, 80), fx("w", "window", 200, 0, 80), fx("d2", "door", 200, 100, 80)]),
      100,
    );
    expect(r.openings).toHaveLength(3);
  });

  it("drops openings that stay narrower than 0.3 m after merging", () => {
    const r = normalizeFixtures(plan([wall("w", 0, 0, 400, 0)], [fx("sliver", "door", 200, 0, 2)]), 100);
    expect(r.openings).toHaveLength(0);
    expect(r.dropped[0].reason).toMatch(/narrower/);
  });

  describe("bundled samples", () => {
    it("cubicasa: 16 icons become 11 openings, all hosted", () => {
      const raw = loadSample("cubicasa");
      const r = normalizeFixtures(preparePlan(raw), initialPpm(raw));
      expect(r.openings).toHaveLength(11);
      expect(r.dropped).toHaveLength(0);
      const ids = r.openings.map((o) => o.id);
      expect(ids).toContain("window_001+window_002"); // exact duplicate
      expect(ids).toContain("window_003+window_004"); // overlapping icons
      // a carved doorway keeps its real width: 0.78 placeholder -> 78 px -> 0.78 m at 100 ppm
      const d1 = r.openings.find((o) => o.id === "door_001")!;
      expect(openingWidthPx(d1)).toBeCloseTo(78);
    });

    it("newri-reference: fragmented door merged, sliver dropped", () => {
      const raw = loadSample("newri-reference");
      const r = normalizeFixtures(preparePlan(raw), initialPpm(raw));
      const frag = r.openings.find((o) => o.sourceIds.includes("door_001"))!;
      expect(frag.sourceIds.sort()).toEqual(["door_001", "door_002", "door_003"]);
      expect(openingWidthPx(frag)).toBeCloseTo(34.5);
      expect(r.dropped.map((d) => d.id)).toEqual(["door_006+door_007"]);
    });

    it("bungalow: no fixtures, no openings", () => {
      const raw = loadSample("bungalow");
      expect(normalizeFixtures(preparePlan(raw), initialPpm(raw)).openings).toEqual([]);
    });
  });
});
