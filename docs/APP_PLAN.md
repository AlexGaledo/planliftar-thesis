# PlanLiftAR app plan (MVP PWA)

Status: plan of record for `app/`, written before the build on 2026-11-20.
Source of truth for behaviour is the working prototype in `deliverables/livemap/`
(`index.html`, `ar.html`, `ar_core.js`, `plan_ops.js`, `PROTOCOL.md`). The app ports
that logic into a typed React codebase; it does not re-invent it.

---

## 1. Who it is for and what it must do

| Reader | Device | Job |
| --- | --- | --- |
| Client / homeowner | Android phone (Chrome), sometimes iPhone | Upload a plan photo, see it in 3D, stand inside it at 1:1 |
| Presenter at a demo | Laptop | Watch the walker live on the 2D map, steer size and rotation remotely |
| Thesis panel | Laptop or projector | Read how the pipeline and the AR work, with real numbers |

Locked decisions carried over from the prototype:

- Plans are unitless (`scale.user_scale_required: true`). The user supplies **one**
  real dimension; everything scales from it (`ppm = plan px per metre`).
- Two independent scale factors: `ppm` (how big the building is) and `model_denom`
  (1:N miniature). `model_denom` is never part of the plan-to-local mapping.
- Place only on a green (tracked, stable, plane, enough parallax) ring.
- The hub protocol in `PROTOCOL.md` is frozen. The app is a client of it.

---

## 2. Information architecture and routes

```
/                         Projects library (home)
/new                      New project: upload image | take photo | import JSON | samples
/new/job/:jobId           Analysis progress (polls the job; survives a reload)
/projects/:id             Plan: overlay on source image, set scale, actions
/projects/:id/3d          3D viewer (orbit, coloured labelled rooms, Export GLB)
/projects/:id/ar          AR walkthrough (WebXR) or model-viewer fallback
/projects/:id/map         Live map (spectator) + phone control panel
/map                      Live map entry: last opened project, or a picker
/learn                    How it works (pipeline, models, charts, AR, glossary, FAQ)
/settings                 Server, hub, demo mode, units, data
*                         Not found
```

Navigation: a bottom tab bar on phones (Projects, New, Live map, Learn, Settings) and
a left rail from 900 px up. The AR route is full-bleed and hides the chrome.

Heavy routes are lazy-loaded (`React.lazy`): the 3D viewer and AR pull in three.js,
`/learn` pulls in Recharts, and the iOS fallback pulls in `<model-viewer>` only when
WebXR AR is unavailable.

---

## 3. Components (by feature folder)

```
src/
  app/            App shell, router, providers, nav, update toast, install banner
  lib/plan/       types, normalize (port), gapClosure (port), geometry, scale, thumbnail
  lib/three/      buildFloorplanGroup (port of ar.html), room meshes, GLB export
  lib/api/        PlanApi interface, httpApi, demoApi, errors, resolveUrls
  lib/hub/        HubClient (WebSocket + backoff, PROTOCOL.md messages), types
  lib/db/         Dexie schema, project repository, sample seeding
  stores/         settings (zustand + persist)
  features/
    projects/     ProjectsPage, ProjectCard, PlanDrawing (SVG), rename/delete
    new-project/  NewProjectPage, ImagePicker, JobProgressPage
    plan/         PlanPage, PlanOverlay (image + SVG), ScaleForm
    viewer/       ViewerPage (R3F), RoomLabels, ExportButton
    ar/           arCore.ts (port of ar_core.js), ArController (port of ar.html loop),
                  ArPage, ArOverlay UI, ModelViewerFallback, fake walk
    livemap/      LiveMapPage, MapCanvas (port of index.html draw), ControlPanel
    learn/        LearnPage, PipelineDiagram, ArchitectureDiagram, ChartCard, Glossary, FAQ
    settings/     SettingsPage (react-hook-form + zod)
  content/        model_viz_data.json (copied from docs/research)
```

---

## 4. State

