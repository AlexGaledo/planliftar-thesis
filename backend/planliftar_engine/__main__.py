"""CLI: python -m planliftar_engine <image> -o out.json"""
from __future__ import annotations

import argparse
import json
import sys

from . import EngineError, PipelineOptions, ensure_all, run_pipeline


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m planliftar_engine",
                                 description="Floor plan image -> PlanLiftAR plan JSON")
    ap.add_argument("image", nargs="?", help="input image (png/jpg/...)")
    ap.add_argument("-o", "--out", help="output JSON path (default: stdout)")
    ap.add_argument("--no-cubicasa", action="store_true", help="MitUNet-only path")
    ap.add_argument("--cpu", action="store_true", help="force CPU")
    ap.add_argument("--tta", action="store_true", help="flip TTA for MitUNet")
    ap.add_argument("--fp16", action="store_true", help="fp16 autocast for MitUNet too")
    ap.add_argument("--cubicasa-max-side", type=int, default=PipelineOptions.cubicasa_max_side)
    ap.add_argument("--no-autocrop", action="store_true")
    ap.add_argument("--no-gap-closure", action="store_true")
    ap.add_argument("--export-rejected", action="store_true")
    ap.add_argument("--debug", action="store_true", help="include stage log in the JSON")
    ap.add_argument("--download-only", action="store_true",
                    help="fetch + verify weights, then exit")
    a = ap.parse_args(argv)

    try:
        if a.download_only:
            print(json.dumps(ensure_all(cubicasa=not a.no_cubicasa), indent=2))
            return 0
        if not a.image:
            ap.error("image is required")
        with open(a.image, "rb") as f:
            data = f.read()
        opts = PipelineOptions(
            use_cubicasa=not a.no_cubicasa, device="cpu" if a.cpu else "auto",
            mitunet_fp16=a.fp16, mitunet_tta=a.tta, cubicasa_max_side=a.cubicasa_max_side,
            autocrop=not a.no_autocrop, close_gaps=not a.no_gap_closure,
            export_rejected=a.export_rejected, include_debug=a.debug)
        plan = run_pipeline(data, opts)
    except EngineError as e:
        print(f"error [{e.code}]: {e}", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    text = json.dumps(plan, indent=1)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
        acc, eng = plan["acceptance"], plan["engine"]
        print(f"{a.out}: accepted={acc['accepted']} walls={len(plan['walls'])} "
              f"rooms={len(plan['rooms'])} fixtures={len(plan['fixtures'])} "
              f"mode={eng['mode']} total={eng['total_s']}s timings={eng['timings_s']}",
              file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
