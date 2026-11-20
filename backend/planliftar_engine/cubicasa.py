"""CubiCasa5k multi-task network (planliftar-cubicasa notebook, cells 0-4 and 6).

Produces the two fragments the geometry stage consumes, in the coordinate
frame of the image passed in:

  sample_geometry      {"walls": [{start:[x,y], end:[x,y], thickness_px}],
                        "openings": [{type: door|window, position:[x,y], width_px}]}
  rooms_fixtures       {"rooms": [{id, type, polygon:[{x,y}]}],
                        "fixtures": [{id, type, position:{x,y}, scale, rotation_degrees}]}

These are only ever used as *hints* (labeling seals + consensus scoring +
door/window fixtures); MitUNet stays the geometry source.

Memory: the hourglass net runs at the full input resolution, so VRAM grows
with image area. `max_side` downsizes the network input (default 2730 px
longest side; see predict() for precision); the logits
are upsampled back to the original size before post-processing, so every
pixel threshold in floortrans' post-processing still sees the notebook's
resolution, and coordinates come back in original-image pixels.
"""
from __future__ import annotations

import sys
import threading

import numpy as np
import torch
import torch.nn.functional as F

from .weights import cubicasa_source, cubicasa_weights

ROOM_CLASSES = ["Background", "Outdoor", "Wall", "Kitchen", "Living Room", "Bed Room",
                "Bath", "Entry", "Railing", "Storage", "Garage", "Undefined"]
RATIO = 0.01   # notebook placeholder m/px, used only for fixture "scale.width"

_cache: dict = {}
_lock = threading.Lock()
_shimmed = False


def _import_floortrans():
    """Put the pinned CubiCasa5k checkout on sys.path and apply the notebook's
    two compatibility patches (without editing the third-party files)."""
    global _shimmed
    root = str(cubicasa_source())
    if root not in sys.path:
        sys.path.insert(0, root)
    if not _shimmed:
        # Gotcha 2: `from scipy.ndimage import measurements` is gone in new SciPy.
        import scipy.ndimage as ndi
        try:
            from scipy.ndimage import measurements  # noqa: F401
        except ImportError:
            sys.modules["scipy.ndimage.measurements"] = ndi
        # scipy.stats.mode(keepdims) changed default; repo expects .mode[0]
        from scipy import stats
        orig = stats.mode

        def _mode_compat(a, axis=0, **kw):
            kw.setdefault("keepdims", True)
            return orig(a, axis=axis, **kw)
        stats.mode = _mode_compat
        _shimmed = True
    from floortrans.models.hg_furukawa_original import hg_furukawa_original
    from floortrans import post_prosessing
    if post_prosessing.drop_big_icons is not _drop_big_icons_fast:
        post_prosessing.drop_big_icons = _drop_big_icons_fast
        post_prosessing.adjust_door_points = _make_safe_adjust(post_prosessing.adjust_door_points)
        post_prosessing.get_wall_lines = _make_fast_wall_lines(post_prosessing)
        post_prosessing.get_polygon_class = _get_polygon_class_nocopy
        post_prosessing.drop_long_walls = _make_fast_drop_long_walls(post_prosessing)
    return hg_furukawa_original, post_prosessing


def _get_polygon_class_nocopy(polygon, segmentation, remove_layers=[]):
    """floortrans get_polygon_class minus a full-image np.copy per call (it only
    reads): 1925 copies = 15.7 s on the sample. Same result."""
    from skimage import draw
    jj, ii = draw.polygon(polygon[:, 1], polygon[:, 0], shape=segmentation.shape)
    values, counts = np.unique(segmentation[jj, ii], return_counts=True)
    if len(counts) != 0:
        return values[np.argmax(counts)]
    return None


def _make_fast_drop_long_walls(pp):
    """floortrans drop_long_walls with set membership instead of list scans
    (same pair order, same decisions; 13 s -> well under 1 s)."""
    def drop_long_walls(walls, wall_points):
        dims = [pp.calc_line_dim(wall_points, w) for w in walls]
        keys = [tuple(w) for w in walls]
        bad, rem_set, remaining = set(), set(), []

        def add(i):
            k = keys[i]
            if k not in rem_set and k not in bad:
                rem_set.add(k)
                remaining.append(walls[i])

        n = len(walls)
        for i in range(n):
            ki = keys[i]
            for j in range(i + 1, n):
                kj = keys[j]
                if (ki not in bad and kj not in bad and dims[i] == dims[j]
                        and (ki[0] == kj[0] or ki[1] == kj[1])):
                    l1 = pp.get_wall_length(walls[i], wall_points)
                    l2 = pp.get_wall_length(walls[j], wall_points)
                    if l1 <= l2:
                        good, bad_k = i, kj
                    else:
                        good, bad_k = j, ki
                    bad.add(bad_k)
                    if keys[good] not in rem_set:
                        rem_set.add(keys[good])
                        remaining.append(walls[good])
                else:
                    add(i)
                    add(j)
        return [w for w in remaining if tuple(w) not in bad]
    return drop_long_walls


