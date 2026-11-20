# PlanLiftAR MVP: end-to-end verification report

Date: 2026-11-20. Branch `planliftar-mvp-pwa`. Machine: Windows 11, RTX 3050 Laptop 4 GB,
16 GB RAM. Backend: `python backend/run_server.py` (real MitUNet + CubiCasa on CUDA, demo
off) serving the built PWA on `http://127.0.0.1:8000`. Browser: Playwright 1.65.1,
headless Chromium (SwiftShader WebGL), one worker, one GPU job at a time.

## How to run

```powershell
cd app; pnpm build; cd ..
python backend/run_server.py                 # wait for "[engine] models loaded"
cd app; npx playwright install chromium      # once
pnpm e2e                                     # = playwright test (app/playwright.config.ts)
```

Every spec runs as a **phone** (Pixel 7: 412x915, touch, `pointer: coarse`) and a
**desktop** (1440x900). The full-preset GPU job runs only in the phone project, and the fast
and >4096 px jobs only in the desktop project, so each GPU job runs once per suite. Each test
fails on any uncaught page error and on console errors it does not expect
(`e2e/fixtures.ts`). Results go to `app/e2e-results/` (gitignored).

## Integration gaps fixed in this pass

| # | Gap | Fix | Contract |
| --- | --- | --- | --- |
| 1 | Uploads over 4096 px came back in the downscaled analysis frame, so the overlay, thumbnails and scale were wrong by `input_scale`. | `planliftar_engine.pipeline.to_full_frame` maps walls, thickness, rooms (`area_px` by k²), fixture positions and widths, and the px metrics in `acceptance`/`gap_fill` back to full uploaded-image pixels. `input_scale` is informational only. The app needs no change, so `API.md` holds as written. | `docs/API.md` PlanJSON |
| 2 | The live map only worked when the laptop had the same plan in its own IndexedDB. | The AR page sends `{type:"plan", plan_id, name, plan, ppm, wall_height_m}` on every hub (re)connect. The `/ws` hub caches the latest one and replays it to viewers that join later. `/map` follows the shared plan with **Save to library**, and a project map says when the phone has a different plan open. Limits: 2 MB of UTF-8, one update per 2 s per phone address, `plan_rejected` reply. Each viewer has one latest-plan slot outside its message queue. | `PROTOCOL.md` "Plan", `API.md` hub |
| 3 | Android Scene Viewer cannot open the fallback's `blob:` GLB. | `POST /api/models`: GLB body ≤ 15 MB, checked for the `glTF` v2 magic, a header length that equals the body length and a JSON first chunk. The model gets a 128-bit random id, a 15 min TTL and a store cap of 16 models / 64 MB. `GET /api/models/{id}.glb` serves it. The fallback uploads its GLB and uses the https URL. Demo mode, or a failed upload, keeps the blob URL. Download is always offered. | `API.md` `/api/models` |

A security review of #2 led to these changes: size caps count bytes, not characters; plans never enter the outbox; plan updates are rate-limited. Each has a test.

## Pass/fail matrix (final runs)

`P` = pass, `-` = skipped by design (GPU job runs in the other project).

| Area | Spec | Phone | Desktop |
| --- | --- | --- | --- |
| Install readiness: manifest (name, start_url, display, 192/512 icons), SW registered at `/` | `pwa` | P | P |
| Offline reload (`context.setOffline`): shell, library, project page, Learn | `pwa` | P | P |
| Upload sample, **full** preset: progress monotonic to done, `mitunet+cubicasa`, accepted, overlay.png | `upload` | P (71 s) | - |
| Overlay alignment: viewBox = image px (2730x2048), `scale(1)`, walls inside the image and spanning >50% of it | `upload` | P | P |
| Set scale (building length + wall height), reload persists; project in library | `upload` | P | - |
| Upload, **fast** preset: `mitunet_only`, saved, survives reload | `upload` | - | P (5.4 s) |
| >4096 px upload (sample x2.2 = 6006x4506, 2.1 MB): full-image coords, `input_scale` < 1, walls reach past 4096 px | `upload` | - | P (12 s) |
| 3D viewer: WebGL canvas, context not lost, no WebGL/three errors; Export GLB is a valid `glTF` v2 file | `viewer-ar` | P | P |
| AR without WebXR: fallback renders, GLB uploaded (201), `model-viewer src` = `/api/models/<id>.glb` serving `model/gltf-binary`, download still offered | `viewer-ar` | P | P |
| AR `?fake=1`: scripted walk streams poses to the hub | `viewer-ar` | P | P |
| Live map, two contexts: the phone (Pixel 7 context, `?fake=1`) shares its plan and poses; a fresh laptop context on `/map` loads the plan it never had, shows "Phone live", the green dot and phone state; Save to library keeps the phone's id; the other-plan notice shows | `livemap` | - | P |
| How it works: every chart draws marks (11 Recharts + 1 table chart) | `pages` | P | P |
| Settings: demo off, Test connection reports "on GPU", units persist across reload | `pages` | P | P |
| Error: corrupt file, not an image (415) and PNG header + garbage (400), readable message | `errors` | P | P |
| Error: 16 MB file blocked client-side with no request sent; the server answers 413 from Content-Length | `errors` | P | P |
| Error: server down: status banner, "Cannot reach the server", offers demo mode | `errors` | P | P |
| Error: unknown/expired job | `errors` | P | P |

