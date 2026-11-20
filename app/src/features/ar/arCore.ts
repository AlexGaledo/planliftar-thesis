/**
 * World-locked placement core for the WebXR AR client.
 *
 * FAITHFUL TypeScript port of deliverables/livemap/ar_core.js (commit b51f983,
 * "lock placed model to the anchor's full pose"). Only types were added; the
 * algorithm, thresholds and state names are unchanged. Read
 * docs/research/AR_ANCHORING.md before changing anything here.
 *
 * Nothing in this file touches the DOM, the WebSocket or React. It answers three
 * questions every frame:
 *
 *   1. Is the device really tracking position?              -> TrackingMonitor
 *   2. Is the surface under the reticle good enough to
 *      anchor to yet?                                       -> SurfaceGate
 *   3. Where, in the reference space, is the placed
 *      model's origin THIS frame?                           -> AnchoredPlacement
 *
 * ---- THE ALGORITHM (AnchoredPlacement) ----
 *   At placement (inside the XR frame, with a live plane hit H0):
 *     B0     = translation(hitPos)            model "base": gravity-aligned, no rotation
 *     rel    = inverse(H0) * B0               base expressed in the anchor's own frame
 *     anchor = hit.createAnchor()             (falls back to frame.createAnchor, then
 *                                             to no anchor at all = "fixed")
 *   Every frame after the anchor resolves:
 *     A    = frame.getPose(anchor.anchorSpace, refSpace)
 *     base = yawOnly(A * rel)                 position AND yaw from the anchor; tilt
 *                                             discarded so the floor stays level
 *   Model matrix = base * T(0, groundOffsetY, 0) * Ry(-userYaw) * S(1/denom)
 *
 * Why yaw matters: when ARCore corrects its world frame it corrects heading too.
 * Ignoring a 2 degree correction moves a wall 8 m away by ~28 cm, which reads as
 * "the model moves when I walk".
 */
import * as THREE from "three";

// ---------------------------------------------------------------------
// Session setup
// ---------------------------------------------------------------------

/**
 * "anchors" stays optional: Chrome Android has it (M85+), but a session without
 * it should still run in "fixed" mode rather than refuse to start.
 */
export function sessionInit(overlayRoot?: Element | null): XRSessionInit {
  const init: XRSessionInit & { optionalFeatures: string[] } = {
    requiredFeatures: ["hit-test"],
    optionalFeatures: ["anchors", "local-floor", "plane-detection"],
  };
  if (overlayRoot) {
    init.optionalFeatures.push("dom-overlay");
    init.domOverlay = { root: overlayRoot };
  }
  return init;
}

export interface HitTestSources {
  /** Planes only. Only these hits may be anchored (plane-attached anchors get refined). */
  placement: XRHitTestSource;
  /** Planes + feature points: lands sooner, drives the reticle only. Null if unsupported. */
  preview: XRHitTestSource | null;
}

/** Two hit-test sources from the screen centre (see HitTestSources). */
export async function requestHitTestSources(session: XRSession): Promise<HitTestSources> {
  const space = await session.requestReferenceSpace("viewer");
  // requestHitTestSource is optional in the type definitions; it is required here
  // because "hit-test" is a required feature of the session.
  const request = session.requestHitTestSource!.bind(session);
  let placement: XRHitTestSource;
  try {
    placement = (await request({ space, entityTypes: ["plane"] })) as XRHitTestSource;
  } catch {
    placement = (await request({ space })) as XRHitTestSource;
  }
  let preview: XRHitTestSource | null = null;
  try {
    preview = (await request({ space, entityTypes: ["plane", "point"] })) as XRHitTestSource;
  } catch {
    preview = null;
  }
  return { placement, preview };
}

// ---------------------------------------------------------------------
// Math helpers (module-level scratch objects avoid per-frame allocation)
// ---------------------------------------------------------------------
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _x = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

