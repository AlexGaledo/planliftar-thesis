"""PlanVisAR local server: docs/API.md over planliftar_engine, the /ws hub, and the PWA.

    python run_server.py --tls            (from backend/)
    python -m server --tls                (same thing)

See backend/README.md.
"""
from .app import create_app  # noqa: F401
from .config import Settings  # noqa: F401
