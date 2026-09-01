"""Shared plan preparation: schema normalisation and wall-gap closure.

Every consumer of a floorplan JSON - the GLB builder, the live map, the WebXR
view - needs the same two things done first, and each had grown its own copy.
This is the single implementation; deliverables/livemap/*.html carry a
JavaScript port of close_wall_gaps kept in parity by
local/test_plan_ops_parity.py.

Canonical form after normalize_plan:
    walls[i]["start"] / ["end"]   {"x": float, "y": float}   plan PIXELS
    walls[i]["thickness"]         float                      plan PIXELS
    walls[i]["height"]            float                      METRES (real world)

Pixels, not metres, for thickness: every tolerance in close_wall_gaps is a
multiple of the median wall thickness and is compared against pixel distances
between endpoints. Mixing units there is how the AR view ended up clamping
every wall to the same 2 cm.
"""
from __future__ import annotations

import math
import statistics

DEFAULT_HEIGHT_M = 2.7

# All tolerances are multiples of the median wall thickness (t_med), so the
# same numbers hold at any raster resolution - the same convention the
# segmentation pipeline uses for its own tolerances.
SNAP_T_MED_FRAC = 0.5     # endpoints this close are already the same node
JOIN_T_MED_FRAC = 3.0     # corner / jog / T-junction closure range
ONLINE_T_MED_FRAC = 1.0   # a fixture this close counts as lying "on" a line


# --------------------------------------------------------------------------
# schema normalisation
# --------------------------------------------------------------------------
def normalize_plan(data: dict) -> dict:
    """Bring any of the project's three plan schemas to the canonical form.

        schema 1.0  "start": [x, y]  + thickness_px          (mitunet_geometry.json)
        forked      "start": {x, y}  + thickness in METRES   (sample_response.json)
        schema 2.0  "start": {x, y}  + thickness in px       (our export)

    Metres are converted with the file's OWN stated
    metadata.pixel_to_meter_ratio, which is exact: every wall in
    sample_response.json equals mitunet_geometry.json's thickness_px when
    divided by it. A file that states no ratio is left alone rather than
    guessed at - inventing a scale would invent geometry.
    """
    if not isinstance(data, dict) or not isinstance(data.get("walls"), list):
        return data

    raw_ratio = (data.get("metadata") or {}).get("pixel_to_meter_ratio")
    ratio = float(raw_ratio) if isinstance(raw_ratio, (int, float)) else 0.0

    def pt(v):
        if isinstance(v, (list, tuple)) and len(v) >= 2:
            return {"x": float(v[0]), "y": float(v[1])}
        return v

    walls = []
    for w in data["walls"]:
        if not isinstance(w, dict):
            walls.append(w)
            continue
        out = dict(w, start=pt(w.get("start")), end=pt(w.get("end")))
        if not isinstance(out.get("thickness"), (int, float)):
            if isinstance(w.get("thickness_px"), (int, float)):
                out["thickness"] = float(w["thickness_px"])
        elif ratio > 0:
            out["thickness"] = float(out["thickness"]) / ratio   # metres -> px
        if not isinstance(out.get("height"), (int, float)):
            # schema 1.0 spells it height_m; both are real-world metres
            out["height"] = float(w.get("height_m", DEFAULT_HEIGHT_M))
        walls.append(out)
    data["walls"] = walls

    if isinstance(data.get("rooms"), list):
        data["rooms"] = [
            dict(r, polygon=[pt(p) for p in r["polygon"]])
            if isinstance(r, dict) and isinstance(r.get("polygon"), list) else r
            for r in data["rooms"]
        ]
    return data


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------
def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _nearest_on_segment(p, a, b):
    """Closest point on segment ab to p, plus that distance.

    Clamping the projection parameter to [0, 1] is what makes this a segment
    rather than an infinite line; without it a dangling end would "connect" to
    a wall's imaginary extension.
    """
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return a, _dist(p, a)
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    q = (a[0] + t * dx, a[1] + t * dy)
    return q, _dist(p, q)


