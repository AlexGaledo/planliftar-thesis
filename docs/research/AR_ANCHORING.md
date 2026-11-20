# AR anchoring: why the model followed the camera, the fix, and how to ship AR for the MVP

Date: 2026-11-20. Scope: `deliverables/livemap/ar.html` (WebXR `immersive-ar`, three.js 0.160, Chrome on Android) and the new shared core `deliverables/livemap/ar_core.js`.

User report: *"when I place the 3D object, it shouldn't move with the camera. It should stay where it is even if I move around."*

---

## 1. Root cause

Before this change, `ar.html` already asked for `anchors`, created an anchor from the hit-test result, hid the model when `emulatedPosition` was set, and refused to place on the amber estimated ring (commits `8f98c36`, `de29c13`). The model still drifted. Each item from the checklist, checked against that code:

| Checked | Finding | Contributes? |
|---|---|---|
| Reference space type | `local-floor` when granted, otherwise `local`, set before `setSession`. Both are stationary spaces: neither drifts by itself, and neither is what makes content world-locked (the anchor does that). Chrome's ARCore backend does not offer `unbounded`. | No |
| Anchors requested / used | `anchors` was optional and `hit.createAnchor()` was called. **But only the anchor's position was read each frame. Its orientation was thrown away** ("Position only: the placement contract requires identity rotation", a contract the file's own header says never existed). | **Yes, the main cause** |
| Lever arm / scale | At life size the plan is 6 to 20 m across. Its centre sits on the anchor, so walls are up to ~10 m from it. When ARCore corrects its world frame it corrects heading too. If you ignore a 2° heading correction, a wall 8 m away moves **27.9 cm** (measured in the unit test below). The walls you are looking at slide while the tap point stays put, which reads exactly as "it moves when I walk". ARCore's own guidance is to keep content within ~8 m of its anchor because of this rotational effect. | **Yes (amplifier)** |
| Smoothing | Every anchor update was eased in with a 120 ms time constant, so each correction played out as the model visibly gliding across the real floor. | Yes (minor) |
| Hit type used for the anchor | One hit source with `entityTypes: ["plane","point"]`, and `results[0]` was anchored. That could be a feature-point hit, which is weaker than an anchor attached to a plane trackable. | Yes (minor) |
| Placement timing | The model could be placed on the first green frame, before ARCore had seen the room from more than one angle. Anchors created in the first seconds of a session see the largest corrections afterwards. | Yes |
| `matrixAutoUpdate` / per-frame overwrite | The group used auto-update. The anchor-follow loop was the only per-frame writer. Nothing was camera-parented. The reticle uses `matrixAutoUpdate=false`, which is correct. | No |
| `emulatedPosition` / 3-DoF | Handled when Chrome sets the flag. There was no detection when it doesn't (rotation without translation), and nothing blocked *placing* while in 3-DoF. | Partial |
| Frame-loop ordering | `maybeSendPose` called `worldToLocal` before `render()`, so it read the previous frame's `matrixWorld` (one frame stale for the pose stream only). | No (pose stream only) |
| Depth sensing / plane detection | Plane detection is used only to measure the surface for tabletop auto-fit. Depth sensing is not used. Neither one affects locking. | No |

## 2. The fix

All world-locking logic now lives in `deliverables/livemap/ar_core.js`, a framework-free ES module. It imports `three` and touches nothing else, so the React app can import it unchanged. `ar.html` imports it through its existing importmap.

### Algorithm (`AnchoredPlacement`)

```
At placement (inside the XR frame, with a live PLANE hit H0):
  B0     = translate(hitPos)                  model base: gravity-aligned, no own rotation
  rel    = inverse(H0) * B0                   base expressed in the anchor's frame
  anchor = hit.createAnchor()                 plane-attached
           ?? frame.createAnchor(H0, refSpace) free-space fallback
           ?? none -> mode "fixed" (world-locked fixed matrix B0)

Every frame (once the anchor has resolved; adopted inside a frame):
  if anchor not in frame.trackedAnchors or getPose == null: keep last base (counted)
  A    = frame.getPose(anchor.anchorSpace, refSpace)
  base = yawOnly(A * rel)                     position AND heading from the anchor;
                                              pitch/roll dropped so the floor stays level
  model = base * T(0, groundOffsetY, 0) * Ry(-userYaw) * S(1/denom)   (applyPlacementPose)
  no smoothing: the anchor pose is already ARCore's filtered estimate
```

- **Model origin on the tap point:** the plan's footprint centre lands exactly on the hit, and the anchor is made from that hit. That gives the shortest possible lever arm for any rotation correction.
- **Re-anchor button:** creates a new anchor from a plane hit near the user, with `rel' = inverse(H') * currentBase`. The model does not move at the moment of the switch (tested), the old anchor is `delete()`d, and from then on the anchor nearest the user drives corrections. This follows ARCore's advice to make a new anchor near content that is more than 8 m from its anchor.
- **Fallback:** if `anchors` was not granted or creation was refused, the mode is `fixed`, the model holds B0, and the coach line says "this phone cannot anchor it. If it slides, tap Start over."

