#!/usr/bin/env python
"""test_resolution.py -- scale-invariance regression test for local/consensus_lab.py.

Task B of the wall-geometry-fixes work: proves the pixel-tolerance constants that
were made relative to t_med (median wall thickness) in Task A actually behave in a
resolution-relative way, by resampling the cached wall-probability map to 0.5x /
1.0x / 2.0x and re-running the pipeline stages at each scale, then comparing
normalised metrics.

Does NOT copy any stage logic -- imports stage_hysteresis / stage_seal_thickness /
stage_cubicasa_seal / stage_regions_and_walls (and shoelace_area) straight from
local/consensus_lab.py via importlib (that file has an `if __name__ == "__main__"`
guard around main(), so a normal import is also safe, but importlib-by-path is used
here to avoid depending on sys.path / package layout).

Usage
-----
    python local/test_resolution.py

Exits 0 if every metric passes its tolerance, 1 otherwise.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

LOCAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = LOCAL_DIR.parent

# --------------------------------------------------------------------------
# Import consensus_lab.py by path (importlib, not a plain `import`) -- this is
# the approach verified to work given the file's __main__ guard.
# --------------------------------------------------------------------------
_spec = importlib.util.spec_from_file_location("consensus_lab", LOCAL_DIR / "consensus_lab.py")
consensus_lab = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(consensus_lab)

CFG = consensus_lab.CFG
stage_hysteresis = consensus_lab.stage_hysteresis
stage_seal_thickness = consensus_lab.stage_seal_thickness
stage_cubicasa_seal = consensus_lab.stage_cubicasa_seal
stage_regions_and_walls = consensus_lab.stage_regions_and_walls
shoelace_area = consensus_lab.shoelace_area

WALL_PROB_PATH = REPO_ROOT / "out" / "wall_prob_crop.npy"
GEOMETRY_PATH = REPO_ROOT / "out-cubicasa" / "sample_geometry.json"
FIXTURES_PATH = REPO_ROOT / "out-cubicasa" / "cubicasa_rooms_fixtures.json"

SCALES = [0.5, 1.0, 2.0]

# --------------------------------------------------------------------------
# Tolerances
# --------------------------------------------------------------------------
# Upscaling (2x) is close to a lossless resample of the same information -- linear
# interpolation adds smoothing but doesn't destroy structure -- so a tight 5%
# tolerance is reasonable for anything that should scale linearly (lengths, t_med)
# or quadratically (areas, which get double the linear tolerance since two
# dimensions of measurement error compound).
#
# Downscaling (0.5x) genuinely discards information: thin walls (t_med/2 ~ 13px
# here) are more exposed to 1px rounding/quantization in hysteresis, distance
# transform and skeletonization, and small rooms can cross MIN_ROOM_AREA (a
# still-ABSOLUTE px^2 threshold, out of scope for this task -- see report) after
# their area shrinks by 4x. So downscale tolerances are set much looser, and the
# room-count check is reported but not used to fail the run at 0.5x, since losing
# small rooms on downsample is expected lossy behaviour, not a resolution-relative
# tolerance bug.
LEN_TOL = {0.5: 0.20, 2.0: 0.05}     # t_med, wall length: normalise by scale
AREA_TOL = {0.5: 0.40, 2.0: 0.10}    # room area: normalise by scale^2 (2x the linear tol)
COUNT_TOL = {0.5: 0.30, 2.0: 0.10}   # wall run count: relative tolerance vs scale=1.0


def load_and_scale_geometry(scale):
    """Deep-copy sample_geometry.json + cubicasa_rooms_fixtures.json and scale every
    pixel-space coordinate/length field by `scale`, without mutating the originals."""
    sg = copy.deepcopy(_SG_BASE)
    rf = copy.deepcopy(_RF_BASE)

    for w in sg["walls"]:
        w["start"] = [w["start"][0] * scale, w["start"][1] * scale]
        w["end"] = [w["end"][0] * scale, w["end"][1] * scale]
        if "thickness_px" in w and w["thickness_px"] is not None:
            w["thickness_px"] = w["thickness_px"] * scale

    for o in sg["openings"]:
        o["position"] = [o["position"][0] * scale, o["position"][1] * scale]
        if "width_px" in o and o["width_px"] is not None:
            o["width_px"] = o["width_px"] * scale

    for r in rf.get("rooms", []):
        r["polygon"] = [{"x": p["x"] * scale, "y": p["y"] * scale} for p in r["polygon"]]

    return sg, rf


def run_pipeline_at_scale(scale):
    H0, W0 = _PROB_BASE.shape
    new_w, new_h = max(1, round(W0 * scale)), max(1, round(H0 * scale))
    prob = cv2.resize(_PROB_BASE, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    H, W = prob.shape

    sg, rf = load_and_scale_geometry(scale)

    cfg = dict(CFG)
    lines = []

    mask, _m1 = stage_hysteresis(lines, prob, cfg)
    sealed, dist, m2 = stage_seal_thickness(lines, mask, cfg, prob)
    t_med = m2["t_med"]
    cfg["_t_med"] = t_med  # stage_regions_and_walls reads this, same as main()

    seal_mask, cubicasa_rooms, fixtures, _m3 = stage_cubicasa_seal(
        lines, sealed, sg, rf, t_med, 0, 0, H, W, cfg=cfg)

    ctx = stage_regions_and_walls(lines, seal_mask, dist, cfg, prob)

    wall_lengths = [
        math.hypot(w["end"]["x"] - w["start"]["x"], w["end"]["y"] - w["start"]["y"])
        for w in ctx["walls"]
    ]
    room_areas = [shoelace_area(r["polygon"]) for r in ctx["rooms"]]

    return {
        "scale": scale,
        "shape": (H, W),
        "t_med": t_med,
        "room_count": len(ctx["room_ids"]),
        "wall_run_count": len(ctx["walls"]),
        "total_wall_length": float(sum(wall_lengths)),
        "room_areas": room_areas,
        "total_room_area": float(sum(room_areas)),
    }


def check(label, values_by_scale, base_scale, tol_by_nonbase_scale, exact=False):
    """Compare a normalised metric across scales against its value at base_scale.
    Returns list of (scale, raw, normalised, pass_bool, reason) rows."""
    base = values_by_scale[base_scale]
    rows = []
    for s in SCALES:
        v = values_by_scale[s]
        if s == base_scale:
            rows.append((s, v, v, True, "reference"))
            continue
        if exact:
            ok = (v == base)
            rows.append((s, v, v, ok, "exact match required"))
        else:
            tol = tol_by_nonbase_scale[s]
            rel_err = abs(v - base) / base if base else float("inf")
            ok = rel_err <= tol
            rows.append((s, v, v, ok, f"rel_err={rel_err:.1%} tol={tol:.0%}"))
    return rows


def main():
    global _PROB_BASE, _SG_BASE, _RF_BASE

    _PROB_BASE = np.load(WALL_PROB_PATH).astype(np.float32)
    assert _PROB_BASE.shape == (2048, 2730), f"unexpected base shape {_PROB_BASE.shape}"
    _SG_BASE = json.loads(GEOMETRY_PATH.read_text(encoding="utf-8"))
    _RF_BASE = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))

    print(f"base prob map: {WALL_PROB_PATH}  shape={_PROB_BASE.shape}")
    print(f"scales under test: {SCALES}\n")

    results = {}
    for s in SCALES:
        print(f"--- running pipeline at scale={s} ---")
        r = run_pipeline_at_scale(s)
        results[s] = r
        print(f"  shape={r['shape']}  t_med={r['t_med']:.2f}  room_count={r['room_count']}  "
              f"wall_run_count={r['wall_run_count']}  total_wall_length={r['total_wall_length']:.1f}  "
              f"total_room_area={r['total_room_area']:.1f}")
    print()

    # --------------------------------------------------------------------
    # Table: raw + normalised values
    # --------------------------------------------------------------------
    print("=" * 100)
    print(f"{'metric':<26} " + "".join(f"scale={s:<10}" for s in SCALES))
    print("-" * 100)

    def row(name, raw_fn, norm_fn):
        raw = [raw_fn(results[s]) for s in SCALES]
        norm = [norm_fn(results[s]) for s in SCALES]
        print(f"{name:<26} " + "".join(f"{v:<16.3f}" for v in raw))
        print(f"{'  (normalised)':<26} " + "".join(f"{v:<16.3f}" for v in norm))

    row("t_med (px)", lambda r: r["t_med"], lambda r: r["t_med"] / r["scale"])
    row("room_count", lambda r: r["room_count"], lambda r: r["room_count"])
    row("wall_run_count", lambda r: r["wall_run_count"], lambda r: r["wall_run_count"])
    row("total_wall_length", lambda r: r["total_wall_length"], lambda r: r["total_wall_length"] / r["scale"])
    row("total_room_area", lambda r: r["total_room_area"], lambda r: r["total_room_area"] / (r["scale"] ** 2))
    print("=" * 100)
    print()

    # --------------------------------------------------------------------
    # PASS/FAIL per metric, normalised value vs scale=1.0 reference
    # --------------------------------------------------------------------
    t_med_norm = {s: results[s]["t_med"] / s for s in SCALES}
    room_count_raw = {s: results[s]["room_count"] for s in SCALES}
    wall_run_norm = {s: results[s]["wall_run_count"] for s in SCALES}
    wall_len_norm = {s: results[s]["total_wall_length"] / s for s in SCALES}
    room_area_norm = {s: results[s]["total_room_area"] / (s ** 2) for s in SCALES}

    checks = [
        ("t_med / scale", check("t_med / scale", t_med_norm, 1.0, LEN_TOL)),
        ("room count (identical)", check("room count", room_count_raw, 1.0, None, exact=True)),
        ("wall run count", check("wall run count", wall_run_norm, 1.0, COUNT_TOL)),
        ("total wall length / scale", check("total wall length / scale", wall_len_norm, 1.0, LEN_TOL)),
        ("total room area / scale^2", check("total room area / scale^2", room_area_norm, 1.0, AREA_TOL)),
    ]

    print("PASS/FAIL (tolerance: lengths/t_med 5% up / 20% down, areas 10% up / 40% down, "
          "wall-run-count 10% up / 30% down, room count must be exactly identical):\n")
    all_pass = True
    for label, rows in checks:
        print(f"{label}:")
        for s, raw, norm, ok, reason in rows:
            status = "PASS" if ok else "FAIL"
            if s == 1.0:
                print(f"  scale={s}: {norm:.3f}  (reference)")
                continue
            if not ok:
                all_pass = False
            print(f"  scale={s}: {norm:.3f}  {status}  ({reason})")
        print()

    if all_pass:
        print("RESULT: all metrics PASS.")
    else:
        print("RESULT: at least one metric FAILED -- see above.")

    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
