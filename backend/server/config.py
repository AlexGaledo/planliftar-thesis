"""Server settings. One frozen dataclass, built by run_server.py or by tests."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent

MAX_UPLOAD_BYTES = 15 * 1024 * 1024          # docs/API.md
MAX_IMAGE_PIXELS = 40_000_000                # decompression-bomb cap (engine uses the same)


def _env_origins() -> tuple[str, ...]:
    raw = os.environ.get("PLANLIFTAR_ALLOWED_ORIGINS", "")
    return tuple(o.strip().rstrip("/") for o in raw.split(",") if o.strip())


@dataclass(frozen=True)
class Settings:
    # --- engine -------------------------------------------------------------
    demo: bool = False             # canned sample plans, no torch, no models
    preload: bool = True           # load models in a background thread at startup
    device: str = "auto"           # "auto" | "cpu" (--cpu)
    preload_cubicasa: bool = True  # also load CubiCasa at startup

    # --- jobs ---------------------------------------------------------------
    max_queue: int = 8             # queued (not running) jobs before 503
    job_ttl_s: float = 3600.0      # finished jobs are forgotten after this
    cleanup_interval_s: float = 60.0
    demo_step_s: float = 0.6       # demo mode: seconds per fake stage

    # --- uploads ------------------------------------------------------------
    max_upload_bytes: int = MAX_UPLOAD_BYTES
    max_image_pixels: int = MAX_IMAGE_PIXELS

    # --- web ----------------------------------------------------------------
    static_dir: Path = REPO_DIR / "app" / "dist"
    allowed_origins: tuple[str, ...] = field(default_factory=_env_origins)
    allow_private_lan_origins: bool = False   # --allow-lan-origins (opt-in)
    # Host allowlist (DNS rebinding): loopback + lan_ips on listen_ports, plus extras.
    lan_ips: tuple[str, ...] | None = None    # None = discover with tls.get_lan_ips()
    listen_ports: tuple[int, ...] = (8000, 8443)
    allowed_hosts: tuple[str, ...] = ()       # --allowed-host, "name" or "name:port"

    # --- tls ----------------------------------------------------------------
    cert_dir: Path = BACKEND_DIR / ".certs"
    publish_ca: bool = True        # GET /cert serves the (public) CA cert when TLS is on
    tls: bool = False

    # --- demo plans ---------------------------------------------------------
    demo_plans_dir: Path = REPO_DIR / "deliverables" / "livemap" / "plans"
