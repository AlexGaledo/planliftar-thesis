"""MitUNet wall segmentation (planliftar-geometry-v2 cells 1-2).

Model: smp.Unet(mit_b4, scSE decoder) with the encoder transplanted from an
smp.Segformer - exactly how the aliasstudio/mitunet repo assembles it, so the
checkpoint's keys line up. Inference: resize to 512x512, ImageNet normalise,
sigmoid, bilinear resize back to the input size (probability map is KEPT -
every downstream threshold reads it). Auto-crop second pass when the plan is
a sub-region of a large sheet.

VRAM: the network always sees 512x512, so peak use is ~0.6 GB fp32 regardless
of upload size; the 4 GB RTX 3050 has plenty of headroom. fp16 autocast is
available (opt-in) but not the default, because fp32 reproduces the notebook.
"""
from __future__ import annotations

import threading

import cv2
import numpy as np
import torch

from .weights import mitunet_weights

_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
_STD = np.array([0.229, 0.224, 0.225], np.float32)
INPUT_SIZE = 512

_cache: dict = {}
_lock = threading.Lock()


def load_model(device: str):
    """Build + load MitUNet once per device (cached; thread-safe)."""
    with _lock:
        if device in _cache:
            return _cache[device]
        import segmentation_models_pytorch as smp
        aux = smp.Segformer(encoder_name="mit_b4", encoder_weights=None)
        model = smp.Unet(encoder_name="mit_b4", encoder_weights=None, in_channels=3,
                         classes=1, decoder_attention_type="scse")
        model.encoder = aux.encoder
        sd = torch.load(mitunet_weights(), map_location="cpu", weights_only=True)
        model.load_state_dict(sd)
        model.to(device).eval()
        _cache[device] = model
        return model


def _to_tensor(img_rgb: np.ndarray) -> torch.Tensor:
    # albumentations A.Resize(512,512) == cv2.resize INTER_LINEAR; A.Normalize
    # divides by 255 then (x-mean)/std. Done with cv2/numpy to drop the dependency.
    x = cv2.resize(img_rgb, (INPUT_SIZE, INPUT_SIZE), interpolation=cv2.INTER_LINEAR)
    x = (x.astype(np.float32) / 255.0 - _MEAN) / _STD
    return torch.from_numpy(x.transpose(2, 0, 1)).unsqueeze(0)


def infer(model, img_rgb: np.ndarray, device: str, fp16: bool = False,
          tta: bool = False) -> np.ndarray:
    """Wall probability map (float32, same HxW as img_rgb, values 0..1).

    tta=True averages the identity pass with a horizontal + vertical flip pass
    (flip-invariant task; ~3x cost, still <1 s on GPU).
    """
    inp = _to_tensor(img_rgb).to(device)
    batch = [inp]
    if tta:
        batch += [torch.flip(inp, dims=[3]), torch.flip(inp, dims=[2])]
    x = torch.cat(batch, 0)
    with torch.inference_mode():
        if fp16 and device.startswith("cuda"):
            with torch.autocast("cuda", dtype=torch.float16):
                logits = model(x)
        else:
            logits = model(x)
        p = torch.sigmoid(logits.float())[:, 0]
        if tta:
            p = torch.stack([p[0], torch.flip(p[1], dims=[1]), torch.flip(p[2], dims=[0])]).mean(0)
        else:
            p = p[0]
    p = p.cpu().numpy()
    return cv2.resize(p, (img_rgb.shape[1], img_rgb.shape[0]), interpolation=cv2.INTER_LINEAR)


def infer_with_autocrop(model, image_rgb_full: np.ndarray, device: str, fp16: bool = False,
                        tta: bool = False, autocrop: bool = True):
    """Notebook cell 2: whole-sheet pass, then re-infer on the plan's bbox if the
    plan covers < 50% of the sheet. Returns (prob, image_rgb_crop, (cx0, cy0), info)."""
    Hf, Wf = image_rgb_full.shape[:2]
    prob1 = infer(model, image_rgb_full, device, fp16, tta)
    ys, xs = np.nonzero(prob1 > 0.3)
    if not autocrop or len(xs) == 0:
        return prob1, image_rgb_full, (0, 0), {"autocrop": False, "reason":
                                                "disabled" if not autocrop else "no wall pixels"}
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    mw, mh = int(0.08 * (x1 - x0)), int(0.08 * (y1 - y0))
    cx0, cy0 = max(0, x0 - mw), max(0, y0 - mh)
    cx1, cy1 = min(Wf, x1 + mw), min(Hf, y1 + mh)
    if (cx1 - cx0) * (cy1 - cy0) < 0.5 * Hf * Wf:
        crop = image_rgb_full[cy0:cy1, cx0:cx1]
        return (infer(model, crop, device, fp16, tta), crop, (int(cx0), int(cy0)),
                {"autocrop": True, "crop": [int(cx0), int(cy0), int(cx1), int(cy1)]})
    return prob1, image_rgb_full, (0, 0), {"autocrop": False, "reason": "plan fills sheet"}
