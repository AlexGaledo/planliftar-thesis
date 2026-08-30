# PlanLiftAR v1 — Master Plan

**Status: FINAL (v1), 2026-08-29. Target platform: Android only.**

## Locked decisions (v1)

- Rooms-first region extraction; no line stitching, no `merge_walls()`.
- All thresholds in relative units (wall-thickness multiples); scale is
  user-supplied at AR placement time from the plan's handwritten dimensions —
  one reference dimension scales the whole model.
- Production consensus runs the CubiCasa multi-task net alongside MitUNet
  (two-source, both CC-BY-NC — retrain before commercial launch).
- Open-plan merged regions passing invariants are accepted as one room; the
  pipeline never invents walls, watershed fires only on geometry anomaly.
- Door spans are carved back out of derived walls at export.
- Compute on Kaggle cloud (R&D) / FastAPI GPU service (prod); dev machine runs
  CLI + Unity Editor only; AR runs on phone only.
- AR delivery staged: Stage A GLB via Android Scene Viewer (proof), Stage B
  Unity + AR Foundation dev-build APK (product). Android only; iOS deferred
  past v1.
- App-backend transport: REST async job pattern. No WebSocket.

Scaffold for a new Kaggle notebook (`planliftar-geometry-v2`) that upgrades the current
MitUNet wall-test pipeline from "line-first extraction with fixed-pixel merging" to a
rooms-first pipeline with layered break-healing and an enforced acceptance barrier.
The output contract stays the same shape as `sample_response.json` (walls, rooms,
fixtures) so the Unity mesh builder does not need to change.

## Context and goal

The current notebook proves the model half works: MitUNet produces a clean wall mask
on a standard plan, and the merge step reduces 18 Hough fragments to 9 walls. Two
problems block AR use. First, the vectorized walls have gaps at fragment boundaries,
which become literal holes when extruded to 3D. Second, all merge tolerances are
fixed pixel counts, so behavior changes with image resolution. This plan replaces the
gap-prone step with region extraction (closed by construction) and wraps the whole
thing in detect-heal-or-reject logic. Scale stays user-supplied per the product
decision: the pipeline is size-agnostic and expresses every threshold in relative
units (wall-thickness multiples), never absolute pixels.

## Design correction: Layer 3 is a consensus check, not an answer key

