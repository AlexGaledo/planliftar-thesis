"""Exception types raised by planliftar_engine. All derive from EngineError."""


class EngineError(Exception):
    """Base class. `code` is a stable machine-readable string for API responses."""
    code = "engine_error"


class InputError(EngineError):
    """The uploaded bytes are not a decodable image, or are too small/large."""
    code = "bad_input"


class WeightsError(EngineError):
    """A checkpoint or third-party source could not be downloaded or failed its hash."""
    code = "weights_unavailable"


class InferenceError(EngineError):
    """Model inference failed (including CUDA OOM after the CPU retry)."""
    code = "inference_failed"
