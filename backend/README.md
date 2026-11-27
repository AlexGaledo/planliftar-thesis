# PlanVisAR backend

Two parts:

- `planliftar_engine/`: the local inference engine (MitUNet + CubiCasa5k + geometry).
  `run_pipeline(image_bytes, options, progress_cb=None)` returns a schema-2.0 plan.
- `server/`: a FastAPI + uvicorn server that puts the engine behind
  [`docs/API.md`](../docs/API.md), runs the Live Map hub at `/ws`
  ([`PROTOCOL.md`](../deliverables/livemap/PROTOCOL.md)) and serves the built PWA
  from `app/dist`.

For the thesis-demo walkthrough, see [`../RUN.md`](../RUN.md).

## Install

Python 3.11+ (tested on 3.13, Windows 11, RTX 3050 Laptop 4 GB).

```powershell
cd backend
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128   # or .../whl/cpu
pip install -r requirements.txt
pip install qrcode                                    # optional: QR code at startup
python -m planliftar_engine --download-only           # ~470 MB of weights into backend/weights/
```

## Run

```powershell
python run_server.py                 # http://127.0.0.1:8000 only (local dev)
python run_server.py --tls           # + https://<lan-ip>:8443 for phones
python run_server.py --demo          # no GPU/models: jobs return sample plans
python -m server --tls               # same as run_server.py
```

| Flag | Effect |
| --- | --- |
| `--tls` | Also serve HTTPS/WSS on `0.0.0.0:8443` (`--tls-port`) with a local CA certificate. Phones need this: WebXR, the camera and PWA install require a secure context. |
| `--port N` | Plain-http port (default 8000, bound to `--host`, default `127.0.0.1`). |
| `--no-preload` | Do not load models at startup; the first job loads them. |
| `--cpu` | Run inference on the CPU (MitUNet-only ~11 s, full ~40 s+). |
| `--demo` | No torch, no models: jobs walk fake stages and return a bundled sample plan (`engine.mode = "demo"`). |
| `--allow-origin URL` | Allow a frontend on another origin, e.g. the Vercel deployment (repeatable, `*` = any). Also `PLANLIFTAR_ALLOWED_ORIGINS` (comma-separated). |
| `--allow-lan-origins` | Also allow pages served from any private-LAN origin. Off by default. |
| `--allowed-host H` | Accept an extra `Host` header, e.g. `mylaptop.local` or `mylaptop.local:8443`. |
| `--no-cubicasa-preload`, `--max-queue`, `--job-ttl`, `--static-dir` | See `--help`. |

Both listeners share one app, one job queue and one hub. The Vite dev server
(`pnpm dev` in `app/`) proxies `/api` and `/ws` to `http://127.0.0.1:8000`.

## How the server works

- **Jobs.** `POST /api/jobs` validates the upload, then queues it. A single worker
  thread runs one GPU job at a time (4 GB VRAM, 16 GB RAM). At most `--max-queue`
  (8) jobs can wait; past that the server answers 503. Finished jobs are kept for
  `--job-ttl` seconds (1 h), then `GET` returns 404. The uploaded bytes are dropped
  when a job finishes.
- **Models** load once at startup in a background thread, so `/api/health` answers
  while they load (`"loading": true`, `models.*` false until each one is ready). Jobs
  submitted meanwhile wait in the queue with the stage "waiting for models to load".
  If MitUNet cannot load, health has `ok: false` and new jobs get 503. If only
  CubiCasa fails, jobs run MitUNet-only and the plan notes `cubicasa_unavailable`.
- **Progress.** `stage` and `progress` come from the engine's `progress_cb`.
- **Options** (`options` form field, JSON): `use_cubicasa` (default `true`),
  `preset`: `"fast"` (MitUNet only, ~4 s warm on the GPU, like `--no-cubicasa`) or
  `"full"`; an explicit `use_cubicasa` overrides the preset. Also `mitunet_tta`,
  `export_rejected`. Unknown keys are ignored; wrong types give 400.
