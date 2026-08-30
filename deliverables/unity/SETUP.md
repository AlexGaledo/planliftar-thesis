# AR Floorplan Viewer — Unity Setup

Scaffolded C# only (no `.unity`/`.meta`/project files). Drop the `.cs` files
into an existing Unity project's `Assets/` folder (e.g.
`Assets/Scripts/FloorPlan/`) and follow the steps below to wire up a working
scene.

## 1. Unity version

- Unity **2022.3 LTS** (any 2022.3.x patch).

## 2. Packages (Package Manager → Add package by name)

- `com.unity.xr.arfoundation` — **5.1.x** (AR Foundation 5)
- `com.unity.xr.arcore` — **5.1.x** (Google ARCore XR Plugin)
- `com.unity.xr.management` — pulled in automatically by the above; confirms
  XR Plug-in Management is present.
- `com.unity.ugui` — already included in 2022.3 by default (used by
  `ScaleInputUI.cs`, no TextMeshPro import required).

Use matching AR Foundation / ARCore XR Plugin versions (both 5.1.x) — mixing
major versions is the most common cause of AR Foundation compile errors.

## 3. XR Plug-in Management

`Edit → Project Settings → XR Plug-in Management`:

1. Click **Install XR Plug-in Management** if not already present.
2. Switch to the **Android** tab.
3. Check **ARCore**.

`Project Settings → XR Plug-in Management → ARCore Extensions` (if the
ARCore Extensions package is also added) is not required for this scaffold —
plain AR Foundation + ARCore XR Plugin is sufficient for plane detection and
anchors.

## 4. Player Settings (Android)

`Edit → Project Settings → Player → Android tab`:

- **Scripting Backend**: IL2CPP
- **Target Architectures**: check **ARM64** only, uncheck ARMv7
- **Minimum API Level**: Android 7.0 'Nougat' (API level 24) — ARCore's floor
- **Target API Level**: Automatic (highest installed)
- **Internet Access** (under Other Settings): **Require** — needed for
  `FloorPlanApiClient`'s UnityWebRequest calls to reach the backend
- `Configuration → Active Input Handling`: leave as **Input Manager (Old)**
  or **Both** — `TapToPlaceFloorPlan` reads legacy `Input.touchCount`/
  `Input.GetTouch`. If the project is set to "Input System Package (New)"
  only, either switch this setting to "Both", or rewrite the tap-detection
  block in `TapToPlaceFloorPlan.GetTapScreenPosition()` to use
  `UnityEngine.InputSystem.Touchscreen.current`.

## 5. Scene hierarchy

Create a new scene (or add to an existing one):

```
AR Session                      [ARSession]
XR Origin                       [XROrigin]
├─ Camera Offset
│  └─ Main Camera                [Camera, ARCameraManager, ARCameraBackground,
│                                  TrackedPoseDriver]
├─ [ARPlaneManager]              (add to XR Origin GameObject itself)
├─ [ARRaycastManager]            (add to XR Origin GameObject itself)
└─ [ARAnchorManager]             (add to XR Origin GameObject itself)

Managers                         (empty GameObject)
├─ [FloorPlanApiClient]
│    baseUrl = https://<your-backend-host>
│    pollIntervalSeconds = 2
│    offlineSampleFileName = sample_response.json
└─ [TapToPlaceFloorPlan]
     raycastManager  -> XR Origin's ARRaycastManager
     planeManager    -> XR Origin's ARPlaneManager
     anchorManager   -> XR Origin's ARAnchorManager
     placeOnFirstTapOnly = true

Canvas                          [Canvas: Screen Space - Overlay, CanvasScaler]
├─ MetersInputField               [InputField], Content Type: Decimal Number
├─ SelectedWallLabel              [Text]
├─ PrevWallButton                 [Button]
├─ NextWallButton                 [Button]
├─ ApplyButton                    [Button]
└─ [ScaleInputUI]  (can live on the Canvas GameObject itself)
     floorPlanPlacer     -> Managers' TapToPlaceFloorPlan
     metersInputField    -> MetersInputField
     selectedWallLabel   -> SelectedWallLabel
     prevButton          -> PrevWallButton
     nextButton          -> NextWallButton
     applyButton         -> ApplyButton
     highlightMaterial   -> (an emissive/bright Material asset, created in-editor)
```

