/**
 * Tests for the AR placement core, with mocked XRFrame / XRAnchor objects.
 * Mirrors the verification listed in docs/research/AR_ANCHORING.md.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  AnchoredPlacement,
  SurfaceGate,
  TrackingMonitor,
  composeModelMatrix,
  yawOfMatrix,
  yawOnly,
  type AnchorLike,
  type FrameLike,
} from "./arCore";

const REF = {} as XRReferenceSpace;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A mock anchor whose world pose the test can move around. */
function makeAnchor(pose: THREE.Matrix4) {
  const anchor: AnchorLike & { deleted: boolean; pose: THREE.Matrix4 } = {
    anchorSpace: {} as XRSpace,
    deleted: false,
    pose,
    delete() {
      this.deleted = true;
    },
  };
  return anchor;
}

function frameFor(anchors: ReturnType<typeof makeAnchor>[]): FrameLike {
  return {
    trackedAnchors: new Set(anchors),
    getPose(space) {
      const a = anchors.find((x) => x.anchorSpace === space);
      if (!a) return null;
      const position = new THREE.Vector3().setFromMatrixPosition(a.pose);
      return { transform: { matrix: a.pose.toArray(), position } };
    },
  };
}

const hitAt = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

async function placedWith(anchor: ReturnType<typeof makeAnchor>, hit: THREE.Matrix4) {
  const placement = new AnchoredPlacement();
  const pos = new THREE.Vector3().setFromMatrixPosition(hit);
  placement.place({ createAnchor: () => Promise.resolve(anchor) }, hit, pos, frameFor([anchor]), REF);
  await flush();
  return placement;
}

describe("math helpers", () => {
  it("yawOnly keeps position and heading, drops tilt", () => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(1, 2, 3),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.5, -0.05, "YXZ")),
      new THREE.Vector3(1, 1, 1),
    );
    const out = yawOnly(m, new THREE.Matrix4());
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    out.decompose(p, q, new THREE.Vector3());
    expect(p.toArray()).toEqual([1, 2, 3]);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(up.y).toBeCloseTo(1, 6);
  });

  it("yawOfMatrix reads a pure Y rotation", () => {
    expect(yawOfMatrix(new THREE.Matrix4().makeRotationY(0.7))).toBeCloseTo(0.7);
  });

  it("composeModelMatrix equals the old rotation.y = -yaw + uniform scale", () => {
    const base = new THREE.Matrix4().makeTranslation(1, 0, -2);
    const out = composeModelMatrix(base, 0.1, 30, 0.02, new THREE.Matrix4());
    const group = new THREE.Group();
    group.position.set(1, 0.1, -2);
    group.rotation.y = THREE.MathUtils.degToRad(-30);
    group.scale.setScalar(0.02);
    group.updateMatrix();
    out.elements.forEach((v, i) => expect(v).toBeCloseTo(group.matrix.elements[i], 9));
  });
});

