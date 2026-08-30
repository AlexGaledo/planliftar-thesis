#!/usr/bin/env python
"""test_consensus_metric.py -- property tests for graded_room_consensus()
(local/consensus_lab.py, wall-geometry-fixes Task A/B/D).

This is a metric-design regression test, not a pipeline test: it builds small
SYNTHETIC label maps and CubiCasa room masks directly (no real data, no
notebook, no other consensus_lab.py stage) and calls graded_room_consensus()
straight from local/consensus_lab.py via importlib -- the same import pattern
local/test_resolution.py already uses, so this exercises the real
implementation rather than a re-derived copy of it.

Five properties are asserted, matching the task brief's minimum list:

  1. Perfect one-to-one agreement (region masks exactly equal their matching
     CubiCasa room masks) scores 1.0.
  2. Zero overlap (no CubiCasa room touches any MitUNet region) scores 0.0.
  3. A clean open-plan merge -- one MitUNet region exactly covering two
     adjacent CubiCasa rooms, no leakage either direction -- scores 1.0.
     Justification: this is the pipeline's own accepted "merged_rooms"
     outcome (see local/README.md item 2/2b and graded_room_consensus's
     docstring) -- MitUNet's wall map is authoritative for whether a wall
     exists, so a region with no internal wall evidence that lines up
     exactly with the union of two real rooms IS full agreement, not a
     partial one. Requiring anything less than 1.0 here would reintroduce a
     penalty for exactly the case Task B exists to stop penalizing.
  4. Pathological over-segmentation (many equal-sized MitUNet regions tiling
     one CubiCasa room) does NOT score near 1.0 -- asserted as < 0.15 for a
     25-way tiling (an unpenalized formula would land near 1.0 here; this
     formula lands near 1/25 = 0.04, since only one tile can be the room's
     "dominant" region and that tile is compared against the room's FULL
     area, not just the slice it covers).
  5. Monotonicity: for a single region growing its true overlap with a
     single room (always a subset of the room, area only increasing), the
     score never decreases -- including across the point where the region
     crosses the 50% majority-ownership gate (GRADED_MERGE_MAJORITY_FRAC),
     which must not produce a discontinuity/dip.

Also spot-checks the majority-ownership gate itself (the fix made after
discovering, on the REAL sample, that ungated argmax-only grouping let an
unrelated badly-over-segmented room drag a clean 0.448 kitchen match down to
~0.38 -- see graded_room_consensus's docstring) with a synthetic repro.

Usage
-----
    python local/test_consensus_metric.py

Exits 0 if every assertion passes, 1 otherwise.
"""
from __future__ import annotations

import importlib.util
import sys
import traceback
from pathlib import Path

import numpy as np

LOCAL_DIR = Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location("consensus_lab", LOCAL_DIR / "consensus_lab.py")
consensus_lab = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(consensus_lab)

graded_room_consensus = consensus_lab.graded_room_consensus
CFG = consensus_lab.CFG


def room(rid, mask, rtype="room"):
    """A minimal CubiCasa room dict + rasterized mask pair, area_pairs-shaped."""
    return ({"id": rid, "type": rtype}, mask.astype(np.uint8))


def rect_mask(shape, y0, y1, x0, x1):
    m = np.zeros(shape, dtype=np.uint8)
    m[y0:y1, x0:x1] = 1
    return m


def rect_labels(shape, rects):
    """rects: list of (label_id, y0, y1, x0, x1) -- non-overlapping by construction
    in every test below. Returns an int label array, background = 0."""
    labels = np.zeros(shape, dtype=np.int32)
    for lab, y0, y1, x0, x1 in rects:
        labels[y0:y1, x0:x1] = lab
    return labels


# --------------------------------------------------------------------------
# Test harness
# --------------------------------------------------------------------------
_failures = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f"  -- {detail}" if detail else ""))
    if not cond:
        _failures.append(name)


