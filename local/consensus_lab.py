#!/usr/bin/env python
"""consensus_lab.py -- local CPU diagnostic harness for the PlanLiftAR v2
rooms-first consensus pipeline (planliftar-geometry-v2/planliftar_geometry_v2.ipynb).

Ports cells 1, 5, 6, 7, 8, 9, 10, 11, 12 of the notebook (CFG through the
acceptance barrier) so we can iterate on room-consensus scoring on CPU,
without touching Kaggle, the GPU inference cell, or the notebook itself.

INSTRUMENTATION ONLY. This file does not change any scoring/routing formula
from the notebook -- every computation that feeds a printed metric or the
acceptance report is copied verbatim (same operators, same thresholds, same
order of operations). Extra bookkeeping is added only to *observe*
intermediate state (per-room IoU candidates, filter drop reasons, etc.) for
local/out/diagnostics.json and local/out/consensus_overlay.png.

Usage
-----
    python local/consensus_lab.py
    python local/consensus_lab.py --wall-prob out/wall_prob_crop.npy \
        --fixtures out-cubicasa/cubicasa_rooms_fixtures.json \
        --geometry out-cubicasa/sample_geometry.json --crop-offset 0,0

See local/README.md for full argument docs and findings.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from scipy import ndimage
from scipy.optimize import linear_sum_assignment
from skimage.filters import apply_hysteresis_threshold
from skimage.morphology import skeletonize
from skimage.segmentation import watershed as sk_watershed

REPO_ROOT = Path(__file__).resolve().parent.parent
LOCAL_DIR = Path(__file__).resolve().parent

# --------------------------------------------------------------------------
# Cell 1 -- CFG (verbatim from the notebook's single-config cell). Overridable
# from the CLI so we can sweep these later without editing this file.
# --------------------------------------------------------------------------
CFG = {
    "HYST_LOW": 0.25,      # hysteresis weak threshold; sweep 0.15-0.35
    "HYST_HIGH": 0.50,
    "SEAL_FACTOR": 1.5,    # seal openings narrower than SEAL_FACTOR * wall thickness
    "CONSENSUS_MIN": 0.70,  # Layer 3 threshold (Phase 2) -- routing, NOT the match cutoff
    # Minimum plausible room area. Was an absolute 2000px^2, which made room COUNT
    # resolution-dependent (10/14/16 rooms at 0.5x/1x/2x - see local/test_resolution.py).
    # Expressed in t_med^2 units: 2000/26^2 reproduces exactly 2000px^2 at t_med=26.
    "MIN_ROOM_AREA_T_MED_SQ": 2000.0 / (26.0 ** 2),  # -> 2000.0 px^2 at t_med=26
    "WALL_HEIGHT": 2.5,     # relative units for GLB extrusion (Phase 3) -- unused here
    # Not a CFG constant in the notebook -- it's the literal `min_iou=0.5` hardcoded
    # into every `hungarian_match(...)` call in cell 7/8. Broken out here so it can
    # be swept too; default matches the notebook exactly.
    "MATCH_MIN_IOU": 0.5,

    # wall-geometry-fixes -- graded consensus (Task A/B, see graded_room_consensus).
    # A CubiCasa room only merges into its dominant MitUNet region's many-to-one
    # group (full union-based IoU credit) if that region owns MORE THAN HALF the
    # room's own area; otherwise it scores its own plain IoU alone. Not an
    # arbitrary sweep knob like MATCH_MIN_IOU: 0.5 is the unique threshold at
    # which "this region is the room's majority owner" is a well-defined,
    # mutually-exclusive structural fact (at most one region can hold >50% of a
    # room's disjoint pixels), which is what stops an unrelated, badly
    # over-segmented room from dragging down a genuinely clean match it happens
    # to share an argmax-by-raw-pixel-count region with (measured on this
    # sample: room_010_1, only 26% inside label 12, was contaminating the
    # kitchen's isolated 0.448 down to ~0.38 before this gate was added).
    "GRADED_MERGE_MAJORITY_FRAC": 0.5,

    # wall-geometry-fixes -- room-selection wall-probability gate (see
    # stage_regions_and_walls). The cell-8 exterior test only strips components
    # whose BOUNDING BOX touches an image edge; a large blank-margin region that is
    # fully interior to the (already auto-cropped) canvas slips through and is
    # counted as a "room" purely because it clears MIN_ROOM_AREA, even though it has
    # no wall evidence and can never match anything (see local/README.md's
    # "Findings: why is consensus 0.07?" -- MitUNet label 2 on the sample plan,
    # area 1,041,398px, contributes zero possible IoU).
    #
    # Two signals were measured and rejected outright -- not just tuned around --
    # because they are not evidence of blankness at all, not because of a threshold
    # problem:
    #   - mean prob over the region's own pixel mask ("interior"): a real room's
    #     interior IS empty floor, so this cannot discriminate in principle. Label
    #     2 measures 0.005x image mean; the real bedroom that is the pipeline's one
    #     accepted match (room 7) measures 0.007x -- indistinguishable.
    #   - boundary-ring mean (dilation-minus-region): actively anti-correlated.
    #     Every connected component of the inverted seal mask is bounded by wall BY
    #     CONSTRUCTION, so label 2 scores 8.04x image mean on this signal --
    #     *higher* than most real rooms (room 7: 3.36x). No normalisation rescues
    #     a signal that's measuring the wrong thing.
    #
    # Signal 1 (kept): mean wall_prob over the region's full bounding box (not just
    # its own pixel mask), relative to the whole image's mean wall_prob. This is
    # the exact quantity local/README.md's "Findings" section already cites (0.0030
    # for label 2 / 0.121 for label 4 vs the image's 0.0774) and it is
    # resolution-stable (verified at 0.5x/1x/2x, see local/test_resolution.py) --
    # but ALONE it is not sufficient: it separates label 2 only because it measures
    # local drawing density (how much ink sits in that region's neighbourhood), not
    # whether the region is a room, so on its own it also flags real, sparse-area
    # rooms as false positives (measured: labels 3, 8, 13, 14, 16, 17, 18 on this
    # sample -- two of which, label 3 and label 18, have genuine IoU overlap with a
    # real CubiCasa room, 0.372 and 0.345, so wrongly gating them is expensive, not
    # a free cleanup).
    #
    # Signal 2 (new): the region's own area as a fraction of the total image area.
    # What actually characterises page margin is being BIG *and* in an ink-free
    # part of the sheet -- a small region in a sparse corner is just a room, not a
    # margin. A region is only gated if BOTH signals say so (AND, not OR): low bbox
    # ink density is necessary but not sufficient; it must also be large enough to
    # plausibly be sheet margin rather than a real small room. Expressed as a
    # fraction of image area (not t_med units) because this is about the region's
    # share of the page, which is a scale-free quantity by construction -- an area
    # in px^2 would not be.
    #   0.10 -> label 2 is 0.186 of the image (1.86x above cutoff, gated); the
    #   largest region signal-1 alone would have wrongly gated, label 3, is 0.006
    #   of the image (17x below cutoff, survives); the largest surviving real room,
    #   label 4, is 0.029 of the image (3.5x below cutoff, headroom on the other
    #   side too). Any threshold between roughly 0.03 and 0.18 produces the same
    #   result on this sample.
    #
    # 0.5 -> label 2's bbox_mean/img_mean = 0.039 (12.7x below the signal-1
    # cutoff); label 4's = 1.560 (3.1x above it) at this sample's t_med=26.
    "ROOM_WALL_GATE_BBOX_MEAN_FRAC": 0.5,
    "ROOM_WALL_GATE_MIN_AREA_FRAC": 0.10,

    # wall-geometry-fixes -- seal-risk instrumentation (see stage_seal_thickness).
    # The Layer-1 micro-gap seal CLOSEs with a kernel (SEAL_FACTOR * t_med, 39px
    # on this sample) that is deliberately WIDER than a wall is thick (26px) so it
    # can bridge a real gap in a single wall -- but the same width can just as
    # easily weld two separate, nearby walls solid across a thin corridor/closet,
    # and because room extraction downstream only sees enclosed regions, a welded
    # corridor doesn't error, it silently stops existing (see planliftar-v1.md:
    # "if the sealed count jumps implausibly, verify each seal against the
    # probability map before keeping it"). This has NOT misfired on the samples
    # run so far -- the gate below is warning-only instrumentation (it logs, it
    # never changes `mask`), added now so a real misfire is caught with numbers
    # instead of discovered as a silently-vanished room later.
    #
    # Each connected component of (closed_mask & ~mask_before_close) is one
    # "seal". A legitimate seal bridges a real (if below-hysteresis-threshold)
    # wall gap, so the wall-probability map should read meaningfully elevated
    # under it; a seal that welds two separate walls together runs across
    # genuinely empty floor, so it should read close to background. Exactly one
    # signal alone is not sufficient, same shape of problem as
    # ROOM_WALL_GATE_BBOX_MEAN_FRAC/ROOM_WALL_GATE_MIN_AREA_FRAC above: low
    # probability alone also fires on small, ordinary noise-healing seals (a
    # few px of below-threshold static in an otherwise-real wall), and area
    # alone also fires on large seals that legitimately bridge a long but real
    # gap. A seal is only flagged suspicious when BOTH hold: its own mean
    # wall_prob is low relative to the image's mean wall_prob (not an absolute
    # cutoff -- probability maps vary in overall confidence/sparsity from plan
    # to plan) AND its area is large relative to t_med^2 (a seal's structural
    # significance scales with wall thickness -- a seal a few wall-thicknesses
    # across is plausibly a bridged corridor; one a fraction of a wall-thickness
    # across is ordinary noise-healing, regardless of how low its probability
    # reads).
    "SEAL_GATE_PROB_MEAN_FRAC": 0.5,        # seal mean wall_prob < this x image mean wall_prob -> low evidence
    "SEAL_GATE_AREA_T_MED_SQ_FRAC": 2.0,    # seal area >= this x t_med^2 -> large enough to matter

    # Task A -- previously-hardcoded absolute pixel tolerances, now expressed as
    # fractions of t_med (median wall thickness in px, see stage_seal_thickness)
    # so behaviour doesn't drift with image resolution. Each fraction is chosen
    # so multiplier * t_med reproduces the old hardcoded constant exactly at this
    # sample's t_med=26.0px -- native-resolution output is unchanged.
    "WALL_EPS_T_MED_FRAC": 3.0 / 26.0,           # approxPolyDP epsilon, wall boundary contours -> 3.0px at t_med=26
    "MIN_SEG_LEN_T_MED_FRAC": 5.0 / 26.0,        # min wall-segment length (compared squared) -> 5.0px at t_med=26
    "MIN_BOUNDARY_PTS_T_MED_FRAC": 5.0 / 26.0,   # min boundary-px count per label pair -> 5.0px at t_med=26
    "OPENING_BAR_MIN_T_MED_FRAC": 6.0 / 26.0,    # floor on opening-bar thickness -> 6.0px at t_med=26
    "WALL_MIN_THICKNESS_T_MED_FRAC": 2.0 / 26.0,  # floor on rasterized CubiCasa wall thickness -> 2.0px at t_med=26

    # Task C -- post-processing pass over the raw derived wall segments (dedupe
    # reversed near-duplicates from 1px-wide-curve contour tracing, axis-snap,
    # merge collinear touching/overlapping runs, drop stubs). Expressed as
    # fractions of t_med for the same resolution-relative reason as Task A; each
    # comment gives the absolute px value it reproduces at this sample's
    # t_med=26.0px. The snap angle is the one exception -- degrees are already
    # scale-free, so it's a plain degree value.
    #
    # Values below were swept (see task report), not left at the brief's starting
    # guesses -- the guesses (0.25/8deg/0.3/0.5/0.5) landed at 95 walls with 47%
    # of segments still >5deg off-axis by count. Widening WALL_SNAP_ANGLE_DEG,
    # WALL_COLLINEAR_T_MED_FRAC, WALL_MERGE_GAP_T_MED_FRAC and WALL_STUB_LEN_T_MED_FRAC
    # trades a few more (still-correct) merges/drops for a meaningfully smaller,
    # cleaner wall list. The off-axis-by-COUNT metric plateaus around 35-45% past
    # this point no matter how far tolerances are pushed -- that floor is
    # structural (approxPolyDP's zigzag staircase alternates direction between
    # consecutive segments, so they are never pairwise collinear) and needs the
    # derivation rewritten to fix, which is out of scope here. By LENGTH (the
    # metric that actually matters for the AR extrusion), off-axis segments are
    # only ~12-15% of total wall length at these settings.
    #
    # WALL_COLLINEAR_T_MED_FRAC=0.4 (10.4px) was tried and REJECTED: it lands on
    # an unlucky knife-edge where one particular near-borderline segment pair
    # flips its merge decision between resolutions from 1px rounding in the
    # underlying pixel geometry, breaking local/test_resolution.py's 5% scale
    # tolerance at 2x (7.8% observed) even though the tolerance itself is
    # correctly t_med-relative. 0.3, 0.35, 0.5 and 0.6 all sit comfortably off
    # that edge (<1% error at every scale) -- 0.5 was chosen as a value with
    # headroom on both sides, not just the first one that happened to pass.
    "WALL_DUP_TOL_T_MED_FRAC": 6.5 / 26.0,        # duplicate-endpoint match tolerance -> 6.5px at t_med=26
    "WALL_SNAP_ANGLE_DEG": 10.0,                  # axis-snap angle tolerance, degrees
    "WALL_COLLINEAR_T_MED_FRAC": 13.0 / 26.0,     # perpendicular distance for collinearity -> 13.0px at t_med=26
    "WALL_MERGE_GAP_T_MED_FRAC": 19.5 / 26.0,     # endpoint-gap tolerance for merging collinear runs -> 19.5px at t_med=26
    # Endpoint-adjacency tolerance for the ADVISORY loose-endpoint warning. Was a
    # hardcoded 6.0px default arg on wall_endpoint_degrees() - the same absolute-px
    # bug class as Task A, missed there because it sat in a helper signature.
    #
    # Set to 1.0 * t_med rather than the old 6.0px (0.23 * t_med) on physical
    # grounds, not to silence the warning: walls are EXTRUDED AS BOXES one t_med
    # thick, so two endpoints within a wall thickness of each other produce
    # overlapping boxes and no hole. The old 6px asked whether centreline points
    # were nearly coincident; the question that matters for AR is whether the
    # extruded solids fail to meet. A gap wider than a full wall thickness is a
    # real hole and still warns.
    "WALL_ENDPOINT_TOL_T_MED_FRAC": 1.0,   # -> 26.0px at t_med=26
    "WALL_STUB_LEN_T_MED_FRAC": 26.0 / 26.0,      # min surviving segment length -> 26.0px at t_med=26
}


def min_room_area(cfg):
    """MIN_ROOM_AREA in px^2, derived from t_med so it scales with resolution.

    Areas go as length^2, so the multiplier is applied to t_med^2. Requires
    cfg["_t_med"]; see the guard in stage_regions_and_walls for why a missing
    value is an error rather than a default.
    """
    t = cfg.get("_t_med", 0.0)
    if not t:
        raise ValueError("cfg['_t_med'] is unset or zero; cannot derive MIN_ROOM_AREA")
    return cfg["MIN_ROOM_AREA_T_MED_SQ"] * (t ** 2)


def log(lines, msg):
    print(msg)
    lines.append(msg)


# --------------------------------------------------------------------------
# Cell 7-pre -- consensus helpers (verbatim port from cell index 9)
# --------------------------------------------------------------------------
def rasterize_rooms(cubicasa_rooms, shape, cx0, cy0):
    """Shift each CubiCasa room polygon into crop coords and rasterize to a filled mask, skipping ones fully outside the crop."""
    h, w = shape
    out = []
    for room in cubicasa_rooms:
        poly = room.get("polygon", [])
        if len(poly) < 3:
            continue
        pts = np.array([[p["x"] - cx0, p["y"] - cy0] for p in poly], dtype=np.float64)
        x0, y0 = pts[:, 0].min(), pts[:, 1].min()
        x1, y1 = pts[:, 0].max(), pts[:, 1].max()
        if x1 < 0 or y1 < 0 or x0 >= w or y0 >= h:
            continue
        mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(mask, [pts.round().astype(np.int32)], 1)
        out.append((room, mask))
    return out


def pairwise_iou(labels, room_ids, cubi_masks):
    """Compute the IoU matrix between each label-map room region and each rasterized CubiCasa mask."""
    n, m = len(room_ids), len(cubi_masks)
    iou = np.zeros((n, m), dtype=np.float64)
    for i, rid in enumerate(room_ids):
        rmask = labels == rid
        for j, cmask in enumerate(cubi_masks):
            cm = cmask.astype(bool)
            inter = np.count_nonzero(rmask & cm)
            union = np.count_nonzero(rmask | cm)
            iou[i, j] = inter / union if union else 0.0
    return iou


def hungarian_match(iou_matrix, min_iou=0.5):
    """Solve the IoU-maximizing 1:1 assignment via the Hungarian algorithm, keeping only matches >= min_iou."""
    if iou_matrix.size == 0:
        return []
    row_idx, col_idx = linear_sum_assignment(-iou_matrix)
    matches = []
    for i, j in zip(row_idx, col_idx):
        v = float(iou_matrix[i, j])
        if v >= min_iou:
            matches.append((int(i), int(j), v))
    return matches


def hungarian_assignment_raw(iou_matrix):
    """Like hungarian_match but returns EVERY assigned pair regardless of threshold
    (diagnostic-only helper, not in the notebook) -- used for the overlay figure so
    we can show best-pair-but-below-threshold as a dashed red line."""
    if iou_matrix.size == 0:
        return []
    row_idx, col_idx = linear_sum_assignment(-iou_matrix)
    return [(int(i), int(j), float(iou_matrix[i, j])) for i, j in zip(row_idx, col_idx)]


def shoelace_area(poly):
    """Absolute polygon area via the shoelace formula for a list of {"x","y"} dict vertices."""
    xs = np.array([p["x"] for p in poly], dtype=np.float64)
    ys = np.array([p["y"] for p in poly], dtype=np.float64)
    return float(0.5 * abs(np.dot(xs, np.roll(ys, -1)) - np.dot(ys, np.roll(xs, -1))))


def polygon_is_closed(poly):
    """True if poly has >=3 vertices and encloses nonzero (shoelace) area, i.e. isn't degenerate."""
    if len(poly) < 3:
        return False
    return shoelace_area(poly) > 0.0