def _bresenham_np(x0, y0, x1, y1):
    """Closed form of floortrans' bresenham_line -> (rows, cols) int arrays.
    Verified identical to the original on 20k random segments."""
    dx, dy = x1 - x0, y1 - y0
    xs = 1 if dx > 0 else -1
    ys = 1 if dy > 0 else -1
    dx, dy = abs(dx), abs(dy)
    if dx > dy:
        xx, xy, yx, yy = xs, 0, 0, ys
    else:
        dx, dy = dy, dx
        xx, xy, yx, yy = 0, ys, xs, 0
    k = np.arange(dx + 1)
    y = (2 * dy * k + dx) // (2 * dx) if dx > 0 else np.zeros(1, dtype=k.dtype)
    return y0 + k * xy + y * yy, x0 + k * xx + y * yx


def _make_fast_wall_lines(pp):
    """floortrans get_wall_lines with the per-line pixel walk vectorised.

    Line-for-line the original except the `rooms_on_line` evidence sum, which
    was a Python bresenham + np.array over ~240k candidate lines (~45 s of a
    60 s wall pass on the sample). Same pixels, same argmax.
    """
    def get_wall_lines(wall_heatmaps, room_segmentation, threshold, wall_classes,
                       point_orientations, orientation_ranges, max_num_points=100):
        _, height, width = room_segmentation.shape
        gap = 10
        wall_points = []
        for i in range(len(wall_heatmaps)):
            info = [int(i / 4), int(i % 4)]
            p = pp.extract_local_max(wall_heatmaps[i], max_num_points, info, threshold,
                                     close_point_suppression=True)
            wall_points += p
        point_info = pp.calc_point_info(wall_points, gap, point_orientations,
                                        orientation_ranges, height, width)
        wall_lines, wall_point_orientation_lines_map, wall_point_neighbors = point_info
        good_wall_lines = []
        for i1, i2 in wall_lines:
            x1, y1 = wall_points[i1][0], wall_points[i1][1]
            x2, y2 = wall_points[i2][0], wall_points[i2][1]
            rows, cols = _bresenham_np(x1, y1, x2, y2)
            segment = np.argmax(room_segmentation[:, rows, cols].sum(axis=1))
            if segment in wall_classes:
                good_wall_lines.append((i1, i2, segment))
        wall_lines = pp.drop_long_walls(good_wall_lines, wall_points)
        v_walls = [line for line in wall_lines if pp.calc_line_dim(wall_points, line)]
        h_walls = [line for line in wall_lines if not pp.calc_line_dim(wall_points, line)]
        connected_walls_v = pp.get_connected_walls(v_walls)
        wall_points = pp.points_to_manhantan(connected_walls_v, wall_points, 0)
        connected_walls_h = pp.get_connected_walls(h_walls)
        wall_points = pp.points_to_manhantan(connected_walls_h, wall_points, 1)
        return wall_lines, wall_points, wall_point_orientation_lines_map
    return get_wall_lines


def _drop_big_icons_fast(icons, icon_points):
    """Same result as floortrans.post_prosessing.drop_big_icons, same order.

    The original does `x in list` membership tests inside an O(n^2) pair loop
    (O(n^3) overall): 316 s of a 376 s post-process on the 10052 sample. This
    keeps the identical pair-visiting order and decisions, with set lookups,
    and short-circuits pairs that cannot share a corner.
    """
    def area(ic):
        p1, p2, p3, p4 = (icon_points[ic[k]] for k in range(4))
        return ((int((p2[0] + p4[0]) / 2) - int((p1[0] + p3[0]) / 2))
                * (int((p3[1] + p4[1]) / 2) - int((p1[1] + p2[1]) / 2)))

    keys = [tuple(ic) for ic in icons]
    bad, rem_set, remaining = set(), set(), []

    def add(i):
        k = keys[i]
        if k not in rem_set and k not in bad:
            rem_set.add(k)
            remaining.append(icons[i])

    n = len(icons)
    for i in range(n):
        ki = keys[i]
        for j in range(i + 1, n):
            kj = keys[j]
            if ki not in bad and kj not in bad:
                if ki[0] == kj[0] or ki[1] == kj[1] or ki[2] == kj[2] or ki[3] == kj[3]:
                    if area(icons[i]) <= area(icons[j]):
                        good, bad_k = i, kj
                    else:
                        good, bad_k = j, ki
                    bad.add(bad_k)
                    if keys[good] not in rem_set:
                        rem_set.add(keys[good])
                        remaining.append(icons[good])
            else:
                add(i)
                add(j)
    return [ic for ic, k in zip(remaining, (tuple(x) for x in remaining)) if k not in bad]