Totals: 25 passed, 4 skipped by design. The full-preset test was rerun alone after its
deadline was widened (see bug 7).

Other suites:

| Suite | Result | Time |
| --- | --- | --- |
| `backend: python -m pytest` (fast, incl. MitUNet-only GPU test) | 52 passed | 32 s |
| `backend: python -m pytest -m slow` (real HTTP job + new >4096 px frame test) | 2 passed | 77 s |
| `app: vitest run` | 93 passed (12 files) | ~15 s |
| `app: eslint .` | clean | |
| `app: pnpm build` (tsc + vite + PWA) | ok, 52 precache entries, 2.5 MB | 12-47 s |

## Timings (real backend, this laptop)

| What | Time |
| --- | --- |
| Model load at server start | 20-34 s |
| Full preset (MitUNet + CubiCasa), 2730x2048 sample, through the UI | 70-77 s idle; **340 s** once while other work loaded the CPU (stuck at 40%, CubiCasa post-processing) |
| Fast preset, through the UI | 5-6 s |
| Fast preset, 6006x4506 upload | 12-16 s |
| Whole e2e suite (both projects) | 8.3 min |

## Bugs found and fixed

1. **Engine coordinate frame** (gap 1): fixed in the engine. New unit test plus a slow GPU test
   on a 2.2x upscaled sample, and an e2e check through the UI.
2. **Live map needed the plan on both devices** (gap 2): fixed as above.
3. **Scene Viewer could not open `blob:` GLBs** (gap 3): fixed as above.
4. **Hub caps counted characters, not bytes, and a 2 MB plan could sit in every viewer's
   256-slot outbox** (security review): fixed with byte counts, a latest-plan slot and a rate limit.
5. **`/api/health` key clash**: the new model-store count would have overwritten
   `models` (the model-load flags the app reads). It is now `hosted_models`. Caught before commit.
6. **`vitest` collected `e2e/*.spec.ts`**: added `include: ["src/**/*.test.{ts,tsx}"]`.
7. **Full preset is slow under CPU contention.** The 340 s run was correct (accepted, 53 walls)
   but sat at 40% for about 4.5 min. The test deadline is now 420 s. This is not a code bug:
   CubiCasa post-processing is CPU-bound. For the demo, keep the laptop otherwise idle, or use
   the fast preset.

Test-side issues that were not app bugs, kept here for anyone extending the suite: every chart
carries a collapsed "Show the numbers" table, so the check branches on `.recharts-wrapper`.
Windows resets a connection when body bytes go unread, so the 413 probe sends headers only.

## Open notes (not fixed)

- Uvicorn on Windows logs a `ConnectionResetError [WinError 10054]` traceback when a client
  drops mid-request, e.g. after an early 413. It is noise only.
- A rejected `plan` message during a hub reconnect within 2 s is harmless, because the cached
  copy is used, but the phone does not show `plan_rejected` to the user yet.
- The legacy 8765 hub forwards `plan` but does not replay it. Its 1 MiB frame cap is respected:
  the app shares ≤ 1 MiB in legacy mode.
- Scene Viewer fetches the GLB itself. Android apps do not trust user-installed CA certificates
  by default, so with the self-signed `--tls` CA, Scene Viewer may refuse the https URL even
  though Chrome accepts it. This needs a phone to confirm (below). If it fails, the download
  fallback still works.

## What still needs a real phone

Headless Chromium has no WebXR `immersive-ar`, camera or ARCore. These need an Android phone
(Chrome, Google Play Services for AR) on `https://<lan-ip>:8443` with the CA installed (RUN.md):

1. **Anchor stability** (protocol from `docs/research/AR_ANCHORING.md` §2, "Not yet verified on
   a phone"): place the model at life size on a textured floor, walk 5 m out and back, and watch
   `anchorYawCorrDeg` / `anchorDriftM` in the `diag` stream on the laptop. A wall edge must stay
   on its real-world tape mark (target: under 5 cm at 5 m). Repeat with **Re-anchor** halfway and
   check that nothing jumps. Repeat on a plain white floor and check that the surface gate refuses
   to place (red/amber ring) rather than placing badly.
2. **Placement flow**: the ring turns green only on a stable, tracked plane; tabletop 1:50 versus
   life size; the rotate buttons; Drop to floor.
3. **Live map with a real walk**: the dot and heading cone follow the phone. Confirm the laptop
   `/map` picks up the shared plan with no project on the laptop, and that remote controls
   (`model_denom`, `rotation_deg`, `reset_placement`) apply on the phone and come back as `state`.
4. **Scene Viewer fallback** (Chrome without ARCore, or another Android browser): Open in AR
   launches Scene Viewer with the `/api/models/<id>.glb` URL. Check it loads over the self-signed
   CA (see the open note) and opens at true size.
5. **iOS Quick Look**: model-viewer converts the GLB to USDZ in the browser and opens it at true
   size.
6. **PWA install** from Chrome's menu on the phone, then airplane mode: the library, 3D and AR
   fallback open offline.
7. **Camera capture** ("Take a photo" on `/new`) with a real plan photo: EXIF rotation and a
   photo over 4096 px (most phone cameras) now come back in full-image coordinates. Check the
   overlay lines up.
