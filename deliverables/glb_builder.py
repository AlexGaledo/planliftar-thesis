"""GLB builder extracted verbatim from notebook Cell 11-pre so it can run locally."""
# Cell 11-pre — GLB builder (reviewed deliverable)
# Notebook does: !pip install -q trimesh   (run that in the cell above this one)
import numpy as np
import trimesh

from plan_ops import prepare_plan


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