`XR Origin` also needs a plane visualization prefab assigned on
`ARPlaneManager` (Unity's `AR Foundation` samples ship a default
`ARFeatheredPlaneMeshVisualizer`-based prefab you can reuse, or use the
built-in `ARPlaneMeshVisualizer` on a simple quad prefab) so the user has
visual feedback for where they can tap.

Create two Materials in `Assets/Materials/`: `WallMaterial` (assigned to
`FloorPlanMeshBuilder.BuildWalls`'s `mat` argument) and `WallHighlightMaterial`
(assigned to `ScaleInputUI.highlightMaterial`).

## 6. Wiring the flow at runtime

None of the scripts auto-wire the end-to-end flow (upload → poll → build →
place → scale) — that orchestration is app-specific glue code, e.g. a small
`FloorPlanFlowController` MonoBehaviour that:

1. Calls `FloorPlanApiClient.UploadPlan(texture, onJobId, onError)`.
2. On `onJobId`, calls `FloorPlanApiClient.PollJob(jobId, onAccepted, onRejected, onError)`.
   For offline dev, call `FloorPlanApiClient.LoadFromStreamingAssets(onLoaded, onError)`
   instead, and copy `reference/wall-test-out/sample_response.json` into
   `Assets/StreamingAssets/sample_response.json`.
3. On `onAccepted(JobResponse data)`, calls
   `FloorPlanMeshBuilder.BuildWalls(data, initialMetersPerPixel, wallHeightMeters, wallMaterial)`
   — `initialMetersPerPixel` can be a rough guess (e.g. `data.metadata.pixel_to_meter_ratio`
   if nonzero, else any placeholder like `0.01f`); it only affects the
   model's size before the user applies a real dimension, not its shape.
4. Passes the returned root GameObject to `TapToPlaceFloorPlan.SetFloorPlan(root)`.
5. User taps a detected plane → `TapToPlaceFloorPlan` anchors and parents the model.
6. User selects a reference wall via `ScaleInputUI`'s Prev/Next, types its
   real length, taps Apply → `TapToPlaceFloorPlan.SetScaleFromReference` fires
   and the model snaps to real-world scale.

## 7. Building and sideloading a development APK

1. `File → Build Settings → Android` → **Switch Platform**.
2. Under **Build Settings**, check **Development Build** (enables profiler/
   logcat-visible Debug.Log output) and optionally **Script Debugging**.
3. Ensure a device is connected via USB with **USB debugging** enabled
   (Android Settings → Developer Options) and **File Transfer/Android Auto**
   mode (not "charging only") so `adb` can see it.
4. Click **Build And Run** to build, install, and launch directly on the
   connected device — or click **Build** to produce a standalone `.apk`
   (choose an output path/filename).
5. To sideload a `.apk` built separately (no `adb` in the Unity dialog):
   ```
   adb devices              # confirm the device is listed and authorized
   adb install -r path/to/YourApp.apk
   ```
   `-r` reinstalls over any existing build with the same package name.
6. Grant the **Camera** permission when first launched (AR Foundation
   requests it automatically via the ARCore requirement, but Android may
   still show the runtime permission dialog on first run — accept it or AR
   session initialization will fail silently).

## Known gaps / caveats to close before shipping

- `UploadResponse.job_id` field name is an assumption (see comment in
  `FloorPlanData.cs`) — confirm against the real backend contract.
- `Wall.GetThicknessMeters` picks `thickness` over `thickness_px` whenever
  `thickness > 0`; confirm the backend never sends both simultaneously with
  conflicting values.
- Fixtures (doors/windows) are parsed into `FloorPlanData.Fixture` but not
  yet instantiated as geometry — `FloorPlanMeshBuilder` only builds walls,
  per the current scope. Room polygons are likewise parsed but unused.
- No error/retry UI is wired for `FloorPlanApiClient`'s `onError` callbacks —
  hook these up to user-facing messaging in the flow controller.

## Minimap setup

Adds a game-style bird's-eye minimap (`MinimapController.cs` +
`MinimapUI.cs`) that mirrors the placed floorplan's walls onto a dedicated
camera/RenderTexture and tracks the AR camera as a heading marker. Read the
"Wall-rendering approach" and "Player marker coordinate space" comments at
the top of `MinimapController.cs` before changing the layering/coordinate
logic — the short version: walls are re-layered onto a "Minimap" layer
in-place (no mesh cloning), and both the main AR camera and the minimap
camera draw the same mesh instances via culling masks.

