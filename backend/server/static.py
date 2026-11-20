"""Serve the built PWA (app/dist) with an SPA fallback and correct cache headers.

* Existing files are served as-is.
* GET paths that match no file and have no file extension (client-side routes
  like /projects/abc/3d) get index.html. Missing files WITH an extension
  (/assets/old-hash.js) get 404, so a stale chunk fails loudly instead of being
  parsed as HTML. /api and /ws are never handled here.
* Caching: index.html, sw.js, registerSW.js, workbox-*.js and the manifest are
  `no-cache` so a new deploy is picked up (the service worker then manages the
  rest). /assets/* are content-hashed by Vite: cached for a year, immutable.
* Dot-segments (/.certs/...) and traversal are refused.
"""
from __future__ import annotations

import mimetypes
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response

NO_CACHE = "no-cache"
IMMUTABLE = "public, max-age=31536000, immutable"
_NO_CACHE_NAMES = {"index.html", "sw.js", "registerSW.js", "manifest.webmanifest",
                   "manifest.json"}

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("model/gltf-binary", ".glb")

NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>PlanLiftAR server</title>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">
<h1>PlanLiftAR server is running</h1>
<p>The web app has not been built, so there is nothing to show here yet.
The API is up at <a href="/api/health">/api/health</a>.</p>
<pre>cd app
pnpm install
pnpm build</pre>
<p>Then reload this page (no server restart needed).</p></body>"""


def cache_control(rel: str) -> str:
    name = rel.rsplit("/", 1)[-1]
    if name in _NO_CACHE_NAMES or (name.startswith("workbox-") and name.endswith(".js")):
        return NO_CACHE
    if rel.startswith("assets/"):
        return IMMUTABLE
    return "public, max-age=3600"


def _file(path: Path, rel: str) -> FileResponse:
    headers = {"Cache-Control": cache_control(rel)}
    if rel.rsplit("/", 1)[-1] == "sw.js":
        headers["Service-Worker-Allowed"] = "/"
    return FileResponse(path, headers=headers)


def serve_spa(static_dir: Path, url_path: str) -> Response:
    rel = unquote(url_path).lstrip("/")
    first = rel.split("/", 1)[0]
    if first in ("api", "ws"):
        return JSONResponse({"error": "not found"}, status_code=404)
    index = static_dir / "index.html"
    if not index.is_file():
        return HTMLResponse(NOT_BUILT, status_code=404)
    parts = PurePosixPath(rel).parts
    if any(p.startswith(".") or p in ("..",) or "\\" in p or ":" in p for p in parts):
        return JSONResponse({"error": "not found"}, status_code=404)
    if rel:
        candidate = (static_dir / rel).resolve()
        root = static_dir.resolve()
        if candidate.is_relative_to(root) and candidate.is_file():
            return _file(candidate, rel)
        if "." in parts[-1]:
            return JSONResponse({"error": "not found"}, status_code=404)
    return _file(index, "index.html")
