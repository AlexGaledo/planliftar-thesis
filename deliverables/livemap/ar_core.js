// ar_core.js - world-locked placement core for the WebXR AR client.
//
// Framework-free ES module. ar.html imports it through its importmap; the
// React app can import it unchanged as long as "three" resolves to the same
// three.js build. Nothing here touches the DOM, the WebSocket or the UI - it
// only answers three questions every frame:
//
//   1. Is the device really tracking position?          -> TrackingMonitor
//   2. Is the surface under the reticle good enough
//      to anchor to yet?                                -> SurfaceGate
//   3. Where, in the reference space, is the placed
//      model's origin THIS frame?                       -> AnchoredPlacement
//
// See docs/research/AR_ANCHORING.md for why each piece exists.
//
// ---- THE ALGORITHM (what AnchoredPlacement does) ----
//   At placement (inside the XR frame, with a live plane hit H0):
//     B0  = translation(hitPos)                  model "base": gravity-aligned,
//                                                no rotation of its own
//     rel = inverse(H0) * B0                     model base expressed in the
//                                                anchor's own frame
//     anchor = hit.createAnchor()                (falls back to
//                                                frame.createAnchor, then to
//                                                no anchor at all = "fixed")
//   Every frame after the anchor resolves:
//     A    = frame.getPose(anchor.anchorSpace, refSpace)
//     base = yawOnly(A * rel)                    full pose re-read from the
//                                                anchor, position AND yaw;
//                                                tilt discarded so the floor
//                                                stays level
//   Model matrix = base * T(0, groundOffsetY, 0) * Ry(-userYaw) * S(1/denom)
//
//   The previous ar.html copied only the anchor POSITION and threw away its
//   rotation. When ARCore corrects its world frame it corrects yaw as well,
//   so a model several metres across stayed put at the tap point but swung
//   at its far walls - which reads as "the model moves when I walk".

import * as THREE from "three";

// ---------------------------------------------------------------------
// Session setup
// ---------------------------------------------------------------------

// "anchors" stays optional: Chrome Android has it (M85+), but a session
// without it should still run in "fixed" mode rather than refuse to start.
export function sessionInit(overlayRoot) {
  const init = {
    requiredFeatures: ["hit-test"],
    optionalFeatures: ["anchors", "local-floor", "plane-detection"],
  };
  if (overlayRoot) {
    init.optionalFeatures.push("dom-overlay");
    init.domOverlay = { root: overlayRoot };
  }
  return init;
}

// Two hit-test sources from the screen centre:
//   placement - planes only. Only these results may be anchored to: an anchor
//               created from a plane hit is attached to that plane trackable,
//               which ARCore keeps refining. A feature-point anchor is not.
//   preview   - planes + feature points. Lands far sooner on plain floors, so
//               the reticle can show "almost" before a plane exists. Never
//               used to place. Null when the runtime rejects entityTypes.
export async function requestHitTestSources(session) {
  const space = await session.requestReferenceSpace("viewer");
  let placement;
  try {
    placement = await session.requestHitTestSource({ space, entityTypes: ["plane"] });
  } catch (e) {
    placement = await session.requestHitTestSource({ space });
  }
  let preview = null;
  try {
    preview = await session.requestHitTestSource({ space, entityTypes: ["plane", "point"] });
  } catch (e) {
    preview = null;
  }
  return { placement, preview };
}

// ---------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _x = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

// Keep translation and heading, drop pitch/roll. The reference space's +Y is
// gravity-up on ARCore, so a floor model must stay level in it; a plane
// anchor's normal wobbling by half a degree would otherwise lift the far wall
// of a 10 m building by ~9 cm.
export function yawOnly(m, out) {
  m.decompose(_p, _q, _s);
  _x.set(1, 0, 0).applyQuaternion(_q);
  // Ry(t) maps +X to (cos t, 0, -sin t)
  const yaw = Math.atan2(-_x.z, _x.x);
  _q.setFromAxisAngle(_yAxis, yaw);
  _s.set(1, 1, 1);
  return out.compose(_p, _q, _s);
}

