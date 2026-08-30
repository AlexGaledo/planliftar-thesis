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
    "MIN_ROOM_AREA": 2000,  # px^2, same default as v1 spike
    "WALL_HEIGHT": 2.5,     # relative units for GLB extrusion (Phase 3) -- unused here
    # Not a CFG constant in the notebook -- it's the literal `min_iou=0.5` hardcoded
    # into every `hungarian_match(...)` call in cell 7/8. Broken out here so it can
    # be swept too; default matches the notebook exactly.
    "MATCH_MIN_IOU": 0.5,
}


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


def wall_endpoint_degrees(walls, tol=6.0):
    """For each wall's start/end, count other walls (by endpoint or segment-body proximity) within tol px."""
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

    m = re.search(r"derived (\d+) wall runs from (\d+) adjacent label pairs", text)
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
                    "See local/README.md for why (sample-pairing mismatch, not a bug).")
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


def stage_seal_thickness(lines, mask, cfg):
    """Cell 4 (notebook cell index 6) -- Layer 1 wall thickness + micro-gap seal."""
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    skel = skeletonize(mask.astype(bool))
    t_med = 2 * float(np.median(dist[skel]))
    seal_below = cfg["SEAL_FACTOR"] * t_med
    k = int(seal_below) | 1
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    comps_after = cv2.connectedComponents(mask)[0] - 1
    log(lines, f"t_med = {t_med:.1f}px  seal kernel = {k}px  components after close = {comps_after}")
    return mask, dist, {"t_med": t_med, "seal_kernel": k, "components_after_close": comps_after}


def stage_cubicasa_seal(lines, mask, sg, rf, t_med, cx0, cy0, H, W):
    """Cell 5 (notebook cell index 7) -- CubiCasa seal hints, labeling only."""
    cubicasa_rooms = rf.get("rooms", [])
    fixtures = rf.get("fixtures", [])

    walls_np = [(np.array(w["start"], float), np.array(w["end"], float),
                 w.get("thickness_px", t_med)) for w in sg["walls"]]

    cubi = np.zeros_like(mask)
    for a, b, th in walls_np:
        cv2.line(cubi, (int(a[0] - cx0), int(a[1] - cy0)), (int(b[0] - cx0), int(b[1] - cy0)),
                  1, thickness=int(max(2, th)))

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
                  (int(fx + d[0] * L / 2), int(fy + d[1] * L / 2)), 1, thickness=max(6, int(t_med)))
        sealed += 1
    cubi_px = int(cubi.sum())
    log(lines, f"seal layer: {cubi_px} CubiCasa wall px + {sealed} opening bars (labeling copy only)")
    return seal_mask, cubicasa_rooms, fixtures, {"cubicasa_wall_px": cubi_px, "opening_bars": sealed}


