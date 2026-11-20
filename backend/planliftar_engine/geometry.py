"""Probability map (+ optional CubiCasa hints) -> schema-2.0 floorplan dict.

The stage logic is the vendored local/consensus_lab.py (see _vendor/), which
is AHEAD of the Kaggle notebook: graded/area-weighted consensus, page-margin
region gate, wall dedupe/axis-snap/collinear merge, t_med-relative room size.
On the CubiCasa 10052 sample it gives 13 rooms where v9_out.txt gave 14 (the
14th was a blank page-margin region). Export / door carving is notebook cell 10.
"""
from __future__ import annotations

import copy

import numpy as np

from ._vendor import consensus_lab as lab
from ._vendor import plan_ops

EMPTY_SG = {"walls": [], "openings": []}
EMPTY_RF = {"rooms": [], "fixtures": []}


def carve_doors(walls_in, openings, off_x, off_y, t):
    """Notebook cell 10: split wall runs where a DOOR crosses them (windows stay wall)."""
    out = []
    for w in walls_in:
        a = np.array([w["start"]["x"], w["start"]["y"]], float)
        b = np.array([w["end"]["x"], w["end"]["y"]], float)
        segs = [(a, b)]
        for o in openings:
            if o["type"] != "door":
                continue
            p = np.array(o["position"], float) - [off_x, off_y]
            half = 0.5 * o["width_px"]
            nxt = []
            for (s, e) in segs:
                d = e - s
                L = float(np.linalg.norm(d))
                if L < 1e-6:
                    continue
                u = d / L
                tproj = float(np.clip((p - s) @ u, 0, L))
                foot = s + tproj * u
                if np.linalg.norm(foot - p) > max(t, half):
                    nxt.append((s, e))
                    continue
                lo, hi = max(0.0, tproj - half), min(L, tproj + half)
                if lo > 4:
                    nxt.append((s, s + lo * u))
                if L - hi > 4:
                    nxt.append((s + hi * u, e))
            segs = nxt
        for i, (s, e) in enumerate(segs):
            out.append({**w, "id": f'{w["id"]}_{i}' if len(segs) > 1 else w["id"],
                        "start": {"x": round(float(s[0]), 1), "y": round(float(s[1]), 1)},
                        "end": {"x": round(float(e[0]), 1), "y": round(float(e[1]), 1)}})
    return out


def _room_types(consensus_ctx):
    """MitUNet label -> CubiCasa room type with the largest pixel overlap."""
    best = {}
    for r, m, label in consensus_ctx.get("cubi_pairs_final", []):
        px = consensus_ctx["overlap_px"].get(r["id"], 0)
        if label and px > best.get(label, (0, None))[0]:
            best[label] = (px, r.get("type"))
    return {k: v[1] for k, v in best.items() if v[1]}


def build_plan(prob, crop_offset, full_size, sg=None, rf=None, cfg_overrides=None,
               close_gaps=True, export_rejected=False):
    """Run the rooms-first geometry on a wall-probability map.

    prob          float32 HxW (crop frame)
    crop_offset   (cx0, cy0) of the crop inside the full image
    full_size     (W, H) of the full image
    sg, rf        CubiCasa sample_geometry / rooms_fixtures in FULL-image coords,
                  or None for the MitUNet-only path (no seals, no consensus).
    Returns (plan_dict, log_lines).
    """
    cfg = dict(lab.CFG)
    cfg.update(cfg_overrides or {})
    lines = []
    lab.log = lambda ls, msg: ls.append(msg)        # silence the harness's print()
    sg = sg or EMPTY_SG
    rf = rf or EMPTY_RF
    cx0, cy0 = crop_offset
    H, W = prob.shape
    prob = prob.astype(np.float32)

    mask, m1 = lab.stage_hysteresis(lines, prob, cfg)
    if not mask.any():
        raise ValueError("no wall pixels above HYST_HIGH - not a floor plan, or unreadable")
    mask, dist, m2 = lab.stage_seal_thickness(lines, mask, cfg, prob)
    t_med = m2["t_med"]
    if not np.isfinite(t_med) or t_med <= 0:
        raise ValueError("could not estimate wall thickness (empty skeleton)")
    cfg["_t_med"] = t_med
    seal_mask, cubicasa_rooms, fixtures, m3 = lab.stage_cubicasa_seal(
        lines, mask, sg, rf, t_med, cx0, cy0, H, W, cfg=cfg)
    region = lab.stage_regions_and_walls(lines, seal_mask, dist, cfg, prob)
    cons = lab.stage_consensus(lines, region["labels"], region["room_ids"], region["rooms"],
                               region["walls"], cubicasa_rooms, cx0, cy0, cfg,
                               exterior_labels=region["exterior"])
    c_final, _c_split, split = lab.stage_watershed_split(
        lines, region["labels"], region["room_ids"], cons, cfg)
    report = lab.stage_acceptance(
        lines, region["rooms"], cons["cubi_masks"], cons["matches"], c_final,
        cons["consensus"], cfg, t_med, cons["n_loose"], cons["inv"], cons["needs_repair"],
        cons["merged_rooms_note"], cx0, cy0, split["consensus_final_legacy"],
        cons["consensus_legacy"])

    have_cubi = bool(sg["walls"] or rf["rooms"])
    if not have_cubi:
        # Without a second model there is nothing to agree with: consensus is
        # undefined rather than 0, and must not be read as "low agreement".
        report["notes"] = [n for n in report["notes"] if n != "merged_rooms"] + ["mitunet_only"]
        for k in ("consensus_iou", "consensus_raw", "consensus_legacy", "consensus_legacy_final"):
            report["metrics"][k] = None

    W_full, H_full = full_size
    plan = {
        "schema_version": "2.0",
        "source": {"image_width_px": int(W_full), "image_height_px": int(H_full)},
        "scale": {"units": "relative_px", "user_scale_required": True},
        "walls": [], "rooms": [], "fixtures": [],
        "acceptance": {"accepted": report["accepted"], "reject_reasons": report["reject_reasons"],
                       "notes": report["notes"], **report["metrics"]},
    }
    if report["accepted"] or export_rejected:
        types = _room_types(cons)
        walls = carve_doors(region["walls"], sg["openings"], cx0, cy0, t_med)

        def to_sheet(pt):
            return {"x": pt["x"] + cx0, "y": pt["y"] + cy0}
        plan["walls"] = [{**w, "start": to_sheet(w["start"]), "end": to_sheet(w["end"])}
                         for w in walls]
        plan["rooms"] = [{"id": f'room_{r["label"]}',
                          **({"type": types[r["label"]]} if r["label"] in types else {}),
                          "polygon": [to_sheet(p) for p in r["polygon"]],
                          "area_px": r["area_px"]} for r in region["rooms"]]
        plan["fixtures"] = copy.deepcopy(fixtures)
        if close_gaps:
            # Our rooms-first output is closed by construction, so this is
            # normally a no-op; it is the same pass every frontend consumer runs.
            # normalize_plan is skipped on purpose: this export is already
            # canonical schema 2.0 (px thickness), and its idempotency marker
            # would leak into the response.
            plan_ops.close_wall_gaps(plan, enabled=True)
    return plan, lines, {"t_med": t_med, **m1, "components_after_close": m2["components_after_close"],
                         "n_seals_suspicious": m2["n_seals_suspicious"], **m3}