def _make_safe_adjust(orig):
    """adjust_door_points indexes wall_lines[door_wall_map[i]] where the map holds
    -1 for "no parallel wall found"; with an empty wall list that is an
    IndexError that kills the whole CubiCasa pass. Skip such doors instead
    (they keep their un-snapped coordinates)."""
    def safe(door_points, door_lines, wall_points, wall_lines, door_wall_map):
        keep = [k for k, m in enumerate(door_wall_map) if 0 <= m < len(wall_lines)]
        if len(keep) == len(door_lines):
            return orig(door_points, door_lines, wall_points, wall_lines, door_wall_map)
        return orig(door_points, [door_lines[k] for k in keep], wall_points, wall_lines,
                    [door_wall_map[k] for k in keep])
    return safe


def load_model(device: str):
    with _lock:
        if device in _cache:
            return _cache[device]
        hg, _ = _import_floortrans()
        # get_model() would also call init_weights(), which loads an unrelated
        # MPII checkpoint by a cwd-relative path; it is fully overwritten by the
        # state dict below, so build the module directly instead.
        model = hg(n_classes=51)
        model.conv4_ = torch.nn.Conv2d(256, 44, bias=True, kernel_size=1)
        model.upsample = torch.nn.ConvTranspose2d(44, 44, kernel_size=4, stride=4)
        # The notebook needed weights_only=False ("Gotcha 1") on Kaggle's older
        # torch; on torch >= 2.6 this checkpoint (tensors + plain numbers only)
        # loads with the safe unpickler. The sha256 pin is verified first anyway.
        ckpt = torch.load(cubicasa_weights(), map_location="cpu", weights_only=True)
        model.load_state_dict(ckpt["model_state"])
        model.to(device).eval()
        if device.startswith("cuda"):
            # The final 4x ConvTranspose emits 44 channels at full resolution
            # (~1 GB fp32 for a 2730x2048 sheet) - the single biggest tensor.
            # Running just that layer (and the in-place sigmoid that follows it
            # in forward()) on the CPU lets native-resolution inference fit in
            # 4 GB of VRAM. Same weights, same maths.
            model.upsample = _CpuHead(model.upsample)
        _cache[device] = model
        return model


class _CpuHead(torch.nn.Module):
    def __init__(self, up):
        super().__init__()
        self.up = up.cpu()

    def _apply(self, fn, recurse=True):   # keep the head on CPU through .to()/.cuda()
        return self

    def forward(self, x):
        return self.up(x.float().cpu())


def predict(model, img_rgb: np.ndarray, device: str, max_side: int = 2730,
            precision: str = "fp32") -> torch.Tensor:
    """Raw 44-channel prediction at the ORIGINAL HxW (CPU float32 tensor).

    precision: "fp32" | "bf16" | "fp16" (CUDA only; CPU always fp32).
    fp16 is NOT safe for this network: the hourglass activations overflow and
    every heatmap channel comes back NaN (measured), which silently yields zero
    walls. bf16 keeps fp32's exponent range; fp32 is the notebook's setting.
    """
    H, W = img_rgb.shape[:2]
    x = torch.from_numpy(img_rgb.astype(np.float32) / 255.0).permute(2, 0, 1).unsqueeze(0)
    x = 2 * x - 1                                         # notebook: normalise to [-1, 1]
    s = min(1.0, max_side / max(H, W)) if max_side else 1.0
    if s < 1.0:
        x = F.interpolate(x, size=(max(32, round(H * s)), max(32, round(W * s))),
                          mode="bilinear", align_corners=False)
    x = x.to(device)
    with torch.inference_mode():
        if precision in ("bf16", "fp16") and device.startswith("cuda"):
            dt = torch.bfloat16 if precision == "bf16" else torch.float16
            with torch.autocast("cuda", dtype=dt):
                pred = model(x)
        else:
            pred = model(x)
        pred = pred.float().cpu()
    if not torch.isfinite(pred).all():
        raise FloatingPointError(f"CubiCasa produced non-finite outputs ({precision}); use fp32")
    del x
    if device.startswith("cuda"):
        torch.cuda.empty_cache()
    return F.interpolate(pred, size=(H, W), mode="bilinear", align_corners=True)


