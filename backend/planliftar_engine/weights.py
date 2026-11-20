"""Weight + third-party source fetching, cached under backend/weights/ (gitignored).

Replicates the notebooks' download methods:

  MitUNet   planliftar-geometry-v2 cell 0: plain HTTPS GET from GitHub's LFS
            media host (no git-lfs needed).
  CubiCasa  planliftar-cubicasa cell 0: `git clone CubiCasa5k` for the
            floortrans code + `gdown <id>` for the checkpoint. Here the code
            comes from the GitHub archive zip pinned to a commit (no git
            dependency), and the checkpoint from the same pinned Drive id.

Every file is sha256-verified before every load; a mismatch deletes the file
and raises. The CubiCasa checkpoint is a pickle (the notebook loads it with
weights_only=False); the engine loads it with weights_only=True (works on
torch >= 2.6), and the hash pin is a second line of defence.

Override the cache directory with the PLANLIFTAR_WEIGHTS_DIR env var.
"""
from __future__ import annotations

import hashlib
import io
import os
import shutil
import urllib.request
import zipfile
from pathlib import Path

from .errors import WeightsError

WEIGHTS_DIR = Path(os.environ.get(
    "PLANLIFTAR_WEIGHTS_DIR", Path(__file__).resolve().parent.parent / "weights"))

MITUNET_FILE = "MitUNet_cubicasa-5k_a62_mit_b4_tversky_7666_30E.pth"
MITUNET_URL = ("https://media.githubusercontent.com/media/aliasstudio/mitunet/master/"
               "experiments/models/" + MITUNET_FILE)
MITUNET_SHA256 = "24afed0aeee2ab30eb25fa66e08a048a28ebbf5b17e45138844c160ef92cb3ee"

CUBICASA_FILE = "model_best_val_loss_var.pkl"
CUBICASA_GDRIVE_ID = "1gRB7ez1e4H7a9Y09lLqRuna0luZO5VRK"
CUBICASA_SHA256 = "dd20b4e1bf1d670f2125107b079df06958b1ccd36e49a464ab739aeb00b8e7a2"

CUBICASA_COMMIT = "c34440266665a11f4484eb06cd2e4b7d72ad76c1"   # master, 2019-05-24
CUBICASA_ZIP_URL = f"https://github.com/CubiCasa/CubiCasa5k/archive/{CUBICASA_COMMIT}.zip"
CUBICASA_SRC_DIR = "cubicasa5k_src"
# The only floortrans files the engine imports (model_1427 is imported by
# hg_furukawa_original at module level, though its weights are never used).
_CUBICASA_NEEDED = ("floortrans/__init__.py", "floortrans/models/__init__.py",
                    "floortrans/models/hg_furukawa_original.py",
                    "floortrans/models/model_1427.py", "floortrans/post_prosessing.py")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _verify(path: Path, expected: str) -> None:
    got = _sha256(path)
    if got != expected:
        path.unlink(missing_ok=True)
        raise WeightsError(f"{path.name}: sha256 mismatch (got {got}, expected {expected}); "
                           "file deleted - re-run to download again")


def _http_get(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "planliftar-engine"})
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f, 1 << 20)
        tmp.replace(dest)
    except Exception as e:  # network, HTTP, disk
        tmp.unlink(missing_ok=True)
        raise WeightsError(f"download failed: {url}: {e}") from e


def mitunet_weights(download: bool = True) -> Path:
    """Path to the verified MitUNet checkpoint (state_dict only, ~257 MB)."""
    p = WEIGHTS_DIR / MITUNET_FILE
    if not p.exists():
        if not download:
            raise WeightsError(f"missing {p} (download disabled)")
        WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
        _http_get(MITUNET_URL, p)
        if p.stat().st_size < 1_000_000:   # LFS pointer / HTML error page
            p.unlink()
            raise WeightsError("MitUNet download returned a tiny file (LFS quota or pointer?)")
    _verify(p, MITUNET_SHA256)
    return p


def cubicasa_weights(download: bool = True) -> Path:
    """Path to the verified CubiCasa5k checkpoint (~209 MB pickle)."""
    p = WEIGHTS_DIR / CUBICASA_FILE
    if not p.exists():
        if not download:
            raise WeightsError(f"missing {p} (download disabled)")
        try:
            import gdown  # noqa: F401
        except ImportError as e:
            raise WeightsError("CubiCasa checkpoint needs `pip install gdown` to download "
                               "(Google Drive)") from e
        import gdown
        WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
        out = gdown.download(id=CUBICASA_GDRIVE_ID, output=str(p), quiet=True)
        if not out or not p.exists():
            raise WeightsError("gdown failed for the CubiCasa checkpoint "
                               "(Drive quota exceeded? retry later)")
    _verify(p, CUBICASA_SHA256)
    return p


def cubicasa_source(download: bool = True) -> Path:
    """Directory containing the `floortrans` package from CubiCasa5k@CUBICASA_COMMIT."""
    root = WEIGHTS_DIR / CUBICASA_SRC_DIR
    if all((root / f).exists() for f in _CUBICASA_NEEDED):
        return root
    if not download:
        raise WeightsError(f"missing CubiCasa5k source at {root} (download disabled)")
    buf = io.BytesIO()
    try:
        req = urllib.request.Request(CUBICASA_ZIP_URL, headers={"User-Agent": "planliftar-engine"})
        with urllib.request.urlopen(req, timeout=120) as r:
            shutil.copyfileobj(r, buf)
    except Exception as e:
        raise WeightsError(f"download failed: {CUBICASA_ZIP_URL}: {e}") from e
    prefix = f"CubiCasa5k-{CUBICASA_COMMIT}/"
    with zipfile.ZipFile(buf) as z:
        for rel in _CUBICASA_NEEDED:
            dest = root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(z.read(prefix + rel))
    return root


def ensure_all(cubicasa: bool = True) -> dict:
    """Download/verify everything up front (e.g. at server start). Returns paths."""
    out = {"mitunet": str(mitunet_weights())}
    if cubicasa:
        out["cubicasa"] = str(cubicasa_weights())
        out["cubicasa_src"] = str(cubicasa_source())
    return out
