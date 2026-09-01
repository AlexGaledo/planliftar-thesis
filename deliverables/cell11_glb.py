# Cell 11-pre - GLB builder (reviewed deliverable)
# Notebook does: !pip install -q trimesh   (run that in the cell above this one)
#
# GENERATED FILE - do not edit. Regenerate with:
#     python deliverables/make_notebook_cell.py
#
# This is plan_ops.py and glb_builder.py concatenated, because a Kaggle cell
# cannot import from this repo. Edit those two, then regenerate.

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


import numpy as np
import trimesh



def _px_to_m(value, pixels_per_meter):
    """Convert a px measurement to meters given a pixels_per_meter scale factor."""
    return float(value) / float(pixels_per_meter)


def _wall_box(start_xy_m, end_xy_m, thickness_m, height_m, name):
    """Build a box mesh spanning start->end (plan-space meters), sitting on y=0.

    Plan (x, y) -> world (x, z), with z flipped (world_z = -plan_y) so the
    plan reads correctly (not mirrored) when viewed from above in a
    glTF y-up viewer. Returns None for a degenerate (zero-length) wall.
    """
    sx, sz = start_xy_m[0], -start_xy_m[1]
    ex, ez = end_xy_m[0], -end_xy_m[1]

    dx, dz = ex - sx, ez - sz
    length = float(np.hypot(dx, dz))
    if length < 1e-6:
        return None

    ux = np.array([dx, 0.0, dz]) / length          # wall's long axis, world XZ
    uz_world = np.array([0.0, 1.0, 0.0])            # world up
    uy = np.cross(uz_world, ux)                     # wall's thickness axis (XZ plane)
    uy = uy / np.linalg.norm(uy)

    box = trimesh.creation.box(extents=[length, thickness_m, height_m])

    transform = np.eye(4)
    transform[:3, 0] = ux
    transform[:3, 1] = uy
    transform[:3, 2] = uz_world
    transform[:3, 3] = [
        (sx + ex) / 2.0,
        height_m / 2.0,
        (sz + ez) / 2.0,
    ]
    box.apply_transform(transform)

    box.visual = trimesh.visual.texture.TextureVisuals(
        material=trimesh.visual.material.PBRMaterial(
            baseColorFactor=[235, 232, 225, 255],
            metallicFactor=0.0,
            roughnessFactor=0.9,
        )
    )
    box.metadata["name"] = name
    return box


def build_glb(geometry: dict, pixels_per_meter: float, wall_height_m: float = 2.5,
              out_path: str = "/kaggle/working/planlift.glb", close_gaps: bool = True):
    """Build a GLB from exported floorplan geometry: one box mesh per wall plus a floor slab.

    The geometry is run through plan_ops.prepare_plan() first, so ANY of the
    project's three plan schemas is accepted and dangling walls are welded shut
    before extrusion. That closure is what stops a line-first detector's output
    from rendering as walls that teleport sideways at every corner; pass
    close_gaps=False to extrude the raw segments for comparison.

    After prepare_plan, walls[i] looks like:
        {"start": {"x", "y"}, "end": {"x", "y"}, "thickness": <px>, "height": <m>}
    "start"/"end" and "thickness" are all in plan px and are converted to
    meters via pixels_per_meter; "height" is already real-world meters, with
    wall_height_m as the fallback when a wall has no "height" field.
    """
    geometry = prepare_plan(geometry, close_gaps=close_gaps)
    walls = geometry.get("walls", [])

    wall_meshes = []
    names = []
    for i, wall in enumerate(walls):
        start_m = (
            _px_to_m(wall["start"]["x"], pixels_per_meter),
            _px_to_m(wall["start"]["y"], pixels_per_meter),
        )
        end_m = (
            _px_to_m(wall["end"]["x"], pixels_per_meter),
            _px_to_m(wall["end"]["y"], pixels_per_meter),
        )
        # px, not metres: prepare_plan() has already converted any
        # metre-stated thickness using the file's own pixel_to_meter_ratio.
        thickness_m = _px_to_m(wall.get("thickness", 10.0), pixels_per_meter)
        height_m = float(wall.get("height", wall_height_m))
        name = f"w{i}"

        mesh = _wall_box(start_m, end_m, thickness_m, height_m, name)
        if mesh is None:
            continue
        wall_meshes.append(mesh)
        names.append(name)

    if not wall_meshes:
        raise ValueError("build_glb: geometry['walls'] produced no valid wall meshes")

    # Overall bounding box across all walls (world X/Z), before centering.
    all_bounds = np.array([m.bounds for m in wall_meshes])  # (n, 2, 3)
    min_xyz = all_bounds[:, 0, :].min(axis=0)
    max_xyz = all_bounds[:, 1, :].max(axis=0)
    center_x = (min_xyz[0] + max_xyz[0]) / 2.0
    center_z = (min_xyz[2] + max_xyz[2]) / 2.0

    recenter = np.eye(4)
    recenter[0, 3] = -center_x
    recenter[2, 3] = -center_z
    for m in wall_meshes:
        m.apply_transform(recenter)

    # Floor slab: 0.02 m thick, spanning the (recentered) wall footprint with a small margin.
    floor_thickness = 0.02
    margin = 0.1
    floor_w = (max_xyz[0] - min_xyz[0]) + 2 * margin
    floor_d = (max_xyz[2] - min_xyz[2]) + 2 * margin
    floor = trimesh.creation.box(extents=[max(floor_w, 0.01), floor_thickness, max(floor_d, 0.01)])
    floor.apply_translation([0.0, -floor_thickness / 2.0, 0.0])
    floor.visual = trimesh.visual.texture.TextureVisuals(
        material=trimesh.visual.material.PBRMaterial(
            baseColorFactor=[90, 90, 95, 255],
            metallicFactor=0.0,
            roughnessFactor=1.0,
        )
    )
    floor.metadata["name"] = "floor"

    scene = trimesh.Scene()
    for name, mesh in zip(names, wall_meshes):
        scene.add_geometry(mesh, node_name=name, geom_name=name)
    scene.add_geometry(floor, node_name="floor", geom_name="floor")

    scene.export(out_path, file_type="glb")

    total_vertices = sum(len(g.vertices) for g in scene.geometry.values())
    total_faces = sum(len(g.faces) for g in scene.geometry.values())
    bmin, bmax = scene.bounds
    print(f"Exported: {out_path}")
    print(f"Nodes: {len(wall_meshes)} walls + 1 floor")
    print(f"Vertices: {total_vertices}  Faces: {total_faces}")
    print(f"Bounding box (m): min={bmin.round(3).tolist()} max={bmax.round(3).tolist()} "
          f"size={(bmax - bmin).round(3).tolist()}")

    return scene
