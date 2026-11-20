# How the PlanLiftAR model works

Written for three readers: the thesis panel, non-technical clients, and developers
who need to port or extend the pipeline. Each section starts in plain language
and then gives the technical detail.

Companion data for diagrams and charts: [`model_viz_data.json`](./model_viz_data.json).

**How to read the references.** "geometry-v2 cell N" means the N-th cell (0-based)
of `planliftar-geometry-v2/planliftar_geometry_v2.ipynb`. The notebook also labels
its cells in comments ("Cell 3 - Layer 2"); both are given where they differ.
`file:line` points into this branch (`planliftar-mvp-pwa`). Numbers come from run
logs in the repo and each one names its source file.

---

## 1. Plain-language summary

PlanLiftAR takes a picture of a floor plan and lets you stand inside it on your
phone. Two published, pretrained neural networks read the image. **MitUNet**
marks every pixel that looks like wall. The **CubiCasa5k network** gives a second
opinion on where the rooms, doors and windows are. The system does not trace
walls line by line. It finds the enclosed spaces (rooms) first and treats their
borders as the walls, so every room in the 3D model is closed and has no
accidental holes. It then compares its rooms with the second network's rooms.
Agreement counts as evidence and disagreement raises a flag, but neither network
is treated as the right answer. A final gate either accepts the plan or rejects
it with a clear reason, and a rejected plan never becomes a broken 3D model. An
accepted plan is exported as a small JSON file of walls and rooms. The phone
raises those walls into 3D boxes and places them on the floor with Google's
ARCore. The user types one real measurement, such as the building's longest
side, and the whole model scales from that number. **We did not train a new
network.** The project's contribution is the geometry pipeline, the consensus
check and the AR client built around existing models.

---

## 2. End-to-end pipeline

```
image -> preprocess/auto-crop -> MitUNet -> probability map -> hysteresis
      -> thickness + micro-gap seal -> virtual seals (CubiCasa hints)
      -> rooms-first regions -> nearest-label walls
      -> consensus vs CubiCasa (+ watershed virtual split) -> invariants
      -> acceptance barrier -> JSON (doors carved) -> gap closure
      -> GLB / runtime 3D -> AR placement + user scale
```

All tunables are in one config cell (geometry-v2 cell 1):

| Constant | Value | Meaning |
|---|---|---|
| `HYST_LOW` | 0.25 | weak-wall threshold (planned sweep 0.15-0.35) |
| `HYST_HIGH` | 0.50 | strong-wall threshold |
| `SEAL_FACTOR` | 1.5 | seal gaps narrower than 1.5 x wall thickness |
| `CONSENSUS_MIN` | 0.70 | routing threshold (still uncalibrated) |
| `MIN_ROOM_AREA` | 2000 px² | smallest room. The local harness changes this to `2000/26² x t_med²` (`local/consensus_lab.py:58`, `:230`) |
| `WALL_HEIGHT` | 2.5 | extrusion height for the GLB |

### 2.1 Image in

- **What it does:** loads an RGB floor plan at any resolution.
- **Reference:** geometry-v2 cell 4. The sample is CubiCasa5k `colorful/10052/F1_original.png`. Runs v3-v8 used `high_quality_architectural/6044`.
- **Output:** `image_rgb_full`, with shape `(Hf, Wf, 3)`.

### 2.2 Preprocessing and two-pass auto-crop

- **What it does:** resizes the image to 512x512 and normalises it with the ImageNet mean `(0.485,0.456,0.406)` and std `(0.229,0.224,0.225)` (albumentations; geometry-v2 cell 4, the `transform` and `infer()` functions).
- **Auto-crop:** pass 1 runs inference on the whole sheet and takes the bounding box of `prob > 0.3`, plus an 8% margin. If that box covers less than 50% of the sheet, pass 2 crops to the box and runs inference again. The crop offset `(cx0, cy0)` is saved so the export can return to sheet coordinates.
- **Why:** on a large architectural sheet the plan fills only part of the 512x512 input, so the wall mask comes out starved. Runs v3 and v4 found **0 rooms** on plan 6044 for this reason. After auto-crop, v5 found **5** (`v3_stdout.txt`, `v5_stdout.txt`; amendment 1 in `planliftar-v1.md`).
- **Output:** the cropped RGB image and `crop_offset.txt`.

### 2.3 Segmentation (MitUNet)

- **What it does:** predicts one logit per pixel for "wall". The architecture is in section 3.1.
- **Reference:** geometry-v2 cells 2-3 (download, then assemble and load). The original prototype is `reference/mitunet-wall-test.ipynb` cells 0-2.
- **Key detail:** the network is built as `smp.Unet("mit_b4", classes=1, decoder_attention_type="scse")`, and its encoder is replaced by the encoder of a freshly built `smp.Segformer("mit_b4")`. The parameter names then match the checkpoint.