# --------------------------------------------------------------------------
# wall-gap closure
# --------------------------------------------------------------------------
def close_wall_gaps(data: dict, *, enabled: bool = True) -> dict:
    """Weld dangling wall endpoints shut with axis-aligned connector segments.

    Line-first detectors (newri's Hough + merge_walls pipeline, and anything
    else that emits independent segments) produce walls that look tidy in 2D
    but do not meet: a wall runs down x=645.4, stops at y=340, and the next
    starts at x=607, y=373. Extruded to 3D that reads as the wall teleporting
    sideways and back, and the model has no enclosed interior.

    Three rules decide each gap, and they exist to stop this from inventing
    geometry the plan gives no evidence for:

        junction   gap <= JOIN (3x t_med) -> fill. A corner, jog or T-junction
                   the detector clipped; the surrounding geometry implies it.
        doorway    a DOOR fixture lies on the gap -> leave open. That hole is a
                   real opening, not a detector miss, and in AR you have to be
                   able to walk through it.
        span       a longer gap fills ONLY if a WINDOW fixture sits on the
                   line. A window cannot float in mid-air, so the plan's own
                   fixtures are evidence a wall belongs there. No evidence, no
                   wall.

    Mutates and returns data; generated walls carry "generated": True and a
    "reason", and the decision log lands in data["gap_fill"].

    Our own rooms-first pipeline output is already closed by construction (2
    dangling endpoints out of 488), so this is a repair pass for foreign or
    upstream plans rather than a fix for our own.
    """
    walls = data.get("walls") or []
    data["gap_fill"] = {"added": [], "skipped": [], "enabled": enabled}
    if not enabled or len(walls) < 2:
        return data

    seg = [{
        "id": w.get("id", "w%d" % i),
        "s": (float(w["start"]["x"]), float(w["start"]["y"])),
        "e": (float(w["end"]["x"]), float(w["end"]["y"])),
        "t": float(w.get("thickness") or 4.0),
        "h": float(w.get("height") or DEFAULT_HEIGHT_M),
    } for i, w in enumerate(walls) if w.get("start") and w.get("end")]
    if len(seg) < 2:
        return data

    t_med = statistics.median(sorted(x["t"] for x in seg))
    snap = SNAP_T_MED_FRAC * t_med
    join = JOIN_T_MED_FRAC * t_med
    online = ONLINE_T_MED_FRAC * t_med

    fixtures = [f for f in (data.get("fixtures") or [])
                if isinstance(f, dict) and isinstance(f.get("position"), dict)]

    def fixtures_on(p, q, kind):
        return [f.get("id") for f in fixtures if f.get("type") == kind
                and _nearest_on_segment((f["position"]["x"], f["position"]["y"]),
                                        p, q)[1] <= online]

    done = set()

    def best_gap():
        """Shortest gap from an unresolved dangling endpoint, or None."""
        best = None
        for i, a in enumerate(seg):
            for key in ("s", "e"):
                p = a[key]
                if a["id"] + key in done:
                    continue
                # already joined: some other wall's BODY passes within snap
                if any(j != i and _nearest_on_segment(p, b["s"], b["e"])[1] <= snap
                       for j, b in enumerate(seg)):
                    continue
                for j, b in enumerate(seg):
                    if j == i:
                        continue
                    # sharing a node already: joining again just overlays wall a
                    if min(_dist(a["s"], b["s"]), _dist(a["s"], b["e"]),
                           _dist(a["e"], b["s"]), _dist(a["e"], b["e"])) <= snap:
                        continue
                    q, d = _nearest_on_segment(p, b["s"], b["e"])
                    for ep in (b["s"], b["e"]):
                        # a target within join range of b's own end IS that corner
                        if _dist(q, ep) <= join:
                            q, d = ep, _dist(p, ep)
                            break
                    if best is None or d < best[0]:
                        best = (d, i, key, j, q)
        return best

    added, skipped = [], []
    for _ in range(4 * len(seg)):
        g = best_gap()
        if g is None:
            break
        d, i, key, j, q = g
        a, b = seg[i], seg[j]
        p = a[key]
        done.add(a["id"] + key)

        # The connector turns exactly one corner (both walls are axis-aligned).
        # Reject the corner whose first leg runs back along wall a over itself;
        # keep the one that leaves a's far end.
        far = a["e"] if key == "s" else a["s"]
        opts = [c for c in ((p[0], q[1]), (q[0], p[1]))
                if _dist(far, c) >= _dist(far, p) - 1e-6]
        doors = fixtures_on(p, q, "door")
        windows = fixtures_on(p, q, "window")

        why = None
        if not opts:
            why = "corner backtracks"
        elif doors:
            why = "doorway " + ",".join(str(x) for x in doors)
        elif d > join and not windows:
            why = "no fixture evidence"
        if why:
            skipped.append("%s.%s->%s %.1fpx: %s" % (a["id"], key, b["id"], d, why))
            continue

        c = min(opts, key=lambda c: _dist(p, c) + _dist(c, q))
        thickness = min(a["t"], b["t"])
        reason = "junction" if d <= join else "span/fixture"
        for u, v in ((p, c), (c, q)):
            if _dist(u, v) <= snap:
                continue
            wid = "fill_%03d" % (len(added) + 1)
            walls.append({
                "id": wid,
                "start": {"x": u[0], "y": u[1]},
                "end": {"x": v[0], "y": v[1]},
                "thickness": thickness,
                "height": a["h"],
                "generated": True,
                "reason": reason,
            })
            seg.append({"id": wid, "s": u, "e": v, "t": thickness, "h": a["h"]})
            added.append("%s %s->%s %.1fpx [%s]"
                         % (wid, a["id"], b["id"], _dist(u, v), reason))

    data["gap_fill"] = {"added": added, "skipped": skipped, "enabled": True,
                        "t_med": t_med, "join": join}
    return data


def prepare_plan(data: dict, *, close_gaps: bool = True, verbose: bool = True) -> dict:
    """normalize_plan + close_wall_gaps. What every 3D consumer should call."""
    data = normalize_plan(data)
    data = close_wall_gaps(data, enabled=close_gaps)
    rep = data.get("gap_fill") or {}
    if verbose and rep.get("enabled"):
        print("[plan_ops] gap closure: +%d connectors, %d gaps left open (t_med=%.1fpx)"
              % (len(rep["added"]), len(rep["skipped"]), rep.get("t_med", 0.0)))
        for line in rep["added"] + rep["skipped"]:
            print("           " + line)
    return data


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 2:
        sys.exit("usage: python deliverables/plan_ops.py <plan.json>")
    plan = prepare_plan(json.load(open(sys.argv[1], encoding="utf-8")))
    print("walls: %d (%d generated)"
          % (len(plan["walls"]), sum(1 for w in plan["walls"] if w.get("generated"))))
