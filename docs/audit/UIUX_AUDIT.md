# PlanLiftAR PWA: UI/UX audit

Date: 2026-11-20. Branch `planliftar-mvp-pwa`. Scope: everything in `app/`.
Method: production build served by `vite preview`, demo mode on, Chrome headless
through `playwright-core`; every route at 390x844 (phone, 2x) and 1440x900
(desktop); each core flow walked as a first-time, non-technical client; an
automated pass for touch targets, unlabelled controls, text contrast and heading
order; Lighthouse 12.2.1; `vite build` chunk sizes.

No PRODUCT.md exists. The product context comes from `docs/APP_PLAN.md`,
`app/README.md` and `deliverables/livemap/DEFENSE_NOTES.md`; the direction in
APP_PLAN §7 (ink on paper, two signal colours) is treated as the brief.

## Screenshots

Screenshots are not committed (about 60 PNGs). They live in the session scratchpad:

```
C:\Users\alex\AppData\Local\Temp\claude\8cf567745ba1df3d\1f95bf69-1898-4853-907b-96d01912b618\scratchpad\audit\
  before\            every route, phone-* and desktop-* (from app/scripts/screenshots.mjs)
  before\flows\      Learn page screen by screen, first run, upload with no server, job progress, offline reload
  after\             the same set after the fixes
  after\flows\       plus live-map-demo-walk
```

References below use the form `before/phone-learn.png`, `after/flows/phone-upload-no-server.png`.
To regenerate the route set: `pnpm build`, `pnpm preview --port 4173`,
`node scripts/screenshots.mjs http://127.0.0.1:4173 <dir>`. The script now shoots desktop at
1440x900 and takes full-page captures of the long pages.

## Scores

| # | Dimension | Before | After | Key finding |
|---|---|---|---|---|
| 1 | Accessibility | 2 | 3 | Chart legend text at 2.8:1; targets of 14-40 px; live map had no h1 |
| 2 | Performance | 3 | 3 | Heavy libraries are already per-route; Learn LCP 3.5 s on a throttled phone |
| 3 | Theming | 3 | 3 | Tokens with dark mode everywhere; charts use off-palette blue/orange/green |
| 4 | Responsive | 2 | 3 | Pipeline diagram clipped; offline badge hidden on phones; legend overlaps |
| 5 | Implementation integrity | 3 | 4 | Coherent drawing-sheet system; copy described gap fills as dashed when they were solid |
| | **Total** | **13/20** | **16/20** | Acceptable to Good |

Lighthouse (mobile preset, run after the fixes):

