"""One-off: turn ambientCG 1K-JPG downloads into the bundled "home" theme maps.

    python -I scripts/textures/prepare_photo_textures.py <unzipped-dir> public/textures

<unzipped-dir> holds one folder per asset id (e.g. Plaster001/), each the
unzipped https://ambientcg.com/get?file=<id>_1K-JPG.zip. Writes one 512 px
JPEG q80 colour map per set, <name>_color.jpg (no roughness / normal maps: the
GLB, AR and the viewer all use colour maps only).
All assets are CC0 1.0 (https://docs.ambientcg.com/license/); see CREDITS.txt.
Needs Pillow and NumPy.

The wall map is reprocessed (docs/research/bakeoff/DECISION.md fix W1):
Plaster001's low-frequency blotches tile into a visible grid, so they are
removed with a high-pass (minus a Gaussian blur, plus the mean), the remaining
contrast is halved and the mean is moved to an off-white (#ecebe7).
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

# name -> (asset id, rotate 90 deg?, wall-style reprocess?)
SETS = {
    "plaster": ("Plaster001", False, True),  # walls (W1)
    "door": ("Wood049", True, False),  # grain turned vertical for door leaves
    "wood": ("WoodFloor051", False, False),  # dry-room floors
    "tile": ("Tiles139", False, False),  # kitchen + bathroom floors (W4: 33 cm tiles)
    "concrete": ("Concrete034", False, False),  # garage/storage floors + slab
}
SIZE = 512
QUALITY = 80

# W1 parameters (at 512 px)
WALL_BLUR_RADIUS = 48
WALL_CONTRAST = 0.5
WALL_MEAN = (0xEC, 0xEB, 0xE7)


def flatten_wall(im: Image.Image) -> Image.Image:
    """High-pass + reduced contrast + off-white mean, keeping the fine tooth.

    The blur wraps around (the image is tiled 3x3 first), so the output stays
    seamless like its source.
    """
    w, h = im.size
    tiled = Image.new("RGB", (3 * w, 3 * h))
    for i in range(3):
        for j in range(3):
            tiled.paste(im, (i * w, j * h))
    blur = tiled.filter(ImageFilter.GaussianBlur(WALL_BLUR_RADIUS)).crop((w, h, 2 * w, 2 * h))
    a = np.asarray(im, dtype=np.float32)
    b = np.asarray(blur, dtype=np.float32)
    # Detail in luminance only: the tint comes from WALL_MEAN, not the photo.
    detail = (a - b).mean(axis=2, keepdims=True) * WALL_CONTRAST
    out = np.clip(np.array(WALL_MEAN, dtype=np.float32) + detail, 0, 255)
    return Image.fromarray(out.astype(np.uint8))


def convert(src: str, dst: str, rotate: bool, wall: bool) -> None:
    im = Image.open(src).convert("RGB")
    if rotate:
        im = im.transpose(Image.Transpose.ROTATE_90)
    w, h = im.size
    # keep the aspect ratio (Concrete034 is 2:1); the longest side becomes 512
    s = SIZE / max(w, h)
    im = im.resize((round(w * s), round(h * s)), Image.Resampling.LANCZOS)
    if wall:
        im = flatten_wall(im)
    im.save(dst, "JPEG", quality=QUALITY, optimize=True, progressive=False)
    print(f"{os.path.basename(dst)}: {im.size[0]}x{im.size[1]}, {os.path.getsize(dst)} B")


def main() -> None:
    src_root, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for name, (asset, rotate, wall) in SETS.items():
        base = os.path.join(src_root, asset, f"{asset}_1K-JPG_")
        convert(base + "Color.jpg", os.path.join(out, f"{name}_color.jpg"), rotate, wall)


if __name__ == "__main__":
    main()
