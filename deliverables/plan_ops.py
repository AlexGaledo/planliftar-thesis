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

import heapq
import math
import statistics
import time

DEFAULT_HEIGHT_M = 2.7

# All tolerances are multiples of the median wall thickness (t_med), so the
# same numbers hold at any raster resolution - the same convention the
# segmentation pipeline uses for its own tolerances.
SNAP_T_MED_FRAC = 0.5     # endpoints this close are already the same node
JOIN_T_MED_FRAC = 3.0     # corner / jog / T-junction closure range
ONLINE_T_MED_FRAC = 1.0   # a fixture this close counts as lying "on" a line

# Beyond this, a dangling endpoint is treated as having nothing to connect to.
# It is a real limit, not just a performance guard: the widest gap any of this
# project's plans legitimately closes is 599.9 px at t_med 20, i.e. 30x, and
# that one only passes because two windows sit on the line. 40x leaves room
# above the real cases while keeping the nearest-wall search local, which is
# what stops the cost from exploding on a plan of disconnected segments.
SEARCH_T_MED_FRAC = 40.0

# Hard ceiling on input size. This runs on user-uploaded JSON in the browser,
# where the only thing between a hostile file and a frozen tab is this number.
MAX_WALLS_FOR_CLOSURE = 5000

# Wall-clock ceiling, because a wall count alone cannot bound the work: cost
# depends on how DISCONNECTED the plan is, not just how big. A 244-wall real
# plan finishes in milliseconds because almost nothing is dangling; 2000
# deliberately disconnected segments take ~42 s. Past this the closure stops
# early, keeps what it has, and says so. Generous enough that no real plan can
# reach it, so results stay deterministic in the parity tests.
CLOSURE_BUDGET_S = 2.0


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

    Idempotent, via the "_plan_ops_normalized" marker. It has to be: the
    metre->px division is destructive, so a second pass over an already
    converted plan turns a 0.10 m wall into 1000 px instead of 10. The upload
    path in index.html normalises once to validate and once more inside
    applyPlan, and hit exactly that.
    """
    if not isinstance(data, dict) or not isinstance(data.get("walls"), list):
        return data
    if data.get("_plan_ops_normalized"):
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
    data["_plan_ops_normalized"] = True
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
    if any(isinstance(w, dict) and w.get("generated") for w in walls):
        return data          # already closed; re-running would duplicate fill ids
    data["gap_fill"] = {"added": [], "skipped": [], "enabled": enabled}
    if not enabled or len(walls) < 2:
        return data

    if len(walls) > MAX_WALLS_FOR_CLOSURE:
        data["gap_fill"] = {
            "added": [], "enabled": False,
            "skipped": ["%d walls exceeds MAX_WALLS_FOR_CLOSURE=%d; closure skipped"
                        % (len(walls), MAX_WALLS_FOR_CLOSURE)]}
        return data

    # Sanitation, not decoration. JSON has no NaN literal but 1e400 parses to
    # inf, and inf/NaN coordinates poison every comparison below: NaN fails
    # every < test silently, so a poisoned wall is never "nearest" but is also
    # never rejected, and an inf endpoint makes the spatial grid try to
    # enumerate an unbounded number of cells. Drop those walls instead.
    seg = []
    dropped = 0
    for i, w in enumerate(walls):
        if not (isinstance(w, dict) and isinstance(w.get("start"), dict)
                and isinstance(w.get("end"), dict)):
            continue
        try:
            s = (float(w["start"]["x"]), float(w["start"]["y"]))
            e = (float(w["end"]["x"]), float(w["end"]["y"]))
            t = float(w.get("thickness") or 4.0)
            h = float(w.get("height") or DEFAULT_HEIGHT_M)
        except (TypeError, ValueError):
            dropped += 1
            continue
        if not all(math.isfinite(v) for v in (s[0], s[1], e[0], e[1], t, h)) or t <= 0:
            dropped += 1
            continue
        seg.append({"id": w.get("id", "w%d" % i), "s": s, "e": e, "t": t, "h": h})
    if len(seg) < 2:
        if dropped:
            data["gap_fill"]["skipped"].append(
                "%d wall(s) dropped: non-finite or non-positive values" % dropped)
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
    search_r = SEARCH_T_MED_FRAC * t_med

    # Uniform grid over segment bounding boxes. The nearest-wall query used to
    # scan every wall, inside a loop that itself re-scanned every endpoint, and
    # the whole thing ran once per fill: measured at 1.3 s for 50 disconnected
    # walls and 21.5 s for 100 - roughly n^4. On a page that accepts uploaded
    # plans that is a hostile-file freeze, not just a slow path.
    #
    # A wall is registered in every cell its bbox touches, so the cell holding
    # the closest point on it is always registered and the query cannot miss.
    cell = max(2.0 * t_med, 1e-6)

    def _cells_for(a, b):
        x0, x1 = sorted((a[0], b[0]))
        y0, y1 = sorted((a[1], b[1]))
        for cx in range(int(math.floor(x0 / cell)), int(math.floor(x1 / cell)) + 1):
            for cy in range(int(math.floor(y0 / cell)), int(math.floor(y1 / cell)) + 1):
                yield (cx, cy)

    grid = {}

    def _index(idx):
        for c in _cells_for(seg[idx]["s"], seg[idx]["e"]):
            grid.setdefault(c, []).append(idx)

    for idx in range(len(seg)):
        _index(idx)

    def _near(p, radius):
        """Indices of walls whose bbox lies within `radius` of p."""
        out = set()
        cx0 = int(math.floor((p[0] - radius) / cell))
        cx1 = int(math.floor((p[0] + radius) / cell))
        cy0 = int(math.floor((p[1] - radius) / cell))
        cy1 = int(math.floor((p[1] + radius) / cell))
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                out.update(grid.get((cx, cy), ()))
        return out

    def _joined(i, p):
        """True if any other wall's body already passes within snap of p."""
        return any(j != i and _nearest_on_segment(p, seg[j]["s"], seg[j]["e"])[1] <= snap
                   for j in _near(p, snap))

    def _candidate(i, key):
        """Nearest connectable wall to seg[i][key], or None.

        Radius grows from `join` outward: most endpoints resolve against a
        corner one wall-thickness away, and only the genuinely isolated ones
        pay for the wide search. Scanning every cell within a radius means any
        wall closer than that radius was scanned, so the first radius that
        yields a hit yields the true nearest.
        """
        a, p = seg[i], seg[i][key]
        radius = join
        while True:
            best = None
            for j in sorted(_near(p, radius)):
                if j == i:
                    continue
                b = seg[j]
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
                    best = (d, j, q)
            # A hit found at radius r is only PROVABLY the nearest if it lies
            # within r - the scan covered every cell inside r, but a wall whose
            # bbox reaches into the box while its body stays far away can be
            # returned at a distance greater than r, and a nearer wall outside
            # the scanned cells would then be missed. So keep widening until
            # the best hit is inside the radius that found it.
            if best is not None and best[0] <= radius:
                return best
            if radius >= search_r:
                return best      # widest scan done; nearest found, if any
            radius = min(radius * 2.0, search_r)

    # Lazy-evaluated priority queue. Entries can go stale - inserting a
    # connector can put a new wall closer to some other dangling endpoint - so
    # every pop is re-checked against a fresh candidate before being acted on,
    # and endpoints near a new connector are re-queued. Tie-break is
    # (wall index, s before e, target index), which is the order the old
    # exhaustive scan happened to visit in, so results are unchanged.
    heap = []

    def _push(i, key):
        if seg[i]["id"] + key in done:
            return
        c = _candidate(i, key)
        if c is not None:
            heapq.heappush(heap, (c[0], i, 0 if key == "s" else 1, c[1], c[2]))

    # The deadline has to start HERE, not at the loop. Seeding the queue costs
    # one nearest-wall search per endpoint, and on a plan where nothing is
    # connected every one of those widens all the way to search_r - 5000
    # disconnected walls spent 46 s in this loop alone, before the first pop.
    deadline = time.monotonic() + CLOSURE_BUDGET_S
    timed_out = False
    for i in range(len(seg)):
        if (i & 0x3F) == 0 and time.monotonic() > deadline:
            timed_out = True
            break
        _push(i, "s")
        _push(i, "e")

    added, skipped = [], []
    # Two separate limits. `decisions` counts endpoints actually resolved, and
    # is the same 4n the exhaustive version used. `pops` bounds the queue churn
    # - stale and already-resolved entries are popped and discarded, and
    # counting those against the decision budget silently starved the long-gap
    # endpoints: the 6 m span fill vanished and every skip reason with it.
    decisions = 4 * len(seg)
    pops = 64 * len(seg) + 1000
    while heap and decisions > 0 and pops > 0 and not timed_out:
        pops -= 1
        if (pops & 0x3F) == 0 and time.monotonic() > deadline:
            timed_out = True
            break
        d, i, keyn, j, q = heapq.heappop(heap)
        key = "s" if keyn == 0 else "e"
        a, p = seg[i], seg[i][key]
        if a["id"] + key in done:
            continue
        if _joined(i, p):
            done.add(a["id"] + key)
            continue
        fresh = _candidate(i, key)
        if fresh is None:
            done.add(a["id"] + key)
            continue
        if abs(fresh[0] - d) > 1e-9 or fresh[1] != j:
            # a later insertion changed this endpoint's nearest wall
            heapq.heappush(heap, (fresh[0], i, keyn, fresh[1], fresh[2]))
            continue
        b = seg[j]
        done.add(a["id"] + key)
        decisions -= 1

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
            _index(len(seg) - 1)
            added.append("%s %s->%s %.1fpx [%s]"
                         % (wid, a["id"], b["id"], _dist(u, v), reason))
            # This connector may now be the nearest wall to some other
            # dangling endpoint, so anything near it needs re-queuing.
            for k in (_near(u, search_r) | _near(v, search_r)):
                if k < len(seg):
                    _push(k, "s")
                    _push(k, "e")

    if timed_out:
        skipped.append("closure stopped after %.1fs (CLOSURE_BUDGET_S); "
                       "remaining gaps left open" % CLOSURE_BUDGET_S)
    if dropped:
        skipped.append("%d wall(s) dropped: non-finite or non-positive values" % dropped)
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