/**
 * Keep translation and heading, drop pitch/roll. The reference space's +Y is
 * gravity-up on ARCore, so a floor model must stay level in it; a plane
 * anchor's normal wobbling by half a degree would otherwise lift the far wall
 * of a 10 m building by ~9 cm.
 */
export function yawOnly(m: THREE.Matrix4, out: THREE.Matrix4): THREE.Matrix4 {
  m.decompose(_p, _q, _s);
  _x.set(1, 0, 0).applyQuaternion(_q);
  // Ry(t) maps +X to (cos t, 0, -sin t)
  const yaw = Math.atan2(-_x.z, _x.x);
  _q.setFromAxisAngle(_yAxis, yaw);
  _s.set(1, 1, 1);
  return out.compose(_p, _q, _s);
}

export function yawOfMatrix(m: THREE.Matrix4): number {
  m.decompose(_p, _q, _s);
  _x.set(1, 0, 0).applyQuaternion(_q);
  return Math.atan2(-_x.z, _x.x);
}

const _off = new THREE.Matrix4();
const _rot = new THREE.Matrix4();
const _scl = new THREE.Matrix4();

/**
 * Model matrix = base * T(0, groundOffsetY, 0) * Ry(-yawDeg) * S(scale).
 * The yaw sign keeps rotation_deg meaning "clockwise seen from above".
 */
export function composeModelMatrix(
  base: THREE.Matrix4,
  groundOffsetY: number,
  yawDeg: number,
  scale: number,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  _off.makeTranslation(0, groundOffsetY, 0);
  _rot.makeRotationY(THREE.MathUtils.degToRad(-yawDeg));
  _scl.makeScale(scale, scale, scale);
  return out.copy(base).multiply(_off).multiply(_rot).multiply(_scl);
}

// ---------------------------------------------------------------------
// TrackingMonitor - is position really being tracked?
// ---------------------------------------------------------------------

/**
 * ok            6-DoF tracking
 * lost          no viewer pose this frame
 * emulated      runtime says position is emulated (rotation-only / 3-DoF)
 * rotation-only heuristic: the phone turned a lot but its reported position did
 *               not move. A handheld phone rotating 60 deg always translates
 *               several cm, so ~0 cm means the runtime is not seeing translation.
 * Anything but "ok" means world-locked content WILL appear to follow the camera,
 * so callers must not place, and should hide a placed model.
 */
export type TrackingState = "ok" | "lost" | "emulated" | "rotation-only";

/** The subset of XRViewerPose this class reads (lets tests pass plain objects). */
export interface ViewerPoseLike {
  emulatedPosition?: boolean;
  transform: {
    position: { x: number; y: number; z: number };
    orientation: { x: number; y: number; z: number; w: number };
  };
}

export class TrackingMonitor {
  readonly windowMs: number;
  readonly rotRad: number;
  readonly maxTravelM: number;
  state: TrackingState = "lost";
  suspect3dof = false;
  private prevPos: THREE.Vector3 | null = null;
  private prevQuat: THREE.Quaternion | null = null;
  private winStart = 0;
  private winRot = 0;
  private winTravel = 0;

  constructor({ windowMs = 2000, rotDeg = 60, maxTravelM = 0.02 } = {}) {
    this.windowMs = windowMs;
    this.rotRad = THREE.MathUtils.degToRad(rotDeg);
    this.maxTravelM = maxTravelM;
    this.reset();
  }

  reset(): void {
    this.state = "lost";
    this.suspect3dof = false;
    this.prevPos = null;
    this.prevQuat = null;
    this.winStart = 0;
    this.winRot = 0;
    this.winTravel = 0;
  }