### Tracking guard (`TrackingMonitor`)

The monitor reports one of four states: `ok`, `lost` (no viewer pose), `emulated` (`emulatedPosition === true`), or `rotation-only`. The last one is a heuristic: more than 60° of rotation with less than 2 cm of travel in a 2 s window. A handheld phone always translates several cm when it turns that far. Any state other than `ok` blocks placement, hides a placed model, pauses the pose stream, and shows *"The phone is only tracking rotation, so the model would follow you. Move the phone slowly side to side and point it at a well-lit, textured area."*

### Surface-quality gate (`SurfaceGate`)

There are now two hit-test sources. **placement** is planes only; these hits are the only ones that can be anchored. **preview** is planes plus feature points, used for the reticle only. The ring turns green and Place is enabled only when all of these hold:
1. tracking is `ok`,
2. there is a plane hit (point-only hits give `weak/points`),
3. the hit has been stable within 3 cm for 12 frames (`weak/settling`),
4. the camera has moved at least 30 cm since the session started (`weak/parallax`).

The coach line names whichever condition is missing.

### Other changes

- `applyPlacementPose()` is the single writer of the group transform. Rotation, scale, "Drop onto the floor" and geometry rebuilds all go through it, so the anchor-follow can never undo them and they can never undo the anchor. It also refreshes `matrixWorld`, so the pose stream is current for this frame.
- Diagnostics: the `diag` messages now include `tracking`, `surface`, `placementMode`, `anchorDriftM`, `anchorYawCorrDeg`, `anchorJitterMm`, `reanchors` and `sessionTravelM`. `AR_BUILD = "2026-11-20-anchor-yaw"`.
- `sw.js`: `ar_core.js` is added to the shell cache and VERSION is bumped to v4. Without that, stale-while-revalidate would keep serving the old page.

### Verification done

- `node --check` passes on the extracted module script of `ar.html` and on `ar_core.js`.
- A unit test with real three@0.160.0 and mocked `XRFrame`/`XRAnchor` (25 assertions, all pass) covers:
  - no jump when the anchor is adopted
  - a far corner follows a 2° plus 3 cm world correction exactly (old code: 27.9 cm error at 8 m)
  - the base stays level under a tilted anchor
  - `composeModelMatrix` equals the old `rotation.y = -yaw` and scale transform
  - re-anchor causes no jump and deletes the old anchor
  - fixed fallback, both when anchoring is unsupported and when it is refused
  - an anchor that resolves after reset is deleted
  - `TrackingMonitor` and `SurfaceGate` state transitions
- A headless Chrome load of `ar.html` runs the module, loads the plan ("17 walls, 6 rooms"), and reports no errors.
- **Not yet verified on a phone.** Device test: place at life size, walk 5 m out and back, watch `anchorYawCorrDeg`/`anchorDriftM` in the diag stream, and check that a wall edge stays on its real-world mark.

### Remaining limits (not code bugs)

- ARCore can only lock to what it can track. Plain white floors, low light and fast motion still hurt. The gate makes the page say so instead of placing anyway.
- One rigid model has one anchor. For buildings much larger than 16 m, a real multi-anchor solution (anchors per wing, blended) is future work. Re-anchor covers the walk-through use case.

---

## 3. AR delivery options for the MVP

| Option | Anchor stability | 1:1 walkthrough | iOS | PWA / no install | Live pose to spectator map | Effort to thesis deadline |
|---|---|---|---|---|---|---|
| **(a) WebXR `immersive-ar`, Chrome Android (current)** | ARCore anchors (Chrome 85+). Good once heading is followed (this fix). | Yes, full control | **No.** Safari has no `immersive-ar` on iPhone, and Apple engineers say it is unsupported on iOS and visionOS | Yes, already a PWA | **Yes**, already streaming at 10 Hz | Done; device test only |
| **(b) `<model-viewer>` → Scene Viewer (Android) / AR Quick Look (iOS)** | Native ARCore / ARKit placement, generally stable | Possible with `ar-scale="fixed"` (100%), but reports say Quick Look ignores it for auto-generated USDZ, so ship an authored `.usdz` | **Yes** (Quick Look) | Yes, plain web page. AR opens in the OS viewer | **No.** The OS viewer gives the page no pose, so the spectator map goes dark | Low: export GLB + USDZ from the same mesh, ~1 to 2 days |
| **(c) Unity AR Foundation APK (`deliverables/unity/` scaffold)** | ARCore/ARKit anchors via `ARAnchorManager`, best control | Yes | Yes, but needs a Mac, Xcode and an Apple developer account to ship | **No.** APK sideload / TestFlight | Yes (`PoseStreamer.cs` exists) | High: the scaffold is unbuilt, plus device builds and signing |
| **(d) 8th Wall / other WebAR SLAM** | 8th Wall's own SLAM | Not designed for building scale | Yes (its main selling point) | Yes | Possible | **Risky.** Hosted 8th Wall wound down (transition done 2026-02-28). The MIT open-source engine **excludes SLAM**, which ships as a separately licensed binary, self-hosted. Moving to Zappar/Mattercraft means new vendor lock-in and cost |
| **(e) Variant Launch (WebXR on iOS)** | ARKit underneath, exposed as WebXR | Likely (same code path as (a)) | Yes, via App Clip | Mostly (App Clip launch on iOS) | Yes (same JS) | Low code effort, but: $0 developer tier is ~5k views/month with a watermark, paid tiers are listed at $299+/project/month, and it reportedly does not implement the full spec (anchors/hit-test parity unverified) |

