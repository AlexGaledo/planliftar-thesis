#!/usr/bin/env python
"""eval_metrics.py -- grades a pipeline OUTPUT (rooms/walls, the
sample_response.json-shaped contract) against a hand-labeled ground-truth
set: room precision/recall and wall IoU. Independent of which model(s)
produced the prediction -- no coupling to MitUNet or CubiCasa internals.

Reuses rasterize_rooms() / hungarian_match() from consensus_lab.py so room
matching uses the exact same IoU + Hungarian-assignment rule the pipeline
itself uses for MitUNet<->CubiCasa consensus (local/README.md) -- "is this
room right" is graded the same way "do these two models agree" is, just
against a human-labeled reference instead of a second noisy model.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import cv2
import numpy as np

LOCAL_DIR = Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location("consensus_lab", LOCAL_DIR / "consensus_lab.py")
_consensus_lab = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_consensus_lab)

rasterize_rooms = _consensus_lab.rasterize_rooms
hungarian_match = _consensus_lab.hungarian_match


def mask_iou(mask_a, mask_b):
    a, b = mask_a.astype(bool), mask_b.astype(bool)
    inter = np.count_nonzero(a & b)
    union = np.count_nonzero(a | b)
    return inter / union if union else 0.0


def mask_iou_matrix(masks_a, masks_b):
    n, m = len(masks_a), len(masks_b)
    iou = np.zeros((n, m), dtype=np.float64)
    for i, ma in enumerate(masks_a):
        for j, mb in enumerate(masks_b):
            iou[i, j] = mask_iou(ma, mb)
    return iou


def room_precision_recall(pred_rooms, gt_rooms, shape, min_iou=0.5):
    """pred_rooms/gt_rooms: list of {"id", "polygon": [{"x","y"}, ...]}.
    Rasterizes both to `shape`, 1:1-matches by IoU (same Hungarian rule as
    consensus_lab.hungarian_match), returns precision/recall/f1 and matches."""
    pred_pairs = rasterize_rooms(pred_rooms, shape, 0, 0)
    gt_pairs = rasterize_rooms(gt_rooms, shape, 0, 0)
    iou = mask_iou_matrix([m for _, m in pred_pairs], [m for _, m in gt_pairs])
    matches = hungarian_match(iou, min_iou=min_iou)
    tp, n_pred, n_gt = len(matches), len(pred_pairs), len(gt_pairs)
    precision = tp / n_pred if n_pred else 0.0
    recall = tp / n_gt if n_gt else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {
        "precision": precision, "recall": recall, "f1": f1,
        "tp": tp, "n_pred": n_pred, "n_gt": n_gt,
        "matches": [{"pred_id": pred_pairs[i][0]["id"], "gt_id": gt_pairs[j][0]["id"], "iou": v}
                    for i, j, v in matches],
    }


def rasterize_walls(walls, shape, default_thickness=4):
    """Same cv2.line approach consensus_lab.stage_cubicasa_seal uses to seal
    CubiCasa walls into the hysteresis mask, applied here to grade a wall
    layer instead of sealing one."""
    canvas = np.zeros(shape, dtype=np.uint8)
    for w in walls:
        a, b = w["start"], w["end"]
        th = max(1, int(round(w.get("thickness_px", default_thickness))))
        cv2.line(canvas, (int(round(a[0])), int(round(a[1]))), (int(round(b[0])), int(round(b[1]))), 1, thickness=th)
    return canvas


def wall_iou(pred_walls, gt_walls, shape, default_thickness=4):
    """One pixel-IoU scalar for the whole wall layer -- walls don't have a
    natural 1:1 id to match per-wall the way rooms do, so this grades the
    rasterized layer as a whole rather than per-segment."""
    pred_mask = rasterize_walls(pred_walls, shape, default_thickness)
    gt_mask = rasterize_walls(gt_walls, shape, default_thickness)
    return mask_iou(pred_mask, gt_mask)
