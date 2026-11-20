# AR occlusion and spatial understanding: what is possible, and what to ship

Date: 2026-11-21. Scope: `app/src/features/ar/ArController.ts`, `app/src/features/ar/arCore.ts` (`sessionInit`), `deliverables/livemap/ar_core.js`, `app/src/lib/three/{materials,buildFloorplanGroup}.ts`, and `ModelViewerFallback.tsx`. Installed three.js: **0.160.1** (`app/package.json`: `"three": "~0.160.1"`). Research only: no app code was changed.

User request: *"spatial recognition, so the 3D model knows about blockings, e.g. I won't see the model if there's a real wall between us, or it's not possible."*

That request covers three separate features. They differ a lot in difficulty:

| # | Feature | In one sentence | Status in PlanLiftAR today |
|---|---|---|---|
| 1 | **Real-world occlusion** | Real walls, people and furniture hide the virtual model where they are in front of it. | Not implemented. The virtual model is always drawn on top of the camera image. |
| 2 | **Spatial awareness** | The app knows where real floors and walls are, so it can warn when the virtual building would pass through a real wall. | Partly there. `plane-detection` is requested but used only to measure the tabletop for auto-fit. |
| 3 | **Virtual-virtual occlusion** | The model's own walls hide the virtual rooms behind them as you walk. | **Already works when walls are solid** (opacity 1). See-through mode turns it off on purpose. |

---

## 1. Plain-language explanations

### 1.1 Real-world occlusion (real things hide virtual things)

A phone AR app draws the camera picture first and the 3D model on top. The renderer has no idea what is real, so the model always "wins", even when a real wall or a person is closer to the phone. The result looks like X-ray vision: you can see a virtual room through the real wall in front of you.

To fix this, the phone needs a **depth map**: a small greyscale image where each pixel holds the distance in metres from the camera to the real surface at that point. With it, each pixel of the virtual model can be checked: *is the real surface here closer than my virtual wall?* If it is, that pixel is not drawn and the camera image shows through. Real walls, doors, furniture and people then hide the model correctly.

On Android, ARCore builds this depth map **without any special sensor**. It compares camera frames taken from slightly different positions as you move the phone ("depth from motion") and refines the result with machine learning. A time-of-flight (ToF) sensor improves it when present, but is not required. Chrome exposes this to web pages through the **WebXR Depth Sensing API** (`depth-sensing` feature).

What it cannot do well: the depth map is low resolution (much coarser than the camera image, so edges are blocky or wobbly), it is only accurate up to about 5 m (it reports values out to ~65 m, but precision drops quickly), it needs the phone to move before it becomes valid, and it is unreliable on plain white walls and in poor light. Thin things such as chair legs and railings are often missed.

### 1.2 Spatial awareness (the app understands the room)

Occlusion is purely visual. It hides pixels, but the app still does not "know" that a real wall is there. Spatial awareness means the app has a geometric model of the room it can reason about. WebXR offers three levels:

- **Hit test** (we use it): "where does this ray hit a real surface?" One point at a time.
- **Plane detection** (we request it): a list of flat surfaces, each a polygon marked *horizontal* or *vertical*. Floors, tables and large walls show up; clutter does not.
- **Mesh detection** (experimental): a triangle mesh of the whole room. It exists in Chrome behind a flag, mainly on Android XR headsets. It is not usable on phones for the thesis.

With vertical planes we can, for example, check whether the virtual building's footprint crosses a real wall and warn "the model passes through a real wall here; move or rotate it". With the depth map we can also sample real 3D points and test whether any of them fall inside a virtual wall's volume.

Important: a wall the phone has never seen is unknown. If you place a life-size model in one room, the app cannot know about the wall in the next room until the camera has looked at it. Warnings are therefore "best effort, for what has been scanned".

### 1.3 Virtual-virtual occlusion (the model's walls hide its own rooms)

This is ordinary 3D rendering: the GPU keeps a depth buffer, so a near virtual wall hides a far virtual wall. In our code it **already works whenever walls are solid**:

