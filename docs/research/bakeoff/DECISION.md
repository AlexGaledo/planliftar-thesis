# Texture bake-off: decision

Status: decided and implemented (see Outcome). Date: 2026-11-21. Branch `planliftar-mvp-pwa` (base `7a104cb`).
Criteria: `docs/research/TEXTURES_ASSETS.md` §5. Inputs: each branch's `NOTES.md`, `metrics.json` and screenshots, plus the placeholder baseline in `placeholder/`.

| Option | Branch | Commit |
|---|---|---|
| 1 Procedural Plus | `bakeoff/procedural` | `96989ea` |
| 2 CC0 Photo | `bakeoff/photo` | `5a29f43` |
| 3 Kit Fixtures (Option 1 textures + Kenney door/window) | `bakeoff/kit` | `1d5ddbe` |

**Decision: a hybrid, "Photo + Kit".** It takes Option 2's photo floors and door veneer, Option 3's fitted Kenney door and window, and a reworked wall map. It does not take Option 1's canvas generator or its base-shade band.

---

## 1. Blind visual pass (metric 8)

The screenshots were exported to a scratch folder under shuffled letters (A, B, C). They were ranked before the mapping was revealed (A = photo, B = kit, C = procedural). There was one reviewer, not the 3 or more the doc asks for, so treat these scores as a single expert's view. The plan is still to run the 3-person blind ranking on the final hybrid (see §5).

Score: "looks like a real home", 1 to 5.

| Shot | A (photo) | B (kit) | C (procedural) | What decided it |
|---|---|---|---|---|
| cubicasa eye | **4** | 3 | 3 | A's floor reads as real multi-strip oak. B and C read as a game floor: uniform planks, hard dark seams, a visible 1 m repeat. A's walls are worse: a blotchy grid at 1 m, and darker. |
| cubicasa close-up (door) | 3.5 | **4** | 3 | B's lever handle is the strongest "this is a door" cue in the whole set. A has the better veneer and floor, but grey trim and no handle. C is a flat slab. |
| newri eye | **4** | 3 | 3 | Same pattern: A's floor and door look real, but its walls look like dirty concrete. B and C have cleaner white-ish walls and crisp white trim. |
| bungalow eye | **3.5** | 3 | 3 | A's floor wins. Its 12.5 cm tiles read as graph paper at distance. In C, the base-shade band leaves stipple and sliver artefacts at wall ends. |
| cubicasa aerial | 3 | 3 | 3 | No real difference at 45 degrees. Walls dominate, and they are mid-grey in every option. |
| kit window pose (B only) | | 4 | | A 9-slice casing and sash at 2 m wide. Clearly better than stretch, and better than the P0 boxes. |
| **Mean** | **3.6** | **3.3** | **3.0** | |

Wall brightness, from the mean 8-bit luminance of a wall patch in `cubicasa-eye` (x 150-550, y 250-450):

| Option | Mean luminance |
|---|---|
| Photo | 150 |
| Procedural | 166 |
| Placeholder | 163 |

A white wall in a real photo sits at about 200-230. **Every option reads as grey.** That is the lighting (hemisphere plus directional light, ACES, no environment map), not the texture.

What the eye takes from this:
* **Floors and door wood:** photo wins outright. This is the largest share of the realism gain.
* **Door hardware and window casing:** the kit wins. A handle is a tiny asset with a big effect.
* **Walls:** the photo plaster loses to the procedural plaster, because Plaster001's low-frequency blotches tile into a visible grid. Neither is good while the lighting renders walls grey.
* **Trim:** procedural's flat white paint beats photo's PaintedPlaster017, which renders grey.
* **The base-shade band** (procedural and kit) adds little in the shots and creates artefacts.

## 2. Ranking against the bake-off criteria

Gates (metrics 2, 4 and 12): **all three pass.**
* 0 validator errors.
* Materials 5-9 at most, and at most 2 alpha.
* Offline works. Option 1 passes by construction. Options 2 and 3 were measured offline with the service worker.
* Licences: Option 1 has no assets. Option 2 is CC0 (ambientCG), with a CREDITS file. Option 3 is CC0 (Kenney), with a CREDITS file.

