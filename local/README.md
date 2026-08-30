# consensus_lab -- local CPU diagnostic harness

Reproduces the post-inference half of `planliftar-geometry-v2/planliftar_geometry_v2.ipynb`
(cells 1, 5, 6, 7, 8, 9, 10, 11, 12 -- CFG through the acceptance barrier) on CPU, from
cached `.npy` probability maps, so room-consensus scoring can be iterated on without
touching Kaggle, GPU inference, or the notebook itself. Diagnostics only: no
scoring/routing formula was changed while porting.

## Run it

```
python local/consensus_lab.py
```

With no arguments this uses the pairing that was verified (see "Fidelity check" below)
to reproduce `v9_out.txt` exactly:

- `--wall-prob out/wall_prob_crop.npy` (float32, shape `(2048, 2730)`)
- `--fixtures out-cubicasa/cubicasa_rooms_fixtures.json` (31 CubiCasa rooms + 16 fixtures)
- `--geometry out-cubicasa/sample_geometry.json` (109 CubiCasa walls + 16 openings)
- `--crop-offset 0,0`

Writes:
- `local/out/run_log.txt` -- the same progress lines the notebook prints, diffable against `v9_out.txt`
- `local/out/diagnostics.json` -- Deliverable 2 (per-room IoU candidates, filter drops, IoU matrices, watershed block)
- `local/out/consensus_overlay.png` -- Deliverable 3 (visual)

### Args

| flag | default | meaning |
|---|---|---|
| `--wall-prob` | `out/wall_prob_crop.npy` | cached probability map (float32 HxW) |
| `--fixtures` | `out-cubicasa/cubicasa_rooms_fixtures.json` | CubiCasa `rooms`/`fixtures` |
| `--geometry` | `out-cubicasa/sample_geometry.json` | CubiCasa `walls`/`openings` (cell 7's real input -- see below) |
| `--crop-offset` | `0,0` | `cx0,cy0` shift applied to CubiCasa coords before rasterizing |
| `--reference-log` | `v9_out.txt` | log to diff the fidelity check against |
| `--out-dir` | `local/out` | output directory |
| `--hyst-low`, `--hyst-high`, `--seal-factor`, `--consensus-min`, `--min-room-area`, `--wall-height` | notebook CFG cell defaults | overridable for sweeps |
| `--match-min-iou` | `0.5` | not an official CFG constant -- it's the `min_iou=0.5` literal hardcoded into every `hungarian_match()` call in cells 7/8, broken out here so it can be swept too |

Example sweep:
```
python local/consensus_lab.py --hyst-low 0.20 --seal-factor 1.2 --out-dir local/out_sweep1
```

To explore the other cached array on purpose:
```
python local/consensus_lab.py --wall-prob out/wall_prob.npy --out-dir local/out_altprob
```
(this will *not* reproduce `v9_out.txt` -- see the data-pairing verdict below for why that's expected.)

## Fidelity check

Every printed metric from `local/out/run_log.txt` (component counts, t_med, seal kernel,
CubiCasa wall/opening px, labels/exterior/room counts, room vertex counts, wall-run count,
consensus, invariants, routing, watershed split, final `acceptance_report`-shaped JSON)
**reproduces `v9_out.txt` exactly** with the default args. `local/out/diagnostics.json`'s
`fidelity` block records this (`any_mismatch: false`).

## Data-pairing verdict

The task brief flagged a real-looking hazard: `v9_out.txt` reports a `(2048, 2730)` prob
map and "182822 CubiCasa wall px", but the local `out-cubicasa/cubicasa_rooms_fixtures.json`
has an **empty** `"walls": []` and a `metadata` size of `3507x2480` -- neither matches at a
glance. After tracing the actual code path, the verdict is: **it pairs cleanly, the hazard
was a false alarm caused by two easy-to-conflate details:**

1. **Cell 7 (the seal-layer cell) never reads `cubicasa_rooms_fixtures.json`'s `"walls"`
   field.** That field genuinely is empty in this file -- it's an unused placeholder. The
   walls that get rasterized into `cubi` (and produce the "182822 CubiCasa wall px" line)
   come from a *different* file, `sample_geometry.json`'s `"walls"`/`"openings"` (109 walls,
   16 openings). `out-cubicasa/sample_geometry.json` has real geometry and its opening
   count (16) already hinted at the pairing before I even ran anything.
2. **The `metadata.original_width_px/height_px: 3507x2480` in both `out-cubicasa` json
   files describes the full, un-cropped CubiCasa source canvas** -- it is never compared
   against the prob-map's shape anywhere in the pipeline, and no rescaling happens (`cell 7`
   only *translates* CubiCasa coordinates by `-cx0, -cy0`, it never scales them). Every real
   wall/opening coordinate in `sample_geometry.json` sits inside `x:[1064, 1855]`,
   `y:[160, 1600]` -- comfortably inside the `2730x2048` prob-map crop -- so the size
   mismatch in the metadata is cosmetically confusing but functionally inert.

