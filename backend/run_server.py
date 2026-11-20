#!/usr/bin/env python3
"""Start the PlanLiftAR server. Run from anywhere:

    python backend/run_server.py --tls

Flags: --tls --port --no-preload --cpu --demo (see --help).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from server.main import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