- `createWallMaterial` makes a `MeshLambertMaterial` with `FrontSide` culling, and `depthWrite` stays on.
- `applyWallOpacity(material, opacity)` keeps depth writes on when `opacity >= 0.99`. Below that it switches to `transparent = true`, `depthWrite = false`, `DoubleSide`. That is the *see-through* mode, and it deliberately shows every room through every wall.
- `ArController` starts with `wallOpacity = 1`, and **Life-size** (`setLifeSize`) forces it back to 1. Only the live map's "Wall transparency" slider (`wall_opacity` control patch) makes walls see-through.

So the "rooms behind walls are visible" effect appears only when (a) the laptop panel has lowered the transparency, or (b) **real** walls are in front (item 1). Two small caveats remain. Every wall is merged into one mesh, so in see-through mode the GPU cannot sort walls back-to-front, and translucent walls can blend in the wrong order. Also, standing *inside* a wall's thickness (or within the camera's near plane) shows the inside of the box with its back faces culled, so the wall seems to vanish.

**Recommendation:** add an explicit three-way wall mode instead of a free slider on the phone: **See-through** (0.35), **Solid** (1, current Life-size), and **Realistic** (solid + real-world occlusion). "Realistic" is the answer to the user's request.

---

## 2. Feature and support matrix (as of November 2026)

| Capability | API / feature string | Chrome Android (ARCore phone) | Notes |
|---|---|---|---|
| Hit test | `hit-test` | Shipped (since 81) | Used today. |
| Anchors | `anchors` | Shipped (since 85) | Used today (see `AR_ANCHORING.md`). |
| Depth sensing | `depth-sensing` + `depthSensing: {usagePreference, dataFormatPreference}` | **Shipped** (Google lists "Depth API: Shipped"; MDN lists `depthUsage` since Chrome 90) | Only on ARCore devices that support the Depth API. Google: "over 88% of active devices" (May 2026). No ToF needed. |
| Depth usage `cpu-optimized` | `usagePreference: ["cpu-optimized"]` | Supported | `frame.getDepthInformation(view)` returns an `ArrayBuffer`. The most portable path. |
| Depth usage `gpu-optimized` | `usagePreference: ["gpu-optimized"]` | Supported on phones, device-dependent (sample reports vary) | `glBinding.getDepthInformation(view)` returns a `WebGLTexture` (`textureType: "texture"` on phones, `"texture-array"` on stereo headsets). |
| Data formats | `luminance-alpha`, `float32`, `unsigned-short` (newer drafts) | `luminance-alpha` is the safe choice | luminance-alpha = 16-bit raw value split across two bytes; multiply by `rawValueToMeters` (normally 0.001). |
| Depth perf extensions | `depthTypeRequest: ["raw"\|"smooth"]`, `matchDepthView`, pause/resume | Intent to Ship, **Chrome 139** (Android) | Optional. `"smooth"` is the one for occlusion. |
| Plane detection | `plane-detection`, `frame.detectedPlanes` | Was a developer trial for years. **Intent to Ship Feb 2026, Chrome 147**. Should be on by default in current Chrome; verify on the test phone through the `granted` list in diag. | Gives horizontal and vertical polygons. |
| Mesh detection | `mesh-detection` | Behind `chrome://flags/#webxr-mesh-detection` (Chrome 148+); aimed at Android XR | Not for the thesis. |
| "real-world-geometry" | (old umbrella name for planes and meshes in the immersive-web repo) | Not a separate shipping feature | Split into `plane-detection` and `mesh-detection`. |
| three.js built-in occlusion | `renderer.xr.getDepthSensingMesh()`, `getDepthTexture()`, `hasDepthSensing()` | **Not usable on phones as is** (see below) | r161 added `WebXRDepthSensing`; r166 added `getDepthTexture()`; later versions skip it unless `session.depthUsage === "gpu-optimized"`. Not present in our r160. |
| Scene Viewer (Android fallback) | ARCore native | Occlusion **on automatically** on depth-capable devices (Google announced it in Dec 2019) | No developer control. Live pose is unavailable (see `AR_ANCHORING.md`). |
| AR Quick Look (iOS fallback) | ARKit native | People occlusion on A12+; object occlusion from the scene mesh on LiDAR devices; automatic | Developers report it cannot be turned off. |
| `<model-viewer>` WebXR mode | model-viewer's own `immersive-ar` | No occlusion | Our fallback lists `ar-modes="webxr scene-viewer quick-look"`. The fallback is shown only when WebXR is unavailable, so in practice Scene Viewer or Quick Look runs and occlusion comes for free. |
| Unity AR Foundation | `AROcclusionManager` (environment depth, ARCore modes Disabled/Fastest) | Native ARCore | Mature and simple to switch on. But our Unity scaffold is unbuilt and ships as an APK (see `AR_ANCHORING.md` option (c)). |
| iOS Safari | — | **No `immersive-ar` at all** | Unchanged. |