  update(viewerPose: ViewerPoseLike | null | undefined, timestamp: number): TrackingState {
    if (!viewerPose) {
      this.state = "lost";
      return this.state;
    }
    if (viewerPose.emulatedPosition === true) {
      this.state = "emulated";
      return this.state;
    }
    const t = viewerPose.transform;
    const pos = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
    const quat = new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
    if (this.prevPos && this.prevQuat) {
      this.winTravel += pos.distanceTo(this.prevPos);
      this.winRot += this.prevQuat.angleTo(quat);
    } else {
      this.winStart = timestamp;
    }
    this.prevPos = pos;
    this.prevQuat = quat;

    if (this.winTravel > this.maxTravelM * 2.5) this.suspect3dof = false;
    if (timestamp - this.winStart >= this.windowMs) {
      if (this.winRot >= this.rotRad && this.winTravel < this.maxTravelM) this.suspect3dof = true;
      this.winStart = timestamp;
      this.winRot = 0;
      this.winTravel = 0;
    }
    this.state = this.suspect3dof ? "rotation-only" : "ok";
    return this.state;
  }
}

// ---------------------------------------------------------------------
// SurfaceGate - is it safe to place yet?
// ---------------------------------------------------------------------

/**
 * searching  no hit at all
 * weak       something was hit but an anchor made now would be poor:
 *              points   - only feature points, no plane yet
 *              settling - plane hit, but its position is still jumping
 *              parallax - camera has not moved enough since the session started
 *                         (anchors made in the first seconds drift most)
 * good       plane hit, stable for N frames, enough camera travel  -> green ring
 * blocked    tracking is not "ok" (reason = the tracking state)
 */
export type SurfaceLevel = "searching" | "weak" | "good" | "blocked";

export interface SurfaceGateInput {
  trackingState: TrackingState;
  planeHitPos: THREE.Vector3 | null;
  previewHitPos: THREE.Vector3 | null;
  camPos: THREE.Vector3 | null;
}

export class SurfaceGate {
  readonly stableFrames: number;
  readonly stableM: number;
  readonly minTravelM: number;
  travelM = 0;
  level: SurfaceLevel = "searching";
  reason = "";
  stable = 0;
  private lastHit: THREE.Vector3 | null = null;
  private lastCam: THREE.Vector3 | null = null;

  constructor({ stableFrames = 12, stableM = 0.03, minTravelM = 0.3 } = {}) {
    this.stableFrames = stableFrames;
    this.stableM = stableM;
    this.minTravelM = minTravelM;
    this.reset();
  }

  /** Keeps travelM: camera travel belongs to the session's map, not to one attempt. */
  reset(): void {
    this.level = "searching";
    this.reason = "";
    this.stable = 0;
    this.lastHit = null;
    this.lastCam = null;
  }

  resetSession(): void {
    this.travelM = 0;
    this.reset();
  }

  update({ trackingState, planeHitPos, previewHitPos, camPos }: SurfaceGateInput): SurfaceLevel {
    if (camPos && trackingState === "ok") {
      if (this.lastCam) {
        const step = camPos.distanceTo(this.lastCam);
        if (step < 0.5) this.travelM += step; // ignore relocalisation jumps
      }
      this.lastCam = (this.lastCam || new THREE.Vector3()).copy(camPos);
    }

    if (trackingState !== "ok") {
      this.stable = 0;
      return this.set("blocked", trackingState);
    }
    if (!planeHitPos) {
      this.stable = 0;
      this.lastHit = null;
      return previewHitPos ? this.set("weak", "points") : this.set("searching", "");
    }
    if (this.lastHit && planeHitPos.distanceTo(this.lastHit) < this.stableM) this.stable++;
    else this.stable = 0;
    this.lastHit = (this.lastHit || new THREE.Vector3()).copy(planeHitPos);

    if (this.stable < this.stableFrames) return this.set("weak", "settling");
    if (this.travelM < this.minTravelM) return this.set("weak", "parallax");
    return this.set("good", "");
  }

  private set(level: SurfaceLevel, reason: string): SurfaceLevel {
    this.level = level;
    this.reason = reason;
    return level;
  }
}

// ---------------------------------------------------------------------
// AnchoredPlacement - where is the model this frame?
// ---------------------------------------------------------------------

