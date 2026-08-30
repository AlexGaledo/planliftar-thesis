#!/usr/bin/env python3
"""Miniature (tabletop-scale) GLB export.

Stage A bakes a fixed scale into the GLB because Scene Viewer gives us no place
to type a dimension -- the notebook's Cell 11 uses PPM = 100 plan-px per real
meter, which yields a 1:1 model you walk through. This script re-exports the
same geometry at an architectural model scale (1:25 by default), so the whole
floorplan sits on a table instead.

It builds the normal 1:1 scene with the unmodified Cell 11-pre builder and then
applies one uniform scale to the finished scene. Shrinking via a faked
pixels_per_meter would NOT be uniform: the builder's floor slab uses a fixed
0.1 m margin and 0.02 m thickness, which would stay full size and leave a fat
border around a tiny model.

Usage:
    python deliverables/make_mini_glb.py                 # 1:25
    python deliverables/make_mini_glb.py --denom 50      # 1:50
"""
import argparse
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_builder import build_glb

PPM = 100.0          # plan px per real-world meter, same constant as Cell 11
WALL_HEIGHT = 2.5    # real-world wall height in meters, same as CFG


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--geometry", default="out/sample_response.json")
    ap.add_argument("--denom", type=float, default=25.0,
                    help="model scale denominator: 25 means 1:25")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    out_path = args.out or f"out/planlift_mini_1_{int(args.denom)}.glb"

    geo = json.load(open(args.geometry))
    # Wall thickness in the exported JSON is in plan px; build_glb wants meters.
    for w in geo["walls"]:
        w["thickness"] = float(w["thickness"]) / PPM

    with tempfile.TemporaryDirectory() as tmp:
        scene = build_glb(geo, pixels_per_meter=PPM, wall_height_m=WALL_HEIGHT,
                          out_path=os.path.join(tmp, "full.glb"))

    k = 1.0 / args.denom
    shrink = np.eye(4)
    shrink[0, 0] = shrink[1, 1] = shrink[2, 2] = k
    scene.apply_transform(shrink)
    scene.export(out_path, file_type="glb")

    bmin, bmax = scene.bounds
    print(f"\nMiniature 1:{args.denom:g} -> {out_path}")
    print(f"Bounding box (m): size={(bmax - bmin).round(4).tolist()}  "
          f"wall height={WALL_HEIGHT * k:.3f}")


if __name__ == "__main__":
    main()
