# PlanVisAR: run the thesis demo

> The app was renamed from PlanLiftAR to PlanVisAR (Nov 2026). Code identifiers, the Python package `planliftar_engine`, storage keys and env vars keep the old name on purpose.

A Windows laptop with an NVIDIA GPU runs the analysis server and serves the app. An
Android phone (Chrome, Google Play Services for AR) on the same Wi-Fi or hotspot
opens it over HTTPS. Commands are for Windows PowerShell, run from the repo root.

## 1. Install (once)

```powershell
# Python 3.11+ and Node 20+ with pnpm (npm i -g pnpm)
cd backend
pip install torch --index-url https://download.pytorch.org/whl/cu128   # CPU only: .../whl/cpu
pip install -r requirements.txt
pip install qrcode                                    # optional: QR code in the terminal
cd ..
```

## 2. Download the model weights (once, ~470 MB)

```powershell
cd backend
python -m planliftar_engine --download-only
cd ..
```

## 3. Build the app

```powershell
cd app
pnpm install
pnpm build          # writes app/dist, which the server serves
cd ..
```

## 4. Start the server

```powershell
python backend/run_server.py --tls
```

Wait for `[engine] models loaded` (10 to 60 s). The banner prints the phone URL
(`https://<lan-ip>:8443`) and a QR code.

- No GPU? Add `--demo` (sample plans) or `--cpu` (slow but real).
- Windows Firewall: allow Python on **private** networks when asked, or run once
  (in an admin PowerShell):
  `New-NetFirewallRule -DisplayName "PlanLiftAR 8443" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Private`
- Stop it with Ctrl+C.

## 5. Trust the certificate on the phone (once per laptop IP)

1. Connect the phone to the same Wi-Fi or hotspot as the laptop.
2. In Chrome, open `https://<lan-ip>:8443/cert` and install the downloaded
   `planliftar-ca.crt` as a **CA certificate**. If no prompt appears, go to
   Settings > Security > Encryption & credentials > Install a certificate >
   CA certificate, and pick it from Downloads.

   The first visit shows Chrome's "not private" warning. Tap Advanced > Proceed to
   reach `/cert`.
3. Close and reopen Chrome, then open `https://<lan-ip>:8443`. There should be no
   warning now.

The CA can only vouch for this laptop's own addresses, and its private key was
never saved, so trusting it does not let anyone impersonate other sites. Remove it
after the demo under Settings > Security > Trusted credentials > User.

## 6. Install the PWA and run a plan

1. In Chrome's menu, tap **Install app** (or **Add to Home screen**). Open
   PlanLiftAR from the home screen.
2. **New** > upload or photograph a floor plan. The job page shows the stages, about
   45 to 65 s with CubiCasa, or about 4 s with the fast MitUNet-only option.
3. Open the plan, set one real dimension, then **3D** or **AR** to walk it.
4. On the laptop, open `http://127.0.0.1:8000/map` (or the phone URL) for the live
   map and the control panel.

## Checks

```powershell
curl.exe -k https://<lan-ip>:8443/api/health
cd backend; python -m pytest; cd ..
```

## Developing the app instead

```powershell
python backend/run_server.py       # http://127.0.0.1:8000
cd app; pnpm dev                    # Vite proxies /api and /ws to :8000
```

To use the app hosted on Vercel with the laptop server, start the server with
`--tls --allow-origin https://<your-app>.vercel.app`, trust the certificate (step
5), and enter `https://<lan-ip>:8443` in the app's Settings.

### 3D look ("home" theme) and the bake-off harness

The 3D viewer, AR and the exported GLB use the "home" theme: CC0 photo textures
in `app/public/textures/` and CC0 door/window models in `app/public/models/`
(credits in the `CREDITS.txt` next to them and on the How it works page). To
re-measure it (GLB size, validator, precache, offline, first textured frame,
wall tone, screenshots into `docs/research/bakeoff/home/`):

```powershell
cd app; pnpm bakeoff home           # builds, starts vite preview on :4173, stops it
```

The textures are regenerated from ambientCG downloads with
`python -I app/scripts/textures/prepare_photo_textures.py <unzipped-dir> app/public/textures`.

More detail: [`backend/README.md`](backend/README.md) and [`docs/API.md`](docs/API.md).
