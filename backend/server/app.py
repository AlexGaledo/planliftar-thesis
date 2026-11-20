"""FastAPI app: docs/API.md routes, /ws hub, /cert, and the PWA at /."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse, Response
from starlette.websockets import WebSocket

from .config import Settings
from .cors import CorsAndLimitsMiddleware, OriginPolicy
from .hub import Hub
from .jobs import JobManager, QueueFull
from .runners import DemoRunner, EngineRunner
from .static import serve_spa
from .tls import CertPaths, ca_der
from .uploads import UploadRejected, parse_options, validate_image

ENGINE_VERSION_FALLBACK = "0.1.0"


def _engine_version(demo: bool) -> str:
    try:
        from planliftar_engine import __version__
        return __version__
    except Exception:
        return ENGINE_VERSION_FALLBACK


def err(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status,
                        headers={"Cache-Control": "no-store"})


def create_app(settings: Settings | None = None, runner=None) -> FastAPI:
    settings = settings or Settings()
    runner = runner or (DemoRunner(settings) if settings.demo else EngineRunner(settings))
    jobs = JobManager(settings, runner)
    hub = Hub()
    policy = OriginPolicy(settings.allowed_origins, settings.allow_private_lan_origins)
    certs = CertPaths(settings.cert_dir)
    version = _engine_version(settings.demo)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        jobs.start()          # idempotent: safe when two listeners share the app
        yield
        jobs.stop()

    app = FastAPI(title="PlanLiftAR server", lifespan=lifespan, docs_url=None,
                  redoc_url=None, openapi_url=None)
    app.state.settings, app.state.jobs, app.state.hub, app.state.runner = settings, jobs, hub, runner
    app.add_middleware(CorsAndLimitsMiddleware, policy=policy, max_body=settings.max_upload_bytes)

    @app.exception_handler(StarletteHTTPException)
    async def _http_exc(request: Request, exc: StarletteHTTPException):
        return err(exc.status_code, str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def _validation_exc(request: Request, exc: RequestValidationError):
        return err(400, "invalid request")

    # ---------------------------------------------------------------- API
    @app.get("/api/health")
    async def health():
        st = runner.status()
        body = {"ok": st["error"] is None, "device": st["device"], "engine_version": version,
                "models": st["models"],
                # extras (not in the contract; clients ignore them)
                "loading": st["loading"], "demo": settings.demo, "queue": jobs.counts(),
                "hub": hub.counts()}
        if st["error"]:
            body["error"] = st["error"]
        return JSONResponse(body, headers={"Cache-Control": "no-store"})

    @app.post("/api/jobs")
    async def create_job(request: Request):
        fatal = runner.can_accept()
        if fatal:
            return err(503, f"models not loaded: {fatal}")
        ctype = request.headers.get("content-type", "")
        if not ctype.startswith("multipart/form-data"):
            return err(400, "send multipart/form-data with an `image` field")
        try:
            form = await request.form(max_files=1, max_fields=4)
        except ClientDisconnect:
            if request.scope.get("state", {}).get("body_too_large"):
                return err(413, f"image is larger than {settings.max_upload_bytes // 2**20} MB")
            return err(400, "upload interrupted")
        except Exception as e:
            return err(400, f"malformed multipart body: {e}")
        try:
            upload = form.get("image")
            if upload is None or isinstance(upload, str):
                raise UploadRejected(400, "missing `image` file field")
            raw_opts = form.get("options")
            if raw_opts is not None and not isinstance(raw_opts, str):
                raise UploadRejected(400, "`options` must be a JSON string field")
            options = parse_options(raw_opts)
            data = await upload.read(settings.max_upload_bytes + 1)
            await asyncio.to_thread(validate_image, data, upload.content_type,
                                    settings.max_upload_bytes, settings.max_image_pixels)
        except UploadRejected as e:
            return err(e.status, e.message)
        finally:
            await form.close()
        try:
            job = jobs.submit(data, options)
        except QueueFull as e:
            return err(503, str(e))
        return JSONResponse({"id": job.id}, status_code=202,
                            headers={"Location": f"/api/jobs/{job.id}",
                                     "Cache-Control": "no-store"})

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str):
        job = jobs.get(job_id)
        if job is None:
            return err(404, "unknown or expired job")
        return JSONResponse(job.to_api(), headers={"Cache-Control": "no-store"})

    @app.get("/api/jobs/{job_id}/overlay.png")
    async def get_overlay(job_id: str):
        job = jobs.get(job_id)
        if job is None or job.overlay_png is None:
            return err(404, "no overlay for this job")
        return Response(job.overlay_png, media_type="image/png",
                        headers={"Cache-Control": "private, max-age=3600"})

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    async def api_not_found(rest: str):
        return err(404, "not found")

    # ---------------------------------------------------------------- hub
    @app.websocket("/ws")
    async def ws_hub(websocket: WebSocket):
        headers = websocket.headers
        if not policy.allows(headers.get("origin"), headers.get("host")):
            await websocket.close(code=1008)
            return
        await hub.handle(websocket)

    # ---------------------------------------------------------------- cert
    @app.get("/cert")
    async def cert():
        """Public CA certificate (DER) so a phone can trust this server. Never the key."""
        if not (settings.tls and settings.publish_ca):
            return err(404, "certificate download is only available with --tls")
        der = await asyncio.to_thread(ca_der, certs)
        if der is None:
            return err(404, "no certificate available")
        return Response(der, media_type="application/x-x509-ca-cert",
                        headers={"Content-Disposition": 'attachment; filename="planliftar-ca.crt"',
                                 "Cache-Control": "no-cache"})

    # ---------------------------------------------------------------- PWA
    @app.get("/{path:path}")
    async def spa(path: str):
        return serve_spa(settings.static_dir, path)

    return app