### Recommendation

**Confirmed: WebXR on Android as the primary path, and `<model-viewer>` as the fallback for iOS and unsupported devices.**

- **(a)** is the only option that already meets every hard thesis requirement: a 1:1 walkthrough, live pose to the spectator map, and installation as a PWA. With this fix it also follows ARCore anchors the way ARCore recommends. Its gap is iOS, and nothing will change that by the deadline, because Apple ships no `immersive-ar` on iPhone.
- **(b)** fills the gap cheaply. iPhone users, and Android phones without ARCore, still see the building at 1:1 on their floor. On those devices the defence should say plainly that the live map is unavailable. Ship an authored USDZ so `ar-scale="fixed"` is honoured. The same `buildFloorplanGroup` mesh can be exported once with three's `GLTFExporter`/`USDZExporter`.
- **(e)** is a demo-day option if an *iPhone with the live map* is required. Run the existing page through Variant Launch's free tier and check that anchors and hit-test behave before relying on it.
- **(c)** is the post-thesis production path, if native iOS telemetry becomes a requirement.
- **(d)** is not recommended. The platform is in transition and its SLAM is no longer part of the open package.

---

## Sources

- WebXR Anchors Module: https://immersive-web.github.io/anchors/ and explainer https://immersive-web.github.io/anchors/explainer
- MDN `XRAnchor.anchorSpace`: https://developer.mozilla.org/docs/Web/API/XRAnchor/anchorSpace ; `XRPose.emulatedPosition`: https://developer.mozilla.org/en-US/docs/Web/API/XRPose/emulatedPosition
- Chrome Android anchors support (since 85): https://web-platform-dx.github.io/web-features-explorer/features/webxr-anchors
- Chromium WebXR anchors sample: https://chromium.googlesource.com/external/github.com/immersive-web/webxr-samples/+/9c7e303bbc3be15f339530c078ab191524890751/anchors.html
- Chromium: null anchor/plane poses while tracking paused: https://crrev.com/757560
- ARCore "Working with anchors" (8 m rule, trackable vs session anchors, reuse, detach): https://developers.google.com/ar/develop/anchors
- Unity AR Foundation drift thread: https://discussions.unity.com/t/ar-object-keeps-drifting-after-placing-on-ground-plane-in-ar-foundation/1560959
- iOS / visionOS `immersive-ar` not supported (Apple forums): https://developer.apple.com/forums/thread/743655 , https://developer.apple.com/forums/thread/826845 ; WebKit WebXR meta-bug: https://bugs.webkit.org/show_bug.cgi?id=208988
- model-viewer AR: https://modelviewer.dev/examples/augmentedreality , https://developers.google.com/ar/develop/webxr/model-viewer ; Scene Viewer: https://developers.google.com/ar/develop/java/scene-viewer
- Quick Look `allowsContentScaling` and the auto-USDZ issue: https://developer.apple.com/documentation/quicklook/arquicklookpreviewitem/allowscontentscaling , https://bugs.webkit.org/show_bug.cgi?id=226265 , https://lightrun.com/answers/google-model-viewer-fixed-scaling-not-working-in-ios-ar-quicklook-when-auto-generating-usdz
- 8th Wall wind-down / open source: https://info.nianticspatial.com/blog/8th-wall-open-source , https://roadtovr.com/niantic-webar-platform-8th-wall-open-source/ , https://forum.8thwall.com/t/important-changes-to-8th-wall-business/8578 , https://www.zappar.com/insights/moving-from-8th-wall-to-mattercraft
- Variant Launch pricing / notes: https://www.goodfirms.co/software/variant-launch , https://www.trustradius.com/products/variant-launch/reviews , https://forum.babylonjs.com/t/how-to-try-ar-feature-on-ios-browser/49822

Pricing and 8th Wall licence details come from third-party listings and news coverage. Check the vendor pages before committing.
