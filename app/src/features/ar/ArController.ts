/**
 * The AR session, as a plain (non-React) class. Faithful port of the module
 * script in deliverables/livemap/ar.html: same frame loop, same gates, same
 * constants. The tested pieces (TrackingMonitor, SurfaceGate,
 * AnchoredPlacement, composeModelMatrix) come from arCore.ts unchanged.
 *
 * Why a class and not React state: the XR frame loop runs 60-90 times a second
 * outside React. Keeping three.js objects and per-frame state here, and handing
 * React a small `ArUiState` snapshot only when something visible changes, keeps
 * the overlay responsive and the frame loop allocation-free.
 *
 * This file is longer than our usual 150-line guideline on purpose: splitting
 * the frame loop across files would make it much harder to compare line-by-line
 * with ar.html, which is the reference implementation.
 *
 * Flow: ready -> (Start AR) aiming -> (surface "good", tap Place) placed.
 * While placed, the phone streams {x, y, yaw_deg} in plan px to the hub at
 * 10 Hz and obeys {"type":"control"} patches from the live map.
 */
import * as THREE from "three";
import { HubClient, type HubStatus } from "@/lib/hub/HubClient";
import type { ControlPatch, PhoneState, XrStatus } from "@/lib/hub/protocol";
import { boundsCenter, computeBounds, localToPlan, type Plan, type PlanBounds, type PlanPoint } from "@/lib/plan";
import { buildFloorplanGroup, disposeGroup } from "@/lib/three/buildFloorplanGroup";
import { applyWallOpacity } from "@/lib/three/materials";
import {
  AnchoredPlacement,
  SurfaceGate,
  TrackingMonitor,
  composeModelMatrix,
  requestHitTestSources,
  sessionInit,
  type FrameLike,
  type HitLike,
  type TrackingState,
} from "./arCore";
import { gateHint, trackingHint } from "./hints";

// ---- constants (identical to ar.html) ----
export const DENOM_MIN = 1;
export const DENOM_MAX = 200;
const SURFACE_FILL = 0.8;
const HEIGHT_MIN = 0.1;
const HEIGHT_MAX = 10;
const OPACITY_MIN = 0.05;
const OPACITY_MAX = 1;
const REAL_LONGEST_MIN = 0.5;
const REAL_LONGEST_MAX = 500;
const SEND_INTERVAL_MS = 1000 / 10;
const REANCHOR_TIMEOUT_MS = 4000;
const SURFACE_PROBE_MS = 250;
const HINT_REFRESH_MS = 300;
const DIAG_INTERVAL_MS = 500;
const FALLBACK_DROP_M = 1.4;
const FALLBACK_MIN_M = 0.25;
const FALLBACK_MAX_M = 2.5;
const FALLBACK_DEFAULT_M = 0.7;
const RETICLE_TRACKED = 0x39f0c0;
const RETICLE_ESTIMATED = 0xffb020;
const FAKE_RADIUS_PX = 250;
const FAKE_STEP = 0.06;
export const AR_BUILD = "2026-11-20-anchor-yaw";
export const TABLETOP_DEFAULT_DENOM = 50;

export type ArStage = "loading" | "ready" | "aiming" | "placed" | "fake" | "unsupported";

/** Everything the React overlay needs to draw. */
export interface ArUiState {
  stage: ArStage;
  hint: string;
  canStart: boolean;
  canPlace: boolean;
  canDropToFloor: boolean;
  hub: HubStatus;
  phone: PhoneState;
  /** set when the browser cannot run WebXR AR (shows the fallback) */
  unsupportedReason: string | null;
  errors: string[];
  debug: string;
  fakePose: string | null;
}

export interface ArControllerOptions {
  plan: Plan;
  ppm: number;
  wallHeightM: number;
  hubUrl: string;
  fake: boolean;
  /**
   * Encoded {"type":"plan"} message (protocol.ts encodeSharedPlan), sent on
   * every hub (re)connect so the laptop's map can draw this plan without
   * having it in its own library. null = too big to share.
   */
  sharedPlanMessage?: string | null;
  onUi: (ui: ArUiState) => void;
  /** the user changed the building length on the phone: persist the new ppm */
  onPpmChange?: (ppm: number) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const wrapDeg = (d: number) => ((d % 360) + 360) % 360;

export class ArController {
  // ---- user-adjustable model state (what PhoneState reports) ----
  private ppm: number;
  private modelDenom = TABLETOP_DEFAULT_DENOM;
  private autoFit = true;
  private wallHeightM: number;
  private wallOpacity = 1;
  private modelYawDeg = 0;
  private xrStatus: XrStatus = "idle";

  // ---- plan ----
  private readonly plan: Plan;
  private readonly bounds: PlanBounds;
  private readonly center: PlanPoint;