**Verified empirically, not just argued:** `out/wall_prob_crop.npy` +
`out-cubicasa/cubicasa_rooms_fixtures.json` + `out-cubicasa/sample_geometry.json` with
`crop_offset=(0,0)` reproduce `v9_out.txt` line-for-line, including the final
`acceptance_report.json`-shaped block byte-for-byte (after JSON re-serialization). That is
about as strong a confirmation of correct pairing as is possible without the original
Kaggle session.

**The other two candidate pairings are genuinely bad, and are worth naming so nobody
reaches for them by default:**

- `out/wall_prob.npy` (`2480x3507`) is a size-consistent, visually coherent
  wall-probability map for a plan whose room-polygon outlines from
  `cubicasa_rooms_fixtures.json` line up with real wall ridges when overlaid (checked by
  eye) -- but it is **not** the array that produced `v9_out.txt`. Running the harness with
  it gives a completely different, self-consistent-looking but wrong story: naive/hysteresis
  components 10 vs the reference's 6, `t_med` 24.0px vs 26.0px, 7 labels / 4 rooms vs 19
  labels / 14 rooms, 3 Hungarian matches at IoU 0.27 vs the reference's 1 match at 0.07.
  Nothing here errors or looks obviously wrong if you don't check against the reference log
  -- it would be very easy to silently diagnose the wrong run. It's most likely a cached
  probability map from an earlier full-sheet-only inference pass over the same source image,
  before the "auto-crop second pass" in cell 4 was introduced or before it fired for this
  sample.
- `reference/planliftar-out/cubicasa_rooms_fixtures.json` +
  `reference/planliftar-out/sample_geometry.json` (`719x1020`, 9 rooms, 48 walls) is a third,
  unrelated sample. It doesn't dimensionally match either cached `.npy` and isn't wired into
  `consensus_lab.py` at all.

## Findings: why is consensus 0.07?

Numbers below are from `local/out/diagnostics.json` produced by the default (verified)
run. Four distinct, independently-sufficient causes stack up:

### 1. Two "phantom" MitUNet rooms eat 47% of MitUNet's own room-pixel budget, contributing zero possible IoU

All 31 real CubiCasa room polygons live inside a tight box, `x:[1104,1854]  y:[160,1596]`,
inside the `2730x2048` canvas -- CubiCasa's own floor-plan content only occupies the middle
third of the image; the rest is blank printed margin around the plan.

- **MitUNet label 2** (`area_px=1,041,398`, bbox `x:119..1103 y:393..1487`) is entirely
  outside that box. Its mean `wall_prob` is **0.0030** vs the whole image's mean of
  **0.0774** (~25x lower) -- i.e. it's blank background, not a real room, misclassified as
  an interior "room" purely because its bounding box happens not to touch any image edge
  (the cell-8 exterior test only strips components that touch `x==0`/`y==0`/right/bottom
  edges). Its top-3 CubiCasa IoU candidates are all **0.0** -- it cannot ever match,
  regardless of threshold tuning.
- **MitUNet label 4** (`area_px=160,525`, bbox `x:1377..2126 y:393..799`) is real detected
  structure (mean `wall_prob=0.121`, not blank) but extends ~270px past CubiCasa's mapped
  right edge (`x=1854`) with the same result: top-3 IoU all **0.0**. This looks like real
  plan content CubiCasa's 31-room export simply doesn't cover (a wing/attic/stairwell not
  given a room polygon), rather than a misalignment bug.

