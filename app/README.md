# PlanVisAR app

An installable web app (PWA) that turns a picture of a floor plan into a 3D model you can walk through in AR on your phone, while a laptop follows you on a live map.

- Plan and architecture: [`../docs/APP_PLAN.md`](../docs/APP_PLAN.md)
- HTTP and WebSocket contract with the analysis server: [`../docs/API.md`](../docs/API.md)
- Live-map protocol (frozen): [`../deliverables/livemap/PROTOCOL.md`](../deliverables/livemap/PROTOCOL.md)

## Routes

| Path | What it does |
|---|---|
| `/` | Project library (IndexedDB): open, rename, delete; works offline |
| `/new` | Upload an image (or take a photo), import a plan JSON, or add an example |
| `/new/job/:jobId` | Analysis progress; saves the result as a project when done |
| `/projects/:id` | Plan drawn over the source image, real size from one measurement, downloads |
| `/projects/:id/3d` | 3D viewer (orbit, room labels, GLB export) |
| `/projects/:id/ar` | WebXR AR walk; `?fake=1` streams a scripted test walk. Falls back to `<model-viewer>` |
| `/projects/:id/map`, `/map` | Live map with the phone's dot, heading and trail, plus remote controls |
| `/learn` | How it works: pipeline, network diagrams, research charts, glossary, FAQ |
| `/settings` | Server URL, hub URL, demo mode, units, gap closure, clear data |

## Develop

Needs Node 20+ and pnpm.

```bash
pnpm install
pnpm dev            # http://localhost:5173
```

`/api` and `/ws` are proxied to `VITE_DEV_BACKEND` (default `http://127.0.0.1:8000`, the `backend/` server). No server? Turn on **Demo mode** in Settings: uploads then return a bundled sample plan after a simulated run.

```bash
pnpm test           # vitest (unit tests for plan maths, AR core, hub protocol, storage, charts)
pnpm lint           # eslint
pnpm build          # type-check + production build into dist/
pnpm preview        # serve dist/ on http://localhost:4173
```

Screenshots of every route, a console-error check, and Chrome's installability check:

```bash
pnpm build
pnpm preview --port 4173 &          # stop it when you are done
node scripts/screenshots.mjs http://127.0.0.1:4173 screenshots
```

The script uses `playwright-core` with the Chrome already installed on the machine (`CHROME_PATH` to override) and visits pages one at a time.

### Testing AR on a phone

WebXR needs a secure origin. Either serve over HTTPS on the LAN (the backend does this), or use `adb reverse tcp:5173 tcp:5173` and open `http://localhost:5173` on the phone. Chrome for Android with Google Play Services for AR is required for the live walk; other browsers get the model-viewer fallback.

## Deploy to Vercel (config only)

`vercel.json` is ready: Vite framework preset, `pnpm build`, output `dist/`, an SPA rewrite so deep links load `index.html`, `no-cache` on `sw.js` (so updates are noticed), and long-lived caching for hashed `/assets/*`.

Set the Vercel project's root directory to `app/`. Optional build variable: `VITE_DEFAULT_DEMO_MODE=true` to ship with demo mode on.

A hosted app is HTTPS, so it can only call an HTTPS analysis server. Users type the laptop's `https://<lan-ip>:<port>` in Settings (after accepting its certificate once), or use demo mode.

## Key libraries and why

| Library | Why |
|---|---|
| React 18 + TypeScript (strict) + Vite | Fast dev server, typed code |
| react-router 6 (data router, lazy routes) | Each page is its own chunk; Recharts, three.js and model-viewer load only where used |
| TanStack Query | Server state: health check and job polling with `refetchInterval` |
| zustand (persist) | Small settings store saved to localStorage |
| Dexie | IndexedDB with live queries: projects update everywhere when one changes |
| React Hook Form + Zod | Settings and upload forms with one schema for validation |
| three.js, @react-three/fiber, drei | 3D viewer; the same `buildFloorplanGroup` feeds viewer, AR and GLB export |
| @google/model-viewer 3.4 | AR fallback (Scene Viewer / Quick Look). Pinned: 4.x needs a newer three.js |
| Recharts | Research charts on the Learn page |
| vite-plugin-pwa (Workbox) | Manifest, offline shell, cached samples, update prompt |

## Folder map

```
src/
  app/          shell, router, toasts, error pages
  components/   Dialog, PlanDrawing
  features/     one folder per route (projects, new-project, plan, viewer, ar, livemap, learn, settings)
  lib/
    plan/       normalise, gap closure, geometry, scale (ports of plan_ops.js, tested)
    three/      model builder, materials, GLB export
    api/        HTTP + demo API behind one interface
    hub/        WebSocket client and protocol types
    db/         Dexie database, projects, samples
  stores/       settings
```

## Gotchas

- **Two scale factors, never mixed.** `ppm` (plan px per real metre) is inside the plan-to-metres mapping; the 1:N miniature (`model_denom`) is only a group scale. That is why live-map positions stay in true plan pixels at any miniature size.
- **The phone shares its plan.** Poses are plan pixels of the plan the phone opened, and projects are stored per browser, so the AR page sends its plan to the hub (`{type:"plan"}`, max 2 MB). The server hub replays it to late viewers, and `/map` follows it with a Save to library button. The legacy 8765 hub forwards it but does not replay it.
- **The AR frame loop lives outside React** (`features/ar/ArController.ts`). Do not move per-frame state into React state.
- **`arCore.ts` mirrors `deliverables/livemap/ar_core.js`**, and `lib/plan` mirrors `plan_ops.js`. Change them together.
- **pnpm 11**: `pnpm add` can crash on this workspace file; edit `package.json` and run `pnpm install`. `pnpm-workspace.yaml` allows the esbuild build script.
- **Scene Viewer on Android** opens models by URL, not blob URLs, so the fallback uploads the GLB to `POST /api/models` (15 min TTL) and uses that https URL. In demo mode it keeps the blob URL; the GLB download is always offered.