# --------------------------------------------------------------------------
# 1. Perfect one-to-one agreement -> 1.0
# --------------------------------------------------------------------------
def test_perfect_one_to_one():
    shape = (100, 100)
    labels = rect_labels(shape, [(1, 0, 50, 0, 100), (2, 50, 100, 0, 100)])
    room_ids = [1, 2]
    area_pairs = [
        room("A", rect_mask(shape, 0, 50, 0, 100), "bedroom"),
        room("B", rect_mask(shape, 50, 100, 0, 100), "kitchen"),
    ]
    score, contrib = graded_room_consensus(labels, room_ids, area_pairs, CFG)
    check("1. perfect one-to-one agreement scores 1.0", abs(score - 1.0) < 1e-9,
          f"score={score:.6f}")
    check("1. both rooms individually score 1.0", all(abs(c["score"] - 1.0) < 1e-9 for c in contrib),
          f"contributions={contrib}")


# --------------------------------------------------------------------------
# 2. Zero overlap -> 0.0
# --------------------------------------------------------------------------
def test_zero_overlap():
    shape = (100, 100)
    # MitUNet region occupies the left half; the CubiCasa room lives entirely
    # in the right half (background label 0 there) -- no pixel in common.
    labels = rect_labels(shape, [(1, 0, 100, 0, 50)])
    room_ids = [1]
    area_pairs = [room("A", rect_mask(shape, 0, 100, 50, 100), "bathroom")]
    score, contrib = graded_room_consensus(labels, room_ids, area_pairs, CFG)
    check("2. zero overlap scores 0.0", score == 0.0, f"score={score}")
    check("2. the room's own contribution is 0.0", contrib[0]["score"] == 0.0, f"contrib={contrib}")


# --------------------------------------------------------------------------
# 3. Clean open-plan merge -> high (== 1.0, see module docstring justification)
# --------------------------------------------------------------------------
def test_clean_merge():
    shape = (100, 100)
    # One MitUNet region spans the WHOLE canvas -- no internal wall detected.
    labels = rect_labels(shape, [(1, 0, 100, 0, 100)])
    room_ids = [1]
    # Two adjacent, non-overlapping CubiCasa rooms whose union exactly tiles
    # the region: no leakage in either direction.
    area_pairs = [
        room("A", rect_mask(shape, 0, 100, 0, 60), "living_room"),
        room("B", rect_mask(shape, 0, 100, 60, 100), "kitchen"),
    ]
    score, contrib = graded_room_consensus(labels, room_ids, area_pairs, CFG)
    check("3. clean open-plan merge scores 1.0 (target: 1.0, see docstring)",
          abs(score - 1.0) < 1e-9, f"score={score:.6f}")
    check("3. both merged rooms individually score 1.0",
          all(abs(c["score"] - 1.0) < 1e-9 for c in contrib), f"contributions={contrib}")
    check("3. both rooms report group_size 2",
          all(c["group_size"] == 2 for c in contrib), f"contributions={contrib}")


# --------------------------------------------------------------------------
# 4. Pathological over-segmentation does NOT score near 1.0
# --------------------------------------------------------------------------
def test_over_segmentation_not_inflated():
    shape = (100, 100)
    # One real CubiCasa room spans the whole canvas. MitUNet shatters it into
    # a 5x5 grid of 25 equal-sized regions (20x20 each) -- collectively they
    # cover the room completely, but no single region owns more than 4% of it.
    rects = []
    lab = 1
    for gy in range(5):
        for gx in range(5):
            rects.append((lab, gy * 20, gy * 20 + 20, gx * 20, gx * 20 + 20))
            lab += 1
    labels = rect_labels(shape, rects)
    room_ids = list(range(1, 26))
    area_pairs = [room("X", rect_mask(shape, 0, 100, 0, 100), "great_room")]
    score, contrib = graded_room_consensus(labels, room_ids, area_pairs, CFG)
    check("4. 25-way over-segmentation does NOT score near 1.0 (< 0.15)",
          score < 0.15, f"score={score:.4f}")
    check("4. ...but still gets honest nonzero partial credit (> 0.0)",
          score > 0.0, f"score={score:.4f}")
    expected = 400.0 / 10000.0  # one 20x20 tile / whole 100x100 room
    check("4. score matches the expected single-dominant-tile IoU (~0.04)",
          abs(score - expected) < 1e-9, f"score={score:.6f} expected~={expected:.6f}")


