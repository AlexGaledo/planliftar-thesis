# Model and pipeline improvements for real client uploads

Status: research note, 2026-11-20. Scope: what to change so PlanLiftAR holds up on
what clients actually upload (phone photos of printed plans, scans, PDFs exported
to PNG, coloured real-estate plans, hand-annotated sheets). The current pipeline
was tuned on clean CubiCasa5k rasters.

## Where we are (baseline)

| stage | today | known weakness |
|---|---|---|
| walls | MitUNet (MiT-b4 encoder + U-Net/scSE decoder, Tversky loss, CubiCasa5k checkpoint), 512x512 input, auto-crop 2nd pass | 512x512 resize of the whole sheet throws away detail on large or photographed plans; trained only on clean rasters |
| openings / room types | CubiCasa5k hourglass multi-task net (2019) | slow post-processing (pure Python); weak on non-CubiCasa styles |
| geometry | rooms-first: hysteresis -> micro-gap seal -> CubiCasa door/window bars -> connected regions -> wall runs | **door bars come only from CubiCasa**: measured on the 10052 sample, MitUNet-only finds 2 rooms instead of 6 because rooms leak through doorways |
| scale | none, `user_scale_required: true` | user must type a scale in AR |
| preprocessing | none | no deskew, no perspective correction, no contrast normalisation |

The local engine (`backend/planliftar_engine`) now makes every recommendation
below testable on the laptop in seconds instead of a Kaggle round-trip, which is
itself the biggest enabler.

### Finding: the Kaggle reference run paired CubiCasa hints from a different image

`out-cubicasa/*.json`, which fed the Kaggle `v9_out.txt` / `floorplan.json` run,
records `original_width_px x height = 3507 x 2480`. `colorful/10052/F1_original.png`
is **2730 x 2048**, and its CubiCasa walls in that file sit only in `x:[1064,1855]`,
while the real plan spans `x:[~100,~2640]`. So the seals and consensus in
`floorplan.json` came from another plan's CubiCasa output. That explains the
"consensus 0.07" puzzle in `local/README.md`, and it means `floorplan.json` is not
ground truth for the CubiCasa half. The local engine runs both models on the same
image and gives 6 visually correct rooms with graded consensus 0.329, vs 0.071.
The MitUNet half reproduces the Kaggle numbers exactly (t_med 26.0, 6 components,
22 seals).

## Ranked recommendations

Ranking = expected gain on real uploads / effort, for a thesis MVP deadline.
Effort: S = under 1 day, M = 1-3 days, L = a week or more.

| # | recommendation | gain | effort | do it? |
|---|---|---|---|---|
| 1 | Input normalisation: EXIF rotation, size cap, grey/contrast normalisation, background flattening | high on photos | S | yes, now |
| 2 | Document detection + perspective warp for phone photos | high on photos | S-M | yes, now |
| 3 | Tiled / higher-resolution MitUNet inference | medium-high on big sheets | S | yes |
| 4 | Test-time augmentation (flips; optional multi-scale) | low-medium, cheap | S | yes (flag exists) |
| 5 | Door bars without CubiCasa (MitUNet-only door sealing) | high for robustness | M | yes |
| 6 | Upload quality gate + user feedback | high for UX | S | yes |
| 7 | Scale from OCR of dimension / area text | high for AR UX | M | stretch |
| 8 | Replace CubiCasa post-processing for doors/windows with a small detector | medium | M-L | after MVP |
| 9 | Fine-tune MitUNet on a regional/photo set (+ synthetic photo augmentation) | highest long-term | L | after MVP |
| 10 | Newer end-to-end vectorisers (Raster2Seq, R2G) as a second opinion | unknown on our data | L | evaluate only |

### 1. Input normalisation (EXIF, size cap, contrast, background flattening)

- Rationale: phone photos arrive rotated (EXIF), at 12-50 MP, with uneven light and
  grey paper. MitUNet was trained on white-background rasters, and the hysteresis
  thresholds (0.25/0.50) assume that probability distribution.
- Expected gain: removes a class of total failures (rotated, all-grey). Small effect
  on clean scans.
- Effort: S. EXIF transpose and the 4096 px cap are already in `decode_image`.
- Sketch:
  ```python
  g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
  bg = cv2.medianBlur(cv2.dilate(g, np.ones((7, 7))), 31)       # paper estimate
  flat = cv2.divide(g, bg, scale=255)                           # remove shading
  flat = cv2.createCLAHE(2.0, (8, 8)).apply(flat)
  img = cv2.cvtColor(flat, cv2.COLOR_GRAY2RGB)
  ```
  Put it behind `PipelineOptions.preprocess="auto"`. Apply it only when the image
  looks like a photo (low fraction of pure-white pixels, or EXIF camera tags), so
  clean digital plans keep their current results. Check it with the
  `t_med`/component metrics in `debug`.
- Sources: DocRes, a generalist document restoration model covering dewarping,
  deshadowing and appearance enhancement: https://arxiv.org/pdf/2405.04408

### 2. Perspective correction for phone photos