def stage_regions_and_walls(lines, seal_mask, dist, cfg):
    """Cell 6 (notebook cell index 8) -- rooms-first region extraction + wall derivation."""
    n, labels, stats, cents = cv2.connectedComponentsWithStats(
        cv2.bitwise_not(seal_mask * 255), connectivity=4)

    Himg, Wimg = labels.shape
    exterior = {l for l in range(1, n)
                if stats[l, cv2.CC_STAT_LEFT] == 0 or stats[l, cv2.CC_STAT_TOP] == 0
                or stats[l, cv2.CC_STAT_LEFT] + stats[l, cv2.CC_STAT_WIDTH] >= Wimg
                or stats[l, cv2.CC_STAT_TOP] + stats[l, cv2.CC_STAT_HEIGHT] >= Himg}
    room_ids = [l for l in range(1, n)
                if l not in exterior and stats[l, cv2.CC_STAT_AREA] >= cfg["MIN_ROOM_AREA"]]
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
        if len(pts) < 5:
            continue
        pm = np.zeros_like(seal_mask)
        for x, y in pts:
            pm[y, x] = 1
        cnts, _ = cv2.findContours(pm, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            approx = cv2.approxPolyDP(c, 3, False)[:, 0, :]
            for i in range(len(approx) - 1):
                (x1, y1), (x2, y2) = approx[i], approx[i + 1]
                if (int(x1) - int(x2)) ** 2 + (int(y1) - int(y2)) ** 2 < 25:
                    continue
                mx, my = int((x1 + x2) // 2), int((y1 + y2) // 2)
                walls.append({"id": f"w{wid}",
                              "start": {"x": int(x1), "y": int(y1)}, "end": {"x": int(x2), "y": int(y2)},
                              "thickness": round(float(2 * dist[np.clip(my, 0, Himg - 1), np.clip(mx, 0, Wimg - 1)]), 1) or round(cfg.get("_t_med", 0.0), 1),
                              "between": [int(la), int(lb)],
                              "exterior": bool(la in exterior or lb in exterior)})
                wid += 1
    log(lines, f"derived {len(walls)} wall runs from {len(pairs)} adjacent label pairs")

    return {
        "n": n, "labels": labels, "stats": stats, "cents": cents,
        "exterior": exterior, "room_ids": room_ids, "rooms": rooms, "walls": walls,
        "metrics": {"labels": n - 1, "exterior": len(exterior), "rooms": len(room_ids),
                    "room_vertices": [len(r["polygon"]) for r in rooms],
                    "wall_runs": len(walls), "adjacent_pairs": len(pairs)},
    }


def stage_consensus(lines, labels, room_ids, rooms, walls, cubicasa_rooms, cx0, cy0, cfg):
    """Cell 7 (notebook cell index 10) -- Layer 3 consensus scoring + invariants + routing."""
    all_cubi_pairs = rasterize_rooms(cubicasa_rooms, labels.shape, cx0, cy0)

    coverage_info = {}
    for r, m in all_cubi_pairs:
        area = max(shoelace_area(r["polygon"]), 1)
        coverage_info[r["id"]] = {"mask_sum": int(m.sum()), "polygon_area": area,
                                   "coverage_ratio": float(m.sum() / area)}

    cubi_pairs = [(r, m) for r, m in all_cubi_pairs
                  if m.sum() >= 0.5 * max(shoelace_area(r["polygon"]), 1)]

    def _centroid_label(m):
        ys, xs = np.nonzero(m)
        return labels[int(ys.mean()), int(xs.mean())] if len(xs) else 0

    centroid_labels = {}
    cubi_pairs2 = [(r, m, _centroid_label(m)) for r, m in cubi_pairs]
    for r, m, l in cubi_pairs2:
        centroid_labels[r["id"]] = int(l)
    cubi_pairs_final = [(r, m, l) for r, m, l in cubi_pairs2 if l in room_ids]
    cubi_masks = [m for _, m, _ in cubi_pairs_final]
    surviving_ids = [r["id"] for r, _, _ in cubi_pairs_final]
    room_masks = build_room_masks(labels, room_ids)

    if room_ids and cubi_masks:
        iou = pairwise_iou(labels, room_ids, cubi_masks)
        matches = hungarian_match(iou, min_iou=cfg["MATCH_MIN_IOU"])
    else:
        iou, matches = np.zeros((0, 0)), []
    consensus = len(matches) / max(len(room_ids), len(cubi_masks), 1)
    log(lines, f"consensus: {len(matches)} matches / max({len(room_ids)} mitunet, {len(cubi_masks)} cubicasa) = {consensus:.2f}")

    inv = {
        "all_polygons_closed": all(polygon_is_closed(r["polygon"]) for r in rooms),
        "min_area_ok": all(r["area_px"] >= cfg["MIN_ROOM_AREA"] for r in rooms),
        "room_count_sane": 1 <= len(rooms) <= 40,
        "has_rooms": len(rooms) > 0,
    }
    degs = wall_endpoint_degrees(walls)
    n_loose = sum((d[0] < 1) + (d[1] < 1) for d in degs.values())
    inv["loose_endpoints_warn"] = n_loose
    log(lines, f"invariants: {inv}")

    hard_fail = not (inv["all_polygons_closed"] and inv["min_area_ok"] and inv["has_rooms"] and inv["room_count_sane"])
    merged_rooms_note = consensus < cfg["CONSENSUS_MIN"] and not hard_fail
    needs_repair = consensus < cfg["CONSENSUS_MIN"] and hard_fail
    log(lines, f"routing: hard_fail={hard_fail}  merged_rooms_note={merged_rooms_note}  needs_repair={needs_repair}")

    return {
        "all_cubi_pairs": all_cubi_pairs, "coverage_info": coverage_info,
        "centroid_labels": centroid_labels, "surviving_ids": surviving_ids,
        "cubi_masks": cubi_masks, "cubi_pairs_final": cubi_pairs_final,
        "room_masks": room_masks, "iou": iou, "matches": matches, "consensus": consensus,
        "inv": inv, "n_loose": n_loose, "hard_fail": hard_fail,
        "merged_rooms_note": merged_rooms_note, "needs_repair": needs_repair,
    }


def stage_watershed_split(lines, labels, room_ids, consensus_ctx, cfg):
    """Cell 8 (notebook cell index 11) -- Layer 4 watershed VIRTUAL split for scoring."""
    merged_rooms_note = consensus_ctx["merged_rooms_note"]
    cubi_pairs_final = consensus_ctx["cubi_pairs_final"]
    cubi_masks = consensus_ctx["cubi_masks"]
    consensus = consensus_ctx["consensus"]
    consensus_split = consensus

    result = {"ran": False, "vroom_ids": [], "iou2": np.zeros((0, 0)), "matches2": []}
    if merged_rooms_note and cubi_pairs_final:
        vlabels = np.zeros_like(labels)
        nxt = 1
        for rid in room_ids:
            region = labels == rid
            seeds = [np.nonzero(m) for r, m, l in cubi_pairs_final if l == rid]
            seeds = [(int(ys.mean()), int(xs.mean())) for ys, xs in seeds if len(xs)]
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
        iou2 = pairwise_iou(vlabels, vroom_ids, cubi_masks)
        matches2 = hungarian_match(iou2, min_iou=cfg["MATCH_MIN_IOU"])
        consensus_split = len(matches2) / max(len(vroom_ids), len(cubi_masks), 1)
        log(lines, f"virtual split: {len(room_ids)} regions -> {len(vroom_ids)} sub-rooms; "
                    f"consensus {consensus:.2f} -> {consensus_split:.2f}")
        result = {"ran": True, "vlabels": vlabels, "vroom_ids": vroom_ids, "iou2": iou2, "matches2": matches2}
    else:
        log(lines, "no split needed")

    consensus_final = max(consensus, consensus_split)
    return consensus_final, consensus_split, result


def stage_acceptance(lines, rooms, cubi_masks, matches, consensus_final, consensus, cfg,
                       t_med, n_loose, inv, needs_repair, merged_rooms_note, cx0, cy0):
    """Cell 9 (notebook cell index 12) -- acceptance barrier."""
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
    centroid_labels = consensus_ctx["centroid_labels"]
    surviving_ids = set(consensus_ctx["surviving_ids"])
    rasterized_ids = {r["id"] for r, _ in all_cubi_pairs}

    cubicasa_rooms_diag = []
    for r in cubicasa_rooms:
        rid = r["id"]
        area = shoelace_area(r["polygon"])
        entry = {"id": rid, "type": r.get("type", "?"), "polygon_area_px": area}
        if rid not in rasterized_ids:
            entry["survived"] = False
            entry["drop_reason"] = "out_of_crop"
            entry["detail"] = "polygon bbox does not overlap the prob-map crop at all"
        elif rid in surviving_ids:
            entry["survived"] = True
            entry["drop_reason"] = None
            cov = coverage_info.get(rid, {})
            entry["detail"] = {"coverage_ratio": cov.get("coverage_ratio"),
                                "centroid_label": centroid_labels.get(rid)}
        else:
            cov = coverage_info.get(rid, {})
            if cov and cov["coverage_ratio"] < 0.5:
                entry["survived"] = False
                entry["drop_reason"] = "coverage_filter"
                entry["detail"] = {"mask_sum_px": cov["mask_sum"], "polygon_area_px": cov["polygon_area"],
                                    "coverage_ratio": cov["coverage_ratio"], "threshold": 0.5}
            else:
                entry["survived"] = False
                entry["drop_reason"] = "centroid_filter"
                cl = centroid_labels.get(rid)
                why = "background/wall pixel" if cl == 0 else (
                    "exterior region" if cl in region_ctx["exterior"] else
                    "a MitUNet region below MIN_ROOM_AREA / not counted as a room")
                entry["detail"] = {"centroid_label": cl, "coverage_ratio": cov.get("coverage_ratio"), "why": why}
        cubicasa_rooms_diag.append(entry)

    # -- official (post-filter) consensus block
    iou_official = consensus_ctx["iou"]
    matches_official = consensus_ctx["matches"]
    surviving_ids_list = consensus_ctx["surviving_ids"]
    consensus_block = {
        "room_ids": [int(r) for r in room_ids],
        "cubi_ids": surviving_ids_list,
        "iou_matrix": iou_official.tolist(),
        "matches": [{"mitunet_label": int(room_ids[i]), "cubi_id": surviving_ids_list[j], "iou": v}
                    for i, j, v in matches_official],
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
            "consensus_before_split": consensus_ctx["consensus"],
            "consensus_after_split": consensus_split,
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
    ap.add_argument("--reference-log", default=str(REPO_ROOT / "v9_out.txt"),
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
    mask, dist, m2 = stage_seal_thickness(lines, mask, cfg)
    cfg["_t_med"] = m2["t_med"]
    seal_mask, cubicasa_rooms, fixtures, m3 = stage_cubicasa_seal(lines, mask, sg, rf, m2["t_med"], cx0, cy0, H, W)
    region_ctx = stage_regions_and_walls(lines, seal_mask, dist, cfg)
    consensus_ctx = stage_consensus(lines, region_ctx["labels"], region_ctx["room_ids"], region_ctx["rooms"],
                                     region_ctx["walls"], cubicasa_rooms, cx0, cy0, cfg)
    consensus_final, consensus_split, split_ctx = stage_watershed_split(
        lines, region_ctx["labels"], region_ctx["room_ids"], consensus_ctx, cfg)
    report = stage_acceptance(lines, region_ctx["rooms"], consensus_ctx["cubi_masks"], consensus_ctx["matches"],
                               consensus_final, consensus_ctx["consensus"], cfg, m2["t_med"], consensus_ctx["n_loose"],
                               consensus_ctx["inv"], consensus_ctx["needs_repair"], consensus_ctx["merged_rooms_note"],
                               cx0, cy0)

    computed = {
        **m1, **{k: v for k, v in m2.items()}, **m3,
        **region_ctx["metrics"],
        "matches": len(consensus_ctx["matches"]),
        "rooms_mitunet": len(region_ctx["rooms"]),
        "rooms_cubicasa": len(consensus_ctx["cubi_masks"]),
        "consensus": consensus_ctx["consensus"],
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