export function yawOfMatrix(m) {
  m.decompose(_p, _q, _s);
  _x.set(1, 0, 0).applyQuaternion(_q);
  return Math.atan2(-_x.z, _x.x);
}

const _off = new THREE.Matrix4();
const _rot = new THREE.Matrix4();
const _scl = new THREE.Matrix4();
// Model matrix = base * T(0, groundOffsetY, 0) * Ry(-yawDeg) * S(scale).
// The yaw sign matches the old `group.rotation.y = -modelYawDeg` so
// rotation_deg keeps meaning "clockwise seen from above".
export function composeModelMatrix(base, groundOffsetY, yawDeg, scale, out) {
  _off.makeTranslation(0, groundOffsetY, 0);
  _rot.makeRotationY(THREE.MathUtils.degToRad(-yawDeg));
  _scl.makeScale(scale, scale, scale);
  return out.copy(base).multiply(_off).multiply(_rot).multiply(_scl);
}

// ---------------------------------------------------------------------
// TrackingMonitor - is position really being tracked?
// ---------------------------------------------------------------------
// States:
//   ok            6-DoF tracking
//   lost          no viewer pose this frame
//   emulated      runtime says position is emulated (rotation-only / 3-DoF)
//   rotation-only heuristic: the phone turned a lot but the reported camera
//                 position did not move. A handheld phone rotating 60 deg
//                 always translates several cm (it sits 30-40 cm from the
//                 wrist/elbow/body axis), so ~0 cm means the runtime is not
//                 seeing translation even though it has not flagged it.
// Anything but "ok" means world-locked content WILL appear to follow the
// camera, and no anchor can fix that - so callers must not place, and should
// hide a placed model, instead of showing it in the wrong place.
export class TrackingMonitor {
  constructor({ windowMs = 2000, rotDeg = 60, maxTravelM = 0.02 } = {}) {
    this.windowMs = windowMs;
    this.rotRad = THREE.MathUtils.degToRad(rotDeg);
    this.maxTravelM = maxTravelM;
    this.reset();
  }

  reset() {
    this.state = "lost";
    this.suspect3dof = false;
    this._prevPos = null;
    this._prevQuat = null;
    this._winStart = 0;
    this._winRot = 0;
    this._winTravel = 0;
  }

  update(viewerPose, timestamp) {
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
    if (this._prevPos) {
      this._winTravel += pos.distanceTo(this._prevPos);
      this._winRot += this._prevQuat.angleTo(quat);
    } else {
      this._winStart = timestamp;
    }
    this._prevPos = pos;
    this._prevQuat = quat;

    if (this._winTravel > this.maxTravelM * 2.5) this.suspect3dof = false;
    if (timestamp - this._winStart >= this.windowMs) {
      if (this._winRot >= this.rotRad && this._winTravel < this.maxTravelM) this.suspect3dof = true;
      this._winStart = timestamp;
      this._winRot = 0;
      this._winTravel = 0;
    }
    this.state = this.suspect3dof ? "rotation-only" : "ok";
    return this.state;
  }
}

// ---------------------------------------------------------------------
// SurfaceGate - is it safe to place yet?
// ---------------------------------------------------------------------
// Levels:
//   searching  no hit at all
//   weak       something was hit but an anchor made now would be poor:
//                points  - only feature points, no plane yet
//                settling- plane hit, but its position is still jumping
//                parallax- camera has not moved enough since the session
//                          started for ARCore's map to be well-conditioned;
//                          anchors made in the first seconds of a session
//                          are the ones that drift most
//   good       plane hit, stable for N frames, enough camera travel
//   blocked    tracking is not "ok" (see TrackingMonitor)
export class SurfaceGate {
  constructor({ stableFrames = 12, stableM = 0.03, minTravelM = 0.3 } = {}) {
    this.stableFrames = stableFrames;
    this.stableM = stableM;
    this.minTravelM = minTravelM;
    this.travelM = 0;
    this.reset();
  }