### Why three.js's built-in depth occlusion does not fit our phones

`WebXRDepthSensing` (r161+) was written for Meta Quest 3. It:
- runs only when `session.depthUsage === "gpu-optimized"` (r168 users hit a null-reference crash on cpu-optimized devices; later versions added the check);
- samples a **`sampler2DArray`** (stereo texture array, layer 0/1 per eye), while phones return a plain `TEXTURE_2D`;
- writes the sampled value straight into `gl_FragDepth` as if it were a depth buffer. It never applies the phone's `normDepthBufferFromNormView` UV transform or `rawValueToMeters`, and phone depth is luminance-alpha millimetres, not normalised depth.

Upgrading three.js would therefore **not** give us occlusion on Android phones, and r160 → r17x carries real migration risk (colour management, `WebXRManager` changes) just before the deadline. A small custom shader patch (section 3) works on r160, handles both the cpu and gpu paths, and is about 120 lines.

### Limits to state honestly in the thesis

| Limit | Value / behaviour | Consequence for PlanLiftAR |
|---|---|---|
| Accurate range | Best at **0.5 to 5 m**; reported up to ~65 m, but noisy past ~5 to 8 m | A real wall 10 m away will not reliably hide a virtual room at 12 m. Occlusion is a near-field effect. |
| Resolution | Far below the camera image (ARCore depth images are on the order of 160×90 to 256×144, device-dependent) | Edges are blocky and shimmer. People's outlines look "haloed". |
| Latency | Depth from motion needs a few frames of movement, and the depth image can lag the camera slightly | Occlusion edges trail fast motion. Nothing is valid until the phone has moved. |
| Low texture | White walls and dark rooms give imprecise or missing depth (value 0 = unknown) | Treat 0 as "no occluder". Plain corridor walls may fail to occlude. |
| Thin objects | Railings, chair legs and glass are often missed | Expected; document it. |
| Coplanar surfaces | Real floor and virtual floor slab are at the same depth | Z-fighting flicker unless a bias is applied (section 3.3). |
| Performance | Enabling depth makes ARCore compute a depth map every frame (extra CPU/GPU load and heat) | Measure on a mid-range phone, and allow switching it off. |
| Coverage | ~88% of active ARCore devices have the Depth API; no iOS | The toggle must degrade gracefully. |

---

## 3. Implementation plan for `ArController`

### 3.1 Feature flags (`arCore.ts` `sessionInit`, mirrored in `ar_core.js`)

```ts
const init = {
  requiredFeatures: ["hit-test"],
  optionalFeatures: ["anchors", "local-floor", "plane-detection", "depth-sensing"],
  // Required by spec whenever "depth-sensing" is requested, even as optional.
  depthSensing: {
    usagePreference: ["cpu-optimized", "gpu-optimized"],
    dataFormatPreference: ["luminance-alpha", "float32"],
    // Chrome 139+: ignored by older browsers.
    depthTypeRequest: ["smooth"],
  },
} as XRSessionInit;
```

- Keep `depth-sensing` **optional**. A device without the Depth API then simply does not grant it, and the session still starts.
- Prefer **cpu-optimized** first. It is what Chrome on ARCore has supported longest, it gives a plain `ArrayBuffer` we can also sample for spatial checks (3.6), and the upload is about 30 KB per frame. Add a gpu path only if profiling shows the upload matters.
- After `requestSession`, read `session.enabledFeatures.includes("depth-sensing")`, `session.depthUsage` and `session.depthDataFormat`, and put all three in the `diag` message.

