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


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
