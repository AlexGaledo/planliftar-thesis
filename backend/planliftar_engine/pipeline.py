"""run_pipeline(image_bytes, options) -> plan dict. See package docstring."""
from __future__ import annotations

import io
import threading
import time
from dataclasses import dataclass, field, asdict
from typing import Callable, Optional

import numpy as np

from .errors import EngineError, InferenceError, InputError, WeightsError

MIN_SIDE = 64
MAX_PIXELS = 40_000_000          # decompression-bomb guard (~6300x6300)
CUBICASA_OOM_FALLBACK_SIDE = 2048

# One inference at a time per process: the 4 GB GPU and 16 GB of RAM hold one
# pipeline comfortably, not two. Callers (the HTTP layer) should queue jobs.
_run_lock = threading.Lock()


@dataclass
class PipelineOptions:
    """All fields optional. Defaults reproduce the notebook / consensus_lab run.

    use_cubicasa     run the CubiCasa5k net for seals, consensus, doors/windows.
                     False -> MitUNet-only path (faster, no fixtures, no door
                     carving, consensus reported as null, note "mitunet_only").
    device           "auto" | "cuda" | "cpu". auto = cuda if available.
    mitunet_fp16     autocast fp16 for MitUNet (off: fp32 matches the notebook).
    mitunet_tta      flip test-time augmentation for MitUNet (3 passes, averaged).
    cubicasa_precision  "fp32" | "bf16" | "fp16" for the CubiCasa net on CUDA.
                     fp16 overflows (NaN heatmaps) - never use it; it is only
                     kept so the failure is reproducible.
    cubicasa_max_side  longest side fed to the CubiCasa net (logits are upsampled
                     back before post-processing). 0 = always native. Default
                     2730 = native for the CubiCasa sheets the notebook used
                     (peak 3.8 GB VRAM); on CUDA OOM it retries at 2048 px.
                     Resolution matters: 1600/2048/2400/native gave 40/56/63/90
                     CubiCasa walls on the 10052 sample (notebook: 109).
    max_image_side   uploads larger than this (longest side, px) are downscaled
                     first; output coords are in the DOWNSCALED frame and
                     source.input_scale records the factor.
    autocrop         notebook's second pass on the plan's bbox for big sheets.
    close_gaps       run plan_ops.close_wall_gaps on the export.
    export_rejected  include geometry even when the acceptance barrier rejects.
    include_debug    add "debug": {log lines, stage metrics} to the result.
    cfg              overrides for consensus_lab.CFG keys (e.g. {"HYST_LOW": 0.2}).
    """
    use_cubicasa: bool = True
    device: str = "auto"
    mitunet_fp16: bool = False
    mitunet_tta: bool = False
    cubicasa_precision: str = "fp32"
    cubicasa_max_side: int = 2730
    max_image_side: int = 4096
    autocrop: bool = True
    close_gaps: bool = True
    export_rejected: bool = False
    include_debug: bool = False
    cfg: dict = field(default_factory=dict)


def _device(pref: str) -> str:
    import torch
    if pref == "cpu":
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if pref == "cuda":
        raise InferenceError("device='cuda' requested but CUDA is not available")
    return "cpu"


def decode_image(image_bytes: bytes, max_side: int):
    """bytes -> (RGB uint8 HxWx3, scale). Applies EXIF orientation (phone photos)."""
    from PIL import Image, ImageOps
    if not image_bytes:
        raise InputError("empty upload")
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        im = Image.open(io.BytesIO(image_bytes))
        # Image.open reads only the header. Enforce the cap here: Pillow merely
        # warns (no error) between 1x and 2x MAX_IMAGE_PIXELS.
        if im.size[0] * im.size[1] > MAX_PIXELS:
            raise Image.DecompressionBombError(f"{im.size[0]}x{im.size[1]}")
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))   # transparent -> white paper
            im = Image.alpha_composite(bg, im)
        im = im.convert("RGB")
    except Image.DecompressionBombError as e:
        raise InputError(f"image too large (> {MAX_PIXELS} px)") from e
    except Exception as e:
        raise InputError(f"not a decodable image: {e}") from e
    w, h = im.size
    if min(w, h) < MIN_SIDE:
        raise InputError(f"image too small ({w}x{h}); need >= {MIN_SIDE}px per side")
    scale = 1.0
    if max_side and max(w, h) > max_side:
        scale = max_side / max(w, h)
        im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    return np.asarray(im), scale


