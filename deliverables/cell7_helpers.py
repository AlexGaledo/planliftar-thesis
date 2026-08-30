import numpy as np
import cv2
from scipy.optimize import linear_sum_assignment


def rasterize_rooms(cubicasa_rooms, shape, cx0, cy0):
    """Shift each CubiCasa room polygon into crop coords and rasterize to a filled mask, skipping ones fully outside the crop."""
    h, w = shape
    out = []
    for room in cubicasa_rooms:
        poly = room.get("polygon", [])
        if len(poly) < 3:
            continue
        pts = np.array([[p["x"] - cx0, p["y"] - cy0] for p in poly], dtype=np.float64)
        x0, y0 = pts[:, 0].min(), pts[:, 1].min()
        x1, y1 = pts[:, 0].max(), pts[:, 1].max()
        if x1 < 0 or y1 < 0 or x0 >= w or y0 >= h:
            continue
        mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(mask, [pts.round().astype(np.int32)], 1)
        out.append((room, mask))
    return out


def pairwise_iou(labels, room_ids, cubi_masks):
    """Compute the IoU matrix between each label-map room region and each rasterized CubiCasa mask."""
    n, m = len(room_ids), len(cubi_masks)
    iou = np.zeros((n, m), dtype=np.float64)
    for i, rid in enumerate(room_ids):
        rmask = labels == rid
        for j, cmask in enumerate(cubi_masks):
            cm = cmask.astype(bool)
            inter = np.count_nonzero(rmask & cm)
            union = np.count_nonzero(rmask | cm)
            iou[i, j] = inter / union if union else 0.0
    return iou


def hungarian_match(iou_matrix, min_iou=0.5):
    """Solve the IoU-maximizing 1:1 assignment via the Hungarian algorithm, keeping only matches >= min_iou."""
    if iou_matrix.size == 0:
        return []
    row_idx, col_idx = linear_sum_assignment(-iou_matrix)
    matches = []
    for i, j in zip(row_idx, col_idx):
        v = float(iou_matrix[i, j])
        if v >= min_iou:
            matches.append((int(i), int(j), v))
    return matches


def shoelace_area(poly):
    """Absolute polygon area via the shoelace formula for a list of {"x","y"} dict vertices."""
    xs = np.array([p["x"] for p in poly], dtype=np.float64)
    ys = np.array([p["y"] for p in poly], dtype=np.float64)
    return float(0.5 * abs(np.dot(xs, np.roll(ys, -1)) - np.dot(ys, np.roll(xs, -1))))


def polygon_is_closed(poly):
    """True if poly has >=3 vertices and encloses nonzero (shoelace) area, i.e. isn't degenerate."""
    if len(poly) < 3:
        return False
    return shoelace_area(poly) > 0.0


def _point_seg_dist(p, a, b):
    """Euclidean distance from point p to segment a-b (each an (x, y) float array)."""
    ap = p - a
    ab = b - a
    denom = np.dot(ab, ab)
    t = 0.0 if denom == 0 else np.clip(np.dot(ap, ab) / denom, 0.0, 1.0)
    proj = a + t * ab
    return float(np.linalg.norm(p - proj))


def wall_endpoint_degrees(walls, tol=6.0):
    """For each wall's start/end, count other walls (by endpoint or segment-body proximity) within tol px."""
    n = len(walls)
    pts = [(np.array([w["start"]["x"], w["start"]["y"]], dtype=np.float64),
            np.array([w["end"]["x"], w["end"]["y"]], dtype=np.float64)) for w in walls]
    degrees = {}
    for i, w in enumerate(walls):
        s_i, e_i = pts[i]
        deg_s = 0
        deg_e = 0
        for j in range(n):
            if j == i:
                continue
            s_j, e_j = pts[j]
            if np.linalg.norm(s_i - s_j) <= tol or np.linalg.norm(s_i - e_j) <= tol:
                deg_s += 1
            elif _point_seg_dist(s_i, s_j, e_j) <= tol:
                deg_s += 1
            if np.linalg.norm(e_i - s_j) <= tol or np.linalg.norm(e_i - e_j) <= tol:
                deg_e += 1
            elif _point_seg_dist(e_i, s_j, e_j) <= tol:
                deg_e += 1
        degrees[w["id"]] = (deg_s, deg_e)
    return degrees


def build_room_masks(labels, room_ids):
    """Map each room label id to a uint8 binary mask of its label-map region."""
    return {rid: (labels == rid).astype(np.uint8) for rid in room_ids}