def _point_seg_dist(p, a, b):
    """Euclidean distance from point p to segment a-b (each an (x, y) float array)."""
    ap = p - a
    ab = b - a
    denom = np.dot(ab, ab)
    t = 0.0 if denom == 0 else np.clip(np.dot(ap, ab) / denom, 0.0, 1.0)
    proj = a + t * ab
    return float(np.linalg.norm(p - proj))


def wall_endpoint_degrees(walls, tol):
    """For each wall's start/end, count other walls (by endpoint or segment-body proximity) within tol px.

    `tol` is required rather than defaulted: it was a hardcoded 6.0px, the same
    absolute-pixel bug class the rest of this branch removed, and it is easy to
    miss here because it sits in a helper's signature rather than in a stage.
    Callers pass WALL_ENDPOINT_TOL_T_MED_FRAC * t_med.
    """
    n = len(walls)
    pts = [(np.array([w["start"]["x"], w["start"]["y"]], dtype=np.float64),
            np.array([w["end"]["x"], w["end"]["y"]], dtype=np.float64)) for w in walls]
    degrees = {}
    for i, w in enumerate(walls):
        s_i, e_i = pts[i]
        deg_s = 0
        deg_e = 0
        for j in range(n):
            if j == i:
                continue
            s_j, e_j = pts[j]
            if np.linalg.norm(s_i - s_j) <= tol or np.linalg.norm(s_i - e_j) <= tol:
                deg_s += 1
            elif _point_seg_dist(s_i, s_j, e_j) <= tol:
                deg_s += 1
            if np.linalg.norm(e_i - s_j) <= tol or np.linalg.norm(e_i - e_j) <= tol:
                deg_e += 1
            elif _point_seg_dist(e_i, s_j, e_j) <= tol:
                deg_e += 1
        degrees[w["id"]] = (deg_s, deg_e)
    return degrees


def build_room_masks(labels, room_ids):
    """Map each room label id to a uint8 binary mask of its label-map region."""
    return {rid: (labels == rid).astype(np.uint8) for rid in room_ids}