/**
 * none     nothing placed
 * pending  placed, anchor requested, not resolved yet (base is fixed)
 * anchor   following an XRAnchor every frame
 * fixed    anchors unsupported or refused: a fixed world matrix. Correct in a
 *          perfect world; drifts with ARCore's corrections in this one. Say so.
 */
export type PlacementMode = "none" | "pending" | "anchor" | "fixed";

export interface PlacementStats {
  updates: number;
  untracked: number;
  driftM: number;
  jitterM: number;
  snaps: number;
  yawCorrDeg: number;
  reanchors: number;
  origin: THREE.Vector3 | null;
  originYaw: number;
}

/** The subset of XRAnchor this class uses. */
export interface AnchorLike {
  anchorSpace: XRSpace;
  delete?: () => void;
}

/** The subset of XRHitTestResult this class uses. */
export interface HitLike {
  createAnchor?: () => Promise<AnchorLike> | undefined;
}

/** The subset of XRFrame this class uses (lets tests pass mocks). */
export interface FrameLike {
  trackedAnchors?: { has(anchor: AnchorLike): boolean };
  getPose(space: XRSpace, base: XRReferenceSpace): { transform: { matrix: ArrayLike<number>; position: { x: number; y: number; z: number } } } | null | undefined;
  createAnchor?: (pose: XRRigidTransform, space: XRReferenceSpace) => Promise<AnchorLike> | undefined;
}

export class AnchoredPlacement {
  readonly snapM: number;
  readonly base = new THREE.Matrix4();
  readonly rel = new THREE.Matrix4();
  anchor: AnchorLike | null = null;
  mode: PlacementMode = "none";
  stats: PlacementStats;
  private gen = 0;
  private candidate: { anchor: AnchorLike; rel: THREE.Matrix4 } | null = null;
  private readonly A = new THREE.Matrix4();
  private readonly next = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly prev = new THREE.Vector3();

  constructor({ snapM = 0.25 } = {}) {
    this.snapM = snapM;
    this.stats = AnchoredPlacement.freshStats();
  }

  private static freshStats(): PlacementStats {
    return {
      updates: 0, untracked: 0, driftM: 0, jitterM: 0, snaps: 0,
      yawCorrDeg: 0, reanchors: 0, origin: null, originYaw: 0,
    };
  }

  reset(): void {
    this.gen++;
    this.deleteAnchor(this.anchor);
    if (this.candidate) this.deleteAnchor(this.candidate.anchor);
    this.anchor = null;
    this.candidate = null;
    this.mode = "none";
    this.stats = AnchoredPlacement.freshStats();
  }

  /**
   * Call INSIDE the XR frame callback, with the plane hit the user accepted.
   * hitMatrix is that hit's pose in refSpace; basePos is where the model origin
   * goes (normally the hit position). The anchor resolves asynchronously.
   */
  place(hit: HitLike | null, hitMatrix: THREE.Matrix4, basePos: THREE.Vector3, frame: FrameLike, refSpace: XRReferenceSpace): void {
    this.reset();
    this.base.makeTranslation(basePos.x, basePos.y, basePos.z);
    this.mode = "pending";
    this.requestAnchor(hit, hitMatrix, frame, refSpace, true);
  }

  /**
   * Re-anchor without moving the model: a new anchor at a fresh plane hit
   * (normally near the user) with the CURRENT base expressed relative to it.
   * ARCore advises keeping content within ~8 m of its anchor.
   */
  reanchor(hit: HitLike | null, hitMatrix: THREE.Matrix4, frame: FrameLike, refSpace: XRReferenceSpace): boolean {
    if (this.mode === "none") return false;
    this.requestAnchor(hit, hitMatrix, frame, refSpace, false);
    return true;
  }