  // Keeps travelM: camera travel is a property of the session's map, not of
  // a particular placement attempt.
  reset() {
    this.level = "searching";
    this.reason = "";
    this.stable = 0;
    this._lastHit = null;
    this._lastCam = null;
  }

  resetSession() {
    this.travelM = 0;
    this.reset();
  }

  // planeHitPos / previewHitPos: THREE.Vector3 or null. camPos: Vector3|null.
  update({ trackingState, planeHitPos, previewHitPos, camPos }) {
    if (camPos && trackingState === "ok") {
      if (this._lastCam) {
        const step = camPos.distanceTo(this._lastCam);
        if (step < 0.5) this.travelM += step;     // ignore relocalisation jumps
      }
      this._lastCam = (this._lastCam || new THREE.Vector3()).copy(camPos);
    }

    if (trackingState !== "ok") {
      this.stable = 0;
      return this._set("blocked", trackingState);
    }
    if (!planeHitPos) {
      this.stable = 0;
      this._lastHit = null;
      return previewHitPos ? this._set("weak", "points") : this._set("searching", "");
    }
    if (this._lastHit && planeHitPos.distanceTo(this._lastHit) < this.stableM) this.stable++;
    else this.stable = 0;
    this._lastHit = (this._lastHit || new THREE.Vector3()).copy(planeHitPos);

    if (this.stable < this.stableFrames) return this._set("weak", "settling");
    if (this.travelM < this.minTravelM) return this._set("weak", "parallax");
    return this._set("good", "");
  }

  _set(level, reason) {
    this.level = level;
    this.reason = reason;
    return level;
  }
}

// ---------------------------------------------------------------------
// AnchoredPlacement - where is the model this frame?
// ---------------------------------------------------------------------
// mode:
//   none     nothing placed
//   pending  placed, anchor requested, not resolved yet (base is fixed)
//   anchor   following an XRAnchor every frame
//   fixed    anchors unsupported or refused: world-locked fixed matrix.
//            Correct in a perfect world; drifts with ARCore's world-frame
//            corrections in this one. Callers should say so.
export class AnchoredPlacement {
  constructor({ snapM = 0.25 } = {}) {
    this.snapM = snapM;
    this.base = new THREE.Matrix4();
    this.rel = new THREE.Matrix4();
    this.anchor = null;
    this.mode = "none";
    this._gen = 0;
    this._candidate = null;     // { anchor, rel } waiting for the next frame
    this._A = new THREE.Matrix4();
    this._next = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._prev = new THREE.Vector3();
    this.stats = this._freshStats();
  }

  _freshStats() {
    return { updates: 0, untracked: 0, driftM: 0, jitterM: 0, snaps: 0,
             yawCorrDeg: 0, reanchors: 0, origin: null, originYaw: 0 };
  }

  reset() {
    this._gen++;
    this._deleteAnchor(this.anchor);
    if (this._candidate) this._deleteAnchor(this._candidate.anchor);
    this.anchor = null;
    this._candidate = null;
    this.mode = "none";
    this.stats = this._freshStats();
  }

  // Call INSIDE the XR frame callback, with the plane hit that the user
  // accepted. hitMatrix is that hit's pose in refSpace (THREE.Matrix4);
  // basePos is where the model origin goes (normally the hit position).
  // Returns immediately; the anchor resolves asynchronously.
  place(hit, hitMatrix, basePos, frame, refSpace) {
    this.reset();
    this.base.makeTranslation(basePos.x, basePos.y, basePos.z);
    this.mode = "pending";
    this._requestAnchor(hit, hitMatrix, frame, refSpace, /*initial*/ true);
  }

  // Re-anchor without moving the model: a new anchor at a fresh plane hit
  // (normally near the user), with the model's CURRENT base expressed
  // relative to it. ARCore's guidance is to keep content within ~8 m of its
  // anchor; at 1:1 a building can exceed that, and the anchor nearest the
  // user is the one whose corrections matter for what they are looking at.
  reanchor(hit, hitMatrix, frame, refSpace) {
    if (this.mode === "none") return false;
    this._requestAnchor(hit, hitMatrix, frame, refSpace, false);
    return true;
  }