### 2.4 Probability map

- **What it does:** keeps the sigmoid output as a float map in [0,1]. It is not thresholded straight to a binary mask. The map is resized back to the crop size with bilinear interpolation and cached as `wall_prob_crop.npy` (geometry-v2 cell 4, last lines).
- **Why:** the binary mask becomes a derived artifact. Hysteresis, the seal-risk check and the wall-ink gate all need the confidence values. The cached map also lets every later stage run on a CPU (`local/consensus_lab.py`).
- **Real output:** a `(2048, 2730)` map for plan 10052 and a `(1253, 900)` crop for plan 6044 (`v9_out.txt`, `v7_out.txt`).

### 2.5 Vectorization, part 1: hysteresis healing (Layer 2)

- **What it does:** `skimage.filters.apply_hysteresis_threshold(prob, low=0.25, high=0.50)`. Pixels at or above 0.50 are wall. Pixels at or above 0.25 count as wall only if they connect to strong wall (geometry-v2 cell 5; `consensus_lab.py:669`).
- **Why:** it heals breaks where the model's confidence dipped without disappearing.
- **Metric:** connected wall components, where the ideal is 1. Real results: naive 10 and hysteresis 10 (v3); 8 and 8 (v5-v8); 6 and 6 (v9). **On these samples hysteresis did not merge any fragments.** That is an honest finding: the CubiCasa seal hints in section 2.7 did the heavy lifting.

### 2.6 Vectorization, part 2: wall thickness and micro-gap sealing (Layer 1)

- **What it does:** `dist = distanceTransform(mask)` and `skel = skeletonize(mask)`. Then `t_med = 2 x median(dist[skel])` gives the median wall thickness in pixels. A morphological CLOSE with a square kernel of `int(1.5 x t_med) | 1` seals hairline breaks. Door-size openings, about 3x thickness, survive (geometry-v2 cell 6; `consensus_lab.py:683`).
- **Why:** every later tolerance is a multiple of `t_med`, so the pipeline behaves the same at any image resolution.
- **Real values:** t_med 24 px with a 37 px kernel (v3), 22 with 33 (v5-v8), 26 with 39 (v9).
- **Known risk:** the CLOSE can weld a corridor narrower than the kernel. The local harness flags any seal that is both low-probability and larger than 2 x t_med². On plan 10052 it found 22 seals covering 2592 px², with **0 flagged** (`local/out/run_log.txt`).

### 2.7 Virtual seals from CubiCasa (labeling copy only)

- **What it does:** builds `seal_mask = mask OR rasterized CubiCasa walls` and adds a bar across each CubiCasa door or window. Each bar is 1.6 x the opening width, oriented along the nearest CubiCasa wall, and at least `max(6, t_med)` px thick (geometry-v2 cell 7; `consensus_lab.py:743`).
- **Why:** rooms must be sealed pockets before labeling, or they leak into each other and into the outside. MitUNet's probability is about 0 along window runs, and hysteresis sweeps from 0.02 to 0.30 gave zero rooms (amendment 2 in `planliftar-v1.md`).
- **Rule:** seals are never exported. Geometry still comes from MitUNet and the label map.
- **Real output:** 182,822 CubiCasa wall px and 16 opening bars (`v9_out.txt`).

### 2.8 Rooms-first region extraction

- **What it does:** runs `cv2.connectedComponentsWithStats(NOT seal_mask, connectivity=4)`. Labels whose bounding box touches the image border are exterior. The remaining labels with area at or above `MIN_ROOM_AREA` are rooms. Each room outline is traced with `findContours` and simplified with `approxPolyDP(eps = 0.01 x perimeter)` (geometry-v2 cell 8; `consensus_lab.py:1000`).
- **Why:** the polygons are **closed by construction**, and there is no line-stitching code (`merge_walls()` from `mitunet-wall-test.ipynb` cell 6 was deleted). The earlier Hough approach turned 18 fragments into 9 walls but left gaps that became holes in 3D (`planliftar-v1.md`, "Context and goal").
- **Local addition, the wall-ink gate:** a region is dropped if the mean wall probability over its bounding box is below 0.5x the image mean **and** the region covers at least 10% of the image. This removed the page-margin "room" (label 2, bbox mean 0.0030 = 0.039x the image mean, 18.6% of the image), so rooms went from 14 to 13 (`run_log.txt`; `consensus_lab.py` CFG comments at lines 81-135).

### 2.9 Nearest-label wall derivation