  private requestAnchor(hit: HitLike | null, hitMatrix: THREE.Matrix4, frame: FrameLike, refSpace: XRReferenceSpace, initial: boolean): void {
    const gen = this.gen;
    const rel = new THREE.Matrix4().copy(hitMatrix).invert().multiply(this.base);
    let promise: Promise<AnchorLike> | undefined | null = null;
    try {
      if (hit && typeof hit.createAnchor === "function") {
        promise = hit.createAnchor(); // plane-attached
      } else if (frame && typeof frame.createAnchor === "function" && typeof XRRigidTransform !== "undefined") {
        hitMatrix.decompose(_p, _q, _s);
        promise = frame.createAnchor( // free-space anchor
          new XRRigidTransform({ x: _p.x, y: _p.y, z: _p.z }, { x: _q.x, y: _q.y, z: _q.z, w: _q.w }),
          refSpace,
        );
      }
    } catch {
      promise = null;
    }
    if (!promise) {
      if (initial) this.mode = "fixed";
      return;
    }
    promise.then(
      (anchor) => {
        if (gen !== this.gen) {
          this.deleteAnchor(anchor);
          return;
        }
        if (this.candidate) this.deleteAnchor(this.candidate.anchor);
        this.candidate = { anchor, rel };
      },
      () => {
        if (gen !== this.gen) return;
        if (initial && this.mode === "pending") this.mode = "fixed";
      },
    );
  }

  private deleteAnchor(a: AnchorLike | null | undefined): void {
    try {
      if (a && typeof a.delete === "function") a.delete();
    } catch {
      /* already gone */
    }
  }

  /**
   * Call every frame (inside the XR frame callback), BEFORE reading `base`.
   * tracked is false only while an anchor exists but is not tracked this frame;
   * base then keeps its last good value.
   */
  update(frame: FrameLike, refSpace: XRReferenceSpace): { tracked: boolean } {
    if (this.candidate) {
      // Adopt a newly resolved anchor here, inside a frame, so the swap and the
      // first pose read happen together. The old anchor is released.
      const { anchor, rel } = this.candidate;
      this.candidate = null;
      if (this.anchor && this.anchor !== anchor) {
        this.deleteAnchor(this.anchor);
        this.stats.reanchors++;
      }
      this.anchor = anchor;
      this.rel.copy(rel);
      this.mode = "anchor";
      this.stats.origin = null;
    }

    if (this.mode !== "anchor" || !this.anchor) return { tracked: this.mode !== "none" };

    const tracked = frame.trackedAnchors;
    if (tracked && !tracked.has(this.anchor)) {
      this.stats.untracked++;
      return { tracked: false };
    }
    let pose: ReturnType<FrameLike["getPose"]> = null;
    try {
      pose = frame.getPose(this.anchor.anchorSpace, refSpace);
    } catch {
      pose = null;
    }
    if (!pose) {
      this.stats.untracked++;
      return { tracked: false };
    }

    this.A.fromArray(Array.from(pose.transform.matrix));
    yawOnly(this.next.multiplyMatrices(this.A, this.rel), this.next);

    const p = pose.transform.position;
    this.pos.set(p.x, p.y, p.z);
    const st = this.stats;
    if (st.origin === null) {
      st.origin = this.pos.clone();
      st.originYaw = yawOfMatrix(this.A);
      this.prev.copy(this.pos);
    } else {
      st.jitterM = st.jitterM * 0.9 + this.pos.distanceTo(this.prev) * 0.1;
      st.driftM = this.pos.distanceTo(st.origin);
      let d = yawOfMatrix(this.A) - st.originYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      st.yawCorrDeg = THREE.MathUtils.radToDeg(d);
      this.prev.copy(this.pos);
    }
    // Applied raw, no smoothing: the anchor pose is already ARCore's filtered
    // estimate, and easing toward it makes the model visibly slide.
    _p.setFromMatrixPosition(this.base);
    if (_p.distanceTo(this.pos.setFromMatrixPosition(this.next)) > this.snapM) st.snaps++;
    this.base.copy(this.next);
    st.updates++;
    return { tracked: true };
  }
}
