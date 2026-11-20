"""What actually turns an image into a plan: the real engine, or the demo fake.

Both expose the same small interface used by jobs.JobManager:

    runner.start_loading()          kick off model loading (background thread)
    runner.wait_ready(timeout)      block until loading finished (ok or not)
    runner.status() -> dict         {device, loading, models:{mitunet, cubicasa}, error}
    runner.can_accept() -> str|None None, or why jobs cannot run at all (-> 503)
    runner.run(image, opts, cb)     plan dict; raises EngineError subclasses
"""
from __future__ import annotations

import copy
import json
import threading
import time
from pathlib import Path
from typing import Callable

from .config import Settings

ProgressCb = Callable[[str, float], None]


class EngineRunner:
    """planliftar_engine on this machine's GPU (or CPU with --cpu)."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._ready = threading.Event()
        self._started = False
        self._lock = threading.Lock()
        self.device: str | None = None
        self.models = {"mitunet": False, "cubicasa": False}
        self.cubicasa_failed = False
        self.error: str | None = None      # fatal: MitUNet cannot load

    # -- loading -----------------------------------------------------------
    def start_loading(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
        threading.Thread(target=self._load, name="model-loader", daemon=True).start()

    def _load(self) -> None:
        t0 = time.perf_counter()
        try:
            import torch
            if self.settings.device == "cpu" or not torch.cuda.is_available():
                self.device = "cpu"
            else:
                self.device = "cuda"
            print(f"[engine] device={self.device}")
            if not self.settings.preload:
                return
            from planliftar_engine import mitunet
            try:
                mitunet.load_model(self.device)
                self.models["mitunet"] = True
            except Exception as e:    # weights missing and download failed, etc.
                self.error = f"MitUNet failed to load: {e}"
                print(f"[engine] {self.error}")
                return
            if self.settings.preload_cubicasa:
                from planliftar_engine import cubicasa
                try:
                    cubicasa.load_model(self.device)
                    self.models["cubicasa"] = True
                except Exception as e:  # jobs then run MitUNet-only
                    self.cubicasa_failed = True
                    print(f"[engine] CubiCasa failed to load, jobs will run MitUNet-only: {e}")
            print(f"[engine] models loaded in {time.perf_counter() - t0:.1f}s: {self.models}")
        except Exception as e:
            self.error = f"engine failed to start: {e}"
            print(f"[engine] {self.error}")
        finally:
            self._ready.set()

    def wait_ready(self, timeout: float | None = None) -> bool:
        return self._ready.wait(timeout)

    @property
    def loading(self) -> bool:
        return self._started and not self._ready.is_set()

    def status(self) -> dict:
        return {"device": self.device or "cpu", "loading": self.loading,
                "models": dict(self.models), "error": self.error}

    def can_accept(self) -> str | None:
        return self.error

    # -- running -----------------------------------------------------------
    def run(self, image: bytes, opts: dict, cb: ProgressCb) -> dict:
        from planliftar_engine import run_pipeline
        opts = dict(opts)
        notes = []
        if opts.get("use_cubicasa", True) and self.cubicasa_failed:
            opts["use_cubicasa"] = False
            notes.append("cubicasa_unavailable")
        if self.settings.device == "cpu":
            opts["device"] = "cpu"
        plan = run_pipeline(image, opts, progress_cb=cb)
        # A lazily loaded model (--no-preload) is resident after its first job.
        self.models["mitunet"] = True
        if opts.get("use_cubicasa", True) and plan.get("engine", {}).get("mode") == "mitunet+cubicasa":
            self.models["cubicasa"] = True
        if notes:
            plan.setdefault("acceptance", {}).setdefault("notes", []).extend(notes)
        return plan


class DemoRunner:
    """No torch, no GPU: walks realistic stages and returns a bundled sample plan.

    The CubiCasa sample (2730x2048) is returned for images of that size (i.e. the
    repo's sample), the small bungalow otherwise. Clearly labelled as a demo in
    engine.mode and acceptance.notes.
    """

    STAGES_FULL = [("decoding image", 0.02), ("segmenting walls (MitUNet)", 0.05),
                   ("detecting rooms, doors and windows (CubiCasa)", 0.15),
                   ("post-processing CubiCasa output", 0.4), ("building walls and rooms", 0.8)]
    STAGES_FAST = [("decoding image", 0.02), ("segmenting walls (MitUNet)", 0.05),
                   ("building walls and rooms", 0.3)]

    def __init__(self, settings: Settings):
        self.settings = settings
        self._plans = {}
        for name in ("cubicasa", "bungalow"):
            p = Path(settings.demo_plans_dir) / f"{name}.json"
            self._plans[name] = json.loads(p.read_text(encoding="utf-8"))

    def start_loading(self) -> None:
        pass

    def wait_ready(self, timeout: float | None = None) -> bool:
        return True

    def status(self) -> dict:
        return {"device": "cpu", "loading": False,
                "models": {"mitunet": False, "cubicasa": False}, "error": None}

    def can_accept(self) -> str | None:
        return None

    def run(self, image: bytes, opts: dict, cb: ProgressCb) -> dict:
        import io
        from PIL import Image
        with Image.open(io.BytesIO(image)) as im:
            size = im.size
        fast = not opts.get("use_cubicasa", True)
        t0 = time.perf_counter()
        for stage, p in (self.STAGES_FAST if fast else self.STAGES_FULL):
            cb(stage, p)
            time.sleep(self.settings.demo_step_s)
        name = "cubicasa" if size == (2730, 2048) else "bungalow"
        plan = copy.deepcopy(self._plans[name])
        plan.setdefault("acceptance", {}).setdefault("notes", []).append("demo")
        plan["engine"] = {"version": "demo", "device": "none", "mode": "demo",
                          "sample": name, "total_s": round(time.perf_counter() - t0, 3)}
        cb("done", 1.0)
        return plan