Together these two regions are 1,201,923 of the 14 MitUNet rooms' combined ~2.55M labeled
px (47%) and can never contribute a match -- they inflate `rooms_mitunet` (the
`max(14, 9)` denominator) for free.

### 2. CubiCasa's own room list is 71% fragment noise, and the "coverage" filter never actually runs

Of the 31 rooms in `cubicasa_rooms_fixtures.json`, **22 are dropped**, all 22 by the
*centroid-lands-in-a-MitUNet-room* filter -- **0 are dropped by the >=50%-inside-crop
filter.** That filter's `coverage_ratio` (rasterized-mask-px / shoelace-polygon-area) ranges
`1.005`-`1.875` across all 31 rooms (always >= 1.0, since there's no crop clipping here at
all -- `crop_offset=(0,0)`, plan fills the sheet). It is dead code for this sample; it exists
to catch neighbor-room slivers cut off by an actual crop boundary, which doesn't occur here.

15 of the 22 centroid-dropped rooms are tiny fragments below `MIN_ROOM_AREA=2000` px²
(e.g. `room_002_1` kitchen, 216px²; `room_010_2` "room", 120px²; `room_002_4` kitchen,
143px²) -- these look like CubiCasa's own polygon export shattering a single real room into
several disconnected slivers, most of which land on a wall/doorway pixel rather than open
floor (20 of 22 drops report `centroid_label=0`, i.e. background/wall; 2 report
`centroid_label` in the MitUNet exterior set).

### 2b. The centroid filter also discards CubiCasa's two *largest* real rooms -- likely the single biggest driver

Two of the 7 *large* (>=2000px²) centroid-dropped rooms are not fragments at all -- they are
the two biggest room polygons in the entire fixture file:

- `room_003_0` **living_room**, 215,802 px² -- centroid lands on a MitUNet wall pixel
  (`centroid_label=0`). Checking its real overlap (bypassing the filter): it is **fragmented
  across 3 different MitUNet regions** -- room 6 (IoU 0.289), room 9 (0.11), room 12
  (0.026). Best possible IoU is 0.289, itself below 0.5, but it never even gets the chance
  to appear as a below-threshold near-miss in the official matrix because the centroid rule
  drops it outright.
- `room_010_1` **"room"**, 208,341 px² -- centroid also lands on a wall pixel. Its real
  footprint is **shattered across 7 MitUNet regions**: 12 (0.189), 10 (0.206), 17 (0.081),
  13 (0.037), 16 (0.028), 14 (0.006), 18 (0.006).