- **What it does:** runs `scipy.ndimage.distance_transform_edt(labels==0, return_indices=True)`, which assigns every wall pixel to its nearest region label. Wherever two neighbouring wall pixels carry different labels, that border is a wall run between those two rooms, or between a room and the exterior. Each run is simplified with `approxPolyDP(eps=3)`. Its thickness is `2 x dist` at the midpoint, and it records `between` and `exterior` flags (geometry-v2 cell 8, second half).
- **Why not dilate-and-intersect:** adjacent regions sit a full wall thickness apart, so one-pixel dilations never meet.
- **Local post-processing** (`consensus_lab.py:933`): removes reversed duplicates, snaps runs within 10° to the nearest axis, merges collinear runs, and drops stubs shorter than t_med. **240 raw runs become 146, then 75, then 73 final runs** (`run_log.txt`). The notebook export still carries the raw runs: 240 in v9, 244 after door carving.

### 2.10 Consensus check with CubiCasa (Layer 3)

- **Inputs:** MitUNet room labels and CubiCasa room polygons from `cubicasa_rooms_fixtures.json`, rasterized into crop coordinates.
- **Filters (geometry-v2 cell 10):** CubiCasa rooms with less than 50% of their area inside the crop are dropped. So are rooms whose pixel centroid does not land in a MitUNet room.
- **Legacy score:** builds the IoU matrix, runs the Hungarian match (`scipy.optimize.linear_sum_assignment`) with a 0.5 IoU floor, and computes `consensus = matches / max(n_mitunet, n_cubicasa)` (geometry-v2 cells 9-10).
- **Graded score (local):** each CubiCasa room is credited to the MitUNet region that overlaps it most. If that region owns more than 50% of the room, all rooms sharing the region are scored together as one IoU against the union of their masks, so a clean open-plan merge scores 1.0. Otherwise the room keeps its own plain IoU. The final score is the area-weighted mean (`consensus_lab.py:368`).
- **Why consensus is advisory:** both sources are model inference and both hallucinate. Agreement is evidence, not ground truth (`planliftar-v1.md`, "Design correction").
- **Real results on plan 10052:** the legacy score is **0.071** in the notebook (`v9_out.txt`) and **0.077** locally. The graded score is **0.343** (`run_log.txt`). The bedroom scores IoU 0.748, and the kitchen 0.448, just under the cutoff. Plan 6044 reached **0.30** in run v8.
- **Why the score is low:** `local/README.md` traces it to four stacked causes. Phantom margin rooms make up 47% of MitUNet's room pixels. 71% of CubiCasa's room list is fragments. The centroid filter drops the two largest real CubiCasa rooms, 52.7% of CubiCasa's room area. And the kitchen misses the cutoff by 0.052. Note: the README's findings describe the pre-gate state (14 rooms). The current harness output is 13 rooms.

### 2.11 Watershed virtual split (Layer 4)

- **What it does:** if routing marks `merged_rooms`, each MitUNet region holding two or more CubiCasa centroids is split by `skimage.segmentation.watershed(-distance, markers=centroids, mask=region)`, and the result is scored again. The final consensus is `max(before, after)` (geometry-v2 cell 11; `consensus_lab.py:1316`).
- **Locked rule:** the split exists only for scoring and **never adds exported walls**. The pipeline does not invent walls in open space.
- **Real results:** the split made things worse on both samples, 0.30 to 0.27 (v8) and 0.07 to 0.06 (v9), because the extra seeds were CubiCasa fragment noise (`local/README.md`). It does not fire in the current local run: 13 regions stay 13.

### 2.12 Invariants and the acceptance barrier (Layer 5)

- **Hard invariants (geometry-v2 cell 10):** every polygon is closed, which here means at least 3 vertices and non-zero shoelace area. Every room meets `MIN_ROOM_AREA`. There are between 1 and 40 rooms, and at least one room.
- **Warning only:** loose wall endpoints. Freestanding half-walls are legitimate. The local tolerance is 1.0 x t_med.
- **Routing:** if consensus is low and the invariants hold, the plan is accepted with the note `merged_rooms`. If consensus is low **and** an invariant fails, `needs_repair` is set and the plan is rejected. A room-count mismatch alone never triggers repair.
- **Barrier (geometry-v2 cell 12):** writes `acceptance_report.json` with `{accepted, reject_reasons[], notes[], metrics{...}}`. The reasons are `no_rooms`, `open_polygon`, `room_below_min_area`, `room_count_implausible` and `low_consensus_with_geometry_anomaly`. **A rejected plan writes no geometry.**
- **Real result:** every run from v6 to v9 is `accepted: true` with `notes: ["merged_rooms"]` and `loose_endpoints: 0`.

