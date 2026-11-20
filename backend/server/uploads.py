"""Upload and options validation for POST /api/jobs (docs/API.md status codes)."""
from __future__ import annotations

import io
import json
import warnings


class UploadRejected(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


ALLOWED_TYPES = {"image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg",
                 "image/webp": "webp"}
MIN_SIDE = 64


def sniff(data: bytes) -> str | None:
    """Format from magic bytes: 'png' | 'jpeg' | 'webp' | None."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def validate_image(data: bytes, declared_type: str | None, max_bytes: int,
                   max_pixels: int) -> tuple[str, tuple[int, int]]:
    """Return (format, (w, h)) or raise UploadRejected(400|413|415).

    Order: empty -> 400, size -> 413, declared type / magic bytes -> 415,
    pixel count (decompression bomb) -> 413, full Pillow decode -> 400.
    """
    if not data:
        raise UploadRejected(400, "the image file is empty")
    if len(data) > max_bytes:
        raise UploadRejected(413, f"image is larger than {max_bytes // (1024 * 1024)} MB")
    declared = (declared_type or "").split(";")[0].strip().lower()
    if declared and declared not in ALLOWED_TYPES and declared != "application/octet-stream":
        raise UploadRejected(415, f"unsupported image type {declared!r}; "
                                  "send image/png, image/jpeg or image/webp")
    fmt = sniff(data)
    if fmt is None:
        raise UploadRejected(415, "file is not a PNG, JPEG or WebP image")

    from PIL import Image
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as im:
                w, h = im.size
                if w * h > max_pixels:
                    raise UploadRejected(413, f"image has {w}x{h} = {w * h} pixels; "
                                              f"the limit is {max_pixels}")
                if (im.format or "").lower() != fmt:
                    raise UploadRejected(400, "image contents do not match its format")
                im.load()     # full decode: catches truncated/corrupt files
    except UploadRejected:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise UploadRejected(413, "image has too many pixels")
    except Exception as e:
        raise UploadRejected(400, f"image could not be decoded: {type(e).__name__}") from e
    if min(w, h) < MIN_SIDE:
        raise UploadRejected(400, f"image is too small ({w}x{h}); need at least "
                                  f"{MIN_SIDE} px per side")
    return fmt, (w, h)


# Job options accepted from clients -> engine PipelineOptions fields.
PRESETS = {
    "full": {"use_cubicasa": True},     # MitUNet + CubiCasa, ~45-65 s on the dev GPU
    "fast": {"use_cubicasa": False},    # MitUNet only (engine --no-cubicasa), ~4 s
}
_BOOL_OPTIONS = ("use_cubicasa", "mitunet_tta", "export_rejected")


def parse_options(raw: str | None) -> dict:
    """options JSON string -> engine options dict, or UploadRejected(400).

    {"use_cubicasa": bool}       default true (docs/API.md)
    {"preset": "fast"|"full"}    fast = MitUNet only; an explicit use_cubicasa wins
    {"mitunet_tta": bool, "export_rejected": bool}
    Unknown keys are ignored so newer clients keep working.
    """
    opts: dict = {"use_cubicasa": True}
    if raw is None or raw.strip() == "":
        return opts
    try:
        data = json.loads(raw)
    except ValueError:
        raise UploadRejected(400, "options is not valid JSON")
    if not isinstance(data, dict):
        raise UploadRejected(400, "options must be a JSON object")
    preset = data.get("preset")
    if preset is not None:
        if preset not in PRESETS:
            raise UploadRejected(400, f"unknown preset {preset!r}; use one of {sorted(PRESETS)}")
        opts.update(PRESETS[preset])
    for key in _BOOL_OPTIONS:
        if key in data:
            if not isinstance(data[key], bool):
                raise UploadRejected(400, f"options.{key} must be true or false")
            opts[key] = data[key]
    return opts