Earlier framing treated the CubiCasa room data as ground truth to validate MitUNet
regions against. That was wrong: the CubiCasa side is also model inference (or
dataset annotation that won't exist for real user uploads), and it hallucinates
breaks of its own. Neither source can adjudicate the other.

The correct framing: two independent noisy estimates of the same rooms. Agreement is
evidence of correctness; disagreement is a signal to repair or reject — never a
verdict about which side is right. Concretely, IoU-match the MitUNet-derived room
regions against the CubiCasa room polygons. High mutual IoU on matching counts:
accept. Count mismatch or low IoU: attempt watershed repair (Layer 4), re-score, and
if still inconsistent, reject at the barrier. Alongside the cross-check, run
self-contained invariants that need no second source at all: every room polygon
closes, every wall endpoint touches another wall, no room below minimum plausible
area, room count within sane bounds for the plan's bounding box. Those invariants
catch broken geometry even when both models hallucinate the same way.

## Notebook scaffold (cell by cell)

Each cell below maps to one layer or one pipeline stage. Keep them separate cells so
individual stages can be re-run and inspected during tuning.

### Cell 0 — Environment and weights

Unchanged from current notebook: install `segmentation-models-pytorch==0.5.0`,
`albumentations`, `opencv-python-headless`, plus add `scikit-image` (hysteresis,
skeleton, watershed). Pull the checkpoint from the LFS media host as you already do.

### Cell 1 — Model assembly and load

Unchanged: Segformer encoder transplant into `smp.Unet` with `scse` attention, load
state dict, eval mode.

### Cell 2 — Inference, keeping the probability map

One change with outsized value: stop discarding the sigmoid output.

```python
with torch.no_grad():
    prob = torch.sigmoid(model(inp)).squeeze().cpu().numpy()   # float in [0,1]
prob_full = cv2.resize(prob, (W, H), interpolation=cv2.INTER_LINEAR)
np.save("/kaggle/working/wall_prob.npy", prob_full)            # keep for Layers 2 and 4
```

The binary mask becomes a derived artifact, not the source of truth.

### Cell 3 — Layer 2: hysteresis thresholding

Heals hallucination breaks where the model's confidence dipped below 0.5 but did not
vanish. Weak pixels count as wall only when connected to strong wall.

```python
from skimage.filters import apply_hysteresis_threshold
mask = apply_hysteresis_threshold(prob_full, low=0.25, high=0.50).astype(np.uint8)
```

Tune `low` on the validation samples: sweep 0.15–0.35 and pick the value that
maximizes closed-room count without inventing wall where the plan has genuine
openings. Log `connectedComponents` count before/after as the healing metric.

### Cell 4 — Layer 1: opening classification and micro-gap sealing

Openings in the healed mask are either doors (keep) or breaks (seal). Discriminate by
width, measured in wall-thickness units so it is resolution-independent.

```python
dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
t_med = 2 * np.median(dist[skeletonize(mask.astype(bool))])    # median wall thickness, px
SEAL_BELOW = 1.5 * t_med       # breaks are hairline; doors are ~3x thickness or more
mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT,
            (int(SEAL_BELOW) | 1, int(SEAL_BELOW) | 1)))
```

Anything narrower than `SEAL_BELOW` closes automatically; door-scale openings are
untouched. If the user-supplied scale is available at this stage, cross-check that
`3 * t_med` lands near 0.8–0.9 m — a cheap sanity signal on the whole mask.

### Cell 5 — Virtual door sealing from fixture data

Before region extraction, plug every known door so rooms cannot leak into each other
or into the exterior. For each door in the fixtures list, find the local wall
orientation (dominant direction of wall pixels within a small window around the
fixture position) and draw a filled bar of thickness `t_med` across the opening,
perpendicular gap-spanning, into a copy of the mask used only for labeling:

```python
seal_mask = mask.copy()
for f in fixtures:                      # doors and windows both seal for labeling
    draw_virtual_wall(seal_mask, f["position"], t_med)
```

The virtual bars never enter the exported geometry; they exist only so the labeling
step sees each room as a sealed pocket. One consequence must be handled explicitly:
derived walls trace region borders, and borders run straight through sealed doorways,
so Cell 10 must carve each door's span back out of its wall run using the fixtures
list — the export is wall segments plus opening markers, never a solid wall across a
doorway.

### Cell 6 — Rooms-first region extraction

```python
n, labels, stats, cents = cv2.connectedComponentsWithStats(
        cv2.bitwise_not(seal_mask), connectivity=4)
```

Exterior is every label whose bounding box touches the image border. Every remaining
label above minimum area is a room. Trace each with `cv2.findContours` and simplify
with `approxPolyDP(eps=0.01 * perimeter)`. These polygons are closed by construction;
no stitching code exists in this pipeline.

Walls for the export contract are then derived, not detected: assign every wall
pixel to its nearest room label (run `skimage.segmentation.watershed` seeded with the
region labels over the wall mask, or `cv2.distanceTransform` with
`cv2.DIST_LABEL_PIXEL` on the inverted labels), then the boundary between two label
assignments is the shared wall run between those rooms (or between a room and the
exterior), with thickness read from the distance transform at its midpoint. Do NOT
use 1-px dilate-and-intersect here: adjacent regions sit a full wall thickness apart,
so one-pixel dilations never meet and the intersection is empty for any wall thicker
than 2 px. Endpoint sharing is guaranteed because adjacent wall runs come from the
same label-assignment map.

### Cell 7 — Layer 3: consensus scoring and invariants

```python
# cross-check (advisory, not ground truth)
iou_matrix = pairwise_iou(mitunet_room_masks, cubicasa_room_polys)
matches = hungarian_match(iou_matrix, min_iou=0.5)
consensus = len(matches) / max(len(mitunet_rooms), len(cubicasa_rooms))

# self-contained invariants (hard requirements)
assert all(polygon_is_closed(r) for r in rooms)
assert all(wall_endpoint_degree(w) >= 2 for w in walls)
assert all(area(r) >= MIN_ROOM_AREA for r in rooms)
```

Routing (product decision): a count mismatch alone does NOT trigger repair. An
open-plan area with no door between living/dining legitimately labels as one region
while CubiCasa annotates two rooms; if that merged region passes every invariant it
is accepted as one room, with a `merged_rooms` note in the report — the pipeline
never invents a wall in open space. Cell 8 fires only when low consensus coincides
with a geometry anomaly (implausible area or aspect for a single room, invariant
failure, wall mass inside the region suggesting a real missed wall). Invariant
failure after Cell 8 routes to rejection.

Production decision: real user uploads have no CubiCasa annotation, so production
runs the CubiCasa multi-task net alongside MitUNet per upload — true two-source
consensus at the cost of a second checkpoint and forward pass. Both models inherit
CC-BY-NC from CubiCasa5k, so the retrain-before-launch note in Risks covers both.

### Cell 8 — Layer 4: watershed repair for merged rooms

Fires only when low consensus coincides with a geometry anomaly per the Cell 7
routing rule — never on count mismatch alone. Seed markers at each expected room
core (eroded region centers, or the centroids of whichever source claims more rooms),
run `skimage.segmentation.watershed` on the inverted distance transform of the
region, and take the collision ridge as the reconstructed wall. Re-run Cell 7
scoring afterward.

### Cell 9 — Layer 5: acceptance barrier and report

Single decision point, machine-readable, so the backend can return a clean rejection
to the app:

```python
report = {
  "accepted": bool(passed),
  "reject_reasons": reasons,          # e.g. ["room_count_mismatch", "open_polygon"]
  "metrics": {"rooms_mitunet": nm, "rooms_cubicasa": nc,
              "consensus_iou": consensus, "components": n_components,
              "wall_thickness_px": t_med}
}
json.dump(report, open("/kaggle/working/acceptance_report.json", "w"), indent=2)
```

A rejected plan produces no geometry file at all — the barrier is the only exit.

### Cell 10 — Export and visual QA

Write the final contract (same schema as `sample_response.json`, walls now sourced
from region borders, `scale` block replaced by `{"units": "relative_px",
"user_scale_required": true}`) and render the standard three-panel QA figure: healed
mask, labeled rooms, exported walls over the input.

## Kaggle CLI workflow

Run from your machine (the CLI needs your API token; grab it from Account → Create
New API Token, save to `~/.kaggle/kaggle.json`, `chmod 600`).

```bash
pip install kaggle
mkdir planliftar-geometry-v2 && cd planliftar-geometry-v2
kaggle kernels init -p .        # creates kernel-metadata.json
```

Edit `kernel-metadata.json`:

```json
{
  "id": "newri20/planliftar-geometry-v2",
  "title": "PlanLiftAR geometry v2",
  "code_file": "planliftar_geometry_v2.ipynb",
  "language": "python",
  "kernel_type": "notebook",
  "is_private": true,
  "enable_gpu": true,
  "enable_internet": true,
  "dataset_sources": ["newri20/sample-2d-floorplan", "qmarva/cubicasa5k"],
  "kernel_sources": []
}
```

Then the loop is:

```bash
kaggle kernels push -p .                                  # upload + run
kaggle kernels status newri20/planliftar-geometry-v2      # poll until complete
kaggle kernels output newri20/planliftar-geometry-v2 -p ./out   # pull artifacts
```

`enable_internet` must be true for the weights `wget`; GPU quota is ~30 h/week, and
this pipeline needs the GPU only for Cell 2 — everything after is CPU OpenCV, so
iterate on Cells 3–10 with GPU off by caching `wall_prob.npy` as a private dataset
after the first run.

## Build order

1. Cells 0–3 first (prob map + hysteresis). Highest healing value per effort;
   measurable immediately via component count on your existing sample.
2. Cells 4–6 (sealing + rooms-first). This deletes `merge_walls()` and with it the
   entire gap class of bugs.
3. Cells 7 and 9 (consensus + barrier). The product's acceptance barrier becomes
   executable here.
4. Cell 8 (watershed) last — it is an optimization of the reject rate, not a
   correctness requirement. Shipping without it just means more rejections.

Success criteria for the sample plan: rooms extracted as closed polygons matching
the 6 CubiCasa rooms with consensus ≥ 0.7, zero unclosed walls, and the exported
geometry renders in the Cell 10 QA figure with no visible gaps.

## AR runtime plan

Two stages. Stage A validates the geometry in real AR with zero app development;
Stage B is the product runtime we already leaned toward (Unity).

### Stage A — GLB + Scene Viewer (proof, no app build)

Add Cell 11 to the notebook: extrude the accepted geometry to a `.glb` with
`trimesh` — each wall run becomes a box (length x thickness x fixed 2.5 units
height), door spans left as openings. Host the GLB anywhere reachable (Kaggle
output, GitHub raw) and open on an Android phone via Scene Viewer
(`https://arvr.google.com/scene-viewer/1.0?file=<glb-url>&mode=ar_only`) or a
one-line `<model-viewer ar>` web page. The floorplan stands as 3D walls in the
room; walk around it. No Unity, no APK, no store. This is the fastest possible
path to "3D object in augmented reality space" and de-risks the entire pipeline
before any app work.

Existing third-party AR apps were considered and rejected: none accept custom
runtime geometry with placement logic. Scene Viewer is the closest thing and it
is built into Android.

### Stage B — Unity + AR Foundation dev build (product)

Unity with AR Foundation (wraps ARCore on Android, ARKit on iOS). Android only for v1:
the dev machine is Windows, and iOS (Mac + Xcode required) is deferred past v1. Build as a
development build APK, sideload to the phone — no Play Store needed during dev.

Runtime flow: app fetches the accepted JSON from the backend, the existing mesh
builder extrudes walls (same contract as `sample_response.json`, unchanged by this
plan), user taps a detected floor plane to place the model and enters the
user-supplied scale (the pipeline is size-agnostic by design; scale is applied
here, at placement). Stage B owns everything Scene Viewer cannot do: scale input,
1:1 walk-through alignment, anchoring, occlusion, and the upload/reject UX driven
by `acceptance_report.json`.

### Mobile prerequisites

Stage A (Android): an ARCore-capable phone (check Google's supported-devices
list), Google Play Services for AR from the Play Store (usually preinstalled;
Scene Viewer prompts the install if missing), and Chrome. Nothing else. On
iPhone: out of scope for v1 (would need `.usdz` for AR Quick Look and a Mac for
Stage B builds — revisit post-v1 if ever).

Stage B (phone): enable Developer Options and USB debugging (tap Build Number
seven times), allow installs from unknown sources for sideloading, USB cable to
the laptop. Stage B (laptop): Unity Hub + Unity Editor with the Android Build
Support module — it bundles the Android SDK/NDK, no separate Android Studio
install needed.

### Success conditions (staged)

1. Geometry (Kaggle): sample plan yields closed room polygons matching the 6
   CubiCasa rooms, consensus >= 0.7, zero unclosed walls, accepted JSON exported.
2. AR proof (Stage A): the extruded wall mesh renders in AR on a phone via Scene
   Viewer — walkable around, proportions correct, doorways open.
3. Product (Stage B): Unity app places the geometry on a detected floor plane at
   user-entered scale, 1:1, stable anchoring while walking the model.

## Phase 1 field amendments (2026-08-29, validated locally on sample 6044)

Two changes discovered during Phase 1 execution, now part of the pipeline:

1. **Auto-crop two-pass inference (Cell 2).** A floorplan on a large architectural
   sheet occupies a fraction of the 512x512 model input and the mask comes out
   starved (the original 719x1020 sample filled the frame; sheet 6044 did not).
   Pass 1 infers on the whole sheet, takes the bounding box of `prob > 0.3` plus
   8% margin; if that box is under half the sheet, pass 2 re-infers on the crop
   and the rest of the pipeline runs in crop coordinates (offset kept for export).

2. **Sealing hints from the CubiCasa side (Cell 5).** Fixture-point bars alone
   cannot close window runs and model-blind stretches (probability is genuinely
   ~0 there — hysteresis sweeps 0.02–0.30 all gave zero rooms). The labeling copy
   of the mask is now `mask OR rasterized CubiCasa walls`, plus bars over each
   CubiCasa opening (length 1.6x the opening's measured width, direction from the
   nearest CubiCasa wall segment). This stays within the plan's rule: seals exist
   only so rooms label as closed pockets; exported geometry is still derived from
   MitUNet + the label map, and the consensus layer still compares against
   CubiCasa rooms as an independent estimate for scoring (the sealing hints use
   its walls/openings, not its room polygons).

Local validation on 6044: 5 closed room regions tiling the apartment (bedroom,
WC, TA exact; living+kitchen+hall merged — partly genuine open-plan; bath+sauna
merged via doors missing from the openings list). Fused regions are Phase 2's
consensus/watershed job, per the routing rule.

## Backend transport (decision: REST)

The app-to-backend connection is REST, not WebSocket. The workload is a one-shot
async job — upload, compute for seconds to minutes, one result — with no
bidirectional streaming, so the async job pattern fits: `POST /plans` with the
image returns `202 {job_id}`; the app polls `GET /plans/{job_id}` until the state
is `accepted` (body: the geometry JSON) or `rejected` (body:
`acceptance_report.json` — the barrier report is literally the response). Unity's
built-in `UnityWebRequest` handles this with no extra libraries; WebSocket would
add a third-party dependency and reconnect handling for zero benefit. Revisit only
if live stage-by-stage progress streaming ever becomes a product requirement, and
even then 2 s polling covers it.

Kaggle is the R&D harness, not the production server. The production backend is a
later phase: the same pipeline cells wrapped as functions in a small FastAPI
service on a GPU host, same contract.

## Risks and notes

The MitUNet pretrained weights are CC-BY-NC (inherited from CubiCasa5k), so this
notebook is fine for R&D but the weights cannot ship in a commercial product —
budget a retrain on owned or permissively licensed data before launch. The
fixture-based sealing assumes fixture positions are roughly correct; a hallucinated
door position seals the wrong spot, which the invariants in Cell 7 will usually
catch as a geometry anomaly. Hysteresis `low` and the consensus threshold are the
only two tunables left in the pipeline; keep them in a single config cell at the top
so sweeps are one-line changes.

Three known sharp edges. The Cell 4 CLOSE kernel at `1.5 * t_med` can bridge
parallel walls closer than the kernel (thin corridors, closets) — if the sealed
count jumps implausibly, verify each seal against the probability map before
keeping it. `approxPolyDP` output is not orthogonalized, so exported walls can be
slightly crooked; add an axis-align snap pass if Unity renders look off. The
`wall_endpoint_degree >= 2` invariant falsely rejects legitimate freestanding half
walls and kitchen islands — demote it to a warning if real plans trip it.