- Rationale: a 10-20 degree tilt makes parallel walls converge. The rooms-first
  geometry and axis-snap (`WALL_SNAP_ANGLE_DEG = 10`) then produce slanted walls,
  and AR placement inherits the skew.
- Expected gain: large on handheld photos, none on scans.
- Effort: S for classical, M for a learned dewarper.
- Sketch (classical, no new deps): find the largest 4-point contour on Canny edges
  (the paper sheet), then `cv2.getPerspectiveTransform` and `warpPerspective`. If
  there is no clean quad, fall back to a deskew. Take the dominant angle from
  `cv2.HoughLinesP` on the MitUNet mask (walls are mostly orthogonal) and rotate by
  minus that angle. Keep the homography in the output (`source.homography`) so
  the UI can map back. Learned option: DocTr++ or the YOLO plus polynomial hybrid
  below, only if the classical quad fails often.
- Sources:
  - DocTr / DocTr++ (geometric unwarping transformer): https://arxiv.org/abs/2110.12942v2 , https://arxiv.org/pdf/2304.08796
  - YOLOv8 doc detection plus classical geometric restoration, reported to beat DocTr++ and CamScanner: https://arxiv.org/abs/2501.03145v3

### 3. Tiled / higher-resolution MitUNet inference

- Rationale: the notebook resizes the whole sheet to 512x512. On the 2730x2048
  sample one network pixel covers about 5x4 image pixels, close to the 26 px wall
  thickness. Thin interior walls and small closets are where tiling helps. The
  MitUNet paper trains on 512 crops, so inference on 512 tiles at native scale
  matches training better than one squashed sheet.
- Expected gain: medium. Thinner walls survive and doorway edges get sharper,
  which helps the micro-gap seal.
- Effort: S. VRAM is not a constraint: each 512 tile is about 0.6 GB in fp32.
- Sketch: resize so `t_med` lands near the training distribution (about 8-12 px at
  512), then run overlapping 512 tiles (stride 384) with a cosine blending window,
  batched 4 at a time. Add `PipelineOptions.mitunet_mode = "resize" | "tiled"`.
  Validate with `local/test_resolution.py`-style invariance checks, comparing room
  counts and `t_med` between modes.
- Sources: MitUNet paper (architecture, training at 512, Tversky loss): https://arxiv.org/html/2512.02413

### 4. Test-time augmentation

- Rationale: wall segmentation is flip-invariant. Averaging flips smooths the
  low-confidence breaks that the hysteresis layer exists to heal.
- Expected gain: low-medium. Fewer hysteresis components, fewer suspicious seals.
- Effort: S, and already implemented: `PipelineOptions(mitunet_tta=True)` or CLI
  `--tta` (3 passes, well under 1 s on the RTX 3050). Multi-scale TTA (0.75/1/1.25
  of the tile scale) is the next step.
- Measure: `components: naive -> hysteresis` and the `seal-risk` line in `debug.log`.

### 5. Door bars without CubiCasa

- Rationale: this is the most important robustness finding from the local port.
  The rooms-first labeling only works if doorways are closed for labeling. Today the
  bars come entirely from CubiCasa's opening detections. Measured on CubiCasa 10052,
  the MitUNet-only path gives **2 rooms vs 6** with CubiCasa. When CubiCasa fails
  on a client style, which is likely because it is the older and weaker model, room
  extraction collapses with it.
- Expected gain: high. It decouples room extraction from the weakest model.
- Effort: M.
- Sketch: doorways show up in the healed MitUNet mask as collinear wall-end pairs
  facing each other, about 0.7-1.2 m apart (roughly 2.5-5x `t_med` on typical
  plans). For each dangling skeleton endpoint, look along the wall direction for
  another endpoint within `[2, 6] x t_med` whose wall is collinear (perpendicular
  offset under `0.5 x t_med`). Draw a labeling-only bar between them, the same as
  the CubiCasa bars, and record the pair as a door fixture candidate. That gives
  doors even in MitUNet-only mode. This is the raster twin of
  `plan_ops.close_wall_gaps`, which already uses the same t_med-relative tolerances
  on vector walls. A cheaper first version is a second, directional morphological
  close (horizontal and vertical line kernels of length `5 x t_med`) used only for
  labeling. It is coarser and risks welding corridors; the seal-risk gate already
  measures that.

### 6. Upload quality gate and user feedback

- Rationale: a bad result with no explanation is worse than a clear "retake the
  photo". The acceptance barrier already rejects implausible geometry. Add
  pre-inference checks so the UI can say why.
- Effort: S.
- Sketch: before inference, compute blur (variance of Laplacian), mean brightness,
  and the white-paper fraction. After MitUNet, compute wall-pixel fraction (no walls
  means not a floor plan) and hysteresis component count. Return them under
  `acceptance.input_quality` with reasons such as `too_blurry`, `too_dark` or
  `no_walls_detected`. The FastAPI layer maps these to user-facing messages.

### 7. Scale from OCR of dimension / area text

- Rationale: `user_scale_required: true` makes the user type a scale in AR.
  Real-estate plans almost always print room areas ("10,0 m2" on the sample) or
  dimension strings ("3600", "12'-6\"").
