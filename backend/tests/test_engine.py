"""planliftar_engine tests.

    cd backend && python -m pytest tests -q          (or: python tests/test_engine.py)

Fast tests need no weights. The end-to-end test runs only when the sample
image and MitUNet weights are already cached (it never downloads).
"""
from __future__ import annotations

import filecmp
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent
sys.path.insert(0, str(BACKEND))

from planliftar_engine import InputError, PipelineOptions, run_pipeline  # noqa: E402
from planliftar_engine import weights  # noqa: E402
from planliftar_engine.pipeline import to_full_frame  # noqa: E402

import pytest  # noqa: E402

SAMPLE = BACKEND / "samples" / "cubicasa_10052_F1_original.png"


def test_vendored_copies_match_sources():
    """_vendor/ must stay byte-identical to the files it copies; re-copy on change."""
    pairs = [(REPO / "local" / "consensus_lab.py", "consensus_lab.py"),
             (REPO / "deliverables" / "plan_ops.py", "plan_ops.py")]
    for src, name in pairs:
        if src.exists():
            dst = BACKEND / "planliftar_engine" / "_vendor" / name
            assert filecmp.cmp(src, dst, shallow=False), \
                f"{dst} drifted from {src}: cp {src} {dst}"


def test_bad_inputs_raise_input_error():
    for bad in (b"", b"not an image", b"\x89PNG\r\n\x1a\n" + b"\0" * 20):
        try:
            run_pipeline(bad)
        except InputError:
            continue
        raise AssertionError(f"accepted {bad[:10]!r}")
    try:
        run_pipeline(b"x", {"nope": 1})
    except InputError:
        pass
    else:
        raise AssertionError("unknown option accepted")


def test_progress_cb_is_optional_and_safe():
    seen = []
    try:
        run_pipeline(b"not an image", None, progress_cb=lambda st, p: seen.append((st, p)))
    except InputError:
        pass
    assert seen == [("decoding image", 0.02)]

    def boom(stage, progress):
        raise RuntimeError("callback bug")
    try:
        run_pipeline(b"not an image", None, progress_cb=boom)   # still an InputError
    except InputError:
        pass


def test_end_to_end_mitunet_only():
    if not SAMPLE.exists() or not (weights.WEIGHTS_DIR / weights.MITUNET_FILE).exists():
        print("skip: sample/weights not cached")
        return
    seen = []
    plan = run_pipeline(SAMPLE.read_bytes(), PipelineOptions(use_cubicasa=False),
                        progress_cb=lambda st, p: seen.append((st, p)))
    progress = [p for _, p in seen]
    assert progress == sorted(progress) and seen[-1] == ("done", 1.0)
    assert plan["schema_version"] == "2.0"
    assert plan["source"]["image_width_px"] == 2730
    assert plan["acceptance"]["wall_thickness_px"] == 26.0       # == v9_out.txt t_med
    assert plan["walls"] and plan["rooms"]
    for w in plan["walls"]:
        assert set(w["start"]) == {"x", "y"} and w["thickness"] > 0
    json.dumps(plan)                                              # serialisable


def test_to_full_frame_scales_every_px_field():
    plan = {"source": {"image_width_px": 100, "image_height_px": 50},
            "walls": [{"id": "w0", "start": {"x": 10, "y": 20}, "end": {"x": 30, "y": 20},
                       "thickness": 4}],
            "rooms": [{"id": "r", "polygon": [{"x": 1, "y": 2}], "area_px": 100}],
            "fixtures": [{"id": "d", "position": {"x": 5, "y": 6},
                          "scale": {"width": 0.5, "depth": 0.1, "height": 2.1}}],
            "acceptance": {"wall_thickness_px": 4.0, "crop_offset": [2, 3]},
            "gap_fill": {"t_med": 4.0, "join": 8.0}}
    to_full_frame(plan, 0.5, (200, 100))
    assert plan["source"] == {"image_width_px": 200, "image_height_px": 100}
    assert plan["walls"][0]["start"] == {"x": 20.0, "y": 40.0}
    assert plan["walls"][0]["end"] == {"x": 60.0, "y": 40.0}
    assert plan["walls"][0]["thickness"] == 8.0
    assert plan["rooms"][0]["polygon"] == [{"x": 2.0, "y": 4.0}] and plan["rooms"][0]["area_px"] == 400
    assert plan["fixtures"][0]["position"] == {"x": 10.0, "y": 12.0}
    assert plan["fixtures"][0]["scale"]["width"] == 1.0
    assert plan["fixtures"][0]["scale"]["depth"] == 0.1
    assert plan["acceptance"]["wall_thickness_px"] == 8.0 and plan["acceptance"]["crop_offset"] == [4, 6]
    assert plan["gap_fill"] == {"t_med": 8.0, "join": 16.0}


def _bbox(plan):
    xs = [p[k] for w in plan["walls"] for p in (w["start"], w["end"]) for k in ("x",)]
    ys = [p[k] for w in plan["walls"] for p in (w["start"], w["end"]) for k in ("y",)]
    return min(xs), min(ys), max(xs), max(ys)


@pytest.mark.slow
def test_upscaled_input_returns_full_image_coordinates():
    """A >4096 px upload is analysed downscaled but answered in full-image px."""
    if not SAMPLE.exists() or not (weights.WEIGHTS_DIR / weights.MITUNET_FILE).exists():
        pytest.skip("sample/weights not cached")
    import io
    from PIL import Image
    k = 2.2
    with Image.open(SAMPLE) as im:
        big = im.convert("RGB").resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    buf = io.BytesIO()
    big.save(buf, "PNG")
    opts = PipelineOptions(use_cubicasa=False)
    ref = run_pipeline(SAMPLE.read_bytes(), opts)
    plan = run_pipeline(buf.getvalue(), opts)
    assert plan["source"]["image_width_px"] == big.width
    assert plan["source"]["image_height_px"] == big.height
    assert plan["source"]["input_scale"] == pytest.approx(4096 / big.width, abs=1e-5)
    rb, pb = _bbox(ref), _bbox(plan)
    for a, b in zip(rb, pb):                         # same plan, k x bigger
        assert b == pytest.approx(a * k, abs=0.02 * big.width)
    for w in plan["walls"]:
        for p in (w["start"], w["end"]):
            assert -1 <= p["x"] <= big.width + 1 and -1 <= p["y"] <= big.height + 1
    t_ref, t_big = ref["acceptance"]["wall_thickness_px"], plan["acceptance"]["wall_thickness_px"]
    assert t_big == pytest.approx(t_ref * k, rel=0.2)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