### 2.13 JSON export (doors carved)

- **Door carving:** `carve_doors()` splits a wall run wherever a door opening lies within `max(t_med, width/2)` of it. Remnants of 4 px or less are dropped. Windows stay solid (geometry-v2 cell 13).
- **Schema 2.0:** `walls[{id,start{x,y},end{x,y},thickness(px),between,exterior}]`, `rooms[{id,polygon,area_px}]`, `fixtures[]`, `scale{units:"relative_px", user_scale_required:true}`, and `acceptance`. Coordinates are shifted back to the full sheet by the crop offset.
- **Real output:** 116 runs became 121 after carving (v7/v8). 240 became 244 (v9).

### 2.14 Gap closure (`plan_ops`)

- **Normalisation:** `normalize_plan()` (`deliverables/plan_ops.py:59`) brings the three schemas in the repo (1.0, the metre-based fork, and 2.0) to one form: points as `{x,y}`, thickness in px, height in metres. It is idempotent.
- **Gap closure:** `close_wall_gaps()` (`plan_ops.py:144`) welds dangling endpoints with axis-aligned connectors. Gaps up to 3 x t_med are filled as junctions. A gap with a door on it is left open. A longer gap is filled only if a window lies on the line. The search radius is capped at 40 x t_med, and the pass has a 5000-wall cap and a 2 s budget. `prepare_plan()` (`plan_ops.py:434`) chains the two steps.
- **Browser copy:** the JavaScript port in `deliverables/livemap/plan_ops.js:171` is kept identical by `local/test_plan_ops_parity.py`.
- **Real results** (from running `prepare_plan` unmodified on `livemap/plans/`):

  | Plan | Walls in | Connectors added | Gaps left open |
  |---|---|---|---|
  | rooms-first cubicasa plan | 244 | 4 | 0 |
  | line-first `newri-mitunet-geometry` | 9 | 6 | 6 |

### 2.15 GLB / 3D extrusion

- **What it does:** `build_glb()` (`deliverables/glb_builder.py:59`; notebook copy in geometry-v2 cells 14-15) calls `prepare_plan` first. It then makes one `trimesh` box per wall with extents length x thickness x height. Plan coordinates map to world as (x, y) to (x, −y), with y pointing up. The model is recentred on the footprint centre and gets a 0.02 m floor slab with a 0.1 m margin.
- **Scale:** the placeholder is 100 px/m. The real scale is supplied in AR.
- **Real output:** 121 walls, 976 vertices and 1464 faces, 8.14 x 10.98 m (v7/v8). 244 walls, 1960 vertices and 2940 faces, 20.92 x 12.65 m (v9).

### 2.16 AR placement and scale

- **Client:** `deliverables/livemap/ar.html`, using WebXR on top of ARCore in Chrome for Android, with three.js. The Unity equivalent is scaffolded in `deliverables/unity/TapToPlaceFloorPlan.cs` (ARRaycastManager plus `AttachAnchor`, line 133).
- **Placement:** a hit-test against detected surfaces (`ar.html:1457`, `:1522`). **Place works only on a tracked (green) ring.** An estimated amber ring, a guess 1.4 m below the camera, cannot be used to place (`ar.html:1310`, `:1628`). An anchor is created at the hit (`ar.html:1885`). Small corrections are smoothed (τ = 0.12 s) and corrections above 0.25 m snap instantly (`ar.html:1330`). The model is hidden while position tracking is lost (`ar.html:1968`).
- **Scale has two independent factors:**
  - `ppm`: plan pixels per real metre, `longest plan side px / user-typed metres` (`ar.html:848`). It sits inside the plan-to-local mapping `localX = (px−cx)/ppm`, `localZ = −(py−cy)/ppm` (`ar.html:942`).
  - `modelDenom`: a 1:N miniature factor (1 to 200), applied only as a uniform group scale. That keeps the live-map pose in true plan pixels, because `worldToLocal` undoes it (`ar.html:97-112`).
- **Live map:** the pose is streamed as `{x, y, yaw_deg}` at 10 Hz to the laptop live map (`DEFENSE_NOTES.md` §2).

---

## 3. Neural network architectures

### 3.1 MitUNet (wall segmentation, primary geometry source)