Together these two polygons are 424,143 of 805,348 total px² across all 31 CubiCasa rooms
(**52.7%** of all CubiCasa room area in the fixture file) -- and both are excluded from
consensus scoring entirely, not because they lack overlap, but because a **single sampled
point** (the mean of each room's rasterized pixel coordinates) happens to land on a MitUNet
wall pixel produced by MitUNet's own over-segmentation of that same real room. **This is a
real fragility in the centroid filter worth flagging, not fixed here per the task
constraints**: any large room that MitUNet (correctly or not) subdivides internally is at
meaningful risk of its centroid falling on the dividing wall/seal pixel, at which point the
room is discarded rather than credited to whichever sub-region covers most of it.

### 3. Real over-segmentation, not just misalignment

The overlap breakdowns above (`living_room` -> 3 MitUNet pieces, `room_010_1` -> 7 MitUNet
pieces) show MitUNet is genuinely splitting large real rooms into more, smaller regions than
CubiCasa's own room-level polygons represent -- this is over-segmentation, distinct from a
coordinate-frame misalignment (the frames line up fine; the wall-seal reproduces
182,822px identically, and the one accepted match, room 7 vs `room_004_0` at IoU 0.748, is a
clean, correctly-aligned bedroom).

### 4. A genuine threshold effect, on top of everything else

`MitUNet room 12` (136,757px²) vs `room_002_0` kitchen (84,869px², the real, main kitchen
polygon) scores **IoU 0.448** -- correctly aligned, correct room type, but **just under**
the hardcoded `min_iou=0.5` Hungarian cutoff, so it's discarded from `matches` even though it
is the single best real correspondence outside the one accepted bedroom match. This is a
pure threshold effect: nothing about the geometry is wrong here, 0.05 of IoU is the entire
gap.

### Why the watershed virtual split makes it *worse* (0.071 -> 0.059)

The split only touches MitUNet regions that have **>=2 CubiCasa seed centroids** landing
inside them: label 12 (2 seeds: `room_002_0` the real kitchen, and `room_002_4`, a 143px²
kitchen sliver) and label 10 (3 seeds: `room_002_1` 216px², `room_005_0` the real bathroom,
`room_010_2` 120px²). Two of those three extra seeds in label 10, and one of the two extra
seeds in label 12, are tiny fragment artifacts, not real distinct sub-rooms. Watershed
dutifully carves labels 12 and 10 into 2 and 3 pieces respectively (14 regions -> 17
sub-rooms), which can only **redistribute or shrink** whatever intersection area the real
room (kitchen / bathroom) had with the original, larger, unsplit region -- it cannot increase
it -- while `max(len(vroom_ids), len(cubi_masks))` grows from 14 to 17. Net effect: the one
real match (room 7, untouched by the split since it only had 1 seed) still counts once, but
the denominator grew for free, so consensus drops from `1/14=0.071` to `1/17=0.059`. The
split is only ever net-positive when the extra seeds it splits on are themselves real,
separately-recognizable rooms; here most of them are CubiCasa's own polygon-fragmentation
noise, so it can't help and mechanically hurts.

### Bottom line

No single bug explains 0.07. It's the sum of: (a) ~47% of MitUNet's "rooms" being
canvas-margin/unmapped-structure phantoms with zero possible ground truth, (b) CubiCasa's
own room list being 71% fragment noise that a dead coverage filter doesn't catch and the
centroid filter mostly does, (c) that same centroid filter also discarding the two largest
*real* rooms (52.7% of all CubiCasa room area) as a side effect of MitUNet's own
over-segmentation of them, (d) genuine over-segmentation on the real floor area (living room
-> 3 pieces, one big room -> 7 pieces), and (e) one clean near-match (kitchen, IoU 0.448)
lost purely to the 0.5 cutoff. Only one correspondence (bedroom, IoU 0.748) survives all of
that intact.

## Overlay (`local/out/consensus_overlay.png`)

MitUNet label regions are filled in distinct colors with their label id at each centroid;
CubiCasa room polygons are outlined in cyan and annotated with their `type`; a line is drawn
for every pair in the raw (unthresholded) Hungarian assignment between MitUNet rooms and the
9 *officially surviving* CubiCasa rooms -- solid green if `IoU >= 0.5` (kept as a real
match), dashed red if it was the algorithm's best pairing for that row but fell below
threshold. The one green line is room 7 <-> `room_004_0` (bedroom, 0.748). The dashed red
lines fan out to whatever surviving CubiCasa room the Hungarian algorithm was forced to pair
each remaining MitUNet room with (including, visibly, the giant margin-phantom room 2, which
gets paired with something purely because Hungarian must assign every row a column when rows
> columns -- that pairing has essentially 0 IoU and is not meaningful beyond "this is what
the algorithm did with a spare row").

## Notebook code notes (not fixed, per task constraints)

- **Centroid filter fragility** (cell 10 / notebook cell index 10): sampling a single point
  (mean of a room's rasterized pixel coordinates) against the MitUNet label map is not
  robust to concave/complex real rooms that MitUNet's own wall detection subdivides
  internally -- see finding 2b above, where this discards 52.7% of CubiCasa's total mapped
  room area in this sample.
- **Exterior detection** (cell 8 / notebook cell index 8) only strips connected components
  that touch the image border. A large blank-margin region that is fully interior to the
  canvas (MitUNet label 2 here) is not caught by this and is counted as a real room once it
  clears `MIN_ROOM_AREA`. Not a crash or exception, just a source of denominator inflation
  worth knowing about when comparing `rooms_mitunet` across samples with different amounts
  of printed margin.

Neither of these was touched -- this harness only observes and reports.
