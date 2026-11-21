import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { parseKitFixture, placeKitFixture, sliceAxis, type KitFixture } from "./kitFixtures";
import type { FixtureSlot } from "./wallLayout";

const glb = (name: string) => {
  // Copy into this realm's ArrayBuffer: GLTFLoader checks `instanceof ArrayBuffer`.
  return new Uint8Array(readFileSync(resolve(__dirname, `../../../public/models/fixtures/${name}.glb`))).buffer;
};

let door: KitFixture;
let windowFx: KitFixture;
beforeAll(async () => {
  door = await parseKitFixture("door", glb("door"));
  windowFx = await parseKitFixture("window", glb("window"));
});

const bbox = (geoms: THREE.BufferGeometry[]) => {
  const b = new THREE.Box3();
  geoms.forEach((g) => (g.computeBoundingBox(), b.union(g.boundingBox!)));
  return b;
};

describe("kit fixture models", () => {
  it("parse into unit-box pieces mapped to surface kinds", () => {
    expect(new Set(door.pieces.map((p) => p.surface))).toEqual(new Set(["window_frame", "door", "hardware"]));
    expect(new Set(windowFx.pieces.map((p) => p.surface))).toEqual(new Set(["window_frame", "glass"]));
    const frame = bbox(door.pieces.filter((p) => p.part === "frame").map((p) => p.geometry));
    expect(frame.min.x).toBeCloseTo(-0.5, 3);
    expect(frame.max.x).toBeCloseTo(0.5, 3);
    expect(frame.min.y).toBeCloseTo(0, 3);
    expect(frame.max.y).toBeCloseTo(1, 3);
    expect(door.triangles + windowFx.triangles).toBeLessThan(400);
    // Welded once at load (W6): indexed, fewer vertices than 3 per triangle.
    for (const p of [...door.pieces, ...windowFx.pieces]) {
      expect(p.geometry.index).not.toBeNull();
      expect(p.geometry.attributes.position.count).toBeLessThan(p.geometry.index!.count);
    }
  });

  it("9-slice keeps the edge bands in metres and fills the target exactly", () => {
    // 2.4 m target, 1 m design, 0.1 bands: edges stay 0.1 m, the ends land on the target.
    expect(sliceAxis(-0.5, -0.5, 1, 2.4, 0.1, 0.1, "slice")).toBeCloseTo(-1.2);
    expect(sliceAxis(-0.4, -0.5, 1, 2.4, 0.1, 0.1, "slice")).toBeCloseTo(-1.1);
    expect(sliceAxis(0.5, -0.5, 1, 2.4, 0.1, 0.1, "slice")).toBeCloseTo(1.2);
    expect(sliceAxis(0, -0.5, 1, 2.4, 0.1, 0.1, "slice")).toBeCloseTo(0);
    // too small for both bands -> uniform
    expect(sliceAxis(-0.4, -0.5, 1, 0.1, 0.1, 0.1, "slice")).toBeCloseTo(-0.04);
    expect(sliceAxis(-0.4, -0.5, 1, 2.4, 0.1, 0.1, "stretch")).toBeCloseTo(-0.96);
  });

  it("fits the frame to the slot: width, height, wall thickness, wall direction", () => {
    const slot: FixtureSlot = { kind: "window", openingId: "w", x: 1, y: 0.9, z: 2, width: 2.4, height: 1.2, thickness: 0.2, yaw: 0 };
    const frame = bbox(
      placeKitFixture(windowFx, slot)
        .filter((_, i) => windowFx.pieces[i].part === "frame")
        .map((p) => p.geometry),
    );
    // yaw 0: the wall runs along +Z, so the width is on Z and the depth on X.
    expect(frame.max.z - frame.min.z).toBeCloseTo(2.4, 3);
    expect(frame.max.y - frame.min.y).toBeCloseTo(1.2, 3);
    expect(frame.min.y).toBeCloseTo(0.9, 3);
    expect(frame.max.x - frame.min.x).toBeCloseTo(0.21, 3);
    expect((frame.min.z + frame.max.z) / 2).toBeCloseTo(2, 3);
  });
});