### 3.2 Per-frame depth fetch (`DepthOcclusion` helper, new file `features/ar/depthOcclusion.ts`)

In `onXrFrame`, right after `getViewerPose`:

```ts
if (this.occlusion && viewerPose) {
  const vp = (renderer.xr.getCamera() as THREE.ArrayCamera).cameras[0].viewport; // framebuffer px (incl. 0.8 scale)
  this.occlusion.update(frame, viewerPose.views[0], vp.z, vp.w);
}
```

Phones have one view. Three's `WebXRManager` has already updated `cameras[0].viewport` before our callback runs.

### 3.3 Shader / material approach

Patch the **existing** Lambert materials with `onBeforeCompile`. No new material class, so texture, lighting and opacity logic stay as they are:

1. Vertex: output `vViewDepth = -mvPosition.z`. That is the distance from the camera plane, which is the same quantity the depth map holds.
2. Fragment, first line of `main()`: compute the normalised view UV from `gl_FragCoord / viewport` and map it through `normDepthBufferFromNormView` into depth-texture UV. Decode metres from the texture. If `0 < real < trustMax` and `real < virtual - bias`, then `discard`.
3. **Bias:** `bias = 0.05 m + 0.03 × distance` for walls. On the **floor slab** use a larger bias (0.15 m), or leave the slab unpatched, so the real floor does not "eat" the virtual slab at grazing angles. People's feet would then not cut the slab. Accept that, or patch it with the larger bias.
4. **Trust limit:** ignore real depth beyond `trustMax = 6 m`, where the data is too noisy and would punch random holes in distant walls.
5. **Hard vs soft edges:** solid walls use `discard` (no sorting problems, cheap). In see-through mode, multiply alpha by `smoothstep(-0.1, 0.1, virtual - real)` instead, for a feathered edge.
6. Sample with `NearestFilter`. Linear filtering on two-byte luminance-alpha interpolates the bytes separately and produces wrong distances.
7. The reticle (`MeshBasicMaterial`) stays unpatched, so it is always visible.
8. Give the patched material `customProgramCacheKey = () => "plf-depthocc"` so three does not share the program with unpatched materials.

### 3.4 Code sketch (three r160, cpu-optimized + luminance-alpha)