# --------------------------------------------------------------------------
# 5. Monotonicity: growing true overlap never decreases the score, including
#    across the 50% majority-ownership gate.
# --------------------------------------------------------------------------
def test_monotonic_growth():
    shape = (100, 100)
    room_ids = [1]
    scores = []
    for k in range(1, 11):  # region grows from 10% to 100% of the room, in 10% steps
        labels = rect_labels(shape, [(1, 0, 10 * k, 0, 100)])
        area_pairs = [room("X", rect_mask(shape, 0, 100, 0, 100), "room")]
        score, _ = graded_room_consensus(labels, room_ids, area_pairs, CFG)
        scores.append(score)
    print(f"    monotonicity scores at 10%..100% overlap: {[round(s, 3) for s in scores]}")
    non_decreasing = all(scores[i + 1] >= scores[i] - 1e-12 for i in range(len(scores) - 1))
    check("5. score is monotonic non-decreasing as true overlap grows", non_decreasing,
          f"scores={scores}")
    check("5. score reaches exactly 1.0 at full overlap", abs(scores[-1] - 1.0) < 1e-9,
          f"scores[-1]={scores[-1]}")
    # This 10-step sweep (10%..100% overlap) straddles the 50% majority-
    # ownership gate (CFG["GRADED_MERGE_MAJORITY_FRAC"]) between step 5
    # (recall exactly 0.5, standalone branch) and step 6 (recall 0.6,
    # qualifies for the grouped branch) -- so the non-decreasing check above
    # already exercises continuity across that boundary, not just one branch.
    check("5. no dip at the majority-ownership gate boundary (step5 <= step6)",
          scores[4] <= scores[5] + 1e-12, f"step5={scores[4]:.4f} step6={scores[5]:.4f}")


# --------------------------------------------------------------------------
# Bonus: majority-ownership gate prevents an unrelated over-segmented room
# from contaminating a clean match sharing the same dominant region -- the
# bug found empirically on the real sample while building this metric (see
# graded_room_consensus's docstring). Synthetic repro of that exact shape.
# --------------------------------------------------------------------------
def test_majority_gate_prevents_contamination():
    shape = (100, 100)
    # Region 1: a clean, isolated match for room A (IoU 0.5 by construction --
    # region and room overlap in a 50x100 area out of a 100x100 region and a
    # 100x100 room respectively... construct concretely below).
    labels = rect_labels(shape, [(1, 0, 100, 0, 60)])  # region 1: cols 0..59
    room_ids = [1]

    # room A: cols 0..79 (80% inside region 1: overlap cols0..59 = 60/80 = 75%,
    # a clean majority match -- like the real kitchen).
    mask_a = rect_mask(shape, 0, 100, 0, 80)
    # room B: cols 40..99 (60 wide), only cols 40..59 (20/60 = 33%) inside
    # region 1 -- like the real room_010_1, badly fragmented, NOT majority-owned
    # by region 1, but happens to have some raw pixel overlap with it too.
    mask_b = rect_mask(shape, 0, 100, 40, 100)

    area_pairs = [room("A", mask_a, "kitchen"), room("B", mask_b, "room")]
    score, contrib = graded_room_consensus(labels, room_ids, area_pairs, CFG)
    by_id = {c["cubi_id"]: c for c in contrib}

    # Room A's isolated (ungrouped-with-B) IoU: intersection = 60*100 = 6000,
    # union = area(region1) + area(A) - intersection = 6000 + 8000 - 6000 = 8000
    # -> 0.75. It must NOT be dragged down by being unioned with B.
    expected_a = 6000.0 / 8000.0
    check("bonus: clean-match room is not contaminated by an unrelated room "
          "sharing the same dominant region",
          abs(by_id["A"]["score"] - expected_a) < 1e-9,
          f"room A score={by_id['A']['score']:.4f} expected={expected_a:.4f}")
    check("bonus: room A is reported as majority-owned (merge-eligible)",
          by_id["A"]["majority_owned"] is True, f"{by_id['A']}")
    check("bonus: room B (minority overlap) is NOT majority-owned / not grouped",
          by_id["B"]["majority_owned"] is False, f"{by_id['B']}")


def main():
    test_perfect_one_to_one()
    test_zero_overlap()
    test_clean_merge()
    test_over_segmentation_not_inflated()
    test_monotonic_growth()
    test_majority_gate_prevents_contamination()

    print()
    if _failures:
        print(f"RESULT: {len(_failures)} FAILURE(S): {_failures}")
        return 1
    print("RESULT: all property tests PASS.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