  // ---- three.js ----
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.01, 50);
  private reticle: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | null = null;
  private placementGroup: THREE.Group | null = null;
  private wallMaterial: THREE.Material | null = null;

  // ---- XR session ----
  private session: XRSession | null = null;
  private spaceType: XRReferenceSpaceType = "local";
  private hitTestSource: XRHitTestSource | null = null;
  private previewHitTestSource: XRHitTestSource | null = null;
  private anchorsGranted: boolean | null = null;
  private readonly placement = new AnchoredPlacement({ snapM: 0.25 });
  private readonly tracking = new TrackingMonitor();
  private readonly gate = new SurfaceGate({ stableFrames: 12, stableM: 0.03, minTravelM: 0.3 });

  // ---- per-frame state ----
  private placed = false;
  private pendingPlace = false;
  private pendingReanchor = false;
  private reanchorRequestedAt = 0;
  private lastTracking: TrackingState = "lost";
  private trackingLost = false;
  private floorY: number | null = null;
  private lastTrackedHitY: number | null = null;
  private groundOffsetY = 0;
  private surfaceExtentAtReticle: number | null = null;
  private reticleEstimated = false;
  private lastSurfaceProbeAt = 0;
  private lastHintAt = 0;
  private lastDiagAt = 0;
  private lastSendAt = 0;
  private selectCount = 0;
  private readonly camStats = { origin: null as THREE.Vector3 | null, travelM: 0, maxM: 0 };

  // ---- UI snapshot ----
  private hint = "Checking whether this phone can run AR…";
  private stage: ArStage = "loading";
  private canStart = false;
  private unsupportedReason: string | null = null;
  private errors: string[] = [];
  private debug = "";
  private fakePose: string | null = null;
  private hubStatus: HubStatus = "connecting";
  private fakeTimer: ReturnType<typeof setInterval> | null = null;

  private readonly hub: HubClient;

  // scratch objects, reused every frame (no per-frame allocation)
  private readonly _modelMatrix = new THREE.Matrix4();
  private readonly _hitMatrix = new THREE.Matrix4();
  private readonly _planeHitPos = new THREE.Vector3();
  private readonly _previewHitPos = new THREE.Vector3();
  private readonly _viewerPos = new THREE.Vector3();
  private readonly _reticlePos = new THREE.Vector3();
  private readonly _estPos = new THREE.Vector3();
  private readonly _estDir = new THREE.Vector3();
  private readonly _estQuat = new THREE.Quaternion();
  private readonly _camTrack = new THREE.Vector3();
  private readonly _camPos = new THREE.Vector3();
  private readonly _camQuat = new THREE.Quaternion();
  private readonly _forward = new THREE.Vector3();
  private readonly _groupQuatInv = new THREE.Quaternion();

  constructor(private readonly opts: ArControllerOptions) {
    this.plan = opts.plan;
    this.ppm = opts.ppm;
    this.wallHeightM = opts.wallHeightM;
    this.bounds = computeBounds(opts.plan);
    this.center = boundsCenter(this.bounds);
    this.hub = new HubClient({
      url: opts.hubUrl,
      role: "phone",
      onStatus: (s) => {
        this.hubStatus = s;
        this.emit();
      },
      onOpen: () => {
        // The plan first, so a viewer has its coordinate space before poses arrive.
        if (opts.sharedPlanMessage) this.hub.sendText(opts.sharedPlanMessage);
        this.sendState(); // so a panel already open picks us up
      },
      onMessage: (msg) => {
        if (msg.kind === "control") this.applyControlPatch(msg.patch);
        else if (msg.kind === "hello") this.sendState();
      },
    });
  }

  // =================================================================
  // Lifecycle
  // =================================================================

  /** Set up three.js in `container`, check WebXR support, connect the hub. */
  async init(container: HTMLElement): Promise<void> {
    this.hub.connect();
    if (this.opts.fake) {
      this.startFakeMode();
      return;
    }
    try {
      this.initThree(container);
    } catch (e) {
      this.fail(`3D could not start on this device: ${(e as Error).message}`);
      return;
    }
    await this.checkXrSupport();
  }

  dispose(): void {
    if (this.fakeTimer) clearInterval(this.fakeTimer);
    this.session?.end().catch(() => undefined);
    this.hub.close();
    this.renderer?.setAnimationLoop(null);
    disposeGroup(this.placementGroup);
    this.reticle?.geometry.dispose();
    this.reticle?.material.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    window.removeEventListener("resize", this.onResize);
  }