### 1. Create the "Minimap" layer

`Edit → Project Settings → Tags and Layers → Layers`: add a new layer named
exactly `Minimap` in any free user slot (8–31). The name must match
`MinimapController.minimapLayerName` (default `"Minimap"`).

Confirm the main AR camera's culling mask still includes this layer — it
does by default (`Everything`), but if a project has narrowed the AR
Camera's culling mask, add `Minimap` to it explicitly or walls will vanish
from the main AR view once the minimap initializes (see the wall-rendering
comment in `MinimapController.cs`).

### 2. RenderTexture

No asset is required — `MinimapController` creates a `RenderTexture` at
runtime (`renderTextureSize`, default 512×512, ARGB32) if
`MinimapController.renderTexture` is left unassigned, and releases it in
`OnDestroy`. Optionally create a `RenderTexture` asset (`Assets → Create →
Render Texture`) and assign it to `renderTexture` instead if the project
wants explicit control over format/compression via the asset importer.

### 3. Scene wiring

```
Managers
├─ [TapToPlaceFloorPlan]            (existing, see step 5 above)
└─ [MinimapController]
     minimapCamera         -> (leave empty; created at runtime)
     renderTexture          -> (leave empty; created at runtime)
     minimapLayerName       = "Minimap"
     followPlayer           = false
     followZoomRadiusMeters = 5
     playerMarkerMaterial   -> (an unlit/emissive Material asset, created in-editor)
     playerMarkerColor      = (bright, e.g. red)

Canvas
├─ MinimapRawImage               [RawImage]
├─ MinimapModeToggleButton       [Button] (+ optional child [Text])
└─ [MinimapUI]  (can live on the Canvas GameObject itself)
     minimapController   -> Managers' MinimapController
     rawImage            -> MinimapRawImage
     toggleButton         -> MinimapModeToggleButton
     toggleButtonLabel    -> (optional) the button's child Text
     cornerAnchor          = TopRight
     useMask / maskComponent -> optional, see MinimapUI.cs header comment
```

`MinimapController` and `MinimapUI` do not need to be on the same
GameObject as `TapToPlaceFloorPlan`; they only need the inspector reference
above plus the placement hook in step 4.

### 4. Connecting to TapToPlaceFloorPlan's placement

`TapToPlaceFloorPlan.cs` gained a small public event so other systems don't
have to poll `IsPlaced` every frame:

```csharp
public event Action<FloorPlanInstance> OnFloorPlanPlaced;
```

It fires once per successful tap-placement (right after the root is
parented, activated, and `_hasPlaced` is set), from inside `TryPlaceAt`.
This was the only change made to `TapToPlaceFloorPlan.cs` — one new `using
System;`, the event declaration next to the existing `CurrentFloorPlan`/
`IsPlaced` properties, and one `OnFloorPlanPlaced?.Invoke(_floorPlanInstance);`
line at the end of `TryPlaceAt`. No existing behavior changed.

Wire a small subscriber (part of the app-specific flow controller mentioned
in step 6 above, or a one-liner `Awake`/`Start` on any MonoBehaviour that
already holds both references) so the minimap initializes right after
placement:

```csharp
[SerializeField] private TapToPlaceFloorPlan floorPlanPlacer;
[SerializeField] private MinimapController minimap;
[SerializeField] private Transform arCamera; // XR Origin's Main Camera transform

private void Awake()
{
    floorPlanPlacer.OnFloorPlanPlaced += instance => minimap.Initialize(instance, arCamera);
}

private void OnDestroy()
{
    // unsubscribe with a matching named method in real code; inline lambda
    // shown here for brevity — see C# event unsubscription caveats if this
    // object can outlive floorPlanPlacer.
}
```

If `placeOnFirstTapOnly` is `false` and the user re-places the plan,
`OnFloorPlanPlaced` fires again — `MinimapController.Initialize` is safe to
call repeatedly and re-layers/re-frames against the new instance each time.