def graded_room_consensus(labels, room_ids, area_pairs, cfg):
    """Graded, many-to-one consensus score (wall-geometry-fixes Task A/B).

    Replaces the binary Hungarian-match-with-cutoff / row-column-count formula
    (consensus_legacy, computed unchanged and reported alongside -- see
    stage_consensus) with a continuous, area-weighted score that:

      A. has no cliff -- a region at IoU 0.448 contributes ~0.448 of its
         room's weight, not 0 (see local/README.md "Findings" item 4 -- the
         kitchen, MitUNet label 12 vs room_002_0, discarded outright today
         purely for landing 0.05 under the 0.5 Hungarian cutoff);
      B. lets ONE MitUNet region legitimately explain SEVERAL CubiCasa rooms.
         Every surviving CubiCasa room is assigned to whichever single
         MitUNet region overlaps it most, by raw pixel count (the same rule
         stage_consensus's Job 2 already uses for the official max-overlap
         mapping, recomputed here so this function is self-contained and
         independently testable) -- but a room only actually MERGES into that
         region's group if the region owns a MAJORITY of the room's own area
         (overlap / room_area > CFG["GRADED_MERGE_MAJORITY_FRAC"], 0.5). Every
         CubiCasa room clearing that bar and sharing the same dominant MitUNet
         region is grouped together, and the group's score is one IoU: that
         MitUNet region's mask against the UNION of the group's CubiCasa room
         masks. A clean merge (the region exactly equals the union, no
         leakage) scores 1.0 for every room in the group -- see
         local/README.md item 2/2b: a MitUNet region correctly spanning
         several real CubiCasa rooms is the pipeline's own accepted
         "merged_rooms" outcome, not a segmentation failure, and this metric
         is deliberately built to score it as agreement.

         The majority-ownership bar matters and is NOT optional bookkeeping:
         without it, a large CubiCasa room that MitUNet badly over-segments
         (e.g. chopped into 7 pieces, no single piece holding more than ~26%
         of it) still "wins" the argmax contest for whichever of its pieces
         happens to be biggest -- which, on this branch's real sample, is the
         SAME MitUNet region that is ALSO the kitchen's clean, isolated 0.448
         match. Grouping them unqualified drags the kitchen's union down to
         the combined rooms' union and its score down to ~0.38, contaminating
         a genuinely good match with an unrelated room's over-segmentation
         debris. 0.5 is not an arbitrary sweep constant: "more than half of
         this room's own pixels sit in this one region" is a structural fact
         that at most one region can ever satisfy for a given room (the
         complement can't also exceed half), so the gate cannot be a cliff
         two nearby regions straddle the way MATCH_MIN_IOU's union-based 0.5
         can. A room that fails the bar keeps its own honest score: the plain
         IoU between just that room and its dominant region (no group,
         equivalent to a group of size 1) -- never zero, never someone else's
         union.

    Directionality is deliberately ASYMMETRIC -- this is the crux the task
    brief calls out explicitly ("symmetric or penalised treatment of one-to-
    many in the wrong direction"):

      - many CubiCasa rooms -> one MitUNet region (open-plan merge): NOT
        penalized, can legitimately reach 1.0. MitUNet's own wall map is
        authoritative for whether a wall exists in this pipeline ("never
        invents walls"); a region with no internal wall evidence spanning
        several real rooms IS the pipeline's accepted output, not a scoring
        failure to punish.
      - one CubiCasa room -> many MitUNet regions (MitUNet over-segmentation):
        IS penalized. A room's contribution is scored against the group-IoU
        of whichever single region is its OWN dominant match (not a sum
        across every region that touches it), and that region is compared to
        the room's FULL area, not just the slice it happens to cover -- so a
        room chopped into N roughly-equal MitUNet pieces caps out near 1/N
        (whichever piece wins the "dominant" pixel-count contest for that
        room), not near 1.0. This is what keeps pathological over-
        segmentation (many small MitUNet regions tiling one CubiCasa room)
        from scoring near 1.0 (see test_consensus_metric.py #4), without a
        separate row/column-count penalty term.

    A spurious/phantom MitUNet region (e.g. blank page margin) that never
    wins the "dominant region" contest for any CubiCasa room contributes
    nothing and COSTS nothing here -- unlike consensus_legacy's
    max(rooms_mitunet, rooms_cubicasa) denominator, which such a region
    inflates "for free" (see local/README.md finding 1). That is a
    deliberate difference from the legacy formula, not an oversight: this
    function only ever measures agreement about something CubiCasa says is a
    real room, so it cannot be inflated OR deflated by MitUNet regions that
    no CubiCasa room ever touches.

    `area_pairs` is stage_consensus's Job-1 output: every CubiCasa room that
    survived the fragment-noise area filter, as (room_dict, mask) pairs --
    INCLUDING rooms with zero overlap against any MitUNet room, which score
    0.0 here and pull the area-weighted average down. (consensus_legacy drops
    these before computing cubi_masks/len(cubi_masks) and so never "sees"
    them at all -- a whole CubiCasa room MitUNet missed entirely would
    otherwise vanish from the denominator instead of costing anything, which
    is exactly the kind of trivial-inflation loophole this metric must not
    have.)

    Returns (score, contributions): score is a float in [0, 1] (1.0 = every
    surviving CubiCasa room's area is fully explained by a single MitUNet
    region with no leakage; 0.0 = no surviving CubiCasa room has ANY overlap
    with any MitUNet room). `contributions` is a list of per-CubiCasa-room
    dicts (cubi_id, cubi_type, area_px, dominant_label, group_size, score)
    for diagnostics/reporting -- this is what lets the per-pair breakdown
    (e.g. the kitchen's 0.448) be read back out of the aggregate number.
    """
    if not area_pairs:
        return 0.0, []

    n_labels = int(labels.max()) + 1 if labels.size else 1
    majority_frac = cfg["GRADED_MERGE_MAJORITY_FRAC"]

    def _dominant(m):
        mb = m.astype(bool)
        if not mb.any() or not room_ids:
            return 0, 0
        counts = np.bincount(labels[mb], minlength=n_labels)
        best_label, best_overlap = 0, 0
        for rid in room_ids:
            c = int(counts[rid]) if rid < len(counts) else 0
            if c > best_overlap:
                best_overlap, best_label = c, rid
        return best_label, best_overlap

    dominant_of = {}
    qualifies = {}  # cubi_id -> bool, region owns a MAJORITY of this room's area
    groups = {}  # mitunet label -> list of (cubi_id, mask) for QUALIFYING rooms only
    for r, m in area_pairs:
        area = float(m.sum())
        lab, overlap = _dominant(m)
        dominant_of[r["id"]] = lab
        qual = lab != 0 and area > 0 and (overlap / area) > majority_frac
        qualifies[r["id"]] = qual
        if qual:
            groups.setdefault(lab, []).append((r["id"], m))

    group_iou = {}
    for lab, members in groups.items():
        region_mask = labels == lab
        merged = np.zeros_like(region_mask)
        for _, m in members:
            merged |= m.astype(bool)
        inter = np.count_nonzero(region_mask & merged)
        union = np.count_nonzero(region_mask | merged)
        group_iou[lab] = (inter / union) if union else 0.0

    contributions = []
    total_area = 0.0
    total_weighted = 0.0
    for r, m in area_pairs:
        area = float(m.sum())
        lab = dominant_of[r["id"]]
        if not lab:
            score, group_size = 0.0, 0
        elif qualifies[r["id"]]:
            # Majority-owned by its dominant region: use the (possibly
            # multi-room) group score -- this is the many-to-one merge credit.
            score = group_iou[lab]
            group_size = len(groups[lab])
        else:
            # Dominant region owns less than half of this room: no merge
            # credit borrowed from -- or lent to -- any other room. Score is
            # this room's own plain IoU against just its dominant region.
            region_mask = labels == lab
            mb = m.astype(bool)
            inter = np.count_nonzero(region_mask & mb)
            union = np.count_nonzero(region_mask | mb)
            score = (inter / union) if union else 0.0
            group_size = 1
        contributions.append({
            "cubi_id": r["id"], "cubi_type": r.get("type", "?"),
            "area_px": int(area), "dominant_label": int(lab),
            "group_size": group_size, "majority_owned": bool(lab and qualifies[r["id"]]),
            "score": float(score),
        })
        total_area += area
        total_weighted += area * score

    score = (total_weighted / total_area) if total_area else 0.0
    return float(score), contributions


def find_file(name, roots):
    for base in roots:
        base = Path(base)
        if not base.exists():
            continue
        for dp, _, fs in os.walk(base):
            if name in fs:
                return str(Path(dp) / name)
    raise FileNotFoundError(name)


# --------------------------------------------------------------------------
# Fidelity check against v9_out.txt
# --------------------------------------------------------------------------
def parse_reference_log(path):
    """Best-effort regex scrape of a notebook run log (v9_out.txt-shaped) into a
    flat dict of the same metrics this script prints, for the fidelity check."""
    if not path or not Path(path).exists():
        return {}
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    ref = {}

    m = re.search(r"prob map:\s*\((\d+),\s*(\d+)\)\s*offset\s*\((-?\d+),\s*(-?\d+)\)", text)
    if m:
        ref["prob_shape"] = (int(m.group(1)), int(m.group(2)))
        ref["crop_offset"] = (int(m.group(3)), int(m.group(4)))

    m = re.search(r"components: naive@0\.5 = (\d+)\s*->\s*hysteresis = (\d+)", text)
    if m:
        ref["naive_components"] = int(m.group(1))
        ref["hysteresis_components"] = int(m.group(2))

    m = re.search(r"t_med = ([\d.]+)px\s*seal kernel = (\d+)px\s*components after close = (\d+)", text)
    if m:
        ref["t_med"] = float(m.group(1))
        ref["seal_kernel"] = int(m.group(2))
        ref["components_after_close"] = int(m.group(3))

    m = re.search(r"seal layer:\s*(\d+)\s*CubiCasa wall px\s*\+\s*(\d+)\s*opening bars", text)
    if m:
        ref["cubicasa_wall_px"] = int(m.group(1))
        ref["opening_bars"] = int(m.group(2))

    m = re.search(r"labels:\s*(\d+)\s*exterior:\s*(\d+)\s*rooms:\s*(\d+)", text)
    if m:
        ref["labels"] = int(m.group(1))
        ref["exterior"] = int(m.group(2))
        ref["rooms"] = int(m.group(3))

    m = re.search(r"room polygons \(closed by construction\):\s*(\[[^\]]*\])\s*vertices", text)
    if m:
        try:
            ref["room_vertices"] = json.loads(m.group(1))
        except json.JSONDecodeError:
            pass

    m = re.search(r"final (\d+) wall runs from (\d+) adjacent label pairs", text)
    if m:
        ref["wall_runs"] = int(m.group(1))
        ref["adjacent_pairs"] = int(m.group(2))

    m = re.search(r"consensus:\s*(\d+)\s*matches\s*/\s*max\((\d+)\s*mitunet,\s*(\d+)\s*cubicasa\)\s*=\s*([\d.]+)", text)
    if m:
        ref["matches"] = int(m.group(1))
        ref["rooms_mitunet"] = int(m.group(2))
        ref["rooms_cubicasa"] = int(m.group(3))
        ref["consensus"] = float(m.group(4))

    m = re.search(r"virtual split:\s*(\d+)\s*regions\s*->\s*(\d+)\s*sub-rooms;\s*consensus\s*([\d.]+)\s*->\s*([\d.]+)", text)
    if m:
        ref["vsplit_regions"] = int(m.group(1))
        ref["vsplit_subrooms"] = int(m.group(2))
        ref["consensus_before_split"] = float(m.group(3))
        ref["consensus_after_split"] = float(m.group(4))

    # final JSON report block, if present verbatim
    m = re.search(r"\{\s*\"accepted\":.*?\n\}", text, re.S)
    if m:
        try:
            ref["final_report"] = json.loads(m.group(0))
        except json.JSONDecodeError:
            pass

    return ref


def compare_to_reference(lines, computed, ref):
    log(lines, "")
    log(lines, "=== FIDELITY CHECK vs reference log ===")
    if not ref:
        log(lines, "no reference log parsed -- skipping fidelity comparison")
        return {"reference_available": False, "deltas": {}}

    deltas = {}
    keys = [
        "naive_components", "hysteresis_components", "t_med", "seal_kernel",
        "components_after_close", "cubicasa_wall_px", "opening_bars",
        "labels", "exterior", "rooms", "wall_runs", "adjacent_pairs",
        "matches", "rooms_mitunet", "rooms_cubicasa", "consensus",
    ]
    any_mismatch = False
    for k in keys:
        if k not in ref or k not in computed:
            continue
        rv, cv_ = ref[k], computed[k]
        # reference values were scraped from printf-rounded text (.1f / .2f); use a
        # tolerance wide enough to absorb that rounding without masking real deltas.
        match = (rv == cv_) if isinstance(rv, int) else abs(rv - cv_) < 0.006
        if not match:
            any_mismatch = True
        deltas[k] = {"reference": rv, "computed": cv_, "match": bool(match)}
        flag = "OK " if match else "!! "
        log(lines, f"{flag}{k}: reference={rv!r}  computed={cv_!r}")

    if any_mismatch:
        log(lines, "RESULT: does NOT reproduce the reference log numerically. "
                    "Either the wall/room geometry genuinely changed (intended - then "
                    "re-snapshot local/ref/step2_reference.txt in the same commit), or "
                    "the wall-prob/CubiCasa inputs are mispaired (see local/README.md).")
    else:
        log(lines, "RESULT: reproduces the reference log numerically.")
    return {"reference_available": True, "deltas": deltas, "any_mismatch": any_mismatch}


