import { describe, expect, it } from "vitest";
import { demoWalkPoses, demoWaypoints } from "./demoWalk";

const square = (x: number, y: number, s: number) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];

describe("demo walk", () => {
  it("visits every room centre once", () => {
    const rooms = [
      { polygon: square(0, 0, 100) },
      { polygon: square(200, 0, 100) },
      { polygon: square(100, 0, 100) },
    ];
    const pts = demoWaypoints({ walls: [], rooms } as never);
    expect(pts.map((p) => Math.round(p.x))).toEqual([50, 150, 250]);
  });

  it("falls back to a square inside the plan when there are no rooms", () => {
    const walls = [{ start: { x: 0, y: 0 }, end: { x: 400, y: 200 } }];
    const pts = demoWaypoints({ walls, rooms: [] } as never);
    expect(pts).toHaveLength(4);
    for (const p of pts) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(400);
    }
  });

  it("steps evenly with the heading along the travel direction", () => {
    const poses = demoWalkPoses(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      10,
    );
    expect(poses).toHaveLength(20);
    expect(poses[1].x).toBeCloseTo(10);
    expect(poses[0].yaw_deg).toBeCloseTo(90); // moving right = east
    expect(poses[10].yaw_deg).toBeCloseTo(-90); // and back
  });

  it("returns nothing for a degenerate path", () => {
    expect(demoWalkPoses([{ x: 0, y: 0 }], 10)).toEqual([]);
    expect(
      demoWalkPoses(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        0,
      ),
    ).toEqual([]);
  });
});