def _rect_to_centerline(poly):
    pts = np.asarray(poly, dtype=float)
    n = len(pts)
    edges = [(i, (i + 1) % n) for i in range(n)]
    L = [np.linalg.norm(pts[a] - pts[b]) for a, b in edges]
    o = np.argsort(L)
    m1 = pts[list(edges[o[0]])].mean(0)
    m2 = pts[list(edges[o[1]])].mean(0)
    return m1.tolist(), m2.tolist(), float((L[o[0]] + L[o[1]]) / 2), float(max(L))


def _norm_label(lbl):
    m = {"Bed Room": "bedroom", "Living Room": "living_room", "Bath": "bathroom",
         "Kitchen": "kitchen", "Entry": "entry", "Storage": "storage", "Garage": "garage",
         "Undefined": "room"}
    return m.get(lbl, lbl.lower().replace(" ", "_"))


def _polygon_rings(geom, min_area=1.0):
    from shapely.geometry import Polygon
    from shapely.geometry.base import BaseMultipartGeometry
    rings = []
    if geom.is_empty:
        return rings
    if isinstance(geom, Polygon):
        if geom.area >= min_area:
            rings.append([{"x": round(float(x), 1), "y": round(float(y), 1)}
                          for x, y in geom.exterior.coords])
    elif isinstance(geom, BaseMultipartGeometry):
        for part in geom.geoms:
            rings.extend(_polygon_rings(part, min_area))
    return rings


def postprocess(pred: torch.Tensor, shape):
    """floortrans post-processing -> (sample_geometry, rooms_fixtures). CPU-bound."""
    _, pp = _import_floortrans()
    H, W = shape
    heatmaps, rooms, icons = pp.split_prediction(pred, (H, W), [21, 12, 11])
    polygons, types, room_polygons, room_types = pp.get_polygons((heatmaps, rooms, icons),
                                                                 0.1, [1, 2])
    # cell 4: walls + openings (sample_geometry.json)
    walls, openings = [], []
    for i, t in enumerate(types):
        poly = polygons[i]
        if t["type"] == "wall":
            s, e, thick, _ = _rect_to_centerline(poly)
            walls.append({"id": f"w{i}", "start": s, "end": e, "thickness_px": round(thick, 1)})
        elif t["type"] == "icon" and int(t["class"]) in (1, 2):
            c = np.asarray(poly, dtype=float).mean(0)
            _, _, _, width = _rect_to_centerline(poly)
            openings.append({"id": f"o{i}", "type": "window" if int(t["class"]) == 1 else "door",
                             "position": [round(c[0], 1), round(c[1], 1)],
                             "width_px": round(width, 1)})
    # cell 6: rooms + fixtures (cubicasa_rooms_fixtures.json)
    out_rooms = []
    for j, (rp, rt) in enumerate(zip(room_polygons, room_types)):
        cls = int(rt["class"])
        if cls in (0, 1, 2):
            continue
        for k, ring in enumerate(_polygon_rings(rp)):
            out_rooms.append({"id": f"room_{j:03d}_{k}", "type": _norm_label(ROOM_CLASSES[cls]),
                              "polygon": ring})
    fixtures, d, w = [], 0, 0
    for i, t in enumerate(types):
        if t["type"] == "icon" and int(t["class"]) in (1, 2):
            pts = np.asarray(polygons[i], float)
            cx, cy = pts.mean(0)
            x_ext = pts[:, 0].max() - pts[:, 0].min()
            y_ext = pts[:, 1].max() - pts[:, 1].min()
            width_px = max(x_ext, y_ext)
            is_door = int(t["class"]) == 2
            if is_door:
                d += 1
                fid, ftype, hgt = f"door_{d:03d}", "door", 2.1
            else:
                w += 1
                fid, ftype, hgt = f"window_{w:03d}", "window", 1.2
            fixtures.append({"id": fid, "type": ftype,
                             "position": {"x": round(float(cx), 1), "y": round(float(cy), 1)},
                             "scale": {"width": round(float(width_px * RATIO), 2), "depth": 0.1,
                                       "height": hgt},
                             "rotation_degrees": 90.0 if y_ext > x_ext else 0.0})
    sg = {"walls": walls, "openings": openings}
    rf = {"metadata": {"original_width_px": int(W), "original_height_px": int(H),
                       "pixel_to_meter_ratio": RATIO},
          "walls": [], "rooms": out_rooms, "fixtures": fixtures}
    return sg, rf
