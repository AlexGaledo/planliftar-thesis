"""CLI entry point: python run_server.py [--tls] [--port N] [--no-preload] [--cpu] [--demo]

Listeners (one process, one app, one job queue, one hub):
  http://127.0.0.1:8000      always (local dev; the Vite dev server proxies here)
  https://0.0.0.0:8443       with --tls (phones on the LAN: WebXR needs https)
Without --tls, --host 0.0.0.0 exposes plain http on the LAN (no WebXR there).
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import replace

from .config import Settings


def parse_args(argv=None):
    ap = argparse.ArgumentParser(prog="run_server.py", description="PlanLiftAR local server")
    ap.add_argument("--tls", action="store_true",
                    help="also serve HTTPS/WSS on 0.0.0.0:--tls-port with a local CA cert "
                         "(needed for phones: WebXR, camera and PWA install need https)")
    ap.add_argument("--port", type=int, default=8000, help="plain http port (default 8000)")
    ap.add_argument("--host", default="127.0.0.1",
                    help="plain http bind address (default 127.0.0.1)")
    ap.add_argument("--tls-port", type=int, default=8443, help="https port (default 8443)")
    ap.add_argument("--no-preload", action="store_true",
                    help="do not load models at startup; the first job loads them")
    ap.add_argument("--cpu", action="store_true", help="run inference on the CPU")
    ap.add_argument("--demo", action="store_true",
                    help="no models/GPU: jobs return bundled sample plans")
    ap.add_argument("--no-cubicasa-preload", action="store_true",
                    help="preload MitUNet only (CubiCasa loads on the first full job)")
    ap.add_argument("--allow-origin", action="append", default=[], metavar="ORIGIN",
                    help="extra CORS origin, e.g. https://planliftar.vercel.app (repeatable; "
                         "'*' = any). Private-LAN origins are always allowed.")
    ap.add_argument("--static-dir", help="built PWA directory (default: app/dist)")
    ap.add_argument("--max-queue", type=int, default=8)
    ap.add_argument("--job-ttl", type=float, default=3600.0, help="seconds to keep results")
    return ap.parse_args(argv)


def build_settings(a) -> Settings:
    s = Settings()
    kw = dict(demo=a.demo, preload=not a.no_preload, device="cpu" if a.cpu else "auto",
              preload_cubicasa=not a.no_cubicasa_preload, tls=a.tls,
              max_queue=a.max_queue, job_ttl_s=a.job_ttl,
              allowed_origins=tuple(s.allowed_origins) + tuple(o.rstrip("/") for o in a.allow_origin))
    if a.static_dir:
        from pathlib import Path
        kw["static_dir"] = Path(a.static_dir).resolve()
    return replace(s, **kw)


def print_banner(settings: Settings, a, ips: list[str]) -> None:
    line = "=" * 64
    print(line)
    mode = "DEMO (sample plans, no models)" if settings.demo else (
        "engine on " + ("CPU" if settings.device == "cpu" else "GPU if available"))
    print(f"PlanLiftAR server  [{mode}]")
    print(line)
    print(f"Local (dev, Vite proxies here):  http://{a.host}:{a.port}")
    app_built = (settings.static_dir / "index.html").is_file()
    print(f"Web app: {'served from ' + str(settings.static_dir) if app_built else 'NOT BUILT (cd app; pnpm build)'}")
    if settings.tls:
        print("\nOn the phone (same Wi-Fi / hotspot), open:")
        for ip in ips:
            print(f"    https://{ip}:{a.tls_port}")
        print("First time: download and install the CA from")
        for ip in ips:
            print(f"    https://{ip}:{a.tls_port}/cert")
        print("(Android: Settings > Security > Encryption & credentials > Install a "
              "certificate > CA certificate). Then reload; the PWA can install.")
        _print_qr(f"https://{ips[0]}:{a.tls_port}")
    else:
        print("\nPhones need https for AR: restart with --tls.")
    print(line, flush=True)


def _print_qr(url: str) -> None:
    try:
        import qrcode
    except ImportError:
        print("(pip install qrcode to get a scannable QR code here)")
        return
    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    qr.make(fit=True)
    try:
        qr.print_ascii(invert=True)
    except UnicodeEncodeError:
        print("(terminal cannot draw the QR code; open the URL above)")
    print(url)


async def serve(a, settings: Settings) -> None:
    import uvicorn
    from .app import create_app
    from .tls import CertPaths, get_lan_ips, make_ssl_context  # noqa: F401

    ips = get_lan_ips()
    app = create_app(settings)
    common = dict(log_level="warning", ws_max_size=1 << 20, timeout_graceful_shutdown=3)
    servers = [uvicorn.Server(uvicorn.Config(app, host=a.host, port=a.port, lifespan="on",
                                             **common))]
    if settings.tls:
        paths = CertPaths(settings.cert_dir)
        make_ssl_context(paths, ips)        # (re)issues the cert if needed, verifies it loads
        servers.append(uvicorn.Server(uvicorn.Config(
            app, host="0.0.0.0", port=a.tls_port, lifespan="off",
            ssl_certfile=str(paths.chain), ssl_keyfile=str(paths.key), **common)))
    print_banner(settings, a, ips)
    # The first server owns the lifespan (job worker). Each uvicorn server
    # installs its own signal handler and only one wins, so propagate the stop
    # request to all of them.
    async def propagate_stop():
        while not any(s.should_exit for s in servers):
            await asyncio.sleep(0.2)
        for s in servers:
            s.should_exit = True

    await asyncio.gather(propagate_stop(), *(s.serve() for s in servers))


def main(argv=None) -> int:
    a = parse_args(argv)
    settings = build_settings(a)
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    try:
        asyncio.run(serve(a, settings))
    except KeyboardInterrupt:
        pass
    print("PlanLiftAR server stopped.")
    return 0