- **Upload validation**: missing/empty/corrupt image or bad options give 400; more
  than 15 MB or more than 40 MP (decompression-bomb cap, checked from the header
  before decoding) give 413; anything that is not PNG, JPEG or WebP by its magic
  bytes, or declares another type, gives 415. Then Pillow fully decodes it.
- **Overlay.** The engine does not draw one, so the server renders rooms, walls and
  fixtures over the input after each job (max 1600 px) and serves it at
  `/api/jobs/{id}/overlay.png`.
- **Errors** are always `{"error": "..."}`. A failed job also has `code`, the
  engine's stable error code (`bad_input`, `weights_unavailable`,
  `inference_failed`, `engine_error`).
- **PWA.** Files from `app/dist` are served as-is. Other GET paths without a file
  extension get `index.html` (SPA routes). `/api/*` and `/ws` never do. `index.html`,
  `sw.js`, `workbox-*.js` and the manifest are `Cache-Control: no-cache`, and the
  hashed `/assets/*` are immutable. If the app is not built, `/` shows how to build
  it.

## Security model (no auth)

There are no accounts or tokens; the MVP trusts the local network. What it guards
against:

- **DNS rebinding.** The `Host` header must name this machine: `localhost`,
  `127.0.0.1`, `[::1]` or one of its LAN IPs, on a port the server listens on (plus
  `--allowed-host` extras). Anything else gets 421, and WebSocket upgrades are refused.
- **CSRF / cross-site pages.** A request whose `Origin` is not the same origin, an
  `--allow-origin` origin, or the local Vite dev/preview server
  (`localhost:5173`/`4173`) gets 403 before the app runs. This includes `/ws`
  upgrades and CORS preflights. Requests without `Origin` (curl, native apps) are
  not browser-driven and pass.
- **CORS** echoes only allowed origins, with `Access-Control-Allow-Private-Network`
  for Chrome when a public https frontend calls a LAN address.
- **TLS keys.** The CA's private key is never written to disk. The CA is
  name-constrained to this machine's addresses, and the leaf key is owner-only
  (`icacls` on Windows). Only the public CA certificate is served, at `/cert`.

**The `/ws` hub has no pairing token. Any device on the same LAN can join it as a
phone or a viewer, read the live pose stream and send control patches to the
phone.** Browser pages on other sites cannot, because of the checks above. Use the
server on a network you trust: your own hotspot or home Wi-Fi, not a venue's open
network.

## TLS on the phone

`--tls` issues a leaf certificate for every LAN IP of the laptop plus localhost,
signed by a single-use local CA (in `backend/.certs/`, gitignored). On the phone:

1. Open `https://<lan-ip>:8443/cert` and install `planliftar-ca.crt` as a CA
   certificate. On Android, if it does not prompt: Settings > Security > Encryption
   & credentials > Install a certificate > CA certificate.
2. Open `https://<lan-ip>:8443`. There is no warning, so WebXR works, and the PWA
   can be installed from Chrome's menu.

If the laptop's IP changes (a new hotspot lease), the certificate is reissued at
the next start with a new CA, and the phone must install it again. Remove the old
one under Trusted credentials > User.

## Tests

```powershell
cd backend
python -m pytest              # engine + server, demo mode (~20 s)
python -m pytest -m slow      # + one real GPU job through HTTP on samples/ (~1 min)
```

`samples/` and `weights/` are gitignored; the GPU test skips when they are missing.

## Layout

```
server/
  app.py       routes: /api/*, /ws, /cert, PWA
  jobs.py      job store, single GPU worker, TTL cleanup
  runners.py   EngineRunner (background model loading) and DemoRunner
  uploads.py   upload and options validation
  overlay.py   debug overlay renderer
  hub.py       /ws hub (ported from deliverables/livemap/server.py), caches the shared plan
  models.py    short-lived GLB hosting for Scene Viewer (/api/models)
  cors.py      Host allowlist, Origin/CSRF check, CORS, body size cap
  static.py    app/dist serving, SPA fallback, cache headers
  tls.py       LAN IP discovery, local CA + leaf (ported from server.py)
  main.py      CLI (run_server.py / python -m server)
```