| Page | Performance | Accessibility | Best practices | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/` | 91 | 100 | 100 | 2.5 s | 2.7 s | 160 ms | 0 |
| `/learn` | 76 | 100 | 100 | 2.7 s | 3.5 s | 450 ms | 0.001 |

Lighthouse 12 has no PWA category any more. Chrome's own check
(`Page.getInstallabilityErrors`) reports the app as installable, and the
screenshot run logs no console errors.

Build: shell `index` chunk 365 kB (120 kB gzip). Route chunks: Learn 443 kB
(Recharts, 126 kB gzip), `exportGlb` 710 kB (three.js, 186 kB gzip, shared by 3D,
AR and downloads), model-viewer 368 kB (loaded only by the AR fallback). Nothing
heavy is in the first download. The service worker precaches 2.5 MB so every
route works offline.

## Implementation integrity verdict

**Pass.** The app holds one visual idea: an architectural drawing sheet in
ink on paper, with green for live and amber for attention. Plans are drawn as
line drawings in every view, and cards read like title blocks. Tokens
(`styles/global.css`) cover colour, type, spacing and touch size, with dark mode.
Deviations were local, not systemic: a caption that described the drawing
wrongly, and chart colours outside the palette.

## Findings

### P0: blocks a client demo

**P0-1. No analysis server means a dead end showing "HTTP 500".** *Fixed.*
`before/flows/phone-upload-no-server.png`, `before/flows/phone-new-demo-off.png`.
A fresh install has demo mode off, unless the build sets `VITE_DEFAULT_DEMO_MODE`.
With no server reachable, the status box read "HTTP 500". Pressing Analyse
showed "HTTP 500" again, and the only way forward was a small "Server settings"
link. On a Vercel build the `/api` request returns `index.html`, which failed
with a JSON parse error.
Fix: `httpApi.ts` explains status codes and non-JSON answers in sentences. The
server check and a failed upload both offer **Use demo mode instead**. Tests
cover both cases. After: `after/flows/phone-upload-no-server.png`.

**P0-2. The live map cannot be shown without a phone and a server.** *Fixed.*
`before/phone-live-map.png`, `before/desktop-live-map.png`.
In a hosted demo, or on a projector, the map stayed on "Hub not reachable,
retrying…" for good: the main presenter view had nothing to show.
Fix: **Play a demo walk** in the waiting card. It feeds simulated poses through
the same `onPose` path a phone uses, touring the room centres. It is labelled
"Demo walk (simulated, not a phone)", and stopping it clears the trail
(`features/livemap/demoWalk.ts`, tested). After:
`after/flows/phone-live-map-demo-walk.png`, `after/flows/desktop-live-map-demo-walk.png`.

### P1: significant difficulty or WCAG AA failure

**P1-1. AR fallback copy is wrong on a laptop, repeats itself, and has no way back.** *Fixed.*
`before/desktop-ar-fallback.png`, `before/phone-ar-fallback.png`.
A laptop was told "This phone does not support AR" under the heading "View in
your phone's AR". The notice repeated "not available" twice, then a 60-word
paragraph. The route sits outside the app shell, so on a phone the only way
back was a 14 px breadcrumb.
Fix: phones get "View it in your room" and one notice with the next step.
Laptops get "AR needs a phone" and are told to add the same plan on the phone.
The Scene Viewer note is shortened and shown only on phones, and **Back to the
plan** is added. After: `after/desktop-ar-fallback.png`, `after/flows/phone-ar-fallback-bottom.png`.

**P1-2. Phones never show the offline state.** *Fixed.*
`before/flows/phone-offline-projects.png`.
`OfflineBadge` lives in the rail's `.status` block, which is `display: none`
below 900 px. The main client device therefore gave no sign it was offline,
or that analysis and the live map need a network.
Fix: a strip at the top of the content on phones, empty and hidden while online.
After: `after/flows/phone-offline-projects.png`.

**P1-3. Chart legends fail contrast and overlap on phones.** *Fixed.*
`before/flows/learn-b.png`, `before/flows/learn-c.png`.
Recharts coloured the legend text with the series colour: green on white
measured 2.82:1 and orange 3.20:1 (WCAG 1.4.3). The legend sat on top of the
x-axis title ("Notebook run" overprinted), and the rotated y-axis title covered
the tick numbers ("0.225").
Fix: the legend moves above the plot with text in ink, and the value-axis title
is a line of text above the chart. After: `after/flows/after-b.png`.

**P1-4. The pipeline diagram looks broken on a phone.** *Fixed.*
`before/flows/learn-a.png`.
The 640-unit SVG has a 520 px minimum width inside a scroll box that opened
at the left edge. Node labels were cut ("CubiCa", "AR pla"), with no sign the
box scrolls.
Fix: it opens centred on the main line of steps, shows "Swipe sideways to see
the side branches", and the scroll box can take keyboard focus. After:
`after/flows/after-b.png`.

**P1-5. Touch targets under 44 px.** *Fixed.*
Rename and Delete were 40 px; Learn section chips and "Show the numbers" were 36 px;
breadcrumbs, the only back path from 3D and AR on a phone, were 14 px.
Fix: buttons, chips and summaries reach 44 px. Breadcrumb links get a 44 px hit
area (`.crumbs`) without changing the layout. The after scan lists only inline
text links and the card title, which repeats the full-size thumbnail link; both
pass WCAG 2.5.8.

**P1-6. "Ready to work offline" covers content until dismissed.** *Fixed.*
`before/phone-projects.png`, `before/flows/learn-a.png`.
On first load the toast sat over the second project card and followed the user
to every page. Fix: it leaves by itself after 5 s. "Reload to update" still
waits for a decision.

**P1-7. The plan caption contradicts the drawing.** *Fixed.*
`before/phone-plan.png`.
The caption said "dashed lines are short gaps the app closed". Gap fills are
shorter than one dash, so they drew as solid dark grey, barely different from
black. Fix: gap fills are plain mid-grey and the caption says "grey lines".
The header says "8 small gaps closed" instead of "8 gap fills".

**P1-8. Engineering words on client screens.** *Fixed.*
"Hub not reachable, retrying…" and "Hub: ws://…" on the live map; "takes under
a minute on a GPU"; demo stages "Finding walls (MitUNet)" and "Second opinion
on rooms (CubiCasa)"; "Every number in charts[] is copied from a repo output
file named in that chart's 'source'" on Learn. All are rewritten in plain words.
The Learn intro keeps its meaning and its sources.

### P2: minor, workaround exists (not fixed)

1. **Chart colours leave the palette.** Multi-series charts use blue, orange and green (`useChartColors.ts`; a deliberate, validated choice with data tables as backup). They are the only colour on the page apart from the two signals. Consider ink, mid-grey and a hatch, which a thesis printout would also survive. `after/flows/after-b.png`
2. **Learn is 16,100 px tall on a phone** (`before/phone-learn.png`). Panel-grade detail such as source file names, raw room ids ("room_004_0 bedroom") and layer shapes is shown inline. Collapse sources and per-chart notes behind "Details" on narrow screens, and map room ids to names.
3. **Learn performance 76**: Recharts (126 kB gzip) parses on route load. Render charts only when they scroll into view (`IntersectionObserver`), or split the results section into its own chunk.
4. **Settings speaks to engineers**: "Live map hub", "Old standalone hub on port 8765 (server.py)", "Requests go to /api" (`before/phone-settings.png`). Fine for the presenter; for clients, move the connection block under an "Advanced" disclosure and keep Demo mode, Units and Data on top.
5. **Example descriptions use jargon** on New project: "Hand-drawn ground truth", "244 wall runs, 14 regions", "line-first". (`before/phone-new.png`)
6. **Bottom tab labels are 11 px.** They are readable, but below the 12 px floor for persistent navigation.
7. **The live map's waiting card covers most of the plan on a phone** (`before/phone-live-map.png`), and the desktop side panel is mostly empty space before a phone connects.
8. **Room labels on the plan overlay are about 9 px on a phone**, and unknown room types show as "Room 4" or "Room 6".
9. **The disabled "Analyse plan" button does not say why.** Add "Choose an image first" as a hint.
10. **The demo walk can cut through walls**: it is a straight tour between room centres. It is labelled as simulated.
11. **The test walk (`?fake=1`) on desktop is a blank white page** with two cards. It is a developer tool, but it is reachable from a shared link.
12. **The skip link is 40 px tall.**

### Not verified

- The install banner (`beforeinstallprompt`) and the iOS "Add to Home Screen" hint: headless Chrome never fires the prompt. Chrome reports the manifest and service worker installable.
- Live WebXR AR on an ARCore phone, and Quick Look on iOS: these need hardware.
- Stage names from the real backend, which the client shows verbatim: they may include model names.

## Flow walk notes (first-time client, phone)

| Flow | Result |
|---|---|
| First open | Projects list arrives pre-filled with four examples, so it is never empty; the offline toast covered a card (fixed). |
| Upload in demo mode | Clear: "Demo mode is on" notice, preview, name pre-filled from the file, progress card with %, stage names and a bar, then lands on the plan with a "Demo result" notice. |
| Upload with no server | Dead end before (P0-1); now one tap to demo mode. |
| Set scale and save | Clear segmented choice (Building length or One wall), units shown in the field, a "Saved. The building is 6.1 x 7.9 m." confirmation. |
| 3D | Good: orbit hint, room-name toggle, Walk it in AR as the primary action. "Export GLB" is jargon but secondary. |
| AR, unsupported device | Fallback model-viewer loads lazily; copy fixed (P1-1). |
| Live map | Steps to connect are clear; it could not be demonstrated alone (P0-2, fixed). |
| How it works | "In short" reads well for a lay reader. The rest is pitched at the panel; diagrams and charts are readable on a phone after the P1-3 and P1-4 fixes. |
| Settings | Works; wording is technical (P2-4). |
| Offline reload | Projects, Learn and New all load from the service worker with the network off; the phone now shows the offline strip. |

## Positive findings

- Every heavy dependency is split by route (three.js, Recharts, model-viewer), and model-viewer loads only when the fallback actually shows.
- Visible `:focus-visible` rings everywhere, a skip link, `prefers-reduced-motion` handling, and a `role="status"` or `role="alert"` on every async message.
- Every chart has a "Show the numbers" table, and the pipeline diagram has an "All steps as text" list.
- Loading, empty and error states exist for the library, job, plan, viewer, AR and map.
- Lighthouse accessibility 100 and best practices 100, with no console errors on any route.

## Fix commits

| Commit | Change |
|---|---|
| `4571bb2` | Plain-language server errors, one-tap demo mode, progress copy (P0-1, part of P1-8) |
| `9c9a1ca` | Live map demo walk, plain connection status, h1 (P0-2, part of P1-8) |
| `71ae473` | AR fallback copy for phones and laptops, back link (P1-1) |
| `40ecb4c` | Touch targets, breadcrumbs, offline strip on phones, toast auto-dismiss, gap-fill drawing (P1-2, P1-5, P1-6, P1-7) |
| `9cf734c` | Learn charts and pipeline diagram on phones, results note copy (P1-3, P1-4, part of P1-8) |

`pnpm build`, `pnpm test` (12 files, 89 tests, including new tests for the HTTP error copy and the demo walk) and `pnpm lint` pass.

## Recommended next steps

1. [P2] `$impeccable clarify`: Settings and the example descriptions (P2-4, P2-5).
2. [P2] `$impeccable optimize`: lazy-render Learn charts (P2-3).
3. [P2] `$impeccable distill`: a phone-length Learn page with collapsible sources (P2-2).
4. [P2] `$impeccable colorize`: decide whether the charts follow the ink palette (P2-1).
5. `$impeccable polish`: final pass.
