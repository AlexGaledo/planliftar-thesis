# Bake-off: the "home" theme (Photo + Kit), now the app default

Spec: `../DECISION.md` §3-§4. Measured with `pnpm bakeoff home` (headless Chrome, 1280x800, DPR 1). Raw numbers are in `metrics.json`. The GLBs are written to `glb/` (git-ignored).

## What was built

* **Theme:** `app/src/lib/three/homeTheme.ts` (from `bakeoff/photo` `photoTheme.ts`, renamed and edited). It is `DEFAULT_THEME`, so the 3D viewer, AR (`ArController`) and every GLB export (`planToGlb`, used by the plan page, the viewer and the Scene Viewer / model-viewer fallback) use it. `placeholder` stays registered (`?theme=placeholder`) and the P0 builder tests pin it.
* **Materials (9 at most, 1 alpha):** wall, slab, trim, door, glass, hardware, floor_wood, floor_tile, floor_concrete. Colour maps only: no `photo-pbr` variant, no roughness/normal maps, no `viewerOnlyMaps`. Trim is flat `#f1f0ec` paint (W3).
* **Maps (5 JPEG, 512 px, q80, 124.4 KB):** `plaster` (Plaster001, reprocessed, 2 m), `wood` (WoodFloor051, 1.8 m), `tile` (**Tiles139**, 2 m set of 6 x 6 = 33 cm beige stone tiles with grout, W4), `concrete` (Concrete034, 1.1 x 0.55 m), `door` (Wood049 rotated, 0.8 m). `prepare_photo_textures.py` regenerates all five; the three unchanged sets come out byte-identical to `5a29f43`.
* **W1 wall map:** 3x3-tiled Gaussian blur (radius 48 px) subtracted, luminance detail x0.5, mean set to `#ecebe7`. The 2x2 contact sheet shows no seam and no grid; on long exterior walls a very faint 2 m mottle remains at close range (`newri-reference-window.png`).
* **Kit fixtures** from `bakeoff/kit` (`1d5ddbe`): `door.glb`, `window.glb`, `normalize_fixtures.mjs`, `kitFixtures.ts` (+ test), `fixtureSlots()` / `usableOpenings()` / `kitKinds` in `wallLayout.ts`, the `pieces` merge path in `buildFloorplanGroup.ts`. No base-shade band, no procedural code, no `kitTheme.ts`. CRLF from the kit branch was converted to LF; files that were already CRLF in the base keep CRLF, so `git diff --stat` shows only real hunks.
* **W6:** `mergeVertices` per kit piece at load; placed copies inherit the index. Door 188 + window 84 triangles.
* **W5 async contract:**
  * `preloadTheme()` (memoised, never rejects) starts at idle time after the shell renders (`main.tsx`, lazy import, skipped on `/bakeoff`).
  * Viewer: `useThemeReady` waits for it (1.5 s grace), then builds; if it had to build early it rebuilds once when the assets land.
  * AR: `init()` awaits it (max 4 s) before offering Start AR, and rebuilds a placed model if the assets arrive later.
  * `planToGlb` awaits it before building.
  * Tests (`homeTheme.test.ts`): a build before preload has box fixtures, no maps and no hardware; `preload()` with stubbed network loads 5/5 maps and both models, is memoised, and a build after it has maps on walls/slab/door/floors and the handle.
* **W2 lighting** (`app/src/lib/three/lighting.ts`, shared by the viewer, the bake-off page and AR):
  * Viewer: `scene.environment` from `PMREMGenerator.fromScene(new RoomEnvironment(renderer))`, made once per canvas and disposed with it; hemisphere 0.9, sun 0.7, ACES.
  * AR: hemisphere sky white, ground `#b0b0b0`, intensity 3.2; sun 0.8; no tone mapping. `/bakeoff?...&lights=ar` renders this setup: cubicasa wall patch 204.
* **Offline:** `globPatterns` = `**/*.{js,css,html,png,jpg,glb,svg,woff2,json,webmanifest}`. `CREDITS.txt` is not precached and is excluded from the SPA navigation fallback, so the links on How it works > Credits open the files.
* **Harness:** `run.mjs` now defaults to `home`, records the eye-shot wall luminance, runs the offline check (metric 4), and the warm-SW timing (5 reloads, median) in SwiftShader and on the default (hardware) GPU. The bake-off page creates the canvas, renderer and environment before the preload timer starts, as the viewer does, so "first textured frame" is preload + build + first render (`envMs` is reported separately).

## Metrics vs. DECISION.md §4.4

| # | Check | Target | cubicasa | newri-reference | bungalow | Result |
|---|---|---|---|---|---|---|
| 2 | Validator errors / warnings | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | pass |
| 2 | extensionsUsed | `KHR_texture_transform` at most | same | same | same | pass |
| 2 | Materials / alpha / UV sets / images | <= 9 / <= 1 / 1 / jpeg | 7 / 1 / 1 / jpeg | 8 / 1 / 1 / jpeg | 5 / 0 / 1 / jpeg | pass |
| 4 | Offline (SW installed, `setOffline(true)`) | no failures, same triangles | 5/5 maps, 0 fixture failures, 7,063 = online | | 5/5, 0, 382 = online | pass |
| 12 | Licences | CREDITS for every shipped file, CC0 | 5 textures (ambientCG), 2 models (Kenney) | | | pass |
| 1 | GLB size | 650 / 300 / 180 KB | **591.8 KB** | 263.3 KB | 143.7 KB | pass |
| 3 | Precache added vs. 2,614,181 B | <= 200 KiB | 2,776,543 B, **+158.6 KiB** | | | pass |
| 11 | Build ms (all runs) | <= 60 | 10-25 | 6-11 | 2-4 | pass |
| 11 | First textured frame, median of 5, warm SW, hardware GPU (RTX 3050 Laptop, D3D11) | < 300 ms | **59 ms** | 89 ms | 67 ms | pass |
| 11 | Same, SwiftShader (recorded, not gated) | | 1,483 ms | 1,442 ms | 1,405 ms | n/a |
| 5 | Draw calls vs. placeholder | <= baseline + 2 | 7 (7) | 8 (8) | 5 (5) | pass |
| 7 | GPU texture memory | <= 8 MB | 4.9 MB | 6.3 MB | 4.9 MB | pass |
| 9 | Fit (close-up, window) | 0 defects | by eye: frames inside openings, no floating pieces, no z-fighting | same | n/a (no doors) | pass |
| 8a | Wall luminance, `cubicasa-eye` patch | >= 190, no 1 m grid | **211.8** (photo was 150) | 200.1 | 231.4 | pass |
| 8b | Blind ranking, 3+ people | hybrid highest mean | not run | | | open |
| 6 | Mobile AR fps, Scene Viewer opens GLB | >= 50 fps | not run (needs the reference phone) | | | open |

Notes:
* Triangles (in app): 7,063 / 1,738 / 382 (photo 6,219, kit 9,763 on cubicasa). Preload (cold, from the local preview) 23-34 ms; warm SW 8-23 ms.
* The SwiftShader first frame (about 1.4 s, almost all in the first `render()`, i.e. software shader compile of the environment-mapped standard material) is much slower than the earlier SwiftShader runs; the machine was low on memory at the time, which may explain it (unverified). It is recorded only, as §4.4 says. On the hardware GPU the first run per context is 63-297 ms (shader compile), then 57-96 ms.
* In-app, the see-through setting fades trim (skirting and door/window frames) with the walls, as in the photo and kit branches.
