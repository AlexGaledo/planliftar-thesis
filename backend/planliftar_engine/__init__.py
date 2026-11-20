"""planliftar_engine - local inference for PlanLiftAR (no Kaggle needed).

Reproduces planliftar-cubicasa + planliftar-geometry-v2 notebooks (with the
newer local/consensus_lab.py geometry) as a plain Python package:

    image bytes
      -> MitUNet wall probability map (512x512 net, auto-crop second pass)
      -> CubiCasa5k walls/openings/rooms (optional hint source)
      -> hysteresis + micro-gap seal + CubiCasa seals (labeling only)
      -> rooms-first regions -> derived wall runs -> consensus + acceptance
      -> door carving -> plan_ops gap closure -> schema-2.0 JSON

    from planliftar_engine import run_pipeline
    plan = run_pipeline(open("plan.png", "rb").read(), {"use_cubicasa": True})

CLI:  python -m planliftar_engine plan.png -o out.json [--no-cubicasa] [--cpu]

See pipeline.run_pipeline for the full input/output/error contract.
"""
__version__ = "0.1.0"

from .errors import EngineError, InferenceError, InputError, WeightsError  # noqa: E402
from .pipeline import PipelineOptions, run_pipeline  # noqa: E402
from .weights import ensure_all  # noqa: E402

__all__ = ["run_pipeline", "PipelineOptions", "ensure_all", "EngineError", "InputError",
           "WeightsError", "InferenceError", "__version__"]