```ts
// features/ar/depthOcclusion.ts  (sketch, not wired in)
import * as THREE from "three";

type CpuDepth = {
  width: number; height: number; data: ArrayBuffer;
  rawValueToMeters: number; normDepthBufferFromNormView: XRRigidTransform;
};

export class DepthOcclusion {
  readonly uniforms = {
    uDepthTex: { value: null as THREE.DataTexture | null },
    uUvFromView: { value: new THREE.Matrix4() },
    uRawToMeters: { value: 0.001 },
    uViewport: { value: new THREE.Vector2(1, 1) },
    uOcclusionOn: { value: 0 },          // 0/1, driven by the UI toggle AND data validity
    uBiasM: { value: 0.05 },
    uBiasPerM: { value: 0.03 },
    uTrustMaxM: { value: 6.0 },
  };
  enabled = true;                         // UI toggle
  available = false;                      // last frame had valid depth
  private tex: THREE.DataTexture | null = null;

  update(frame: XRFrame, view: XRView, vpW: number, vpH: number): void {
    let info: CpuDepth | null = null;
    try {
      info = (frame as unknown as { getDepthInformation(v: XRView): CpuDepth | null })
        .getDepthInformation(view);
    } catch { info = null; }              // not granted, or gpu-optimized session
    this.available = !!info;
    this.uniforms.uOcclusionOn.value = this.enabled && info ? 1 : 0;
    if (!info) return;

    const { width, height } = info;
    if (!this.tex || this.tex.image.width !== width || this.tex.image.height !== height) {
      this.tex?.dispose();
      // luminance-alpha bytes [lo, hi] -> RG8 (WebGL2), decoded in the shader.
      this.tex = new THREE.DataTexture(new Uint8Array(width * height * 2), width, height,
        THREE.RGFormat, THREE.UnsignedByteType);
      this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
      this.tex.generateMipmaps = false;
      this.uniforms.uDepthTex.value = this.tex;
    }
    (this.tex.image.data as Uint8Array).set(new Uint8Array(info.data));
    this.tex.needsUpdate = true;
    this.uniforms.uUvFromView.value.fromArray(info.normDepthBufferFromNormView.matrix);
    this.uniforms.uRawToMeters.value = info.rawValueToMeters;
    this.uniforms.uViewport.value.set(vpW, vpH);
  }

  /** Patch a Lambert/Basic material in place. Call once per material after building. */
  patch(mat: THREE.Material, biasM = 0.05): void {
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u, { uBiasM: { value: biasM } });
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vViewDepth;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvViewDepth = -mvPosition.z;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying float vViewDepth;
          uniform sampler2D uDepthTex; uniform mat4 uUvFromView; uniform float uRawToMeters;
          uniform vec2 uViewport; uniform float uOcclusionOn, uBiasM, uBiasPerM, uTrustMaxM;`)
        .replace("void main() {", `void main() {
          if (uOcclusionOn > 0.5) {
            // normalised view coords: origin top-left (flip GL's bottom-left). VERIFY on device (test T0).
            vec2 viewUv = vec2(gl_FragCoord.x / uViewport.x, 1.0 - gl_FragCoord.y / uViewport.y);
            vec2 depthUv = (uUvFromView * vec4(viewUv, 0.0, 1.0)).xy;
            vec2 lohi = texture2D(uDepthTex, depthUv).rg;              // bytes as 0..1
            float realM = dot(lohi, vec2(255.0, 65280.0)) * uRawToMeters;
            float bias = uBiasM + uBiasPerM * vViewDepth;
            if (realM > 0.0 && realM < uTrustMaxM && realM < vViewDepth - bias) discard;
          }`);
    };
    mat.customProgramCacheKey = () => `plf-depthocc-${biasM}`;
    mat.needsUpdate = true;
  }

  dispose(): void { this.tex?.dispose(); this.tex = null; }
}
```

Wiring in `ArController`:
- construct `this.occlusion = new DepthOcclusion()` in `start()` when `enabledFeatures` includes `depth-sensing`;
- in `buildGroup()`, after `buildFloorplanGroup`, call `occlusion.patch(model.wallMaterial)` and `occlusion.patch(slabMaterial, 0.15)` (expose the slab material from `FloorplanModel`, or find it by `name === "floor"`);
- dispose it in `onSessionEnd` and `dispose()`.

For a `float32` session, swap `RGFormat/UnsignedByteType` for `RedFormat/FloatType` and read `.r * uRawToMeters`. For a gpu-optimized session, skip the upload and wrap `glBinding.getDepthInformation(view).texture` in the sampler (three r160 needs a small `renderer.properties` hack to inject an external `WebGLTexture`, the same trick `WebXRDepthSensing` uses later). That is why cpu-first is recommended.

### 3.5 Fallback when depth is unsupported or not yet valid

| Situation | Detect | Behaviour |
|---|---|---|
| Not granted (old phone, no Depth API) | `!enabledFeatures.includes("depth-sensing")` | Toggle shown disabled: "Real-world occlusion: not available on this phone". The model renders exactly as today. |
| Granted, no data yet (phone has not moved) | `getDepthInformation` returns `null` or throws | `uOcclusionOn = 0`; hint "Move the phone a little so it can sense depth". |
| Data, but the user turned it off | toggle | `uOcclusionOn = 0`; depth still fetched (cheap), so turning it back on is instant. With Chrome 139's pause/resume methods, pause depth instead to save power. |
| Frame rate falls below budget | rolling fps < 24 for 3 s | Auto-disable once, with the hint "Occlusion turned off to keep AR smooth". |
| iOS / no WebXR | existing `unsupported` stage | `<model-viewer>` fallback. Quick Look and Scene Viewer apply their own occlusion. Optionally reorder `ar-modes` to `"scene-viewer webxr quick-look"` so Android always gets Scene Viewer's depth occlusion. |

### 3.6 Spatial awareness ("is the placement possible?")

Two cheap checks, both best-effort:

1. **Plane-based placement warning (recommended):** every 500 ms while aiming in Life-size, take the detected planes with `orientation === "vertical"`. Project each plane polygon into model-local 2D (the plan's coordinate frame, with the yaw and offset the model *would* get), giving a line segment. If a real wall segment crosses the interior of the footprint (and is not within ~20 cm of a virtual wall, which would mean the real and virtual walls coincide, which is fine and expected when overlaying the real building), show an amber hint: "A real wall cuts through the model here. Move or rotate before placing." Do not block placement. Use the same code after placement to colour the conflicting virtual wall red for 2 s. Pure 2D segment maths, testable in Vitest like `SurfaceGate`.
2. **Depth-sample intersection check (stretch):** at 2 Hz, sample the CPU depth buffer on a 16×9 grid, unproject each sample to a world point (inverse projection × view pose; depth is camera-plane distance), transform to model-local, and count points that lie *inside* a virtual wall box (point-in-oriented-rectangle, 0 < y < wall height) or inside a virtual room where the plan says there is open space. More than ~8% of valid samples inside the walls suggests a misalignment. This is also a useful thesis metric: "virtual vs real wall agreement".

Mesh detection would make (2) precise, but it is behind a flag. Do not depend on it.

### 3.7 UI toggle

- In the AR overlay settings sheet (next to Tabletop / Life-size), add a segmented control **Walls: See-through · Solid · Realistic**.
  - See-through: `applyWallOpacity(0.35)`, occlusion off.
  - Solid: opacity 1, occlusion off (today's Life-size).
  - Realistic: opacity 1, occlusion on. Disabled with an explanation when depth is unavailable.
- Default: **Realistic** when depth is granted, otherwise **Solid**.
- Add `occlusion: "on" | "off" | "unavailable"` to `PhoneState` so the live map panel shows it and can toggle it through a `ControlPatch` (`occlusion: boolean`). Keep `wall_opacity` as is.
- Debug: a hidden "depth view" (long-press the debug line) that tints occluded fragments magenta instead of discarding them. Needed for test T0.

### 3.8 Performance budget (mid-range phone, e.g. Pixel 6a / Galaxy A5x class)

| Item | Budget | How to measure |
|---|---|---|
| Frame rate in Realistic mode | ≥ 30 fps sustained, ≥ 24 fps after a 5-minute soak | rolling fps in `diag` |
| `getDepthInformation` + copy + `texSubImage` | ≤ 1.5 ms CPU per frame | `performance.now()` around `update()`, averaged in `diag` |
| Extra fragment cost | 1 texture fetch per wall fragment; negligible at `setFramebufferScaleFactor(0.8)` | compare fps with occlusion on/off |
| ARCore depth computation | Not ours to control; expect a few fps lost and more heat | on/off A/B, 5-minute soak |
| Memory | one RG8 texture (~30 to 75 KB) | — |
| Allocation | zero per frame (reuse the `Uint8Array` and the texture) | — |

If the A/B shows more than 20% fps loss, set `matchDepthView: false` (Chrome 139+, which lets the runtime skip reprojection), or fetch depth every other frame.

### 3.9 Test protocol

Devices: **D1** a depth-capable mid-range Android phone (check it is marked "Supports Depth API" on the ARCore device list); **D2** an ARCore phone *without* depth (or `?nodepth=1` to skip requesting it); **D3** an iPhone (fallback only). Chrome stable; record the Chrome version.

| ID | Scenario | Pass criterion |
|---|---|---|
| T0 | Debug depth view, tabletop model, hand moved over it | Magenta region tracks the hand with the right orientation (catches a wrong y-flip or UV transform). |
| T1 | Life-size; a person walks between phone and a virtual wall at 1, 2, 4 m | Person hides the wall at 1 and 2 m; at 4 m mostly; edge halo ≤ ~10 cm. |
| T2 | Stand in a corridor; place the model so a virtual room is behind a real wall 2 to 3 m away | Virtual room hidden by the real wall (no X-ray) for ≥ 90% of the wall area. |
| T3 | Same as T2 at 7 to 10 m | Document behaviour (expected: partial or no occlusion; beyond `trustMax`). |
| T4 | Look along the floor at grazing angles, slab on | No visible slab flicker (bias OK). |
| T5 | Plain white wall, dim light | Document; no crashes; occlusion may drop out. |
| T6 | Performance: 5-minute walk in Realistic vs Solid | Meets 3.8; record fps, update ms, phone temperature. |
| T7 | D2 / not granted | Toggle disabled with message; session starts; no console errors. |
| T8 | Anchoring regression | `anchorDriftM` / `anchorYawCorrDeg` within the ranges recorded in `AR_ANCHORING.md`. |
| T9 | Placement warning (3.6.1): aim so a real wall crosses the footprint | Amber hint appears within 1 s; no false positive when the real and virtual walls coincide. |
| T10 | D3 Quick Look, D2 Scene Viewer | Note native occlusion behaviour with a person walking in front. |

Automated: Vitest for the luminance-alpha decode, the bias function, and the 2D plane/footprint intersection; a Playwright smoke test that the AR page still loads with `depth-sensing` in `sessionInit` (no device needed).

---

## 4. Effort estimates

| Work item | Estimate | Risk |
|---|---|---|
| Wall mode toggle (See-through / Solid / Realistic), `PhoneState` field, control patch | 0.5 day | Low |
| `depth-sensing` request, `DepthOcclusion` (cpu path) + material patch + diag fields | 1.5 days | Medium: UV orientation and bias need device tuning (T0, T4) |
| Device testing and tuning (T0 to T8) | 1 day | Medium: needs a depth-capable phone |
| Plane-based placement warning (3.6.1) + unit tests | 1 to 1.5 days | Low/medium: false positives when real and virtual walls coincide |
| Depth-sample intersection metric (3.6.2) | 2 days | Medium |
| gpu-optimized path | 1 day | Medium: r160 needs an external-texture workaround |
| Upgrade three.js to use the built-in occlusion | 1 to 2 days and **does not work on phones** | High; not recommended |
| Unity `AROcclusionManager` route | ~1 day for occlusion itself, but **1 to 2 weeks** to build, sign and test the unbuilt scaffold | High |
| Mesh detection | n/a (flag-only) | — |

---

## 5. Recommendation for the thesis demo

Ship, in this order (about **3.5 days** in total):

1. **Wall mode toggle with "Realistic" as the default** where depth exists. That directly answers "I shouldn't see the model through a real wall" for walls and people within ~5 m, which is where a walkthrough demo happens.
2. **Custom cpu-optimized depth occlusion on three r160** (section 3.4), with the slab bias, the 6 m trust limit and the graceful fallback. Do not upgrade three.js for this.
3. **Virtual-virtual occlusion**: no new work. It already works with solid walls. Say so in the thesis, and keep See-through as an explicit mode.
4. **If time allows:** the plane-based "a real wall cuts through the model" warning (3.6.1). It is cheap and it demonstrates *spatial understanding*, not just pixel hiding.

Do **not** ship for the demo: mesh detection (flag-only), the three.js upgrade (does not help phones), or the Unity route (a separate app).

Frame it honestly in the defence: occlusion is per-pixel and approximate (low-resolution depth, ~5 m sweet spot, weak on blank walls). The app only knows about surfaces the camera has seen. iOS gets occlusion only through Quick Look, without the live map.

---

## Sources

- W3C WebXR Depth Sensing Module (Working Draft, 25 Aug 2026): https://www.w3.org/TR/webxr-depth-sensing-1/ ; IDL in WPT: https://chromium.googlesource.com/external/w3c/web-platform-tests.git/+/HEAD/interfaces/webxr-depth-sensing.idl
- MDN `XRSession.depthUsage` / `depthDataFormat`: https://developer.mozilla.org/docs/Web/API/XRSession/depthUsage , https://developer.mozilla.org/docs/Web/API/XRSession/depthDataFormat
- Chromium Intent to Ship, WebXR Depth Sensing Performance Improvements (raw/smooth, pause/resume, non-matching view; Android 139): https://groups.google.com/a/chromium.org/g/blink-dev/c/6z48GgKC95I
- Chromium Intent to Experiment, WebXR Depth API: https://groups.google.com/a/chromium.org/g/blink-dev/c/DjucMDeR-og/m/6yLpNN4wAAAJ
- Google, ARCore vs WebXR feature status (Depth: shipped; Plane Detection: developer trial at time of writing): https://developers.google.com/ar/develop/webxr/arcore-comparison?hl=en
- Chromium Intent to Ship, WebXR Plane Detection (Feb 2026, Chrome 147): https://groups.google.com/a/chromium.org/g/blink-dev/c/FaVm-dsox4U ; spec: https://immersive-web.github.io/plane-detection
- WebXR mesh detection (flag, Chrome 148+), xrblocks notes: https://cdn.jsdelivr.net/gh/google/xrblocks@0.16.0/src/world/mesh/README.md ; Chromium Android meshing CL: https://groups.google.com/a/chromium.org/g/feature-vr-reviews/c/1kQqPl3qxtA
- Android XR WebXR support (depth on Android XR is stereo): https://developer.android.com/develop/xr/develop-with-webxr
- WebXR samples (phone-ar-depth.html / phone-ar-depth-gpu.html) and device issue reports: https://chromium.googlesource.com/external/github.com/immersive-web/webxr-samples/+/9c7e303bbc3be15f339530c078ab191524890751/proposals/ , https://github.com/immersive-web/webxr-samples/issues/99 , https://github.com/immersive-web/webxr-samples/issues/154
- three.js `WebXRDepthSensing` source: https://github.com/mrdoob/three.js/blob/dev/src/renderers/webxr/WebXRDepthSensing.js ; r161 version: https://github.com/mrdoob/three.js/blob/r161/src/renderers/webxr/WebXRDepthSensing.js ; docs: https://threejs.org/docs/pages/WebXRDepthSensing.html , https://threejs.org/docs/pages/WebXRManager.html
- three.js PR #27695 (depth texture access, r166): https://github.com/mrdoob/three.js/pull/27695 ; PR #27743 (extra-pass removal discussion): https://github.com/mrdoob/three.js/pull/27743
- three.js forum, r168 crash on cpu-optimized devices: https://discourse.threejs.org/t/webxr-depth-sensing-api-dont-work-in-three-js-r168/70675
- Meta IWSDK depth occlusion (three.js-based, cpu/gpu usage): https://developers.meta.com/horizon/documentation/web/iwsdk-guide-depth-sensing/ , https://developers.meta.com/horizon/documentation/iwsdk/guides/15-depth-occlusion/
- ARCore Depth API overview (depth from motion, ToF optional, 0 to 65 m, best 0.5 to 5 m, white walls): https://developers.google.com/ar/develop/depth ; developer guide: https://developers.google.com/ar/develop/java/depth/developer-guide ; supported devices (88% figure, May 2026): https://developers.google.com/ar/devices
- Google blog, Blending Realities with the ARCore Depth API (Scene Viewer occlusion, Dec 2019): https://developers.googleblog.com/blending-realities-with-the-arcore-depth-api/ ; A new wave of AR realism (2020): https://developers.googleblog.com/a-new-wave-of-ar-realism-with-the-arcore-depth-api/
- Apple, people occlusion (A12+): https://developer.apple.com/documentation/arkit/occluding-virtual-content-with-people ; Quick Look occlusion cannot be disabled: https://developer.apple.com/forums/thread/691571 , https://forum.needle.tools/t/disable-object-occlusion-in-quicklook-ar-on-ios/2234
- Unity AR Foundation occlusion manager (6.x; ARCore supports Disabled/Fastest): https://docs.unity3d.com/Packages/com.unity.xr.arfoundation@6.4/manual/features/occlusion/occlusion-manager.html ; ARCore provider: https://docs.unity3d.com/Packages/com.unity.xr.arcore@6.1/manual/features/occlusion.html ; ARShaderOcclusion: https://docs.unity3d.com/Packages/com.unity.xr.arfoundation@6.3/api/UnityEngine.XR.ARFoundation.ARShaderOcclusion.html ; Google AR Foundation depth guide: https://developers.google.com/ar/develop/unity-arf/depth/developer-guide
- Meta Depth API limits on thin objects: https://developers.meta.com/horizon/resources/mr-health-depth

Unverified points, to confirm on the device: the exact depth image resolution on the test phone; whether `gpu-optimized` is granted there; the y-orientation of normalised view coordinates (test T0); and whether plane detection is on by default in the installed Chrome (check `granted` in diag).