describe("AnchoredPlacement", () => {
  it("does not jump when the anchor is adopted", async () => {
    const hit = hitAt(0.5, 0, -1);
    const anchor = makeAnchor(hit.clone());
    const placement = await placedWith(anchor, hit);
    expect(placement.mode).toBe("pending");
    const before = new THREE.Vector3().setFromMatrixPosition(placement.base);
    placement.update(frameFor([anchor]), REF);
    expect(placement.mode).toBe("anchor");
    const after = new THREE.Vector3().setFromMatrixPosition(placement.base);
    expect(after.distanceTo(before)).toBeLessThan(1e-9);
  });

  it("makes a far corner follow a 2 degree + 3 cm world correction", async () => {
    const hit = hitAt(0, 0, 0);
    const anchor = makeAnchor(hit.clone());
    const placement = await placedWith(anchor, hit);
    placement.update(frameFor([anchor]), REF);

    // ARCore corrects its world: the anchor (and the real room) rotate 2 degrees and shift 3 cm.
    const correction = new THREE.Matrix4()
      .makeTranslation(0.03, 0, 0)
      .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(2)));
    anchor.pose = correction.clone().multiply(hit);
    placement.update(frameFor([anchor]), REF);

    const corner = new THREE.Vector3(8, 0, 0);
    const expected = corner.clone().applyMatrix4(correction);
    const actual = corner.clone().applyMatrix4(placement.base);
    expect(actual.distanceTo(expected)).toBeLessThan(1e-6);
    // The position-only approach would be ~28 cm off at 8 m.
    const positionOnly = corner.clone().add(new THREE.Vector3().setFromMatrixPosition(anchor.pose));
    expect(positionOnly.distanceTo(expected)).toBeGreaterThan(0.25);
    expect(placement.stats.yawCorrDeg).toBeCloseTo(2, 5);
  });

  it("keeps the base level under a tilted anchor", async () => {
    const hit = hitAt(0, 0, 0);
    const anchor = makeAnchor(hit.clone());
    const placement = await placedWith(anchor, hit);
    anchor.pose = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(3));
    placement.update(frameFor([anchor]), REF);
    const q = new THREE.Quaternion();
    placement.base.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(q).y).toBeCloseTo(1, 9);
  });

  it("re-anchors without moving the model and deletes the old anchor", async () => {
    const hit = hitAt(0, 0, 0);
    const first = makeAnchor(hit.clone());
    const placement = await placedWith(first, hit);
    placement.update(frameFor([first]), REF);
    const before = placement.base.clone();

    const nearUser = hitAt(3, 0, -4);
    const second = makeAnchor(nearUser.clone());
    placement.reanchor({ createAnchor: () => Promise.resolve(second) }, nearUser, frameFor([first, second]), REF);
    await flush();
    placement.update(frameFor([first, second]), REF);

    expect(first.deleted).toBe(true);
    expect(placement.anchor).toBe(second);
    expect(placement.stats.reanchors).toBe(1);
    placement.base.elements.forEach((v, i) => expect(v).toBeCloseTo(before.elements[i], 9));
  });

  it("falls back to fixed when anchors are unsupported", () => {
    const placement = new AnchoredPlacement();
    placement.place(null, hitAt(0, 0, 0), new THREE.Vector3(), { getPose: () => null }, REF);
    expect(placement.mode).toBe("fixed");
    expect(placement.update({ getPose: () => null }, REF).tracked).toBe(true);
  });

  it("falls back to fixed when anchor creation is refused", async () => {
    const placement = new AnchoredPlacement();
    placement.place({ createAnchor: () => Promise.reject(new Error("no")) }, hitAt(0, 0, 0), new THREE.Vector3(), { getPose: () => null }, REF);
    await flush();
    expect(placement.mode).toBe("fixed");
  });

  it("deletes an anchor that resolves after reset", async () => {
    let resolve!: (a: AnchorLike) => void;
    const placement = new AnchoredPlacement();
    placement.place({ createAnchor: () => new Promise((r) => (resolve = r)) }, hitAt(0, 0, 0), new THREE.Vector3(), { getPose: () => null }, REF);
    placement.reset();
    const late = makeAnchor(new THREE.Matrix4());
    resolve(late);
    await flush();
    expect(late.deleted).toBe(true);
    expect(placement.mode).toBe("none");
  });

  it("holds the last base while the anchor is untracked", async () => {
    const hit = hitAt(1, 0, 1);
    const anchor = makeAnchor(hit.clone());
    const placement = await placedWith(anchor, hit);
    placement.update(frameFor([anchor]), REF);
    const frame = frameFor([anchor]);
    frame.trackedAnchors = new Set();
    expect(placement.update(frame, REF).tracked).toBe(false);
    expect(placement.stats.untracked).toBe(1);
  });
});

const pose = (x: number, z: number, yawRad = 0) => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawRad);
  return {
    transform: { position: { x, y: 1.4, z }, orientation: { x: q.x, y: q.y, z: q.z, w: q.w } },
  };
};

describe("TrackingMonitor", () => {
  it("reports lost, emulated and ok", () => {
    const t = new TrackingMonitor();
    expect(t.update(null, 0)).toBe("lost");
    expect(t.update({ ...pose(0, 0), emulatedPosition: true }, 0)).toBe("emulated");
    expect(t.update(pose(0, 0), 0)).toBe("ok");
  });

  it("flags rotation without translation as rotation-only, and clears on travel", () => {
    const t = new TrackingMonitor();
    for (let i = 0; i <= 20; i++) t.update(pose(0, 0, (i / 20) * Math.PI / 2), i * 110);
    expect(t.state).toBe("rotation-only");
    t.update(pose(0.2, 0), 2500);
    expect(t.state).toBe("ok");
  });
});

describe("SurfaceGate", () => {
  const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);

  it("walks searching -> points -> settling -> parallax -> good", () => {
    const g = new SurfaceGate();
    const base = { trackingState: "ok" as const, camPos: v(0, 0) };
    expect(g.update({ ...base, planeHitPos: null, previewHitPos: null })).toBe("searching");
    g.update({ ...base, planeHitPos: null, previewHitPos: v(0, -1) });
    expect(g.reason).toBe("points");
    g.update({ ...base, planeHitPos: v(0, -1), previewHitPos: null });
    expect(g.reason).toBe("settling");
    for (let i = 0; i < 12; i++) g.update({ ...base, planeHitPos: v(0, -1), previewHitPos: null });
    expect(g.reason).toBe("parallax");
    for (let i = 1; i <= 4; i++) g.update({ ...base, camPos: v(i * 0.1, 0), planeHitPos: v(0, -1), previewHitPos: null });
    expect(g.level).toBe("good");
  });

  it("blocks while tracking is not ok", () => {
    const g = new SurfaceGate();
    expect(g.update({ trackingState: "rotation-only", camPos: null, planeHitPos: v(0, 0), previewHitPos: null })).toBe("blocked");
    expect(g.reason).toBe("rotation-only");
  });

  it("ignores relocalisation jumps when measuring travel", () => {
    const g = new SurfaceGate();
    g.update({ trackingState: "ok", camPos: v(0, 0), planeHitPos: null, previewHitPos: null });
    g.update({ trackingState: "ok", camPos: v(5, 0), planeHitPos: null, previewHitPos: null });
    expect(g.travelM).toBe(0);
  });
});