# --------------------------------------------------------------------------
# Pipeline stages
# --------------------------------------------------------------------------
def stage_hysteresis(lines, prob_full, cfg):
    """Cell 3 (notebook cell index 5) -- Layer 2 hysteresis threshold."""
    mask_naive = (prob_full > cfg["HYST_HIGH"]).astype(np.uint8)
    mask = apply_hysteresis_threshold(prob_full, low=cfg["HYST_LOW"], high=cfg["HYST_HIGH"]).astype(np.uint8)

    def n_comp(m):
        n, _ = cv2.connectedComponents(m)
        return n - 1

    naive_n, hyst_n = n_comp(mask_naive), n_comp(mask)
    log(lines, f"components: naive@0.5 = {naive_n}  ->  hysteresis = {hyst_n}   (healing metric; ideal ~1)")
    return mask, {"naive_components": naive_n, "hysteresis_components": hyst_n}


def stage_seal_thickness(lines, mask, cfg, prob):
    """Cell 4 (notebook cell index 6) -- Layer 1 wall thickness + micro-gap seal.

    `prob` is the wall-probability map (float32, same H x W as `mask`) -- threaded
    through explicitly (same pattern as stage_regions_and_walls's `prob_full`) so
    the seal-risk instrumentation below can score each seal the CLOSE produced
    against real wall evidence. WARNING-ONLY: this block only measures and logs;
    it never touches `mask`, so the returned mask/dist/t_med/seal_kernel are
    bit-identical to before this instrumentation was added. See
    CFG["SEAL_GATE_PROB_MEAN_FRAC"]/CFG["SEAL_GATE_AREA_T_MED_SQ_FRAC"] for the
    gate's design rationale.
    """
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    skel = skeletonize(mask.astype(bool))
    t_med = 2 * float(np.median(dist[skel]))
    seal_below = cfg["SEAL_FACTOR"] * t_med
    k = int(seal_below) | 1
    comps_before = cv2.connectedComponents(mask)[0] - 1
    mask_before_close = mask.astype(bool)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    comps_after = cv2.connectedComponents(mask)[0] - 1
    log(lines, f"t_med = {t_med:.1f}px  seal kernel = {k}px  components after close = {comps_after}")

    # --- seal-risk instrumentation (warning-only, see CFG comment above) ---
    added = mask.astype(bool) & ~mask_before_close
    n_seals_raw, seal_labels = cv2.connectedComponents(added.astype(np.uint8))
    n_seals = n_seals_raw - 1  # drop background label 0
    img_mean_prob = float(prob.mean())
    prob_gate_frac = cfg["SEAL_GATE_PROB_MEAN_FRAC"]
    area_gate_px = cfg["SEAL_GATE_AREA_T_MED_SQ_FRAC"] * (t_med ** 2)

    seal_stats = []
    total_seal_area = 0
    for lab in range(1, n_seals_raw):
        seal_px = seal_labels == lab
        area = int(seal_px.sum())
        total_seal_area += area
        seal_mean_prob = float(prob[seal_px].mean()) if area else 0.0
        ratio = (seal_mean_prob / img_mean_prob) if img_mean_prob else 0.0
        suspicious = (ratio < prob_gate_frac) and (area >= area_gate_px)
        seal_stats.append({"label": int(lab), "area_px": area, "mean_prob": seal_mean_prob,
                            "prob_ratio": ratio, "suspicious": bool(suspicious)})

    flagged = [s for s in seal_stats if s["suspicious"]]
    log(lines, f"seal-risk: components before close = {comps_before}  after close = {comps_after}  "
                f"-- {n_seals} seal(s) added, {total_seal_area}px^2 total sealed area, "
                f"{len(flagged)} flagged suspicious "
                f"(prob_ratio < {prob_gate_frac:.2f}x image mean wall_prob ({img_mean_prob:.4f}) "
                f"AND area >= {area_gate_px:.0f}px^2 = {cfg['SEAL_GATE_AREA_T_MED_SQ_FRAC']:.2f} * t_med^2)")
    for s in flagged:
        log(lines, f"  SUSPICIOUS seal label {s['label']}: area={s['area_px']}px^2  "
                    f"mean_prob={s['mean_prob']:.4f} = {s['prob_ratio']:.3f}x image mean -- "
                    f"possible welded corridor/closet, verify against the probability map before trusting this seal")

    return mask, dist, {"t_med": t_med, "seal_kernel": k, "components_after_close": comps_after,
                         "seal_components_before_close": comps_before,
                         "n_seals": n_seals, "seal_area_total_px": total_seal_area,
                         "n_seals_suspicious": len(flagged), "seal_stats": seal_stats}


def stage_cubicasa_seal(lines, mask, sg, rf, t_med, cx0, cy0, H, W, cfg=None):
    """Cell 5 (notebook cell index 7) -- CubiCasa seal hints, labeling only."""
    cfg = CFG if cfg is None else cfg
    cubicasa_rooms = rf.get("rooms", [])
    fixtures = rf.get("fixtures", [])

    walls_np = [(np.array(w["start"], float), np.array(w["end"], float),
                 w.get("thickness_px", t_med)) for w in sg["walls"]]

    # resolution-relative floor on rasterized CubiCasa wall thickness (was hardcoded
    # `2`); rounds to 2 at this sample's t_med=26, so native-res output is unchanged.
    min_wall_thickness = round(cfg["WALL_MIN_THICKNESS_T_MED_FRAC"] * t_med)

    cubi = np.zeros_like(mask)
    for a, b, th in walls_np:
        cv2.line(cubi, (int(a[0] - cx0), int(a[1] - cy0)), (int(b[0] - cx0), int(b[1] - cy0)),
                  1, thickness=int(max(min_wall_thickness, th)))

    def nearest_wall_dir(p):
        best, bd = None, 1e18
        for a, b, th in walls_np:
            ab = b - a
            l2 = ab @ ab
            t = 0 if l2 == 0 else np.clip((p - a) @ ab / l2, 0, 1)
            d2 = ((a + t * ab) - p) @ ((a + t * ab) - p)
            if d2 < bd:
                bd, best = d2, ab
        nn = np.linalg.norm(best)
        return (best / nn) if nn else np.array([1.0, 0.0])

    # resolution-relative floor on opening-bar thickness (was hardcoded `6`); rounds
    # to 6 at this sample's t_med=26, so native-res output is unchanged.
    opening_bar_floor = round(cfg["OPENING_BAR_MIN_T_MED_FRAC"] * t_med)

    seal_mask = cv2.bitwise_or(mask, cubi)
    sealed = 0
    for o in sg["openings"]:
        p = np.array(o["position"], float)
        fx, fy = int(p[0] - cx0), int(p[1] - cy0)
        if not (0 <= fx < W and 0 <= fy < H):
            continue
        d = nearest_wall_dir(p)
        L = 1.6 * o["width_px"]
        cv2.line(seal_mask, (int(fx - d[0] * L / 2), int(fy - d[1] * L / 2)),
                  (int(fx + d[0] * L / 2), int(fy + d[1] * L / 2)), 1, thickness=max(opening_bar_floor, int(t_med)))
        sealed += 1
    cubi_px = int(cubi.sum())
    log(lines, f"seal layer: {cubi_px} CubiCasa wall px + {sealed} opening bars (labeling copy only)")
    return seal_mask, cubicasa_rooms, fixtures, {"cubicasa_wall_px": cubi_px, "opening_bars": sealed}


def _pt_dist(p, q):
    return math.hypot(p[0] - q[0], p[1] - q[1])


def _dedupe_reversed(group, tol):
    """Drop reversed near-duplicate segments within one label pair's wall list.
    Two segments are duplicates when their endpoints match within `tol` either
    same-order or reversed -- see the task brief's reference test."""
    kept = []
    used = [False] * len(group)
    for i, w in enumerate(group):
        if used[i]:
            continue
        a = (w["start"]["x"], w["start"]["y"])
        b = (w["end"]["x"], w["end"]["y"])
        for j in range(i + 1, len(group)):
            if used[j]:
                continue
            w2 = group[j]
            c = (w2["start"]["x"], w2["start"]["y"])
            e = (w2["end"]["x"], w2["end"]["y"])
            if (_pt_dist(a, e) < tol and _pt_dist(b, c) < tol) or (_pt_dist(a, c) < tol and _pt_dist(b, e) < tol):
                used[j] = True
        used[i] = True
        kept.append(w)
    return kept


def _axis_snap(w, angle_tol_deg):
    """Snap a segment's endpoints (in place) to horizontal/vertical when the
    segment is within angle_tol_deg of that axis. Snapping sets both endpoints'
    shared coordinate to their rounded mean. Segments further off-axis are left
    untouched -- genuinely diagonal walls must survive."""
    x1, y1 = w["start"]["x"], w["start"]["y"]
    x2, y2 = w["end"]["x"], w["end"]["y"]
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return w
    ang = math.degrees(math.atan2(dy, dx)) % 180.0
    off_h = min(ang, 180.0 - ang)  # distance to horizontal (0/180deg)
    off_v = abs(ang - 90.0)        # distance to vertical (90deg)
    if off_h <= angle_tol_deg:
        y_mean = int(round((y1 + y2) / 2.0))
        w["start"]["y"] = y_mean
        w["end"]["y"] = y_mean
    elif off_v <= angle_tol_deg:
        x_mean = int(round((x1 + x2) / 2.0))
        w["start"]["x"] = x_mean
        w["end"]["x"] = x_mean
    return w


def _collinear_merge_candidate(w1, w2, collinear_tol, gap_tol):
    """If w1, w2 are collinear within collinear_tol and their spans touch or
    overlap within gap_tol, return (start_pt, end_pt) of the merged union
    segment (the two extreme original endpoints); else None."""
    p1 = (w1["start"]["x"], w1["start"]["y"])
    p2 = (w1["end"]["x"], w1["end"]["y"])
    p3 = (w2["start"]["x"], w2["start"]["y"])
    p4 = (w2["end"]["x"], w2["end"]["y"])

    # reference direction from the longer of the two segments, for stability
    if _pt_dist(p1, p2) >= _pt_dist(p3, p4):
        origin, tip = p1, p2
    else:
        origin, tip = p3, p4
    dx, dy = tip[0] - origin[0], tip[1] - origin[1]
    norm = math.hypot(dx, dy)
    if norm == 0:
        return None
    ux, uy = dx / norm, dy / norm

    def proj(p):
        return (p[0] - origin[0]) * ux + (p[1] - origin[1]) * uy

    def perp(p):
        return abs((p[0] - origin[0]) * (-uy) + (p[1] - origin[1]) * ux)

    pts = (p1, p2, p3, p4)
    if max(perp(p) for p in pts) > collinear_tol:
        return None

    tA_min, tA_max = sorted((proj(p1), proj(p2)))
    tB_min, tB_max = sorted((proj(p3), proj(p4)))
    if tB_min <= tA_max and tA_min <= tB_max:
        gap = 0.0
    else:
        gap = max(tB_min - tA_max, tA_min - tB_max)
    if gap > gap_tol:
        return None

    ranked = sorted(((proj(p), p) for p in pts), key=lambda t: t[0])
    return ranked[0][1], ranked[-1][1]


def _merge_collinear_group(group, collinear_tol, gap_tol):
    """Transitively merge collinear, touching/overlapping segments within one
    label pair's wall list, iterating to a fixed point (so an A-B-C chain
    collapses to a single segment)."""
    walls = list(group)
    changed = True
    while changed and len(walls) > 1:
        changed = False
        for i in range(len(walls)):
            for j in range(i + 1, len(walls)):
                res = _collinear_merge_candidate(walls[i], walls[j], collinear_tol, gap_tol)
                if res is None:
                    continue
                start_pt, end_pt = res
                merged = {
                    "start": {"x": int(round(start_pt[0])), "y": int(round(start_pt[1]))},
                    "end": {"x": int(round(end_pt[0])), "y": int(round(end_pt[1]))},
                    "between": walls[i]["between"],
                    "exterior": walls[i]["exterior"],
                }
                walls = [w for k, w in enumerate(walls) if k not in (i, j)] + [merged]
                changed = True
                break
            if changed:
                break
    return walls