  _requestAnchor(hit, hitMatrix, frame, refSpace, initial) {
    const gen = this._gen;
    const rel = new THREE.Matrix4().copy(hitMatrix).invert().multiply(this.base);
    let promise = null;
    try {
      if (hit && typeof hit.createAnchor === "function") {
        promise = hit.createAnchor();                    // plane-attached
      } else if (frame && typeof frame.createAnchor === "function" &&
                 typeof XRRigidTransform !== "undefined") {
        hitMatrix.decompose(_p, _q, _s);
        promise = frame.createAnchor(                    // free-space anchor
          new XRRigidTransform({ x: _p.x, y: _p.y, z: _p.z },
                               { x: _q.x, y: _q.y, z: _q.z, w: _q.w }),
          refSpace);
      }
    } catch (e) {
      promise = null;
    }
    if (!promise) {
      if (initial) this.mode = "fixed";
      return;
    }
    promise.then(
      (anchor) => {
        if (gen !== this._gen) { this._deleteAnchor(anchor); return; }
        if (this._candidate) this._deleteAnchor(this._candidate.anchor);
        this._candidate = { anchor, rel };
      },
      () => {
        if (gen !== this._gen) return;
        if (initial && this.mode === "pending") this.mode = "fixed";
      }
    );
  }

  _deleteAnchor(a) {
    try { if (a && typeof a.delete === "function") a.delete(); } catch (e) { /* already gone */ }
  }

  // Call every frame (inside the XR frame callback), BEFORE reading `base`.
  // Returns { tracked } - false only while an anchor exists but the runtime
  // is not tracking it this frame; base then holds its last good value.
  update(frame, refSpace) {
    if (this._candidate) {
      // Adopt a newly resolved anchor here, inside a frame, so the swap and
      // the first pose read happen together. The old anchor is released:
      // ARCore keeps a trackable alive for as long as anchors hang off it.
      const { anchor, rel } = this._candidate;
      this._candidate = null;
      if (this.anchor && this.anchor !== anchor) {
        this._deleteAnchor(this.anchor);
        this.stats.reanchors++;
      }
      this.anchor = anchor;
      this.rel.copy(rel);
      this.mode = "anchor";
      this.stats.origin = null;
    }

    if (this.mode !== "anchor") return { tracked: this.mode !== "none" };

    const tracked = frame.trackedAnchors;
    if (tracked && !tracked.has(this.anchor)) {
      this.stats.untracked++;
      return { tracked: false };
    }
    let pose = null;
    try { pose = frame.getPose(this.anchor.anchorSpace, refSpace); } catch (e) { pose = null; }
    if (!pose) {
      this.stats.untracked++;
      return { tracked: false };
    }

    this._A.fromArray(pose.transform.matrix);
    yawOnly(this._next.multiplyMatrices(this._A, this.rel), this._next);

    const p = pose.transform.position;
    this._pos.set(p.x, p.y, p.z);
    const st = this.stats;
    if (st.origin === null) {
      st.origin = this._pos.clone();
      st.originYaw = yawOfMatrix(this._A);
      this._prev.copy(this._pos);
    } else {
      st.jitterM = st.jitterM * 0.9 + this._pos.distanceTo(this._prev) * 0.1;
      st.driftM = this._pos.distanceTo(st.origin);
      let d = yawOfMatrix(this._A) - st.originYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      st.yawCorrDeg = THREE.MathUtils.radToDeg(d);
      this._prev.copy(this._pos);
    }
    // Applied raw, no smoothing: the anchor pose is already ARCore's filtered
    // estimate, and easing toward it makes the model visibly slide across the
    // real floor - motion that does not exist in the world.
    _p.setFromMatrixPosition(this.base);
    if (_p.distanceTo(this._pos.setFromMatrixPosition(this._next)) > this.snapM) st.snaps++;
    this.base.copy(this._next);
    st.updates++;
    return { tracked: true };
  }
}