- Expected gain: high for UX. Correctness can be self-checked.
- Effort: M.
- Sketch: run an OCR model (PaddleOCR or EasyOCR, both CPU-friendly) on the crop.
  Regex out `(\d+[.,]\d+)\s*m(2|²)` area labels. For each label inside a room
  polygon, `px_per_m = sqrt(area_px / area_m2)`. Take the median across rooms and
  report the spread as confidence. When the rooms disagree by more than 15%, fall
  back to `user_scale_required`; that also catches not-to-scale drawings. Dimension
  strings need leader-line association: harder, a second phase.
- Sources:
  - OCR-based scale detection in a floor-plan compliance pipeline: https://arxiv.org/pdf/2607.00015
  - Metric reference reconstruction from dimension text (EC3 2026): https://ec-3.org/wp-content/uploads/2026/08/EC32026_212.pdf
  - Practitioner approach (pytesseract plus clustering of area labels): https://towardsdatascience.com/finding-m²-details-on-a-floorplan-using-unsupervised-learning-f8f8891befa9/

### 8. Faster / better door and window detection

- Rationale: CubiCasa's `get_polygons` is slow pure-Python post-processing, and it
  dominates local runtime: about 25 s of a 50 s warm run on the RTX 3050, even after
  the engine's verified-equivalent speed-ups (it was about 375 s unpatched). Doors and windows are
  small, distinctive symbols, which suits a detector.
- Effort: M-L. A YOLO-family model fine-tuned on CubiCasa5k door/window boxes,
  derived from the SVG annotations or an existing Roboflow export.
- Sources:
  - Roboflow CubiCasa5k door/window/wall derivative: https://universe.roboflow.com/floorplan-recognition/cubicasa5k-2-qpmsa
  - Wall segmentation plus YOLO opening detection: https://arxiv.org/html/2408.01526v1
  - CubiCasa5K paper and repo: https://arxiv.org/pdf/1904.01920 , https://github.com/CubiCasa/CubiCasa5k

### 9. Fine-tune MitUNet for client styles

- Rationale: the MitUNet authors show that a regional fine-tune materially improves
  wall IoU on non-CubiCasa styles; their repo ships a regional fine-tune checkpoint.
  The cheapest real gain is to evaluate that checkpoint on our own client samples
  before training anything.
- Effort: S to evaluate the existing fine-tune (swap `MITUNET_FILE`); L to fine-tune
  on our own data, which needs about 50-100 labelled plans plus synthetic photo
  augmentation (perspective, blur, JPEG, shadows, paper texture).
- Datasets worth using:
  - MitUNet regional set (500 plans): https://doi.org/10.5281/zenodo.17871079
  - WAFFLE, in-the-wild multimodal floorplans: https://arxiv.org/pdf/2412.00955
  - FloorPlan8K (FloorPlanFormer, AAAI): https://ojs.aaai.org/index.php/AAAI/article/view/37625
  - MSD, Modified Swiss Dwellings (ECCV 2024): https://arxiv.org/pdf/2407.10121
  - FGSSNet (wall segmentation on real-world plans): https://arxiv.org/pdf/2507.10343

### 10. Newer end-to-end vectorisers (evaluate, don't adopt yet)

- Raster2Seq (SIGGRAPH 2026): polygon sequence generation with released CubiCasa5K
  checkpoints, and reported strong generalisation to in-the-wild plans. It is the
  most promising swap-in for room polygons, so run it as a third consensus voter
  first. https://arxiv.org/abs/2602.09016 , https://huggingface.co/haopt/Raster2Seq
- Raster-to-Graph (Eurographics 2024): autoregressive wall-junction graph with a
  10k-plan dataset. https://diglib.eg.org/handle/10.1111/cgf15007
- SALI-FP, evidence-gated multimodal parsing (2026 preprint, compares against
  MiT-UNet and Raster2Seq): https://arxiv.org/pdf/2609.25615
- RasterScan Floor-Plan-Recognition (open-source app):
  https://www.github.com/RasterScan/Floor-Plan-Recognition
- SAM-based: FloorSAM targets LiDAR point clouds, not raster plans, so it does not
  apply directly. https://arxiv.org/html/2509.15750v1 . A raster-plan variant
  (SAM prompted with MitUNet room seeds) is possible, but nothing published shows
  it beats a trained wall segmenter on line drawings.

## Suggested order for the MVP

1. Items 1, 2 and 6, preprocessing plus quality gate (about 2 days). Makes phone
   photos usable, or fail clearly.
2. Item 5, MitUNet door sealing (about 2 days). Removes the hard dependency on
   CubiCasa for room extraction.
3. Items 3 and 4, tiled inference with TTA (about 1 day). Validate on 10-20 real
   client plans with the existing room-count and `t_med` invariants.
4. Item 7, OCR scale (stretch).

To measure progress, collect about 20 real client uploads now and hand-mark room
counts and door counts. Track rooms found, false merges, and the accepted rate per
change. The `include_debug` log already exposes every intermediate metric.