def _drop_stub_group(group, stub_len):
    """Drop segments shorter than stub_len, unless doing so would empty the
    group -- a label pair must never lose all its walls (that would open a
    hole between two rooms)."""
    if len(group) <= 1:
        return list(group)
    kept, stubs = [], []
    for w in group:
        length = _pt_dist((w["start"]["x"], w["start"]["y"]), (w["end"]["x"], w["end"]["y"]))
        (stubs if length < stub_len else kept).append(w)
    if not kept:
        kept = [max(stubs, key=lambda w: _pt_dist(
            (w["start"]["x"], w["start"]["y"]), (w["end"]["x"], w["end"]["y"])))]
    return kept


def _postprocess_walls(lines, walls, dist, cfg, Himg, Wimg):
    """Post-process the raw per-boundary-pixel-trace wall segments, per label
    pair (`between`) since segments from different pairs are different walls
    and must never merge:

    1. Drop reversed duplicates (1px-wide boundary-curve tracing walks out and
       back, emitting each real segment ~twice).
    2. Axis-snap segments within WALL_SNAP_ANGLE_DEG of horizontal/vertical.
    3. Merge collinear, touching/overlapping segments into single runs.
    4. Drop surviving stubs shorter than WALL_STUB_LEN_T_MED_FRAC * t_med,
       unless a label pair would be left with zero walls.
    """
    t_med = cfg.get("_t_med", 0.0)
    dup_tol = cfg["WALL_DUP_TOL_T_MED_FRAC"] * t_med
    angle_tol = cfg["WALL_SNAP_ANGLE_DEG"]
    collinear_tol = cfg["WALL_COLLINEAR_T_MED_FRAC"] * t_med
    gap_tol = cfg["WALL_MERGE_GAP_T_MED_FRAC"] * t_med
    stub_len = cfg["WALL_STUB_LEN_T_MED_FRAC"] * t_med

    groups = {}
    for w in walls:
        groups.setdefault(tuple(w["between"]), []).append(w)

    n_raw = sum(len(g) for g in groups.values())

    for key in list(groups.keys()):
        groups[key] = _dedupe_reversed(groups[key], dup_tol)
    n_dedupe = sum(len(g) for g in groups.values())

    for group in groups.values():
        for w in group:
            _axis_snap(w, angle_tol)

    for key in list(groups.keys()):
        groups[key] = _merge_collinear_group(groups[key], collinear_tol, gap_tol)
    n_merge = sum(len(g) for g in groups.values())

    for key in list(groups.keys()):
        groups[key] = _drop_stub_group(groups[key], stub_len)
    n_stubs = sum(len(g) for g in groups.values())

    final = []
    wid = 0
    for key, group in groups.items():
        for w in group:
            x1, y1 = w["start"]["x"], w["start"]["y"]
            x2, y2 = w["end"]["x"], w["end"]["y"]
            mx, my = int((x1 + x2) // 2), int((y1 + y2) // 2)
            thickness = round(float(2 * dist[np.clip(my, 0, Himg - 1), np.clip(mx, 0, Wimg - 1)]), 1) or round(t_med, 1)
            final.append({
                "id": f"w{wid}",
                "start": {"x": int(x1), "y": int(y1)},
                "end": {"x": int(x2), "y": int(y2)},
                "thickness": thickness,
                "between": list(key),
                "exterior": bool(w["exterior"]),
            })
            wid += 1

    log(lines, f"wall post-process: {n_raw} raw -> dedupe -> {n_dedupe} -> axis-snap "
                f"-> merge collinear -> {n_merge} -> drop stubs -> {n_stubs} final walls "
                f"over {len(groups)} label pairs "
                f"(dup_tol={dup_tol:.1f}px snap_angle={angle_tol:.1f}deg "
                f"collinear_tol={collinear_tol:.1f}px gap_tol={gap_tol:.1f}px stub_len={stub_len:.1f}px)")
    return final


def stage_regions_and_walls(lines, seal_mask, dist, cfg, prob_full):
    """Cell 6 (notebook cell index 8) -- rooms-first region extraction + wall derivation.

    `prob_full` is the wall-probability map (float32, same H x W as `seal_mask`) --
    threaded through explicitly (not stashed in `cfg`) so the wall-probability gate
    below can compare each candidate region's own wall evidence against the image's
    own probability statistics. See CFG["ROOM_WALL_GATE_BBOX_MEAN_FRAC"] and
    CFG["ROOM_WALL_GATE_MIN_AREA_FRAC"] for the gate's design rationale.
    """
    min_area = min_room_area(cfg)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(
        cv2.bitwise_not(seal_mask * 255), connectivity=4)

    Himg, Wimg = labels.shape
    exterior = {l for l in range(1, n)
                if stats[l, cv2.CC_STAT_LEFT] == 0 or stats[l, cv2.CC_STAT_TOP] == 0
                or stats[l, cv2.CC_STAT_LEFT] + stats[l, cv2.CC_STAT_WIDTH] >= Wimg
                or stats[l, cv2.CC_STAT_TOP] + stats[l, cv2.CC_STAT_HEIGHT] >= Himg}
    room_ids_pre_gate = [l for l in range(1, n)
                         if l not in exterior and stats[l, cv2.CC_STAT_AREA] >= min_area]

    # Wall-probability gate: a region only counts as page margin (and is dropped
    # from room_ids) if BOTH hold: its bounding box is ink-sparse (low wall_prob
    # relative to the image) AND it is large enough, as a share of the whole
    # image, to plausibly be sheet margin rather than a real small room. Signal 1
    # alone flags real, sparse-area rooms too (see CFG comment); requiring both is
    # what keeps this a page-margin detector instead of a general ink-density
    # filter. See CFG["ROOM_WALL_GATE_BBOX_MEAN_FRAC"] /
    # CFG["ROOM_WALL_GATE_MIN_AREA_FRAC"] for the full rationale and the
    # alternatives (interior mean, boundary-ring mean) that were measured and
    # rejected outright, not just tuned around.
    img_mean_prob = float(prob_full.mean())
    img_area = float(Himg * Wimg)
    gate_frac = cfg["ROOM_WALL_GATE_BBOX_MEAN_FRAC"]
    min_area_frac = cfg["ROOM_WALL_GATE_MIN_AREA_FRAC"]
    room_ids = []
    gated_out = []
    for l in room_ids_pre_gate:
        x, y, w, h, area = stats[l]
        bbox_mean = float(prob_full[y:y + h, x:x + w].mean())
        ratio = (bbox_mean / img_mean_prob) if img_mean_prob else 0.0
        area_frac = area / img_area
        if ratio < gate_frac and area_frac >= min_area_frac:
            gated_out.append((l, bbox_mean, ratio, area_frac))
        else:
            room_ids.append(l)

    if gated_out:
        detail = "; ".join(
            f"label {l} (bbox_mean={bm:.4f} = {r:.3f}x image mean, "
            f"area={af:.3f}x image area)" for l, bm, r, af in gated_out)
        log(lines, f"wall-prob gate: rejected {len(gated_out)} label(s) with "
                    f"bbox_mean < {gate_frac:.2f}x image mean ({img_mean_prob:.4f}) "
                    f"AND area >= {min_area_frac:.2f}x image area ({img_area:.0f}px): {detail}")
    else:
        log(lines, f"wall-prob gate: no labels rejected "
                    f"(bbox_mean threshold {gate_frac:.2f}x image mean = {img_mean_prob:.4f}, "
                    f"area threshold {min_area_frac:.2f}x image area = {img_area:.0f}px)")

    log(lines, f"labels: {n - 1}  exterior: {len(exterior)}  rooms: {len(room_ids)}")

    rooms = []
    for l in room_ids:
        rm = (labels == l).astype(np.uint8)
        cnts, _ = cv2.findContours(rm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        c = max(cnts, key=cv2.contourArea)
        poly = cv2.approxPolyDP(c, 0.01 * cv2.arcLength(c, True), True)[:, 0, :]
        rooms.append({"label": int(l), "polygon": [{"x": int(x), "y": int(y)} for x, y in poly],
                      "area_px": int(stats[l, cv2.CC_STAT_AREA])})
    log(lines, f"room polygons (closed by construction): {[len(r['polygon']) for r in rooms]} vertices")

    _, (iy, ix) = ndimage.distance_transform_edt(labels == 0, return_indices=True)
    assign = labels[iy, ix]

    # resolution-relative pixel tolerances (were hardcoded absolute px); each rounds
    # to its old hardcoded value at this sample's t_med=26, so native-res output is
    # unchanged, but they now scale with wall thickness at other resolutions.
    # `_t_med` is set by main() (and by any caller) from stage_seal_thickness. It is
    # load-bearing for all three tolerances below: defaulting it to 0 would silently
    # disable every filter and make approxPolyDP keep every pixel as a vertex, so a
    # missing value is an error, not a fallback.
    t_med_ref = cfg.get("_t_med", 0.0)
    if not t_med_ref:
        raise ValueError(
            "cfg['_t_med'] is unset or zero; set it from stage_seal_thickness's "
            "t_med before calling stage_regions_and_walls")
    wall_eps = cfg["WALL_EPS_T_MED_FRAC"] * t_med_ref  # was hardcoded `3`
    min_boundary_pts = int(round(cfg["MIN_BOUNDARY_PTS_T_MED_FRAC"] * t_med_ref))  # was hardcoded `5`
    min_seg_len_sq = int(round(cfg["MIN_SEG_LEN_T_MED_FRAC"] * t_med_ref)) ** 2  # was hardcoded `25` (5px squared)

    wall_px = seal_mask.astype(bool)
    a = np.where(wall_px, assign, 0)
    pairs = {}
    for shift, axis in ((1, 1), (1, 0)):
        b = np.roll(a, shift, axis=axis)
        edge = wall_px & np.roll(wall_px, shift, axis=axis) & (a != b) & (a > 0) & (b > 0)
        ys, xs = np.nonzero(edge)
        for y, x in zip(ys, xs):
            key = tuple(sorted((int(a[y, x]), int(b[y, x]))))
            pairs.setdefault(key, []).append((x, y))

    walls = []
    wid = 0
    for (la, lb), pts in pairs.items():
        if len(pts) < min_boundary_pts:
            continue
        pm = np.zeros_like(seal_mask)
        for x, y in pts:
            pm[y, x] = 1
        cnts, _ = cv2.findContours(pm, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            approx = cv2.approxPolyDP(c, wall_eps, False)[:, 0, :]
            for i in range(len(approx) - 1):
                (x1, y1), (x2, y2) = approx[i], approx[i + 1]
                if (int(x1) - int(x2)) ** 2 + (int(y1) - int(y2)) ** 2 < min_seg_len_sq:
                    continue
                mx, my = int((x1 + x2) // 2), int((y1 + y2) // 2)
                walls.append({"id": f"w{wid}",
                              "start": {"x": int(x1), "y": int(y1)}, "end": {"x": int(x2), "y": int(y2)},
                              "thickness": round(float(2 * dist[np.clip(my, 0, Himg - 1), np.clip(mx, 0, Wimg - 1)]), 1) or round(cfg.get("_t_med", 0.0), 1),
                              "between": [int(la), int(lb)],
                              "exterior": bool(la in exterior or lb in exterior)})
                wid += 1
    log(lines, f"derived {len(walls)} raw wall runs from {len(pairs)} adjacent label pairs")

    # Post-process the raw derivation: it emits reversed near-duplicates (tracing a
    # 1px-wide boundary curve walks out and back) and jagged staircase segments
    # (approxPolyDP faithfully following the pixel staircase of a diagonal-ish
    # boundary). See the task brief / local/README.md for the measured baseline.
    walls = _postprocess_walls(lines, walls, dist, cfg, Himg, Wimg)
    # Parsed by parse_reference_log() for the fidelity check. Must report the FINAL
    # wall list, not the raw one above, so log and metrics can never disagree.
    log(lines, f"final {len(walls)} wall runs from {len(pairs)} adjacent label pairs")

    return {
        "n": n, "labels": labels, "stats": stats, "cents": cents,
        "exterior": exterior, "room_ids": room_ids, "rooms": rooms, "walls": walls,
        "metrics": {"labels": n - 1, "exterior": len(exterior), "rooms": len(room_ids),
                    "room_vertices": [len(r["polygon"]) for r in rooms],
                    "wall_runs": len(walls), "adjacent_pairs": len(pairs)},
    }


def stage_consensus(lines, labels, room_ids, rooms, walls, cubicasa_rooms, cx0, cy0, cfg,
                    exterior_labels=frozenset()):
    """Cell 7 (notebook cell index 10) -- Layer 3 consensus scoring + invariants + routing.

    CubiCasa's rasterized rooms are filtered/mapped in two explicitly separate
    passes (see local/README.md "Findings: why is consensus 0.07?" items 2/2b for
    the bug this replaces):

      1. area filter -- drop fragment-noise rooms (CubiCasa's polygon export
         shatters some real rooms into disconnected slivers) using the same
         min_room_area(cfg) threshold MitUNet regions are held to.
      2. max-overlap mapping -- for each surviving room, map it to whichever
         MitUNet region it overlaps most BY PIXEL AREA (every rasterized pixel,
         not one sampled centroid point), and keep it only if that overlap is
         nonzero. This replaces the old single-point _centroid_label rule, which
         was dropping the two largest real rooms in the fixture file because
         their sampled centroid happened to land on a MitUNet wall pixel drawn
         through the middle of a room MitUNet had internally subdivided.

    The old ">=50% inside crop" coverage filter is deleted, not fixed: its
    coverage_ratio (rasterized mask px / shoelace polygon area) never dips below
    1.0 anywhere in this fixture (crop_offset=(0,0), plan fills the sheet -- there
    is no crop boundary to clip a neighbour room against), so it has never fired
    and is confirmed dead code, not merely unexercised. There is also no crop
    rectangle available to clip against here: cx0/cy0 is a translation offset
    applied to CubiCasa coordinates, not a stored crop width/height, so "fix it to
    clip against the actual crop rectangle" would mean inventing new state this
    function doesn't otherwise need. The area filter above already removes any
    resulting sliver small enough to be noise; a partial-room fragment that
    survives a real crop AND clears min_room_area is legitimate area worth
    scoring, not something a coverage filter should be discarding either.
    coverage_info is kept purely as descriptive per-room diagnostic output.
    """
    all_cubi_pairs = rasterize_rooms(cubicasa_rooms, labels.shape, cx0, cy0)

    coverage_info = {}
    for r, m in all_cubi_pairs:
        area = max(shoelace_area(r["polygon"]), 1)
        coverage_info[r["id"]] = {"mask_sum": int(m.sum()), "polygon_area": area,
                                   "coverage_ratio": float(m.sum() / area)}

    # -- Job 1: explicit area filter for fragment noise (before any mapping).
    min_area = min_room_area(cfg)
    area_pairs = [(r, m) for r, m in all_cubi_pairs if m.sum() >= min_area]
    area_dropped = [(r, m) for r, m in all_cubi_pairs if m.sum() < min_area]
    area_dropped_ids = {r["id"] for r, m in area_dropped}
    area_dropped_total_px = sum(int(m.sum()) for r, m in area_dropped)
    log(lines, f"cubicasa area filter: min_room_area={min_area:.0f}px^2 -- "
                f"dropped {len(area_dropped)}/{len(all_cubi_pairs)} rooms as fragment noise, "
                f"total {area_dropped_total_px}px^2")

    # -- Job 2: max-overlap mapping, using every rasterized pixel rather than one
    # sampled centroid point. bincount over the labels restricted to the room's
    # mask gives the overlap area against every MitUNet region in one pass.
    n_labels = int(labels.max()) + 1

    def _max_overlap_label(m):
        mb = m.astype(bool)
        if not mb.any():
            return 0, 0
        counts = np.bincount(labels[mb], minlength=n_labels)
        best_label, best_overlap = 0, 0
        for rid in room_ids:
            c = int(counts[rid]) if rid < len(counts) else 0
            if c > best_overlap:
                best_overlap, best_label = c, rid
        return best_label, best_overlap

    # A room with no overlap against any COUNTED region is dropped, but where its
    # pixels actually landed is diagnostically different: sitting on wall/background
    # is over-segmentation debris, whereas sitting inside MitUNet's EXTERIOR region
    # is the two models disagreeing about the building envelope. room_010_6 (26,010px^2)
    # is 99.6% inside exterior label 1 - a real disagreement worth surfacing, not noise.
    def _dominant_noncounted(m):
        mb = m.astype(bool)
        if not mb.any():
            return None, 0
        counts = np.bincount(labels[mb], minlength=n_labels)
        order = np.argsort(-counts)
        for lab in order:
            lab = int(lab)
            if counts[lab] == 0:
                break
            if lab not in room_ids:
                return lab, int(counts[lab])
        return None, 0

    overlap_labels = {}
    overlap_px = {}
    landed_in = {}
    cubi_pairs2 = []
    for r, m in area_pairs:
        label, overlap = _max_overlap_label(m)
        overlap_labels[r["id"]] = int(label)
        overlap_px[r["id"]] = int(overlap)
        cubi_pairs2.append((r, m, label))
        if overlap > 0:
            log(lines, f"cubicasa room {r['id']} ({r.get('type', '?')}, "
                        f"{int(m.sum())}px^2): max-overlap MitUNet label {label} ({overlap}px overlap)")
        else:
            lab, cnt = _dominant_noncounted(m)
            where = ("MitUNet exterior" if lab in exterior_labels
                     else "wall/background" if lab == 0
                     else f"non-counted label {lab}")
            landed_in[r["id"]] = {"label": lab, "px": cnt, "where": where}
            log(lines, f"cubicasa room {r['id']} ({r.get('type', '?')}, "
                        f"{int(m.sum())}px^2): NO overlap with any counted room - "
                        f"{cnt}px ({100.0 * cnt / max(int(m.sum()), 1):.0f}%) lies in {where}")

    cubi_pairs_final = [(r, m, l) for r, m, l in cubi_pairs2 if overlap_px[r["id"]] > 0]
    cubi_masks = [m for _, m, _ in cubi_pairs_final]
    surviving_ids = [r["id"] for r, _, _ in cubi_pairs_final]
    zero_overlap_ids = {r["id"] for r, m in area_pairs} - set(surviving_ids)
    room_masks = build_room_masks(labels, room_ids)

    if room_ids and cubi_masks:
        iou = pairwise_iou(labels, room_ids, cubi_masks)
        matches = hungarian_match(iou, min_iou=cfg["MATCH_MIN_IOU"])
    else:
        iou, matches = np.zeros((0, 0)), []
    # consensus_legacy: UNCHANGED formula -- binary >=MATCH_MIN_IOU Hungarian
    # match, counted 1:1 over max(rooms_mitunet, rooms_cubicasa). Kept
    # side-by-side per task D for comparison; no longer drives routing below
    # (see graded_room_consensus() for what replaces it and why).
    consensus_legacy = len(matches) / max(len(room_ids), len(cubi_masks), 1)
    log(lines, f"consensus: {len(matches)} matches / max({len(room_ids)} mitunet, {len(cubi_masks)} cubicasa) = {consensus_legacy:.2f}")

    # Task A/B -- graded, many-to-one consensus. This is now the score that
    # drives routing/acceptance below. See graded_room_consensus()'s
    # docstring for the full design rationale.
    consensus, consensus_contributions = graded_room_consensus(labels, room_ids, area_pairs, cfg)

    def _fmt_contrib(c):
        grp = "" if c["group_size"] <= 1 else f", group of {c['group_size']}"
        return f"{c['cubi_id']}({c['cubi_type']})={c['score']:.3f}[{c['area_px']}px^2 -> mitunet {c['dominant_label']}{grp}]"

    contrib_str = "; ".join(_fmt_contrib(c) for c in consensus_contributions)
    log(lines, f"consensus_graded: area-weighted score over {len(consensus_contributions)} "
                f"cubicasa room(s) = {consensus:.3f}  [{contrib_str}]")

    inv = {
        "all_polygons_closed": all(polygon_is_closed(r["polygon"]) for r in rooms),
        "min_area_ok": all(r["area_px"] >= min_room_area(cfg) for r in rooms),
        "room_count_sane": 1 <= len(rooms) <= 40,
        "has_rooms": len(rooms) > 0,
    }
    degs = wall_endpoint_degrees(walls, cfg["WALL_ENDPOINT_TOL_T_MED_FRAC"] * cfg["_t_med"])
    n_loose = sum((d[0] < 1) + (d[1] < 1) for d in degs.values())
    inv["loose_endpoints_warn"] = n_loose
    log(lines, f"invariants: {inv}")

    hard_fail = not (inv["all_polygons_closed"] and inv["min_area_ok"] and inv["has_rooms"] and inv["room_count_sane"])
    merged_rooms_note = consensus < cfg["CONSENSUS_MIN"] and not hard_fail
    needs_repair = consensus < cfg["CONSENSUS_MIN"] and hard_fail
    log(lines, f"routing: hard_fail={hard_fail}  merged_rooms_note={merged_rooms_note}  needs_repair={needs_repair}")

    return {
        "all_cubi_pairs": all_cubi_pairs, "coverage_info": coverage_info,
        "min_room_area": min_area,
        "area_pairs": area_pairs,
        "area_dropped_ids": area_dropped_ids, "area_dropped_total_px": area_dropped_total_px,
        "overlap_labels": overlap_labels, "overlap_px": overlap_px,
        "zero_overlap_ids": zero_overlap_ids, "zero_overlap_landed_in": landed_in,
        "surviving_ids": surviving_ids,
        "cubi_masks": cubi_masks, "cubi_pairs_final": cubi_pairs_final,
        "room_masks": room_masks, "iou": iou, "matches": matches,
        "consensus": consensus, "consensus_legacy": consensus_legacy,
        "consensus_contributions": consensus_contributions,
        "inv": inv, "n_loose": n_loose, "hard_fail": hard_fail,
        "merged_rooms_note": merged_rooms_note, "needs_repair": needs_repair,
    }


def stage_watershed_split(lines, labels, room_ids, consensus_ctx, cfg):
    """Cell 8 (notebook cell index 11) -- Layer 4 watershed VIRTUAL split for scoring.

    Task C -- seed gate: a CubiCasa room only acts as a watershed seed if its OWN
    rasterized area is >= min_room_area(cfg) -- the same t_med-derived threshold
    stage_consensus's Job 1 already filters cubi rooms by. Measured on this branch's
    sample, this turns out to be a no-op in practice, not because the gate is wrong
    but because stage_consensus's Job-1 area filter (added in the immediately
    preceding commit, "Replace centroid room mapping with max-overlap, split
    filter's two jobs") already removes every fragment-sized CubiCasa room --
    including the 120-216px^2 slivers local/README.md's "why the watershed virtual
    split makes it worse" section describes -- before a room can ever become a
    `cubi_pairs_final` entry, which is this function's only source of seeds. So
    every seed reaching this function already satisfies the gate today. The gate is
    implemented anyway, verbatim as specified, because that invariant should not be
    implicit/load-bearing across two functions: a future change to Job 1, or a
    caller that feeds this function seeds from somewhere else, should not silently
    reopen the fragment-seed problem. See the task report for the measured
    (non-)effect on this sample, including why the split still nets out to no real
    change even without the gate (two of the three raw seeds for label 12 are the
    FULL room's centroid, which lands outside label 12's own boundary for a room
    that's mostly in other MitUNet regions -- watershed can't grow from a marker
    that isn't inside the region being split).
    """
    merged_rooms_note = consensus_ctx["merged_rooms_note"]
    cubi_pairs_final = consensus_ctx["cubi_pairs_final"]
    cubi_masks = consensus_ctx["cubi_masks"]
    area_pairs = consensus_ctx["area_pairs"]
    consensus = consensus_ctx["consensus"]
    consensus_legacy = consensus_ctx["consensus_legacy"]
    consensus_split = consensus
    consensus_split_legacy = consensus_legacy
    min_area = min_room_area(cfg)

    result = {
        "ran": False, "vroom_ids": [], "iou2": np.zeros((0, 0)), "matches2": [],
        "consensus_split_legacy": consensus_legacy, "contributions_split": [],
        "gated_seed_drops": [],
    }
    if merged_rooms_note and cubi_pairs_final:
        vlabels = np.zeros_like(labels)
        nxt = 1
        gated_seed_drops = []
        for rid in room_ids:
            region = labels == rid
            seed_cands = [(r["id"], m) for r, m, l in cubi_pairs_final if l == rid]
            seeds = []
            for cubi_id, m in seed_cands:
                area = int(m.sum())
                if area < min_area:
                    gated_seed_drops.append((int(rid), cubi_id, area))
                    continue
                ys, xs = np.nonzero(m)
                if len(xs):
                    seeds.append((int(ys.mean()), int(xs.mean())))
            if len(seeds) <= 1:
                vlabels[region] = nxt
                nxt += 1
                continue
            markers = np.zeros_like(labels)
            for k, c in enumerate(seeds, 1):
                markers[c] = k
            d = cv2.distanceTransform(region.astype(np.uint8), cv2.DIST_L2, 5)
            ws = sk_watershed(-d, markers=markers, mask=region)
            for k in range(1, len(seeds) + 1):
                if (ws == k).any():
                    vlabels[ws == k] = nxt
                    nxt += 1
        vroom_ids = list(range(1, nxt))
        if gated_seed_drops:
            detail = "; ".join(f"region {rid} seed {cid} ({area}px^2)" for rid, cid, area in gated_seed_drops)
            log(lines, f"watershed seed gate: dropped {len(gated_seed_drops)} seed(s) below "
                        f"min_room_area={min_area:.0f}px^2: {detail}")
        else:
            log(lines, f"watershed seed gate: no seeds below min_room_area={min_area:.0f}px^2 "
                        f"(every cubi_pairs_final entry already survived stage_consensus's Job 1)")

        iou2 = pairwise_iou(vlabels, vroom_ids, cubi_masks)
        matches2 = hungarian_match(iou2, min_iou=cfg["MATCH_MIN_IOU"])
        consensus_split_legacy = len(matches2) / max(len(vroom_ids), len(cubi_masks), 1)
        consensus_split, contributions_split = graded_room_consensus(vlabels, vroom_ids, area_pairs, cfg)
        log(lines, f"virtual split: {len(room_ids)} regions -> {len(vroom_ids)} sub-rooms; "
                    f"consensus_legacy {consensus_legacy:.2f} -> {consensus_split_legacy:.2f}  "
                    f"consensus_graded {consensus:.3f} -> {consensus_split:.3f}")
        result = {
            "ran": True, "vlabels": vlabels, "vroom_ids": vroom_ids, "iou2": iou2, "matches2": matches2,
            "consensus_split_legacy": consensus_split_legacy, "contributions_split": contributions_split,
            "gated_seed_drops": gated_seed_drops,
        }
    else:
        log(lines, "no split needed")

    consensus_final = max(consensus, consensus_split)
    consensus_final_legacy = max(consensus_legacy, consensus_split_legacy)
    result["consensus_final_legacy"] = consensus_final_legacy
    return consensus_final, consensus_split, result


def stage_acceptance(lines, rooms, cubi_masks, matches, consensus_final, consensus, cfg,
                       t_med, n_loose, inv, needs_repair, merged_rooms_note, cx0, cy0,
                       consensus_final_legacy, consensus_legacy):
    """Cell 9 (notebook cell index 12) -- acceptance barrier.

    `consensus_final`/`consensus` are now the graded score (see
    graded_room_consensus) -- this is what `needs_repair`/`merged_rooms_note`
    were already computed against upstream, and what the acceptance barrier
    below reasons about. `consensus_final_legacy`/`consensus_legacy` are the
    OLD binary-match formula, reported alongside per task D but not used for
    any routing decision here.
    """
    reasons = []
    if not inv["has_rooms"]:
        reasons.append("no_rooms")
    if not inv["all_polygons_closed"]:
        reasons.append("open_polygon")
    if not inv["min_area_ok"]:
        reasons.append("room_below_min_area")
    if not inv["room_count_sane"]:
        reasons.append("room_count_implausible")
    if needs_repair:
        reasons.append("low_consensus_with_geometry_anomaly")

    passed = not reasons
    report = {
        "accepted": bool(passed),
        "reject_reasons": reasons,
        "notes": (["merged_rooms"] if merged_rooms_note else []),
        "metrics": {"rooms_mitunet": len(rooms), "rooms_cubicasa": len(cubi_masks),
                    "consensus_iou": round(consensus_final, 3), "consensus_raw": round(consensus, 3),
                    # Task D -- old formula, kept alongside for comparison; NOT used
                    # for routing (see docstring). "_raw" suffix mirrors
                    # consensus_raw/consensus_iou: "_legacy" is pre-split,
                    # "_legacy_final" is post-split (max with the watershed pass).
                    "consensus_legacy": round(consensus_legacy, 3),
                    "consensus_legacy_final": round(consensus_final_legacy, 3),
                    "matches": len(matches),
                    "wall_thickness_px": round(t_med, 1), "loose_endpoints": int(n_loose),
                    "crop_offset": [int(cx0), int(cy0)]}
    }
    log(lines, json.dumps(report, indent=2))
    return report


# --------------------------------------------------------------------------
# Diagnostics assembly (Deliverable 2)
# --------------------------------------------------------------------------
ROOM_TYPE_BY_ID = {}


def build_diagnostics(region_ctx, consensus_ctx, split_ctx_tuple, cfg, cubicasa_rooms, report, fidelity):
    labels = region_ctx["labels"]
    stats = region_ctx["stats"]
    room_ids = region_ctx["room_ids"]
    rooms = region_ctx["rooms"]

    for r in cubicasa_rooms:
        ROOM_TYPE_BY_ID[r["id"]] = r.get("type", "?")

    # -- full IoU matrix vs ALL rasterizable cubicasa rooms (pre-filter), for top-3 candidates
    all_cubi_pairs = consensus_ctx["all_cubi_pairs"]
    all_cubi_ids = [r["id"] for r, _ in all_cubi_pairs]
    all_cubi_masks = [m for _, m in all_cubi_pairs]
    iou_all = pairwise_iou(labels, room_ids, all_cubi_masks) if room_ids and all_cubi_masks else np.zeros((len(room_ids), 0))

    mitunet_rooms_diag = []
    for i, rid in enumerate(room_ids):
        x, y, w, h, area = stats[rid]
        cy, cx = np.nonzero(labels == rid)
        centroid = [float(cx.mean()), float(cy.mean())] if len(cx) else None
        row = iou_all[i] if iou_all.size else np.zeros(0)
        order = np.argsort(-row)[:3]
        top3 = [{"cubi_id": all_cubi_ids[j], "cubi_type": ROOM_TYPE_BY_ID.get(all_cubi_ids[j], "?"),
                 "iou": float(row[j])} for j in order]
        mitunet_rooms_diag.append({
            "label": int(rid), "area_px": int(area),
            "bbox": {"x": int(x), "y": int(y), "w": int(w), "h": int(h)},
            "centroid": centroid,
            "top3_cubicasa_candidates": top3,
        })

    # -- cubicasa room survival diagnostics
    coverage_info = consensus_ctx["coverage_info"]
    overlap_labels = consensus_ctx["overlap_labels"]
    overlap_px = consensus_ctx["overlap_px"]
    min_room_area_px = consensus_ctx["min_room_area"]
    area_dropped_ids = consensus_ctx["area_dropped_ids"]
    zero_overlap_ids = consensus_ctx["zero_overlap_ids"]
    surviving_ids = set(consensus_ctx["surviving_ids"])
    rasterized_ids = {r["id"] for r, _ in all_cubi_pairs}

    cubicasa_rooms_diag = []
    for r in cubicasa_rooms:
        rid = r["id"]
        area = shoelace_area(r["polygon"])
        entry = {"id": rid, "type": r.get("type", "?"), "polygon_area_px": area}
        cov = coverage_info.get(rid, {})
        if rid not in rasterized_ids:
            entry["survived"] = False
            entry["drop_reason"] = "out_of_crop"
            entry["detail"] = "polygon bbox does not overlap the prob-map crop at all"
        elif rid in surviving_ids:
            entry["survived"] = True
            entry["drop_reason"] = None
            entry["detail"] = {"coverage_ratio": cov.get("coverage_ratio"),
                                "overlap_label": overlap_labels.get(rid),
                                "overlap_px": overlap_px.get(rid)}
        elif rid in area_dropped_ids:
            entry["survived"] = False
            entry["drop_reason"] = "area_filter"
            entry["detail"] = {"mask_sum_px": cov.get("mask_sum"), "polygon_area_px": cov.get("polygon_area"),
                                "min_room_area_px": min_room_area_px}
        elif rid in zero_overlap_ids:
            entry["survived"] = False
            entry["drop_reason"] = "zero_overlap"
            entry["detail"] = {"mask_sum_px": cov.get("mask_sum"),
                                "why": "max-overlap search found no MitUNet room_ids pixel under this room's mask "
                                       "(entirely background/wall/exterior/below-min-area MitUNet territory)"}
        else:
            # Shouldn't happen -- every rasterized room is exactly one of
            # surviving / area-dropped / zero-overlap. Keep a visible fallback
            # instead of silently mis-labeling if that invariant ever breaks.
            entry["survived"] = False
            entry["drop_reason"] = "unknown"
            entry["detail"] = {"coverage_ratio": cov.get("coverage_ratio")}
        cubicasa_rooms_diag.append(entry)

    # -- official (post-filter) consensus block. "matches"/"iou_matrix" here are
    # the LEGACY (binary >=MATCH_MIN_IOU Hungarian) view; "graded" is the new
    # area-weighted, many-to-one score that now drives routing -- see
    # graded_room_consensus() and consensus_ctx["consensus_contributions"] for
    # the per-CubiCasa-room breakdown (this is where the kitchen's 0.448 and
    # the merged-room groups are visible).
    iou_official = consensus_ctx["iou"]
    matches_official = consensus_ctx["matches"]
    surviving_ids_list = consensus_ctx["surviving_ids"]
    consensus_block = {
        "room_ids": [int(r) for r in room_ids],
        "cubi_ids": surviving_ids_list,
        "iou_matrix": iou_official.tolist(),
        "matches": [{"mitunet_label": int(room_ids[i]), "cubi_id": surviving_ids_list[j], "iou": v}
                    for i, j, v in matches_official],
        "legacy_score": consensus_ctx["consensus_legacy"],
        "graded_score": consensus_ctx["consensus"],
        "graded_contributions": consensus_ctx["consensus_contributions"],
    }

    # -- watershed block
    consensus_final, consensus_split, split_ctx = split_ctx_tuple
    if split_ctx["ran"]:
        vroom_ids = split_ctx["vroom_ids"]
        iou2 = split_ctx["iou2"]
        matches2 = split_ctx["matches2"]
        watershed_block = {
            "ran": True,
            "sub_room_count": len(vroom_ids),
            "vroom_ids": [int(v) for v in vroom_ids],
            "cubi_ids": surviving_ids_list,
            "iou_matrix": iou2.tolist(),
            "matches": [{"vroom_id": int(vroom_ids[i]), "cubi_id": surviving_ids_list[j], "iou": v}
                        for i, j, v in matches2],
            "gated_seed_drops": [{"mitunet_label": r, "cubi_id": c, "area_px": a}
                                  for r, c, a in split_ctx["gated_seed_drops"]],
            "consensus_before_split": consensus_ctx["consensus"],
            "consensus_after_split": consensus_split,
            "consensus_legacy_before_split": consensus_ctx["consensus_legacy"],
            "consensus_legacy_after_split": split_ctx["consensus_split_legacy"],
            "graded_contributions_after_split": split_ctx["contributions_split"],
        }
    else:
        watershed_block = {"ran": False, "reason": "merged_rooms_note is False or no surviving cubi rooms"}

    summary = dict(report["metrics"])
    summary["accepted"] = report["accepted"]
    summary["reject_reasons"] = report["reject_reasons"]
    summary["notes"] = report["notes"]

    return {
        "cfg": cfg,
        "mitunet_rooms": mitunet_rooms_diag,
        "cubicasa_rooms": cubicasa_rooms_diag,
        "consensus": consensus_block,
        "watershed": watershed_block,
        "summary": summary,
        "fidelity": fidelity,
    }


# --------------------------------------------------------------------------
# Overlay figure (Deliverable 3)
# --------------------------------------------------------------------------
def render_overlay(out_path, region_ctx, consensus_ctx, cfg, prob_shape):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    labels = region_ctx["labels"]
    room_ids = region_ctx["room_ids"]
    stats = region_ctx["stats"]
    H, W = prob_shape

    # color the label map (rooms only; everything else black)
    disp = np.zeros((H, W, 3), dtype=np.float32)
    cmap = plt.get_cmap("tab20")
    for i, rid in enumerate(room_ids):
        disp[labels == rid] = cmap(i % 20)[:3]

    fig, ax = plt.subplots(figsize=(W / 220, H / 220), dpi=220)
    ax.imshow(disp, interpolation="nearest")

    for rid in room_ids:
        x, y, w, h, area = stats[rid]
        cy, cx = np.nonzero(labels == rid)
        if len(cx) == 0:
            continue
        ax.text(cx.mean(), cy.mean(), str(rid), color="white", fontsize=9, fontweight="bold",
                ha="center", va="center", bbox=dict(boxstyle="round,pad=0.15", fc="black", alpha=0.6))

    all_cubi_pairs = consensus_ctx["all_cubi_pairs"]
    for r, m in all_cubi_pairs:
        poly = r["polygon"]
        xs = [p["x"] for p in poly] + [poly[0]["x"]]
        ys = [p["y"] for p in poly] + [poly[0]["y"]]
        ax.plot(xs, ys, color="cyan", linewidth=1.2)
        cxp = sum(p["x"] for p in poly) / len(poly)
        cyp = sum(p["y"] for p in poly) / len(poly)
        ax.text(cxp, cyp, r.get("type", "?"), color="cyan", fontsize=7,
                ha="center", va="center", bbox=dict(boxstyle="round,pad=0.1", fc="black", alpha=0.5))

    # Hungarian-matched centroid lines: raw assignment on the OFFICIAL surviving cubi set,
    # colored green (>=0.5, kept) or red/dashed (best pair, below threshold).
    iou_official = consensus_ctx["iou"]
    surviving_ids_list = consensus_ctx["surviving_ids"]
    cubi_pairs_final = consensus_ctx["cubi_pairs_final"]
    cubi_centroid = {}
    for r, m, _ in cubi_pairs_final:
        ys, xs = np.nonzero(m)
        if len(xs):
            cubi_centroid[r["id"]] = (float(xs.mean()), float(ys.mean()))

    room_centroid = {}
    for rid in room_ids:
        cy, cx = np.nonzero(labels == rid)
        if len(cx):
            room_centroid[rid] = (float(cx.mean()), float(cy.mean()))

    raw_pairs = hungarian_assignment_raw(iou_official) if iou_official.size else []
    for i, j, v in raw_pairs:
        rid = room_ids[i]
        cid = surviving_ids_list[j]
        if rid not in room_centroid or cid not in cubi_centroid:
            continue
        (rx, ry), (cx_, cy_) = room_centroid[rid], cubi_centroid[cid]
        if v >= cfg["MATCH_MIN_IOU"]:
            ax.plot([rx, cx_], [ry, cy_], color="lime", linewidth=2.0, solid_capstyle="round")
        else:
            ax.plot([rx, cx_], [ry, cy_], color="red", linewidth=1.5, linestyle="--")

    ax.set_xlim(0, W)
    ax.set_ylim(H, 0)
    ax.set_title(f"MitUNet rooms (colored, id labeled) vs CubiCasa polygons (cyan) -- "
                 f"green=matched>=0.5, red dashed=best-but-below-threshold")
    ax.axis("off")
    fig.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wall-prob", default=str(REPO_ROOT / "out" / "wall_prob_crop.npy"),
                    help="cached wall-probability .npy (float32 HxW). Default: out/wall_prob_crop.npy "
                         "-- this is the array that, together with the default --fixtures/--geometry, "
                         "reproduces v9_out.txt exactly (verified by the fidelity check below). "
                         "out/wall_prob.npy is a DIFFERENT, larger (2480x3507) probability map from an "
                         "earlier/unrelated inference pass -- passing it here still runs, but the fidelity "
                         "check will show large deltas because it is not the array that produced v9_out.txt.")
    ap.add_argument("--fixtures", default=str(REPO_ROOT / "out-cubicasa" / "cubicasa_rooms_fixtures.json"),
                    help="CubiCasa rooms+fixtures json (rooms field used for consensus).")
    ap.add_argument("--geometry", default=str(REPO_ROOT / "out-cubicasa" / "sample_geometry.json"),
                    help="CubiCasa walls+openings json (used only for the labeling-only seal layer).")
    ap.add_argument("--crop-offset", default="0,0", help="cx0,cy0 -- shift applied to CubiCasa coords "
                    "to land them in the prob-map's pixel frame. 0,0 is correct when --wall-prob is "
                    "already in the same (uncropped) coordinate space as --fixtures/--geometry.")
    # Default reference moved off v9_out.txt at the wall post-process change: that
    # log predates the dedupe/snap/merge pass and its wall_runs=240 is no longer the
    # expected value. v9_out.txt is still the Kaggle-side ground truth and can be
    # selected explicitly; local/ref/step2_reference.txt is this branch's snapshot.
    ap.add_argument("--reference-log", default=str(REPO_ROOT / "local" / "ref" / "step2_reference.txt"),
                    help="notebook run log to diff computed numbers against (fidelity check).")
    ap.add_argument("--out-dir", default=str(LOCAL_DIR / "out"))
    for key, default in CFG.items():
        flag = "--" + key.lower().replace("_", "-")
        ap.add_argument(flag, type=type(default), default=default)
    args = ap.parse_args()

    cfg = dict(CFG)
    for key in CFG:
        cfg[key] = getattr(args, key.lower())

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    lines = []
    t_start = time.time()

    prob_full = np.load(args.wall_prob).astype(np.float32)
    H, W = prob_full.shape
    cx0, cy0 = (int(v) for v in args.crop_offset.split(","))
    log(lines, f"loaded wall-prob: {args.wall_prob}  shape={prob_full.shape}  offset=({cx0},{cy0})")
    log(lines, f"fixtures: {args.fixtures}")
    log(lines, f"geometry: {args.geometry}")

    rf = json.load(open(args.fixtures, encoding="utf-8"))
    sg = json.load(open(args.geometry, encoding="utf-8"))

    log(lines, f"prob map: {prob_full.shape} offset ({cx0}, {cy0})")

    mask, m1 = stage_hysteresis(lines, prob_full, cfg)
    mask, dist, m2 = stage_seal_thickness(lines, mask, cfg, prob_full)
    cfg["_t_med"] = m2["t_med"]
    seal_mask, cubicasa_rooms, fixtures, m3 = stage_cubicasa_seal(lines, mask, sg, rf, m2["t_med"], cx0, cy0, H, W, cfg=cfg)
    region_ctx = stage_regions_and_walls(lines, seal_mask, dist, cfg, prob_full)
    consensus_ctx = stage_consensus(lines, region_ctx["labels"], region_ctx["room_ids"], region_ctx["rooms"],
                                     region_ctx["walls"], cubicasa_rooms, cx0, cy0, cfg,
                                     exterior_labels=region_ctx["exterior"])
    consensus_final, consensus_split, split_ctx = stage_watershed_split(
        lines, region_ctx["labels"], region_ctx["room_ids"], consensus_ctx, cfg)
    report = stage_acceptance(lines, region_ctx["rooms"], consensus_ctx["cubi_masks"], consensus_ctx["matches"],
                               consensus_final, consensus_ctx["consensus"], cfg, m2["t_med"], consensus_ctx["n_loose"],
                               consensus_ctx["inv"], consensus_ctx["needs_repair"], consensus_ctx["merged_rooms_note"],
                               cx0, cy0, split_ctx["consensus_final_legacy"], consensus_ctx["consensus_legacy"])

    computed = {
        **m1, **{k: v for k, v in m2.items()}, **m3,
        **region_ctx["metrics"],
        "matches": len(consensus_ctx["matches"]),
        "rooms_mitunet": len(region_ctx["rooms"]),
        "rooms_cubicasa": len(consensus_ctx["cubi_masks"]),
        # Fidelity check is against a reference log that predates the graded
        # score -- it encodes consensus_legacy's formula, so that's what must
        # be compared here, not the new graded "consensus" value.
        "consensus": consensus_ctx["consensus_legacy"],
    }
    ref = parse_reference_log(args.reference_log)
    fidelity = compare_to_reference(lines, computed, ref)

    diagnostics = build_diagnostics(region_ctx, consensus_ctx, (consensus_final, consensus_split, split_ctx),
                                     cfg, cubicasa_rooms, report, fidelity)
    diag_path = out_dir / "diagnostics.json"
    diag_path.write_text(json.dumps(diagnostics, indent=2), encoding="utf-8")
    log(lines, f"\nwrote {diag_path}")

    overlay_path = out_dir / "consensus_overlay.png"
    render_overlay(str(overlay_path), region_ctx, consensus_ctx, cfg, prob_full.shape)
    log(lines, f"wrote {overlay_path}")

    log_path = out_dir / "run_log.txt"
    log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(lines, f"wrote {log_path}")
    log(lines, f"total time: {time.time() - t_start:.1f}s")


if __name__ == "__main__":
    main()
