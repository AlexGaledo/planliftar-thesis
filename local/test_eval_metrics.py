#!/usr/bin/env python
"""test_eval_metrics.py -- pytest regression test for local/eval_metrics.py.

Runs the room precision/recall and wall-IoU scorer against the hand-labeled
ground truth in local/fixtures/eval_ground_truth_sample1.json and a synthetic
prediction (local/fixtures/eval_prediction_sample1.json) that deliberately
reproduces one of the two real failure modes local/README.md's findings
section documents: one clean room match, and one real room split into two
predicted regions by a spurious wall (over-segmentation), each half too
small to clear the 0.5 IoU match threshold on its own.

No real cached .npy/.json data is required (none is present on this
machine -- see the handoff reply): this exercises the scorer itself against
a small, versioned, hand-labeled fixture, and prints a metrics table so a
future run against the real sample (on a machine with out/ and
out-cubicasa/) has somewhere to plug in -- see eval_metrics.room_precision_recall
and eval_metrics.wall_iou, both shape-agnostic.

    pytest local/test_eval_metrics.py
"""
from __future__ import annotations

import json
from pathlib import Path

from eval_metrics import room_precision_recall, wall_iou

LOCAL_DIR = Path(__file__).resolve().parent
FIXTURES_DIR = LOCAL_DIR / "fixtures"

# Regression baseline for the fixture pair above. If this changes, either the
# fixture changed on purpose (update the baseline) or room_precision_recall /
# wall_iou / the underlying hungarian_match changed behaviour (investigate
# before updating the baseline).
BASELINE = {
    "room_precision": 1 / 3,
    "room_recall": 0.5,
    "room_f1": 0.4,
    "room_tp": 1,
    "wall_iou_min": 0.60,
    "wall_iou_max": 0.75,
}


def _load_fixture():
    gt = json.loads((FIXTURES_DIR / "eval_ground_truth_sample1.json").read_text())
    pred = json.loads((FIXTURES_DIR / "eval_prediction_sample1.json").read_text())
    shape = (gt["canvas"]["height"], gt["canvas"]["width"])
    return gt, pred, shape


def test_room_precision_recall_matches_baseline():
    gt, pred, shape = _load_fixture()
    result = room_precision_recall(pred["rooms"], gt["rooms"], shape, min_iou=0.5)

    assert result["n_gt"] == 2
    assert result["n_pred"] == 3
    assert result["tp"] == BASELINE["room_tp"]
    assert abs(result["precision"] - BASELINE["room_precision"]) < 1e-9
    assert abs(result["recall"] - BASELINE["room_recall"]) < 1e-9
    assert abs(result["f1"] - BASELINE["room_f1"]) < 1e-9

    # The one match must be the clean living-room pair, not the split bedroom.
    assert result["matches"] == [
        {"pred_id": "pred_living_room", "gt_id": "gt_living_room", "iou": result["matches"][0]["iou"]}
    ]
    assert result["matches"][0]["iou"] > 0.9


def test_wall_iou_within_expected_range():
    gt, pred, shape = _load_fixture()
    iou = wall_iou(pred["walls"], gt["walls"], shape)
    assert BASELINE["wall_iou_min"] <= iou <= BASELINE["wall_iou_max"]


def test_perfect_prediction_scores_1_0():
    """Sanity check independent of the fixture: identical rooms/walls must
    score a perfect 1.0, so the metric itself isn't silently capped below 1."""
    gt, _pred, shape = _load_fixture()
    result = room_precision_recall(gt["rooms"], gt["rooms"], shape, min_iou=0.5)
    assert result["precision"] == 1.0
    assert result["recall"] == 1.0
    assert result["f1"] == 1.0
    assert wall_iou(gt["walls"], gt["walls"], shape) == 1.0


def test_metrics_table(capsys):
    """Not an assertion -- prints the metrics table the harness's done-check
    (pytest -s local/test_eval_metrics.py) expects to see."""
    gt, pred, shape = _load_fixture()
    rooms = room_precision_recall(pred["rooms"], gt["rooms"], shape, min_iou=0.5)
    walls = wall_iou(pred["walls"], gt["walls"], shape)

    print("\neval_ground_truth_sample1.json vs eval_prediction_sample1.json")
    print(f"{'metric':<18}{'value'}")
    print(f"{'room precision':<18}{rooms['precision']:.3f}")
    print(f"{'room recall':<18}{rooms['recall']:.3f}")
    print(f"{'room f1':<18}{rooms['f1']:.3f}")
    print(f"{'wall iou':<18}{walls:.3f}")