  private initThree(container: HTMLElement): void {
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0); // transparent: camera passthrough shows through
    renderer.xr.enabled = true;
    // 0.8 of native resolution: the single biggest frame-rate win on mid-range phones.
    renderer.xr.setFramebufferScaleFactor(0.8);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x707070, 2.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(1.0, 2.0, 0.6);
    this.scene.add(sun);

    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: RETICLE_TRACKED }));
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    this.scene.add(reticle);
    this.reticle = reticle;
    window.addEventListener("resize", this.onResize);
  }

  private onResize = () => {
    if (!this.renderer) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private async checkXrSupport(): Promise<void> {
    const insecure = !window.isSecureContext;
    if (insecure) {
      this.setUnsupported("AR needs a secure (https) address. Open the app over https, or from localhost.");
      return;
    }
    if (!navigator.xr) {
      this.setUnsupported("This browser cannot run AR in the page. Chrome on an ARCore Android phone can.");
      return;
    }
    try {
      const ok = await navigator.xr.isSessionSupported("immersive-ar");
      if (!ok) {
        this.setUnsupported("This device does not support AR in the browser.");
        return;
      }
    } catch (e) {
      this.setUnsupported(`The AR support check failed: ${(e as Error).message}`);
      return;
    }
    this.stage = "ready";
    this.canStart = true;
    this.hint = "Ready. Tap Start AR.";
    this.emit();
  }

  private setUnsupported(reason: string): void {
    this.xrStatus = "unsupported";
    this.stage = "unsupported";
    this.unsupportedReason = reason;
    this.hint = reason;
    this.emit();
    this.sendState();
  }

  /** Must be called from a user gesture (button tap). */
  async start(overlayRoot: Element | null): Promise<void> {
    if (!navigator.xr || !this.renderer || this.session) return;
    const renderer = this.renderer;
    this.canStart = false;
    this.emit();
    try {
      const session = await navigator.xr.requestSession("immersive-ar", sessionInit(overlayRoot));
      this.session = session;
      session.addEventListener("end", this.onSessionEnd);
      const granted = (session as XRSession & { enabledFeatures?: string[] }).enabledFeatures;
      this.anchorsGranted = granted ? granted.includes("anchors") : null;
      // local-floor gives y = 0 at the floor (used by "drop to floor"); fall back to local.
      this.spaceType = granted?.includes("local-floor") ? "local-floor" : "local";
      renderer.xr.setReferenceSpaceType(this.spaceType);
      try {
        await renderer.xr.setSession(session);
      } catch (e) {
        if (this.spaceType !== "local-floor") throw e;
        this.spaceType = "local";
        renderer.xr.setReferenceSpaceType("local");
        await renderer.xr.setSession(session);
      }
      this.floorY = this.spaceType === "local-floor" ? 0 : null;
      this.tracking.reset();
      this.gate.resetSession();
      this.stage = "aiming";
      this.xrStatus = "active";
      this.hint = gateHint(this.gate);
      this.sendState();
      const sources = await requestHitTestSources(session);
      this.hitTestSource = sources.placement;
      this.previewHitTestSource = sources.preview;
      session.addEventListener("select", this.onSelect);
      renderer.setAnimationLoop(this.onXrFrame);
      this.emit();
    } catch (e) {
      this.canStart = true;
      this.error(`AR could not start: ${(e as Error).message}`);
    }
  }

  end(): void {
    void this.session?.end();
  }

  private onSessionEnd = () => {
    this.hitTestSource?.cancel();
    this.previewHitTestSource?.cancel();
    this.hitTestSource = null;
    this.previewHitTestSource = null;
    this.session = null;
    this.renderer?.setAnimationLoop(null);
    this.xrStatus = "idle";
    this.floorY = null;
    this.lastTrackedHitY = null;
    this.resetPlacement();
    this.stage = "ready";
    this.canStart = true;
    this.hint = "AR stopped. Tap Start AR to begin again.";
    this.emit();
  };

  private onSelect = () => {
    this.selectCount++;
    this.tryPlace();
  };

  // =================================================================
  // User actions
  // =================================================================

  tryPlace(): void {
    if (this.placed) return;
    if (this.lastTracking !== "ok") {
      this.hint = trackingHint(this.lastTracking);
    } else if (this.gate.level !== "good") {
      this.hint = gateHint(this.gate);
    } else {
      // Placed on the NEXT frame, where a fresh hit result and XRFrame exist.
      this.pendingPlace = true;
    }
    this.emit();
  }

  dropToFloor(): void {
    if (!this.placed || !this.placementGroup) return;
    const targetY = this.lastTrackedHitY ?? this.floorY;
    if (targetY === null) {
      this.hint = "No floor detected yet. Point the camera at the floor for a moment, then try again.";
    } else {
      const delta = targetY - this.placementGroup.position.y;
      this.groundOffsetY += delta;
      this.applyPlacementPose();
      const src = this.lastTrackedHitY !== null ? "a detected surface" : "the session floor";
      this.hint = `Moved ${Math.abs(delta * 100).toFixed(0)} cm ${delta < 0 ? "down" : "up"} onto ${src}.`;
    }
    this.emit();
  }

  requestReanchor(): void {
    if (!this.placed) return;
    if (this.anchorsGranted === false) {
      this.hint = "This phone cannot anchor. Use Start over to place it again.";
    } else {
      this.pendingReanchor = true;
      this.reanchorRequestedAt = performance.now();
      this.hint = "Point at the floor near you…";
    }
    this.emit();
  }

  resetPlacement(): void {
    this.placed = false;
    this.pendingPlace = false;
    this.pendingReanchor = false;
    this.placement.reset();
    this.gate.reset();
    this.camStats.origin = null;
    this.camStats.travelM = 0;
    this.camStats.maxM = 0;
    this.groundOffsetY = 0;
    this.trackingLost = false;
    if (this.placementGroup) {
      this.scene.remove(this.placementGroup);
      disposeGroup(this.placementGroup);
      this.placementGroup = null;
    }
    if (this.reticle) this.reticle.visible = false;
    if (this.session) {
      this.stage = "aiming";
      this.hint = gateHint(this.gate);
    }
    this.sendState();
    this.emit();
  }

  /** "Tabletop": fit to the surface again (or 1:50 before placing). */
  setTabletop(): void {
    this.autoFit = true;
    const fitted = this.placed ? this.denomToFitSurface() : null;
    this.modelDenom = fitted ?? TABLETOP_DEFAULT_DENOM;
    this.afterChange();
  }

  /** "Life-size" (ar.html's Walk through): 1:1, no fit, solid walls. */
  setLifeSize(): void {
    this.autoFit = false;
    this.modelDenom = 1;
    this.wallOpacity = 1;
    if (this.wallMaterial) applyWallOpacity(this.wallMaterial, 1);
    this.afterChange();
  }

  nudgeYaw(deltaDeg: number): void {
    this.modelYawDeg = wrapDeg(this.modelYawDeg + deltaDeg);
    this.afterChange();
  }

  setYaw(deg: number): void {
    this.modelYawDeg = wrapDeg(deg);
    this.afterChange();
  }

  /** Dragging the scale slider is a manual choice, so it turns auto-fit off. */
  setDenom(denom: number): void {
    this.modelDenom = clamp(denom, DENOM_MIN, DENOM_MAX);
    this.autoFit = false;
    this.afterChange();
  }

  setAutoFit(on: boolean): void {
    this.autoFit = on;
    this.sendState();
    this.emit();
  }

  /** Building length in metres -> new ppm, rebuild the model at the new size. */
  setRealLongest(meters: number): void {
    const longestPx = Math.max(this.bounds.widthPx, this.bounds.heightPx);
    if (!Number.isFinite(meters) || meters <= 0 || longestPx <= 0) return;
    this.ppm = longestPx / clamp(meters, REAL_LONGEST_MIN, REAL_LONGEST_MAX);
    this.opts.onPpmChange?.(this.ppm);
    this.rebuildPlacedGeometry();
    this.afterChange();
  }

  private afterChange(): void {
    this.applyPlacementPose();
    this.sendState();
    this.emit();
  }

  // =================================================================
  // Hub: state and control
  // =================================================================

  private realFootprintM() {
    return { w: this.bounds.widthPx / this.ppm, d: this.bounds.heightPx / this.ppm };
  }

  currentState(): PhoneState {
    const { w, d } = this.realFootprintM();
    return {
      real_longest_m: Math.max(w, d),
      model_denom: this.modelDenom,
      auto_fit: this.autoFit,
      wall_height_m: this.wallHeightM,
      wall_opacity: this.wallOpacity,
      rotation_deg: this.modelYawDeg,
      placed: this.placed,
      plan_w_m: w,
      plan_d_m: d,
      model_w_cm: (w / this.modelDenom) * 100,
      model_d_cm: (d / this.modelDenom) * 100,
      xr: this.xrStatus,
    };
  }

  private sendState(): void {
    this.hub.sendState(this.currentState());
  }

  /** A viewer's patch. Every value is clamped; the reply is our full state. */
  applyControlPatch(patch: ControlPatch): void {
    let rebuild = false;
    const longest = asNum(patch.real_longest_m);
    if (longest !== null) {
      const longestPx = Math.max(this.bounds.widthPx, this.bounds.heightPx);
      if (longestPx > 0) {
        this.ppm = longestPx / clamp(longest, REAL_LONGEST_MIN, REAL_LONGEST_MAX);
        this.opts.onPpmChange?.(this.ppm);
        rebuild = true;
      }
    }
    const denom = asNum(patch.model_denom);
    if (denom !== null) this.modelDenom = clamp(denom, DENOM_MIN, DENOM_MAX);
    if (typeof patch.auto_fit === "boolean") this.autoFit = patch.auto_fit;
    const height = asNum(patch.wall_height_m);
    if (height !== null) {
      this.wallHeightM = clamp(height, HEIGHT_MIN, HEIGHT_MAX);
      rebuild = true;
    }
    const opacity = asNum(patch.wall_opacity);
    if (opacity !== null) {
      this.wallOpacity = clamp(opacity, OPACITY_MIN, OPACITY_MAX);
      if (this.wallMaterial) applyWallOpacity(this.wallMaterial, this.wallOpacity);
    }
    const yaw = asNum(patch.rotation_deg);
    if (yaw !== null) this.modelYawDeg = wrapDeg(yaw);
    if (patch.reset_placement === true) this.resetPlacement();
    if (rebuild) this.rebuildPlacedGeometry();
    this.afterChange();
  }

  // =================================================================
  // Model
  // =================================================================

  private buildGroup(): THREE.Group {
    const model = buildFloorplanGroup(this.plan, { ppm: this.ppm, wallHeightM: this.wallHeightM, wallOpacity: this.wallOpacity });
    this.wallMaterial = model.wallMaterial;
    return model.group;
  }

  private rebuildPlacedGeometry(): void {
    if (!this.placed || !this.placementGroup) return;
    this.scene.remove(this.placementGroup);
    disposeGroup(this.placementGroup);
    this.placementGroup = this.buildGroup();
    this.scene.add(this.placementGroup);
    this.applyPlacementPose(); // the anchored base is unchanged
  }

  private applyPlacementPose(): void {
    if (!this.placementGroup || this.placement.mode === "none") return;
    composeModelMatrix(this.placement.base, this.groundOffsetY, this.modelYawDeg, 1 / this.modelDenom, this._modelMatrix);
    this._modelMatrix.decompose(this.placementGroup.position, this.placementGroup.quaternion, this.placementGroup.scale);
    this.placementGroup.updateMatrixWorld(true);
  }

  /** The 1:N that makes the building fill SURFACE_FILL of the table under the reticle. */
  private denomToFitSurface(): number | null {
    const extent = this.surfaceExtentAtReticle;
    if (!extent) return null;
    const { w, d } = this.realFootprintM();
    const longest = Math.max(w, d);
    if (longest <= 0) return null;
    return clamp(longest / (SURFACE_FILL * extent), DENOM_MIN, DENOM_MAX);
  }

  /** Shorter side (m) of the smallest horizontal detected plane containing worldPos. */
  private surfaceExtentAt(worldPos: THREE.Vector3, frame: XRFrame, refSpace: XRReferenceSpace): number | null {
    const planes = frame.detectedPlanes;
    if (!planes) return null;
    let best: number | null = null;
    const inv = new THREE.Matrix4();
    const local = new THREE.Vector3();
    planes.forEach((plane) => {
      if (plane.orientation !== "horizontal") return;
      const pose = frame.getPose(plane.planeSpace, refSpace);
      if (!pose) return;
      inv.fromArray(pose.transform.matrix).invert();
      local.copy(worldPos).applyMatrix4(inv);
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const pt of plane.polygon) {
        minX = Math.min(minX, pt.x);
        maxX = Math.max(maxX, pt.x);
        minZ = Math.min(minZ, pt.z);
        maxZ = Math.max(maxZ, pt.z);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minZ)) return;
      if (local.x < minX || local.x > maxX || local.z < minZ || local.z > maxZ) return;
      const shorter = Math.min(maxX - minX, maxZ - minZ);
      if (shorter > 0 && (best === null || shorter < best)) best = shorter;
    });
    return best;
  }

  private placeAtReticle(hit: XRHitTestResult, hitPose: XRPose, frame: XRFrame, refSpace: XRReferenceSpace): void {
    this._hitMatrix.fromArray(hitPose.transform.matrix);
    const pos = new THREE.Vector3().setFromMatrixPosition(this._hitMatrix);
    if (this.placementGroup) {
      this.scene.remove(this.placementGroup);
      disposeGroup(this.placementGroup);
    }
    this.placementGroup = this.buildGroup();
    this.groundOffsetY = 0;
    this.placement.place(hit as unknown as HitLike, this._hitMatrix, pos, frame as unknown as FrameLike, refSpace);
    let fitted: number | null = null;
    if (this.autoFit) {
      fitted = this.denomToFitSurface();
      if (fitted !== null) this.modelDenom = fitted;
    }
    this.scene.add(this.placementGroup);
    this.applyPlacementPose();
    if (this.reticle) this.reticle.visible = false;
    this.placed = true;
    this.trackingLost = false;
    this.stage = "placed";
    if (this.placement.mode === "fixed" || this.anchorsGranted === false) {
      this.hint = "Placed, but this phone cannot anchor it. If it slides, tap Start over.";
    } else {
      this.hint = fitted !== null ? "Placed. Walk around it, or adjust below." : "Placed. Adjust the size below if it looks off.";
    }
    this.sendState();
    this.emit();
  }

  // =================================================================
  // The XR frame loop
  // =================================================================

  private onXrFrame = (timestamp: number, frame?: XRFrame) => {
    const renderer = this.renderer!;
    if (!frame) {
      renderer.render(this.scene, this.camera);
      return;
    }
    const refSpace = renderer.xr.getReferenceSpace()!;
    const viewerPose = frame.getViewerPose(refSpace);
    const trackState = this.tracking.update(viewerPose, timestamp);
    this.lastTracking = trackState;
    if (viewerPose) {
      const p = viewerPose.transform.position;
      this._viewerPos.set(p.x, p.y, p.z);
    }

    // Placement hits: planes only (anchorable).
    let planeHit: XRHitTestResult | null = null;
    let planePose: XRPose | null = null;
    if (this.hitTestSource) {
      const results = frame.getHitTestResults(this.hitTestSource);
      if (results.length > 0) {
        planePose = results[0].getPose(refSpace) ?? null;
        if (planePose) planeHit = results[0];
      }
    }
    // Preview hits: planes + feature points, reticle only.
    let previewPose: XRPose | null = null;
    if (this.previewHitTestSource) {
      const results = frame.getHitTestResults(this.previewHitTestSource);
      if (results.length > 0) previewPose = results[0].getPose(refSpace) ?? null;
    }
    if (planePose) this.lastTrackedHitY = planePose.transform.position.y;

    const levelBefore = this.gate.level;
    this.gate.update({
      trackingState: trackState,
      planeHitPos: planePose ? this._planeHitPos.copy(planePose.transform.position as unknown as THREE.Vector3) : null,
      previewHitPos: previewPose ? this._previewHitPos.copy(previewPose.transform.position as unknown as THREE.Vector3) : null,
      camPos: viewerPose ? this._viewerPos : null,
    });
    let changed = levelBefore !== this.gate.level;

    if (!this.placed) changed = this.aimingFrame(timestamp, frame, refSpace, trackState, planeHit, planePose, previewPose) || changed;

    if (this.placed && this.placementGroup) {
      this.placement.update(frame as unknown as FrameLike, refSpace);
      this.applyPlacementPose();
      if (this.pendingReanchor) {
        if (planeHit && planePose && trackState === "ok") {
          this.pendingReanchor = false;
          this._hitMatrix.fromArray(planePose.transform.matrix);
          this.placement.reanchor(planeHit as unknown as HitLike, this._hitMatrix, frame as unknown as FrameLike, refSpace);
          this.hint = "Re-anchored to the floor near you.";
          changed = true;
        } else if (timestamp - this.reanchorRequestedAt > REANCHOR_TIMEOUT_MS) {
          this.pendingReanchor = false;
          this.hint = "No floor found to re-anchor to. Point at the floor near you and try again.";
          changed = true;
        }
      }
    }

    // Lost tracking: hide the model (it would visibly follow the camera) and
    // pause the stream (positions would be wrong).
    const posLost = trackState !== "ok";
    if (this.placed && this.placementGroup && posLost !== this.trackingLost) {
      this.trackingLost = posLost;
      this.placementGroup.visible = !posLost;
      this.hint = posLost ? trackingHint(trackState) : "Tracking back. Walk around it, or adjust below.";
      changed = true;
    }
    if (this.placed && this.placementGroup && !this.trackingLost) {
      this.maybeSendPose(timestamp);
      renderer.xr.getCamera().getWorldPosition(this._camTrack);
      if (this.camStats.origin === null) this.camStats.origin = this._camTrack.clone();
      else {
        this.camStats.travelM = this._camTrack.distanceTo(this.camStats.origin);
        this.camStats.maxM = Math.max(this.camStats.maxM, this.camStats.travelM);
      }
    }

    if (timestamp - this.lastDiagAt > DIAG_INTERVAL_MS) {
      this.lastDiagAt = timestamp;
      this.debug = this.debugLine();
      this.sendDiag(frame, refSpace, viewerPose ?? null);
      changed = true;
    }
    if (changed) this.emit();
    renderer.render(this.scene, this.camera);
  };

  /** Reticle, surface probe and pending placement while not yet placed. Returns true if UI changed. */
  private aimingFrame(
    timestamp: number,
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    trackState: TrackingState,
    planeHit: XRHitTestResult | null,
    planePose: XRPose | null,
    previewPose: XRPose | null,
  ): boolean {
    let changed = false;
    const reticle = this.reticle!;
    const shownPose = trackState === "ok" ? (planePose ?? previewPose) : null;
    if (shownPose) {
      reticle.visible = true;
      reticle.matrix.fromArray(shownPose.transform.matrix);
      const good = this.gate.level === "good";
      this.reticleEstimated = !good;
      reticle.material.color.setHex(good ? RETICLE_TRACKED : RETICLE_ESTIMATED);
    } else {
      this.estimateReticle();
    }

    if (planePose && timestamp - this.lastSurfaceProbeAt > SURFACE_PROBE_MS) {
      this.lastSurfaceProbeAt = timestamp;
      this._reticlePos.setFromMatrixPosition(this._hitMatrix.fromArray(planePose.transform.matrix));
      try {
        this.surfaceExtentAtReticle = this.surfaceExtentAt(this._reticlePos, frame, refSpace);
      } catch {
        this.surfaceExtentAtReticle = null; // plane-detection not granted
      }
    } else if (!planePose) {
      this.surfaceExtentAtReticle = null;
    }

    if (timestamp - this.lastHintAt > HINT_REFRESH_MS) {
      this.lastHintAt = timestamp;
      const next = gateHint(this.gate);
      if (next !== this.hint) {
        this.hint = next;
        changed = true;
      }
    }

    if (this.pendingPlace) {
      this.pendingPlace = false;
      if (planeHit && planePose && this.gate.level === "good") {
        try {
          this.placeAtReticle(planeHit, planePose, frame, refSpace);
        } catch (err) {
          this.error(`Placement failed: ${(err as Error).message}`);
        }
      } else {
        this.hint = gateHint(this.gate);
      }
      changed = true;
    }
    return changed;
  }

  /**
   * No tracked hit: draw an amber ring where the camera ray meets the best
   * floor guess (last real hit, else the session floor, else 1.4 m below).
   */
  private estimateReticle(): void {
    const renderer = this.renderer!;
    const reticle = this.reticle!;
    if (!renderer.xr.isPresenting) return;
    const xrCam = renderer.xr.getCamera();
    xrCam.getWorldPosition(this._estPos);
    this._estDir.set(0, 0, -1).applyQuaternion(xrCam.getWorldQuaternion(this._estQuat));
    const planeY = this.lastTrackedHitY ?? this.floorY ?? this._estPos.y - FALLBACK_DROP_M;
    let t = FALLBACK_DEFAULT_M;
    if (this._estDir.y < -0.05) t = (planeY - this._estPos.y) / this._estDir.y; // ray-plane intersection
    t = clamp(t, FALLBACK_MIN_M, FALLBACK_MAX_M);
    this._estPos.addScaledVector(this._estDir, t);
    this._estPos.y = planeY; // keep it flat, not on the ray
    reticle.matrix.makeTranslation(this._estPos.x, this._estPos.y, this._estPos.z);
    reticle.visible = true;
    this.reticleEstimated = true;
    reticle.material.color.setHex(RETICLE_ESTIMATED);
  }

  /**
   * Camera position -> model-local -> plan px, and heading relative to the
   * model (so turning the model does not turn the dot). Throttled to 10 Hz.
   * yaw: 0 = plan -Y ("up"), clockwise.
   */
  private maybeSendPose(timestamp: number): void {
    if (timestamp - this.lastSendAt < SEND_INTERVAL_MS) return;
    this.lastSendAt = timestamp;
    const group = this.placementGroup!;
    const xrCam = this.renderer!.xr.getCamera();
    xrCam.getWorldPosition(this._camPos);
    xrCam.getWorldQuaternion(this._camQuat);
    const local = group.worldToLocal(this._camPos.clone());
    this._forward.set(0, 0, -1).applyQuaternion(this._camQuat);
    group.getWorldQuaternion(this._groupQuatInv).invert();
    this._forward.applyQuaternion(this._groupQuatInv);
    this._forward.y = 0;
    if (this._forward.lengthSq() < 1e-6) this._forward.set(0, 0, 1);
    this._forward.normalize();
    const yawDeg = THREE.MathUtils.radToDeg(Math.atan2(this._forward.x, this._forward.z));
    const { x, y } = localToPlan(local.x, local.z, this.center, this.ppm);
    this.hub.sendPose({ x, y, yaw_deg: yawDeg });
  }

  private debugLine(): string {
    const st = this.placement.stats;
    const anch =
      this.placement.mode === "anchor"
        ? `yes upd=${st.updates} lost=${st.untracked} drift=${(st.driftM * 100).toFixed(1)}cm yaw=${st.yawCorrDeg.toFixed(2)}deg snap=${st.snaps} re=${st.reanchors}`
        : this.placement.mode;
    const surf = this.surfaceExtentAtReticle ? `${(this.surfaceExtentAtReticle * 100).toFixed(0)}cm` : "none";
    const ret = this.reticle?.visible ? (this.reticleEstimated ? "estimated" : "tracked") : "hidden";
    return (
      `taps ${this.selectCount} | track ${this.lastTracking} | surface ${this.gate.level}${this.gate.reason ? "/" + this.gate.reason : ""} ` +
      `travel ${(this.gate.travelM * 100).toFixed(0)}cm | reticle ${ret} | plane ${surf} | anchor ${anch} | space ${this.spaceType}`
    );
  }

  private sendDiag(frame: XRFrame, refSpace: XRReferenceSpace, viewerPose: XRViewerPose | null): void {
    if (!this.hub.isOpen) return;
    const r3 = (v: { x: number; y: number; z: number } | null | undefined) => (v ? [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)] : null);
    const anchor = this.placement.anchor;
    let anchorPos = null;
    let anchorTracked: boolean | null = null;
    if (anchor) {
      anchorTracked = frame.trackedAnchors ? frame.trackedAnchors.has(anchor as unknown as XRAnchor) : null;
      try {
        anchorPos = r3(frame.getPose(anchor.anchorSpace, refSpace)?.transform.position);
      } catch {
        /* anchor deleted */
      }
    }
    const st = this.placement.stats;
    this.hub.send({
      type: "diag",
      build: AR_BUILD,
      text: this.debug,
      refSpace: this.spaceType,
      granted: (this.session as (XRSession & { enabledFeatures?: string[] }) | null)?.enabledFeatures ?? null,
      emulated: viewerPose ? viewerPose.emulatedPosition : null,
      tracking: this.lastTracking,
      surface: this.gate.level,
      surfaceReason: this.gate.reason,
      sessionTravelM: +this.gate.travelM.toFixed(2),
      cam: viewerPose ? r3(viewerPose.transform.position) : null,
      group: this.placementGroup ? r3(this.placementGroup.position) : null,
      groupVisible: this.placementGroup ? this.placementGroup.visible : null,
      placed: this.placed,
      placementMode: this.placement.mode,
      hasAnchor: !!anchor,
      anchorTracked,
      anchor: anchorPos,
      anchorDriftM: +st.driftM.toFixed(3),
      anchorYawCorrDeg: +st.yawCorrDeg.toFixed(2),
      reanchors: st.reanchors,
      denom: this.modelDenom,
    });
  }

  // =================================================================
  // Test walk (?fake=1): a scripted circle, no camera needed
  // =================================================================

  private startFakeMode(): void {
    this.xrStatus = "fake";
    this.stage = "fake";
    this.hint = "Test walk: sending a scripted circle to the live map.";
    let t = 0;
    let prev: PlanPoint | null = null;
    let yawDeg = 0;
    let sent = 0;
    this.fakeTimer = setInterval(() => {
      t += FAKE_STEP;
      const x = this.center.x + Math.cos(t) * FAKE_RADIUS_PX;
      const y = this.center.y + Math.sin(t) * FAKE_RADIUS_PX;
      if (prev) {
        const dx = x - prev.x;
        const dy = y - prev.y;
        if (dx * dx + dy * dy > 1e-6) yawDeg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      }
      prev = { x, y };
      if (this.hub.sendPose({ x, y, yaw_deg: yawDeg })) sent++;
      this.fakePose = `x ${x.toFixed(0)}, y ${y.toFixed(0)}, heading ${yawDeg.toFixed(0)} degrees (${sent} sent)`;
      this.emit();
    }, SEND_INTERVAL_MS);
    this.emit();
    this.sendState();
  }

  // =================================================================
  // UI plumbing
  // =================================================================

  private error(msg: string): void {
    this.errors = [...this.errors, msg];
    this.emit();
  }

  private fail(msg: string): void {
    this.stage = "unsupported";
    this.unsupportedReason = msg;
    this.error(msg);
  }

  private emit(): void {
    this.opts.onUi({
      stage: this.stage,
      hint: this.hint,
      canStart: this.canStart,
      canPlace: !this.placed && this.gate.level === "good",
      canDropToFloor: this.placed && (this.lastTrackedHitY !== null || this.floorY !== null),
      hub: this.hubStatus,
      phone: this.currentState(),
      unsupportedReason: this.unsupportedReason,
      errors: this.errors,
      debug: this.debug,
      fakePose: this.fakePose,
    });
  }
}