| Item | Value |
|---|---|
| Paper | Parashchuk, Kaspshitskiy, Karyakin, "Enhancing Floor Plan Recognition: A Hybrid Mix-Transformer and U-Net Approach for Precise Wall Segmentation", *Machine Vision and Applications* 37 (2026), [arXiv:2512.02413](https://arxiv.org/abs/2512.02413) |
| Code | <https://github.com/aliasstudio/mitunet> (MIT License) |
| Encoder | **MiT-b4** Mix-Transformer from SegFormer ([Xie et al. 2021, arXiv:2105.15203](https://arxiv.org/abs/2105.15203)). Four hierarchical stages output 64/128/320/512 channels at 1/4, 1/8, 1/16 and 1/32 resolution, with depths 3/8/27/3. Overlapping patch embeddings, efficient self-attention (sequence-reduction ratios 8/4/2/1) and Mix-FFN, with no positional encoding |
| Decoder | **U-Net** ([Ronneberger et al. 2015, arXiv:1505.04597](https://arxiv.org/abs/1505.04597)) as implemented in segmentation-models-pytorch 0.5.0. Decoder channels are 256/128/64/32/16, each block being upsample x2, concat skip, then 2x (conv3x3-BN-ReLU). MiT has no 1/2-scale feature, so smp feeds an empty skip at that level |
| Attention | **scSE**, concurrent spatial and channel squeeze-and-excitation ([Roy, Navab, Wachinger 2018, arXiv:1803.02579](https://arxiv.org/abs/1803.02579)), applied in every decoder block after the skip concatenation and after the convolutions. It suppresses background noise such as text, hatching and furniture |
| Head | conv3x3 to **1 channel** (wall). The notebook applies a sigmoid |
| Input | **512x512 RGB**, ImageNet normalisation |
| Loss | Tversky loss ([Salehi et al. 2017, arXiv:1706.05721](https://arxiv.org/abs/1706.05721)) with α = 0.6, β = 0.4 per the upstream README |
| Training data | This checkpoint, `MitUNet_cubicasa-5k_..._30E.pth`, is the **CubiCasa5k-trained** model. By its name it is MiT-b4, Tversky loss and 30 epochs. The meaning of "a62" and "7666" is not documented upstream, so do not cite it. Upstream also publishes a fine-tune on a regional dataset ([Zenodo 10.5281/zenodo.17871079](https://doi.org/10.5281/zenodo.17871079)) |
| Size | 257.4 MB fp32 checkpoint, about 64 M parameters (inferred from the file size; `v9_out.txt`) |
| Published accuracy | On the regional dataset: mIoU 87.91%, Boundary IoU 85.01%, Precision 94.82%, Recall 92.35%, Accuracy 98.86% (upstream README). **Not re-measured in this repo** |
| License | Weights **CC BY-NC 4.0**, inherited from CubiCasa5k |

### 3.2 CubiCasa5k multi-task network (second opinion: rooms, doors, windows)

| Item | Value |
|---|---|
| Paper | Kalervo, Ylioinas, Häikiö, Karhu, Kannala, "CubiCasa5K: A Dataset and an Improved Multi-Task Model for Floorplan Image Analysis", SCIA 2019, [arXiv:1904.01920](https://arxiv.org/abs/1904.01920) |
| Code | <https://github.com/CubiCasa/CubiCasa5k> |
| Lineage | Based on Raster-to-Vector ([Liu, Wu, Kohli, Furukawa, ICCV 2017](https://openaccess.thecvf.com/content_iccv_2017/html/Liu_Raster-To-Vector_Revisiting_Floorplan_ICCV_2017_paper.html)), hence the name `hg_furukawa_original`. The hourglass design follows [Newell et al. 2016, arXiv:1603.06937](https://arxiv.org/abs/1603.06937) |
| Backbone | A single hourglass. Stem: 7x7 stride-2 conv to 64 channels, then max-pool, then residual blocks to 256 channels. Encoder: four more 2x2 pools down to 1/64, with residual blocks at 256 channels (512 at the deepest level) and parallel skip branches. Decoder: four 512-channel transposed-conv x2 stages added to the skips. Head: 1x1 convs 512 → 512 → 256 → 44, then a transposed conv (k4, s4) back to full resolution ([source](https://github.com/CubiCasa/CubiCasa5k/blob/master/floortrans/models/hg_furukawa_original.py)) |
| Heads | 44 channels, split `[21, 12, 11]` (planliftar_cubicasa cell 3): **21 junction heatmaps** (sigmoid), **12 room classes** (Background, Outdoor, Wall, Kitchen, Living Room, Bed Room, Bath, Entry, Railing, Storage, Garage, Undefined) and **11 icon classes** (class 1 = Window, class 2 = Door are used as fixtures) |
| Loss | Multi-task loss with learned uncertainty weights ([Kendall, Gal, Cipolla 2018, arXiv:1705.07115](https://arxiv.org/abs/1705.07115)) |
| Input | Native resolution with no resize, scaled to [−1, 1] |
| Post-processing | `get_polygons(..., threshold 0.1, opening classes [1,2])` joins junctions into wall rectangles and room polygons (cell 3). `rect_to_centerline()` turns wall rectangles into centre lines (cell 4) |
| Training data | CubiCasa5k: 5000 annotated Finnish floor plans with 80+ object categories ([Zenodo 2613548](https://zenodo.org/records/2613548)) |
| License | **CC BY-NC 4.0** ([LICENSE](https://github.com/CubiCasa/CubiCasa5k/blob/master/LICENSE)) |

### 3.3 Classical algorithms used

| Algorithm | Where | Reference |
|---|---|---|
| Hysteresis thresholding | Layer 2 | Canny 1986; [`skimage.filters.apply_hysteresis_threshold`](https://scikit-image.org/docs/stable/api/skimage.filters.html#skimage.filters.apply_hysteresis_threshold) |
| Distance transform and skeletonization | t_med and wall thickness | OpenCV `distanceTransform`; [`skimage.morphology.skeletonize`](https://scikit-image.org/docs/stable/api/skimage.morphology.html#skimage.morphology.skeletonize) |
| Hough transform | Original prototype only (`mitunet-wall-test.ipynb` cell 4: `HoughLinesP(1, π/180, 30, minLineLength=25, maxLineGap=8)`) | Replaced by rooms-first extraction |
| Connected components | Room regions | OpenCV `connectedComponentsWithStats` |
| Douglas-Peucker | Polygon simplification | OpenCV `approxPolyDP` |
| Hungarian algorithm | Room matching | Kuhn 1955; [`scipy.optimize.linear_sum_assignment`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.linear_sum_assignment.html) |
| Watershed | Virtual split, scoring only | Beucher & Meyer; [`skimage.segmentation.watershed`](https://scikit-image.org/docs/stable/api/skimage.segmentation.html#skimage.segmentation.watershed) |

---

## 4. Diagram and chart specs for the frontend

The full data is in [`model_viz_data.json`](./model_viz_data.json), which has this shape:

```
{ meta,
  pipeline: { nodes:[{id,label,group,desc}], edges:[[from,to]] },
  architecture: { blocks:[{model,id,label,detail,shape,next[]}], models:[...] },
  charts: [{id,title,type,xLabel,yLabel,series:[{name,data:[[x,y]]}],caption,source}],
  glossary:[{term,def}], faq:[{q,a}] }
```

**Pipeline flowchart.** 18 nodes and 20 edges. Colour nodes by `group`: input, preprocess, neural, data, vectorize, check, output, ar. The two network nodes (`mitunet`, `cubicasa`) feed the vectorize lane and the check lane respectively.

**Architecture block diagram.** Filter `architecture.blocks` by `model` and draw the `next` links:
- **MitUNet:** a U shape. Encoder stages go down the left, decoder blocks come up the right, and skip links run from `mit_s1`, `mit_s2` and `mit_s3` to `mit_d3`, `mit_d2` and `mit_d1`.
- **CubiCasa:** an hourglass with three output heads fanning out.

**Charts** (every value is real; the source is in each entry):

| id | type | What it shows | Source |
|---|---|---|---|
| `kaggle_run_evolution_rooms` | bar | Rooms per run: 0, 0, 5, 5, 5, 5, 14 | `v3`-`v9` logs |
| `kaggle_run_consensus` | bar | 0.103, 0.107, 0.30, 0.071, plus after-split values | `v6`-`v9` logs |
| `healing_components` | grouped bar | Fragments after naive, hysteresis and CLOSE | `v3`, `v5`, `v9` logs |
| `wall_thickness_tmed` | bar | t_med and seal kernel per run | logs |
| `wall_postprocess_funnel` | funnel | 240 → 146 → 75 → 73 | `local/out/run_log.txt` |
| `graded_consensus_per_room` | horizontal bar | 11 CubiCasa rooms; bedroom 0.748, kitchen 0.448 | `local/out/diagnostics.json` |
| `consensus_metric_comparison` | bar | 0.071 / 0.077 / 0.343 vs the 0.70 target | `v9_out.txt`, `run_log.txt` |
| `resolution_invariance` | grouped bar | 0.5x / 1x / 2x: 13 rooms each, wall length within 1% | `local/out/test_resolution_output.txt` |
| `consensus_monotonicity` | line | Score equals overlap from 10% to 100% | `local/out/test_consensus_metric_output.txt` |
| `gap_closure_per_plan` | grouped bar | Connectors needed by each plan | computed with `plan_ops.py` |
| `glb_output_size` | table | Mesh counts and footprint in metres | `v7`-`v9` logs |
| `mitunet_published_metrics` | bar | Upstream mIoU and related scores (not ours) | MitUNet README |

The local overlay image `local/out/consensus_overlay.png` and the QA figures in
`deliverables/livemap/qa/` (`phase1_gate.png`, `phase2_qa.png`, `consensus_overlay.png`)
can sit next to the charts as real visual evidence.

---

## 5. Glossary

These are the key terms in short form. The full list of 32 terms is in `model_viz_data.json`.

- **Segmentation:** labelling each pixel. Here, wall or not wall.
- **Probability map:** each pixel's confidence (0 to 1) that it is wall.
- **Encoder / decoder:** the encoder compresses the image into features. The decoder expands them back into a full-size mask.
- **Transformer (MiT):** attention layers that let every part of the plan "see" every other part.
- **U-Net skip connections:** pass fine detail from encoder to decoder, which gives sharp, thin walls.
- **scSE:** small gates that emphasise useful channels and locations and damp noise.
- **Tversky loss:** a training objective that weighs missed walls and false walls differently.
- **Hysteresis:** two thresholds. Faint pixels count only when they touch confirmed wall.
- **t_med:** the median wall thickness of this image. Every tolerance is a multiple of it.
- **Morphological closing:** fills gaps narrower than a kernel and keeps doorways.
- **Rooms-first:** find the enclosed spaces, then take walls from their borders.
- **IoU:** overlap divided by combined area.
- **Hungarian matching:** the best one-to-one pairing between two lists.
- **Consensus:** agreement between the two models. Evidence, not truth.
- **Watershed:** a flooding split used here only to score merged rooms.
- **Invariants / acceptance barrier:** hard rules and the single accept-or-reject exit.
- **GLB:** the binary 3D model file format.
- **Hit test / anchor:** finding a real surface, then pinning the model to it.
- **ppm:** plan pixels per real metre, set by one typed measurement.
- **CC BY-NC 4.0:** a non-commercial licence. It covers both pretrained models.

## 6. FAQ for the panel

**Did you build or train the AI?**
No new network was trained. We use two published pretrained models. The contribution is the pipeline: probability-map healing, rooms-first geometry, two-model consensus, the acceptance barrier, gap closure, and the AR client with user-supplied scale.

**Why two models?**
Independent errors. Agreement is evidence and disagreement is a flag. Neither model adjudicates the other (`planliftar-v1.md`, "Design correction").

**The consensus score is far below 0.70. Isn't that a failure?**
The legacy formula (0.071-0.077) is dragged down by documented measurement artefacts (section 2.10). The graded metric gives 0.343 on the same plan. The 0.70 threshold is an uncalibrated config value, and calibration was deferred by decision (`planliftar-v1-execution.md`, Phase 2 gate). Acceptance depends on the hard invariants, not on consensus alone.

**How do you know the size of the building?**
We do not infer it. The export is unitless, and the user types one real dimension in AR.

**Does resolution matter?**
No, by design. At 0.5x, 1x and 2x the pipeline gives the same 13 rooms, with wall length within 1.0% and area within 1.1% (`test_resolution_output.txt`).

**What about open-plan spaces?**
They export as one room with a `merged_rooms` note. The pipeline never invents walls.

**Can the 3D model have holes or blocked doors?**
Rooms are closed by construction. Gap closure fills only gaps backed by evidence, and door spans are carved open. A plan that fails the invariants produces no model at all.

**Is it commercially usable?**
Not with these weights, because of CC BY-NC 4.0. Retraining on owned data is budgeted before launch (`planliftar-v1.md`, "Risks").

**How accurate is the wall model?**
The authors report 87.91% mIoU on their dataset. We have not measured pixel accuracy on our own labels. Our evidence is geometric.

**What are the known weaknesses?**
- Margin regions can be counted as rooms. This is now gated in the local harness.
- The CLOSE seal could weld a narrow corridor. This is instrumented, with 0 flags so far.
- Derived walls show approxPolyDP staircase artefacts, with about 12-15% of wall length off-axis (`consensus_lab.py` CFG comment).
- The single-point centroid filter can discard large rooms.
- Consensus has been run on only two samples.

---

## 7. Porting notes (local inference server)

### 7.1 Weights

| Model | File | How to get it |
|---|---|---|
| MitUNet | `MitUNet_cubicasa-5k_a62_mit_b4_tversky_7666_30E.pth` (257.4 MB) | `wget -O <file> https://media.githubusercontent.com/media/aliasstudio/mitunet/master/experiments/models/MitUNet_cubicasa-5k_a62_mit_b4_tversky_7666_30E.pth` (GitHub LFS media host, no git-lfs needed; geometry-v2 cell 2). The best upstream fine-tune is `mitunet_finetune_a6_mit_b4_tversky_8864_28E.pth` in the same folder; the source comment says to swap it in for regional plans |
| CubiCasa | `model_best_val_loss_var.pkl` | `pip install gdown && gdown 1gRB7ez1e4H7a9Y09lLqRuna0luZO5VRK -O model_best_val_loss_var.pkl` (Google Drive; [link](https://drive.google.com/file/d/1gRB7ez1e4H7a9Y09lLqRuna0luZO5VRK/view)). It also needs the repo code: `git clone --depth 1 https://github.com/CubiCasa/CubiCasa5k.git` and `floortrans` on `sys.path` |

### 7.2 Loading code (exact)

```python
# MitUNet  (geometry-v2 cell 3)
import segmentation_models_pytorch as smp, torch
aux = smp.Segformer(encoder_name="mit_b4", encoder_weights=None)
model = smp.Unet(encoder_name="mit_b4", encoder_weights=None, in_channels=3,
                 classes=1, decoder_attention_type="scse")
model.encoder = aux.encoder
model.load_state_dict(torch.load(WEIGHTS, map_location=DEVICE, weights_only=True))
model.eval()

# CubiCasa  (planliftar_cubicasa cell 1)
from floortrans.models import get_model
model = get_model('hg_furukawa_original', 51)
model.conv4_   = torch.nn.Conv2d(256, 44, bias=True, kernel_size=1)
model.upsample = torch.nn.ConvTranspose2d(44, 44, kernel_size=4, stride=4)
ckpt = torch.load('model_best_val_loss_var.pkl', map_location=DEVICE, weights_only=False)
model.load_state_dict(ckpt['model_state']); model.eval()
```

### 7.3 Dependencies

Observed on Kaggle: torch 2.10.0+cu128 on a Tesla T4 (`v9_out.txt`).

- **Inference:** `segmentation-models-pytorch==0.5.0` (pinned), `torch`, `albumentations`, `opencv-python-headless`, `numpy`.
- **Geometry:** `scikit-image` (hysteresis, skeletonize, watershed), `scipy` (ndimage EDT, linear_sum_assignment).
- **CubiCasa post-processing:** `shapely`.
- **Export:** `trimesh` (GLB).
- **Downloads:** `gdown`, `wget` or `requests`.
- **Local harness** (`consensus_lab.py` imports): cv2, numpy, scipy, scikit-image. No torch needed.

### 7.4 Gotchas when porting CubiCasa

1. **Pickle loading:** `torch.load(..., weights_only=False)` is required because the `.pkl` contains a pickled dict. Torch 2.6+ defaults to `weights_only=True`. Unpickling can run arbitrary code, so do it once, in an isolated environment, on a file whose hash you have recorded. Re-save just `ckpt['model_state']` with `torch.save`, and have the server load that with `weights_only=True`.
2. **Removed scipy import:** patch `floortrans/post_prosessing.py` to replace `from scipy.ndimage import measurements` with `import scipy.ndimage as measurements` (cell 0, done with `sed`).
3. **`scipy.stats.mode` behaviour change:** add a compat shim that defaults `keepdims=True` (cell 2).
4. **Hard-coded CUDA:** the notebook uses `map_location='cuda'` and `.cuda()`. Change both to `DEVICE` for a CPU server.
5. **Memory:** CubiCasa runs at **native resolution**, so memory grows with image size. Cap or downscale large uploads on a CPU host. Note that CubiCasa coordinates are then in the scaled frame, and the consensus code only *translates* by the crop offset and never rescales.

### 7.5 Serving shape

- **Contract:** the planned design is a REST async job. `POST /plans` returns `202 {job_id}`. `GET /plans/{job_id}` returns either the geometry JSON (accepted) or `acceptance_report.json` (rejected) (`planliftar-v1.md`, "Backend transport"). The Unity client already targets it (`deliverables/unity/FloorPlanApiClient.cs`).
- **Current server:** `deliverables/livemap/server.py` today serves static pages and the pose hub. It does not run inference yet.
- **Reuse:** only the two forward passes need a GPU. Everything after the probability map can reuse `local/consensus_lab.py`'s `stage_*` functions on a CPU, which already include the t_med-relative fixes, the wall-ink gate and the graded consensus. Note that these differ from the Kaggle notebook, so pick one as the reference before porting.
- **Weights at startup:** load both models once at startup. MitUNet input is fixed at 512x512, so per-request cost is about constant.

### 7.6 Licence reminder

Both checkpoints are CC BY-NC 4.0. A local server for the thesis, demos and research is fine. Any commercial deployment needs retrained weights.
