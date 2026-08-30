#!/usr/bin/env python3
"""Generate a clean, hand-authored bungalow floorplan in the export schema.

Why this exists: the pipeline's current sample is a real CubiCasa plan whose
segmentation is poor - one merged region covering half the building, the other
half shredded into a dozen fragments, 244 derived wall runs. That is a
segmentation problem (see local/README.md), but it makes the AR view look
broken, which blocks work on the AR layer itself.

This emits the same schema by hand: a simple rectangular bungalow with five
rooms and real door gaps. It is ground truth, not a prediction, so anything
that still looks wrong in AR is an AR bug rather than a model artefact.

Geometry is authored in plan pixels at 100 px per metre, matching the default
ppm in ar.html - so the building below is 12 m x 8 m with 0.2 m walls.

Usage:
    python deliverables/make_bungalow_plan.py
    python deliverables/make_bungalow_plan.py --out somewhere/else.json
"""
import argparse
import json
import os

PPM = 100.0          # plan px per metre, matching ar.html's default
W, H = 1200, 800     # 12 m x 8 m
T = 20               # wall thickness in px (0.2 m)
DOOR = 90            # door opening width in px (0.9 m)

# Interior partition lines.
X_SPLIT = 700        # vertical wall: living/kitchen (left) | bedrooms (right)
Y_SPLIT_R = 400      # horizontal wall splitting the right half into 2 bedrooms
Y_SPLIT_L = 500      # horizontal wall: living (top) | bath+kitchen (bottom)
X_SPLIT_B = 300      # vertical wall splitting the bottom-left into bath|kitchen


def span(a, b, gaps):
    """Split the interval [a, b] around each (start, end) gap, in order.

    This is how doorways get into the geometry: a wall is emitted as the
    pieces of its span that are NOT a door, so the opening is a genuine
    absence of wall rather than a marker some later stage has to honour.
    """
    pieces = []
    cursor = a
    for g0, g1 in sorted(gaps):
        if g0 > cursor:
            pieces.append((cursor, g0))
        cursor = max(cursor, g1)
    if cursor < b:
        pieces.append((cursor, b))
    return pieces


def h_wall(y, x0, x1, gaps=(), exterior=False):
    """Horizontal wall at height y, from x0 to x1, minus any door gaps."""
    return [
        {"start": {"x": float(s), "y": float(y)},
         "end": {"x": float(e), "y": float(y)},
         "thickness": float(T), "exterior": exterior}
        for s, e in span(x0, x1, gaps)
    ]


def v_wall(x, y0, y1, gaps=(), exterior=False):
    """Vertical wall at x, from y0 to y1, minus any door gaps."""
    return [
        {"start": {"x": float(x), "y": float(s)},
         "end": {"x": float(x), "y": float(e)},
         "thickness": float(T), "exterior": exterior}
        for s, e in span(y0, y1, gaps)
    ]


def centred(at, width=DOOR):
    """A door gap of `width`, centred on `at`."""
    return (at - width / 2, at + width / 2)


def build():
    walls = []

    # --- exterior shell, with a front door in the bottom wall ---
    walls += h_wall(0, 0, W, exterior=True)
    walls += h_wall(H, 0, W, gaps=[centred(600)], exterior=True)
    walls += v_wall(0, 0, H, exterior=True)
    walls += v_wall(W, 0, H, exterior=True)

    # --- interior partitions, each with its doorway ---
    # living <-> bedrooms, two doors (one per bedroom)
    walls += v_wall(X_SPLIT, 0, H, gaps=[centred(200), centred(600)])
    # bedroom 1 <-> bedroom 2
    walls += h_wall(Y_SPLIT_R, X_SPLIT, W)
    # living <-> kitchen
    walls += h_wall(Y_SPLIT_L, 0, X_SPLIT, gaps=[centred(500)])
    # bath <-> kitchen
    walls += v_wall(X_SPLIT_B, Y_SPLIT_L, H, gaps=[centred(650)])

    for i, w in enumerate(walls):
        w["id"] = f"w{i}"

    def rect(x0, y0, x1, y1):
        return [{"x": float(x0), "y": float(y0)}, {"x": float(x1), "y": float(y0)},
                {"x": float(x1), "y": float(y1)}, {"x": float(x0), "y": float(y1)}]

    rooms = [
        {"id": "living",   "type": "living_room", "polygon": rect(0, 0, X_SPLIT, Y_SPLIT_L)},
        {"id": "bedroom_1", "type": "bedroom",    "polygon": rect(X_SPLIT, 0, W, Y_SPLIT_R)},
        {"id": "bedroom_2", "type": "bedroom",    "polygon": rect(X_SPLIT, Y_SPLIT_R, W, H)},
        {"id": "bathroom", "type": "bathroom",    "polygon": rect(0, Y_SPLIT_L, X_SPLIT_B, H)},
        {"id": "kitchen",  "type": "kitchen",     "polygon": rect(X_SPLIT_B, Y_SPLIT_L, X_SPLIT, H)},
    ]
    for r in rooms:
        xs = [p["x"] for p in r["polygon"]]
        ys = [p["y"] for p in r["polygon"]]
        r["area_px"] = (max(xs) - min(xs)) * (max(ys) - min(ys))

    return {
        "schema_version": "2.0",
        "source": {"image_width_px": W, "image_height_px": H,
                   "origin": "hand-authored bungalow (not model output)"},
        "scale": {"units": "relative_px", "user_scale_required": True},
        "walls": walls,
        "rooms": rooms,
        "fixtures": [],
        "acceptance": {"accepted": True, "reject_reasons": [], "notes": ["synthetic_reference_plan"]},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="deliverables/livemap/plans/bungalow.json")
    args = ap.parse_args()

    plan = build()
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, indent=1)

    print(f"wrote {args.out}")
    print(f"  building {W / PPM:.1f} x {H / PPM:.1f} m, walls {T / PPM:.2f} m thick")
    print(f"  {len(plan['walls'])} wall segments, {len(plan['rooms'])} rooms")
    for r in plan["rooms"]:
        print(f"    {r['id']:10} {r['type']:12} {r['area_px'] / PPM**2:6.1f} m2")


if __name__ == "__main__":
    main()