def _with_cpu_fallback(fn, device, timings, key):
    """Run fn(device); on CUDA OOM free memory and retry once on CPU."""
    import torch
    t = time.perf_counter()
    try:
        out = fn(device)
        used = device
    except torch.cuda.OutOfMemoryError:
        if device == "cpu":
            raise
        torch.cuda.empty_cache()
        out = fn("cpu")
        used = "cpu (cuda OOM fallback)"
    timings[key] = round(time.perf_counter() - t, 3)
    return out, used


ProgressCallback = Callable[[str, float], None]

# Stage labels reported through progress_cb (shown verbatim by the app).
STAGE_DECODE = "decoding image"
STAGE_MITUNET = "segmenting walls (MitUNet)"
STAGE_CUBICASA = "detecting rooms, doors and windows (CubiCasa)"
STAGE_CUBICASA_POST = "post-processing CubiCasa output"
STAGE_GEOMETRY = "building walls and rooms"
STAGE_DONE = "done"


def _notify(cb: Optional[ProgressCallback], stage: str, progress: float) -> None:
    """Call progress_cb, never letting a broken callback fail the pipeline."""
    if cb is None:
        return
    try:
        cb(stage, progress)
    except Exception:
        pass


def run_pipeline(image_bytes: bytes, options: PipelineOptions | dict | None = None,
                 progress_cb: Optional[ProgressCallback] = None) -> dict:
    """Floor plan image -> PlanLiftAR schema-2.0 plan dict.

    Input
        image_bytes  PNG/JPEG/WebP/BMP/TIFF bytes (phone photos OK: EXIF rotation
                     is honoured). Min 64 px per side; >4096 px is downscaled.
        options      PipelineOptions or a dict of its fields (unknown keys -> InputError).
        progress_cb  optional callable(stage: str, progress: float in 0..1), called
                     at the start of each stage (labels: STAGE_* above) and with
                     ("done", 1.0) on success. Exceptions it raises are ignored.

    Output (same schema as deliverables/livemap/floorplan.json):
        {"schema_version": "2.0",
         "source": {"image_width_px", "image_height_px", "input_scale"},
         "scale": {"units": "relative_px", "user_scale_required": true},
         "walls":   [{id, start:{x,y}, end:{x,y}, thickness (px), between, exterior,
                      [generated, reason]}],
         "rooms":   [{id, [type], polygon:[{x,y}], area_px}],
         "fixtures":[{id, type: door|window, position:{x,y}, scale, rotation_degrees}],
         "acceptance": {accepted, reject_reasons, notes, rooms_mitunet, rooms_cubicasa,
                        consensus_iou, ..., wall_thickness_px, crop_offset},
         "gap_fill": {...plan_ops report...},
         "engine": {version, device, mode, timings_s: {...}, total_s}}
        All coordinates are pixels of the (possibly downscaled) input image.
        A rejected plan has empty walls/rooms/fixtures (unless export_rejected).

    Timing (2730x2048 CubiCasa sample, RTX 3050 Laptop 4 GB, i.e. this repo's dev box,
    measured while other jobs shared the machine, so treat as rough):
        warm, mitunet+cubicasa (GPU)   ~45-65 s  (MitUNet ~1 s, CubiCasa net 4-22 s,
                                       CubiCasa post-processing ~25 s CPU, geometry 5-8 s)
        warm, MitUNet-only (GPU)       ~4 s      (+TTA ~6 s)
        CPU only, MitUNet-only         ~11 s;  CPU full @ cubicasa_max_side=1600 ~36 s
        first call adds model load + sha256 checks (~10-60 s), plus a one-off
        ~470 MB weight download if backend/weights/ is empty.
    Peak VRAM ~4.1 GB allocated at native CubiCasa res (both models resident);
    use cubicasa_max_side=2400 (~3.2 GB) if the GPU is shared.

    Errors (all subclass EngineError, each with a stable .code):
        InputError      bad/empty/undecodable/too-small/too-large image, bad options
        WeightsError    download failed / sha256 mismatch
        InferenceError  model failure (CUDA OOM is retried on CPU first)
        EngineError     geometry stage failed (e.g. no walls found)
    Not thread-safe to run concurrently; calls are serialised by a lock.
    """
    from . import __version__
    if options is None:
        options = PipelineOptions()
    elif isinstance(options, dict):
        try:
            options = PipelineOptions(**options)
        except TypeError as e:
            raise InputError(f"bad options: {e}") from e

    with _run_lock:
        t0 = time.perf_counter()
        timings: dict = {}
        _notify(progress_cb, STAGE_DECODE, 0.02)
        img, in_scale = decode_image(image_bytes, options.max_image_side)
        timings["decode"] = round(time.perf_counter() - t0, 3)
        Hf, Wf = img.shape[:2]
        device = _device(options.device)

        from . import mitunet
        _notify(progress_cb, STAGE_MITUNET, 0.05)
        try:
            def _mit(dev):
                model = mitunet.load_model(dev)
                return mitunet.infer_with_autocrop(model, img, dev, options.mitunet_fp16,
                                                   options.mitunet_tta, options.autocrop)
            (prob, _crop, (cx0, cy0), crop_info), mit_dev = _with_cpu_fallback(
                _mit, device, timings, "mitunet")
        except EngineError:
            raise
        except Exception as e:
            raise InferenceError(f"MitUNet inference failed: {e}") from e

        if device == "cuda":
            # Hand MitUNet's cached activation blocks back before CubiCasa's
            # ~3.8 GB native pass; on a 4 GB card the Windows driver otherwise
            # spills to shared system memory and the pass gets ~3x slower.
            import torch
            torch.cuda.empty_cache()

        sg = rf = None
        cubi_dev = None
        cubi_error = None
        if options.use_cubicasa:
            from . import cubicasa
            _notify(progress_cb, STAGE_CUBICASA, 0.15)
            try:
                def _cc(dev):
                    import torch
                    model = cubicasa.load_model(dev)
                    try:
                        return cubicasa.predict(model, img, dev, options.cubicasa_max_side,
                                                options.cubicasa_precision)
                    except torch.cuda.OutOfMemoryError:
                        # Native res peaks at ~3.8 GB on a 2730x2048 sheet; if
                        # something else holds VRAM, a 2048 px pass (~2.2 GB)
                        # still beats falling back to the CPU.
                        fb = CUBICASA_OOM_FALLBACK_SIDE
                        if dev == "cpu" or (options.cubicasa_max_side
                                            and options.cubicasa_max_side <= fb):
                            raise
                        torch.cuda.empty_cache()
                        timings["cubicasa_oom_downscaled_to"] = fb
                        return cubicasa.predict(model, img, dev, fb, options.cubicasa_precision)
                pred, cubi_dev = _with_cpu_fallback(_cc, device, timings, "cubicasa_net")
                _notify(progress_cb, STAGE_CUBICASA_POST, 0.4)
                t = time.perf_counter()
                sg, rf = cubicasa.postprocess(pred, (Hf, Wf))
                del pred
                timings["cubicasa_post"] = round(time.perf_counter() - t, 3)
            except WeightsError:
                raise
            except Exception as e:   # CubiCasa is a hint source: degrade, don't fail
                cubi_error = f"{type(e).__name__}: {e}"
                sg = rf = None

        from . import geometry
        _notify(progress_cb, STAGE_GEOMETRY, 0.8 if options.use_cubicasa else 0.3)
        t = time.perf_counter()
        try:
            plan, lines, metrics = geometry.build_plan(
                prob, (cx0, cy0), (Wf, Hf), sg, rf, options.cfg,
                close_gaps=options.close_gaps, export_rejected=options.export_rejected)
        except ValueError as e:
            raise EngineError(f"geometry failed: {e}") from e
        timings["geometry"] = round(time.perf_counter() - t, 3)

        plan["source"]["input_scale"] = round(in_scale, 6)
        if cubi_error:
            plan["acceptance"]["notes"].append("cubicasa_failed")
        plan["engine"] = {
            "version": __version__,
            "device": {"mitunet": mit_dev, "cubicasa": cubi_dev},
            "mode": "mitunet+cubicasa" if sg is not None else "mitunet_only",
            "crop": crop_info,
            "timings_s": timings,
            "total_s": round(time.perf_counter() - t0, 3),
        }
        if cubi_error:
            plan["engine"]["cubicasa_error"] = cubi_error
        if options.include_debug:
            plan["debug"] = {"log": lines, "metrics": metrics, "options": asdict(options)}
        _notify(progress_cb, STAGE_DONE, 1.0)
        return plan
