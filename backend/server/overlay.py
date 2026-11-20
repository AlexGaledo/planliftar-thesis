"""Debug overlay: the plan's rooms, walls and fixtures drawn over the input image.

The engine does not emit an overlay image, so the server renders one from the
result (cheap, ~0.2 s) right after a job finishes and keeps only the PNG.
"""
from __future__ import annotations

import io

MAX_SIDE = 1600
_ROOM_COLOURS = [(19, 128, 75), (161, 92, 0), (40, 90, 200), (150, 40, 150),
                 (0, 130, 140), (190, 60, 60), (90, 90, 90)]


def _xy(p):
    if isinstance(p, dict):
        return float(p["x"]), float(p["y"])
    return float(p[0]), float(p[1])


def render_overlay(image: bytes, plan: dict) -> bytes | None:
    from PIL import Image, ImageDraw, ImageOps
    if not plan.get("walls") and not plan.get("rooms"):
        return None
    with Image.open(io.BytesIO(image)) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
    src = plan.get("source", {})
    pw, ph = src.get("image_width_px"), src.get("image_height_px")
    if pw and ph and (pw, ph) != im.size:
        im = im.resize((int(pw), int(ph)))        # plan frame (engine may downscale)
    s = min(1.0, MAX_SIDE / max(im.size))
    if s < 1.0:
        im = im.resize((round(im.width * s), round(im.height * s)))
    base = Image.blend(im, Image.new("RGB", im.size, (255, 255, 255)), 0.45).convert("RGBA")
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i, room in enumerate(plan.get("rooms", [])):
        pts = [(x * s, y * s) for x, y in map(_xy, room.get("polygon", []))]
        if len(pts) >= 3:
            r, g, b = _ROOM_COLOURS[i % len(_ROOM_COLOURS)]
            d.polygon(pts, fill=(r, g, b, 70), outline=(r, g, b, 200))
    for w in plan.get("walls", []):
        (x0, y0), (x1, y1) = _xy(w["start"]), _xy(w["end"])
        t = w.get("thickness", w.get("thickness_px", 6)) or 6
        colour = (161, 92, 0, 230) if w.get("generated") else (0, 0, 0, 230)
        d.line([(x0 * s, y0 * s), (x1 * s, y1 * s)], fill=colour, width=max(2, round(t * s)))
    for f in plan.get("fixtures", []):
        x, y = _xy(f["position"])
        r = 6
        colour = (40, 90, 200, 255) if f.get("type") == "window" else (190, 60, 60, 255)
        d.ellipse([x * s - r, y * s - r, x * s + r, y * s + r], fill=colour)
    out = io.BytesIO()
    Image.alpha_composite(base, layer).convert("RGB").save(out, "PNG", optimize=False)
    return out.getvalue()