| Kind | Where | Why |
| --- | --- | --- |
| Projects (plan JSON, thumbnail SVG, source image Blob, scale, name, dates) | IndexedDB via Dexie, read with `useLiveQuery` | Survives offline and reloads; Blobs store natively |
| Settings (server URL, hub mode/URL, demo mode, units, last project) | zustand `persist` (localStorage) | Tiny, synchronous, read everywhere |
| Server state (health, job status) | TanStack Query (`refetchInterval` while running) | Polling, retries, caching for free |
| Live map (pose, trail, phone state) | Local component state + refs inside MapCanvas | 10 Hz updates must not re-render React; drawn on canvas |
| AR session | `ArController` class (imperative, owns the XR loop) publishing a small UI snapshot to React via `useSyncExternalStore` | The XR frame loop must run outside React; only text/flags reach the UI |

Project record:

```ts
interface Project {
  id: string; name: string; createdAt: number; updatedAt: number;
  origin: "sample" | "upload" | "import"; sampleId?: string;
  plan: RawPlan;                 // as received; normalised at read time (idempotent)
  thumbnailSvg: string;          // ink line drawing, generated on save
  sourceImage?: Blob;            // the uploaded photo/scan
  scale: { ppm: number; reference?: { kind: "longest" | "wall"; wallId?: string; meters: number } };
  wallHeightM: number;
}
```

---

## 5. API contract (frontend view)

Full contract in [`API.md`](./API.md). Summary:

- `GET  /api/health` -> `{ok, device, engine_version, models:{mitunet, cubicasa}}`
- `POST /api/jobs` multipart `image` (+ optional `options` JSON string) -> `202 {id}`
- `GET  /api/jobs/{id}` -> `{id, status, stage, progress, error?, result?}`
- `GET  /api/jobs/{id}/overlay.png` (optional debug overlay)
- `WS   /ws` hub, same protocol as `PROTOCOL.md`

Base URL: same-origin `/api` by default. Settings can point at a LAN laptop
(`https://192.168.x.x:8443`) so a Vercel-hosted build reaches the laptop server.
The hub URL defaults to the same origin as the API with `/ws`; it can be switched to
the legacy `ws(s)://<host>:8765` hub or a custom URL.

Demo mode swaps the HTTP client for an in-browser fake (`demoApi`) that walks a job
through realistic stages and returns a bundled sample plan, clearly labelled as a
demo. It works in dev and in the deployed build, with no backend.

---

## 6. Offline strategy

- vite-plugin-pwa (Workbox `generateSW`), `registerType: "prompt"`.
- Precache: app shell (HTML, JS, CSS, fonts, icons) and `/samples/*.json`.
- Navigation fallback to `index.html`, except `/api/*` and `/ws`.
- `/api/*` is never cached (network only): job results are saved into IndexedDB as
  projects, which is the offline copy.
- Projects, thumbnails and source images live in IndexedDB, so the library, plan,
  3D viewer and AR all work offline. Only new analysis and the live map need a network.
- Update flow: a new service worker waits; a toast offers "Reload to update".
- Install: `beforeinstallprompt` is captured and shown as an install banner on the
  library page; iOS gets an "Add to Home Screen" hint instead.

---

## 7. Visual direction

Black and white, as in the prototype redesign (commit 507f722), taken from the
drawing sheet rather than from a dashboard:

- Colours: paper `#FFFFFF`, ink `#000000`, graphite `#545454`, rule `#D6D6D6`,
  wash `#F2F2F2`. Two signal colours only, each with one meaning: **live / ready**
  green `#13804B` (the AR ring, the live dot, a connected hub) and **estimate /
  attention** amber `#A15C00`. Dark mode inverts paper and ink.
- Type: Archivo (variable, self-hosted for offline). Headings use its wide axis
  (`wdth 115`) for a drafting-title feel; body at normal width; tabular figures for
  measurements.
- Signature element: plans are drawn as crisp ink line drawings everywhere (library
  thumbnails, overlay, live map). Project cards read like a drawing register with a
  title block (name, date, size). Everything else stays quiet.
- One decision at a time on the phone (ready, aiming, placed), as in `ar.html`.

---

## 8. Quality bar

- Mobile-first; 44 px touch targets; visible focus rings; labels on every input.
- Loading, empty and error states for every flow (library, job, overlay, viewer, AR,
  map, learn).
- Tests (vitest): plan normalisation and validation, gap closure against the bundled
  plans (connector counts match `model_viz_data.json`), `arCore` maths and state
  machines, scale maths, demo API, hub message parsing.
- `pnpm build`, `pnpm test`, `pnpm lint` all pass.
