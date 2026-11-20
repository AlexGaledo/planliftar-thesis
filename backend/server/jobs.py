"""In-memory job store with a single GPU worker.

* One worker thread runs jobs strictly one at a time (4 GB VRAM, 16 GB RAM).
* The waiting line is bounded (Settings.max_queue); submit() raises QueueFull,
  which the API turns into 503.
* Finished jobs are forgotten after Settings.job_ttl_s; GET then returns 404.
* The uploaded bytes are dropped as soon as the job finishes; only the plan and
  the rendered overlay PNG are kept.
"""
from __future__ import annotations

import queue
import secrets
import threading
import time
import traceback
from dataclasses import dataclass, field

from .config import Settings
from .overlay import render_overlay


class QueueFull(Exception):
    pass


@dataclass
class Job:
    id: str
    options: dict
    image: bytes | None
    status: str = "queued"
    stage: str = "queued"
    progress: float = 0.0
    error: str | None = None
    error_code: str | None = None
    result: dict | None = None
    overlay_png: bytes | None = None
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None

    def to_api(self) -> dict:
        out = {"id": self.id, "status": self.status, "stage": self.stage,
               "progress": round(self.progress, 4)}
        if self.status == "error":
            out["error"] = self.error or "unknown error"
            if self.error_code:
                out["code"] = self.error_code
        if self.status == "done":
            out["result"] = self.result
        return out


class JobManager:
    def __init__(self, settings: Settings, runner):
        self.settings = settings
        self.runner = runner
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._queue: queue.Queue[str | None] = queue.Queue(maxsize=settings.max_queue)
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._started = False
        self.running_id: str | None = None

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self.runner.start_loading()
        for target, name in ((self._worker, "gpu-worker"), (self._janitor, "job-janitor")):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        if not self._started:
            return
        self._stop.set()
        try:
            self._queue.put_nowait(None)      # wake the worker
        except queue.Full:
            pass
        for t in self._threads:
            t.join(timeout=2)

    # -- API ---------------------------------------------------------------
    def submit(self, image: bytes, options: dict) -> Job:
        job = Job(id=secrets.token_urlsafe(9), options=options, image=image)
        if not self.runner.wait_ready(0) or self.runner.status()["loading"]:
            job.stage = "waiting for models to load"
        with self._lock:
            self._jobs[job.id] = job
        try:
            self._queue.put_nowait(job.id)
        except queue.Full:
            with self._lock:
                self._jobs.pop(job.id, None)
            raise QueueFull(f"server busy: {self.settings.max_queue} jobs already waiting")
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def counts(self) -> dict:
        with self._lock:
            jobs = list(self._jobs.values())
        return {"queued": sum(j.status == "queued" for j in jobs),
                "running": sum(j.status == "running" for j in jobs),
                "max_queue": self.settings.max_queue}

    # -- worker ------------------------------------------------------------
    def _worker(self) -> None:
        while not self._stop.is_set():
            job_id = self._queue.get()
            if job_id is None or self._stop.is_set():
                return
            job = self.get(job_id)
            if job is None:
                continue
            while not self.runner.wait_ready(0.5):
                if self._stop.is_set():
                    return
            fatal = self.runner.can_accept()
            if fatal:
                self._fail(job, fatal, "models_unavailable")
                continue
            self._run(job)

    def _run(self, job: Job) -> None:
        job.status, job.stage, job.started = "running", "starting", time.time()
        job.progress = max(job.progress, 0.01)
        self.running_id = job.id

        def progress(stage: str, p: float) -> None:
            if stage != "done":
                job.stage = stage
            job.progress = min(max(job.progress, float(p)), 0.99)   # monotonic; 1.0 on done

        image = job.image
        try:
            plan = self.runner.run(image, job.options, progress)
            job.stage = "rendering overlay"
            try:
                job.overlay_png = render_overlay(image, plan)
            except Exception as e:      # debug view only: never fail the job for it
                print(f"[jobs] {job.id}: overlay failed: {e}")
            job.result = plan
            job.stage, job.progress, job.status = "done", 1.0, "done"
            eng = plan.get("engine", {})
            print(f"[jobs] {job.id} done in {time.time() - job.started:.1f}s "
                  f"mode={eng.get('mode')} accepted={plan.get('acceptance', {}).get('accepted')} "
                  f"walls={len(plan.get('walls', []))} rooms={len(plan.get('rooms', []))}")
        except Exception as e:
            code = getattr(e, "code", None)
            if code is None:
                traceback.print_exc()
                self._fail(job, f"internal error: {type(e).__name__}: {e}", "internal_error")
            else:
                self._fail(job, str(e), code)
        finally:
            job.image = None
            job.finished = job.finished or time.time()
            self.running_id = None

    def _fail(self, job: Job, message: str, code: str) -> None:
        job.status, job.error, job.error_code = "error", message, code
        job.stage = "failed"
        job.image = None
        job.finished = time.time()
        print(f"[jobs] {job.id} error [{code}]: {message}")

    # -- TTL cleanup -------------------------------------------------------
    def cleanup(self, now: float | None = None) -> int:
        now = time.time() if now is None else now
        ttl = self.settings.job_ttl_s
        with self._lock:
            dead = [jid for jid, j in self._jobs.items()
                    if j.finished is not None and now - j.finished > ttl]
            for jid in dead:
                del self._jobs[jid]
        return len(dead)

    def _janitor(self) -> None:
        while not self._stop.wait(self.settings.cleanup_interval_s):
            n = self.cleanup()
            if n:
                print(f"[jobs] expired {n} finished job(s)")