| Criterion | 1 Procedural | 2 Photo | 3 Kit | Hybrid (expected) |
|---|---|---|---|---|
| 8 Visual (blind mean) | 3.0 | **3.6** | 3.3 | best of 2 and 3 (target 4 or more) |
| 9 Fit defects (cubicasa) | 0 | 0 | 0 (9-slice) | 0 |
| 1 GLB cubicasa / newri / bungalow | 792 / 286 / 193 KB | **571 / 239 / 143 KB** | 897 / 342 / 193 KB | about 600 / 270 / 140 KB |
| 3 Precache added | **+5.6 KiB** | +231 KiB (+124 KiB colour only) | +32.9 KiB | about +150 KiB |
| 11 Build ms (cubicasa) | 404 | **34** | 342 | under 60 |
| 11 First textured frame (cubicasa / newri / bungalow) | 486 / 365 / 315 (**fail**) | 482 / 266 / 206 (noisy, mostly SwiftShader upload) | 427 / 354 / 279 (**fail**) | under 300 (see §4) |
| Main-thread texture generation | 205-373 ms | 0 | 205-314 ms | 0 |
| 5 Draw calls vs. baseline | +1 | **-1 to 0** | +1 | +0 to +1 |
| Triangles (cubicasa) | 8,919 (band +2,700) | **6,219** | 9,763 | about 7,100 |
| 7 GPU texture memory | 5.8 MB | 5.6 MB | 5.8 MB | about 5 MB |
| Alpha materials used | 2 of 2 (glass, band) | **1** | 2 of 2 | 1 |
| Licence burden | none | CC0, 1 credits file | CC0, 1 credits file | CC0, 2 credits files |
| Code added (TS, approx.) | 15.7 KB, per-texel noise | 7 KB, a loader | 15.7 KB + 9 KB fitting | about 13 KB |
| Maintainability | Tuning noise by hand | Swap a JPEG | 9-slice bands hand-tuned to two Kenney files | Swap a JPEG. Bands are fixed to 2 committed files. |
| Main risks | First frame. The band is fragile in glTF (overlaps, z-fighting). | Async preload contract. Depends on `KHR_texture_transform`. | Async contract. Line-ending churn in the branch. Unindexed geometry. | Async contract (spec'd below) |

**Overall:**
1. **Hybrid (Photo + Kit)**
2. Photo
3. Kit
4. Procedural

Procedural is the leanest option on bytes, but it is last on looks and fails first frame by design. Kit is Procedural plus a handle, so it inherits Procedural's two problems. Photo is the best single option, and the kit fixtures fix its weakest close-up.

Why not keep the procedural textures for walls? Their only visual advantage is lower contrast and a whiter wall. A reprocessed photo map gets the same result with zero runtime cost (fix W1). That removes all 339 lines of `proceduralTextures.ts` and its 200-370 ms main-thread stall.

## 3. Chosen design: "Photo + Kit"

| Surface | Source | Material | Map |
|---|---|---|---|
| Walls (and lintels, sills, headers) | photo, **reprocessed** (W1) | `wall` | `plaster_color.jpg`, 2 m real size |
| Floors: bedroom, living, room, entry, null | photo `WoodFloor051` | `floor_wood` | `wood_color.jpg`, 1.8 m |
| Floors: kitchen, bathroom | photo, **larger tile** (W4) | `floor_tile` | `tile_color.jpg` |
| Floors: garage, storage, and the slab | photo `Concrete034` | `floor_concrete` / `slab` | `concrete_color.jpg` |
| Door leaf | photo `Wood049` rotated | `door` | `door_color.jpg` |
| Door and window frames, skirting | kit geometry, **flat paint** (W3) | `trim` | none, colour `#f1f0ec` |
| Door handle | kit geometry | `hardware` | none, metalness 0.35 |
| Window glass (sash in the kit model) | kit geometry | `glass` | none, opacity 0.3 |

Material budget: wall, slab, trim, door, glass, hardware, wood, tile and concrete. That is **9 at most, with 1 alpha**, which leaves one slot free. There is **no base-shade band.** It costs 2,700 triangles and about 170 KB of GLB on cubicasa, it takes the last alpha slot, it z-fights and stacks in glTF viewers (which cannot carry `polygonOffset`), and it barely shows. The 8 cm skirting provides the grounding.

## 4. Implementation spec

Work on `planliftar-mvp-pwa`. Do not merge any bake-off branch wholesale.

### 4.1 Take from `bakeoff/photo` (`5a29f43`)
`git checkout 5a29f43 -- <path>` for:
* `app/public/textures/{wood,door,concrete,tile,plaster}_color.jpg`. **Not** `paint_color.jpg` or any `*_rough.jpg` / `*_normal.jpg`.
* `app/public/textures/CREDITS.txt`. Prune it to the files that ship, and add the replacement tile id (W4).
* `app/scripts/textures/prepare_photo_textures.py`. Extend it for W1 and W4.
* `app/src/lib/three/photoTheme.ts`, then edit it:
  * Remove the `photo-pbr` variant, the `rough` and `normal` maps and `viewerOnlyMaps`.
  * Drop the `trim` map. Trim becomes a flat colour.
  * Add `hardware` (as in `kitTheme.ts`).
  * Add `fixtureModel` and `fixtureFit: "slice"`, and wire the kit preload into `preload()`, in parallel with the textures.
  * Rename the export to `homeTheme` with `name: "home"`.
* `app/src/lib/three/photoTheme.test.ts`. Adapt it to `homeTheme`: drop the pbr cases, and add a check that hardware is present when there are doors.
* The `BakeoffPage.tsx` metric fields (`preloadMs`, `firstTexturedFrameMs`, `themeStats`).
* The `vite.config.ts` glob. It ends up as `**/*.{js,css,html,png,jpg,glb,svg,woff2,json,webmanifest}`.
* **Do not take** the `exportGlb.ts` `viewerOnlyMaps` stripping. No map is viewer-only any more.

### 4.2 Take from `bakeoff/kit` (`1d5ddbe`), kit parts only
* Whole files:
  * `app/public/models/fixtures/{door,window}.glb`
  * `app/public/models/CREDITS.txt`
  * `app/scripts/models/normalize_fixtures.mjs`
  * `app/src/lib/three/kitFixtures.ts`
  * `app/src/lib/three/kitFixtures.test.ts`
* Hunks, applied by hand with `git diff -w 7a104cb 1d5ddbe -- <file>` as the reference:
  * `surfaceTheme.ts`:
    * `RequiredSurfaceKind` / `OptionalSurfaceKind`, with `OptionalSurfaceKind = "hardware"` only.
    * `themeHas`, and the hooks `preload`, `stats`, `fixtureModel` and `fixtureFit`.
    * The null-factory guard.
    * Register `home` in `THEMES`. Do **not** register `procedural`, `kit` or `kit-stretch`.
  * `wallLayout.ts`: `kitKinds`, `fixtureSlots()` and `usableOpenings()`. **Not** `baseShadeM` or `BASE_SHADE_PROUD_M`.
  * `buildFloorplanGroup.ts`: the `pieces` and `placeKitFixture` merge path. **Not** the `BASE_SHADE_M` import, the `baseShadeM` option or the band-opacity line.
  * `buildFloorplanGroup.test.ts`: the kit and budget cases, minus the band assertions.
* **Do not take:**
  * `proceduralTextures.ts`
  * `proceduralTheme.ts`
  * `kitTheme.ts` (its trim and hardware factories move into `homeTheme`)
  * the `kit-stretch` mode's registration (keep `FitMode` in code; `slice` is the default)
* **Line endings:** `1d5ddbe` rewrote `BakeoffPage.tsx`, `surfaceTheme.ts`, `wallLayout.ts` and `vite.config.ts` with CRLF. The base is LF. `git diff 7a104cb --stat` for those files must show only the real hunks. For example, `vite.config.ts` should be 1 changed line, not 186.

### 4.3 Fixes required

* **W1, wall repetition and tone.** In `prepare_photo_textures.py`, derive `plaster_color.jpg` from Plaster001:
  * Run a high-pass to remove the low-frequency blotches that make the 1 m grid (subtract a Gaussian blur of radius about 48 px at 512, then add back the mean).
  * Scale the remaining contrast to about 50 %.
  * Shift the mean to sRGB about `#ecebe7`.
  * Set the real size to **2 m** in `MAPS`.
  * If a grid is still visible in `cubicasa-eye`, swap the source for a finer CC0 plaster or paint set (record its id in CREDITS) instead of returning to canvas generation.
* **W2, walls read grey (lighting, not texture).**
  * In the in-app **viewer only**, set `scene.environment` from `PMREMGenerator(renderer).fromScene(new RoomEnvironment())`, created once and disposed with the viewer. Lower the directional light so that the walls come out white, not blown out.
  * In **AR**, raise the `HemisphereLight` sky colour and intensity until the walls are near white. Keep the directional light for form. WebXR light estimation is out of scope.
  * The GLB is unaffected: model-viewer and Scene Viewer bring their own environment.
* **W3, trim.** Trim is `MeshStandardMaterial({ color: 0xf1f0ec, roughness: 0.5, metalness: 0 })` with no map. This saves a map and fixes the grey PaintedPlaster frames.
* **W4, tile.** Replace Tiles107 (12.5 cm white tiles) with a CC0 ambientCG floor tile of 30-60 cm, in a neutral warm grey or beige with a visible grout line. Verify its seams on a 2x2 contact sheet as the photo branch did, and set its real size in `MAPS`.
* **W5, async contract.** This is the main engineering risk.
  * Start `homeTheme.preload()` once at app start, in `main.tsx` or the theme module.
  * Every consumer awaits it before its first build: the viewer, the AR controller and `planToGlb` / `exportGlb`.
  * Preload never rejects. On failure, the build falls back to flat colours and the P0 box fixtures.
  * The viewer also rebuilds once if it built before preload resolved, so a cold start cannot get stuck untextured.
  * Add a test: a build before preload gives box fixtures and fallback colours, and a build after preload gives maps and kit pieces.
* **W6, kit GLB weight.** Run `mergeVertices` on each kit piece once at load (in `kitFixtureFromScene`, after dropping UVs), or index the pieces. This claws back most of the kit's +105 KB on cubicasa.
* **Default.** Set `DEFAULT_THEME = homeTheme` once the acceptance checks below pass. Keep `placeholder` registered for comparison.
* **Won't fix: the JPEG re-encode quality.** `GLTFExporter` re-encodes at Blink's default of q0.92, which is +23 % (about +24 KB on cubicasa). That is far under budget, and the generation loss is not visible. Revisit only if the GLB nears 2 MB.
* **Deferred, not in this change:**
  * double doors above about 1.2 m
  * the hinge side
  * separate exterior wall materials
  * furniture
  * per-room-type classifier quality (cubicasa rooms are `null`, so all wood)

### 4.4 Acceptance criteria

Run `pnpm bakeoff home` and `pnpm lint && pnpm test && pnpm build`. Commit `docs/research/bakeoff/home/` with `NOTES.md`, `metrics.json` and the screenshots, including the kit's `window` pose.

| # | Check | Target |
|---|---|---|
| 2 | glTF Validator, all 3 plans | 0 errors and 0 warnings. `extensionsUsed` is `KHR_texture_transform` at most. At most 9 materials, at most 1 alpha. Images are `image/jpeg` only. 1 UV set. |
| 4 | Offline: service worker installed, `setOffline(true)`, cubicasa and bungalow | `mapsFailed: []`, `fixturesFailed: []`, same triangles as online |
| 12 | Licences | `textures/CREDITS.txt` and `models/CREDITS.txt` list every shipped file, all CC0 |
| 1 | GLB size | cubicasa **at most 650 KB**, newri at most 300 KB, bungalow at most 180 KB |
| 3 | Precache added vs. 2,614,181 B | **at most 200 KiB** |
| 11 | Build ms | at most 60 ms on every plan (no main-thread texture generation) |
| 11 | First textured frame (preload + build + render) | **under 300 ms** on every plan: the median of 5 runs, warm service worker, desktop with hardware GPU. SwiftShader numbers are recorded but not gated. |
| 5 | Draw calls | at most baseline + 2 |
| 7 | GPU texture memory | at most 8 MB |
| 9 | Fit (cubicasa and newri close-up and window) | 0 defects: no floating fixtures, no z-fighting, frames inside the openings |
| 8a | Wall tone | mean luminance of 190 or more on the `cubicasa-eye` wall patch (x 150-550, y 250-450), against 150 for photo today, with no visible 1 m grid |
| 8b | Blind ranking | 3 or more people, 1-5 "looks like a real home", hybrid against placeholder and photo: the hybrid has the highest mean |
| 6 | Mobile AR (reference phone, once) | at least 50 fps average over 30 s with walls filling the view. Scene Viewer opens the exported GLB. |

---

## Outcome

Implemented on `planliftar-mvp-pwa` as the `home` theme, now `DEFAULT_THEME` for the 3D viewer, AR and GLB export (`placeholder` stays registered). Details and the full table: `home/NOTES.md`, `home/metrics.json`, screenshots in `home/` (including the `window` pose).

Choices made inside the spec:
* **W1:** Plaster001 kept (high-pass, contrast x0.5, mean `#ecebe7`, 2 m). No grid in `cubicasa-eye`, so no source swap.
* **W4:** Tiles139 (ambientCG, CC0): 6 x 6 beige stone tiles on a 2 m set, so 33 cm tiles with grout. Checked on a 2x2 contact sheet.
* **W2:** `lib/three/lighting.ts`: RoomEnvironment (PMREM) + hemisphere 0.9 + sun 0.7 in the viewer; hemisphere 3.2 (ground `#b0b0b0`) + sun 0.8 in AR.
* **W5:** preload starts at idle time after the shell renders; the viewer waits (1.5 s grace) and rebuilds once if early, AR waits up to 4 s before offering Start AR, `planToGlb` always awaits.

Measured (`pnpm bakeoff home`):

| # | Target | Measured | |
|---|---|---|---|
| 2 | 0 errors / 0 warnings, <= 9 materials, <= 1 alpha, jpeg, 1 UV set | 0 / 0; 7 / 8 / 5 materials; 1 alpha; jpeg; 1 UV set | pass |
| 4 | offline, no failures, same triangles | cubicasa and bungalow: 5/5 maps, both models, same triangles | pass |
| 12 | CREDITS for every file, CC0 | 5 ambientCG + 2 Kenney, also on How it works > Credits | pass |
| 1 | <= 650 / 300 / 180 KB | 591.8 / 263.3 / 143.7 KB | pass |
| 3 | <= +200 KiB precache | +158.6 KiB (2,776,543 B) | pass |
| 11 | build <= 60 ms | <= 25 ms | pass |
| 11 | first textured frame < 300 ms (median of 5, warm SW, hardware GPU) | 59 / 89 / 67 ms (RTX 3050 Laptop, D3D11); SwiftShader 1.4 s, recorded only | pass |
| 5 | draw calls <= baseline + 2 | 7 / 8 / 5, equal to placeholder | pass |
| 7 | <= 8 MB GPU textures | 4.9 / 6.3 / 4.9 MB | pass |
| 9 | 0 fit defects | none seen in close-up and window shots | pass (by eye) |
| 8a | wall luminance >= 190 | 211.8 on `cubicasa-eye` (photo: 150) | pass |
| 8b | 3-person blind ranking | not run | open |
| 6 | phone AR >= 50 fps, Scene Viewer opens GLB | not run (needs the reference phone) | open |
