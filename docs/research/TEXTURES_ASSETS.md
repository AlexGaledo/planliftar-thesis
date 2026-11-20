# Textures and pregenerated assets: options and bake-off plan

Status: research only. No app code changed. Date: 2026-11-21. Branch `planliftar-mvp-pwa`.

Goal: make the extruded floor-plan model look like a real building. That means distinct
surfaces for walls, floors (per room type), doors and windows, in the viewer, in WebXR AR,
and in the exported GLB (model-viewer / Scene Viewer). It must still work offline from the
PWA precache and run on a mid-range Android phone.

---

## 1. What the code does today

| Area | Current state | File |
|---|---|---|
| Wall material | One `MeshLambertMaterial`, white, with a shared 256x256 procedural canvas "plaster" texture (random speckle plus 4 faint horizontal lines). One tile per metre through `scaleBoxUVs`. | `app/src/lib/three/materials.ts` |
| Wall geometry | One `BoxGeometry(thickness, height, length)` per wall, merged into one mesh (1 draw call). The walls have no openings. | `app/src/lib/three/buildFloorplanGroup.ts` |
| Floor slab | One box under the footprint. Lambert `0x9a9a9a` with the same plaster map. | same |
| Room floors | `ShapeGeometry` per room with a flat pastel colour from `ROOM_COLORS[i]`. `room.type` is stored in `userData` and never used for appearance. Rooms render only when `includeRooms` is true (viewer and GLB). AR leaves them out. | same |
| Fixtures (doors and windows) | **Never rendered.** The client only reads them in `gapClosure.ts`, to decide whether a wall gap is a doorway. | `app/src/lib/plan/gapClosure.ts` |
| AR lighting | `HemisphereLight(2.0)` plus `DirectionalLight(1.1)`. No environment map. | `app/src/features/ar/ArController.ts`, `deliverables/livemap/ar.html` |
| GLB export | three r160 `GLTFExporter`, binary, same group. | `app/src/lib/three/exportGlb.ts` |
| PWA precache | `globPatterns: **/*.{js,css,html,png,svg,woff2,json,webmanifest}`, max 5 MB per file. **`jpg`, `webp`, `ktx2` and `glb` are not precached.** The current build is about 2.7 MB. | `app/vite.config.ts` |

### Export problems the textures work will run into (found in three r160 `GLTFExporter.js`)

1. **Lambert exports as half-metal.** For any material that is not `MeshStandardMaterial` or `MeshBasicMaterial`, the exporter writes `metallicFactor: 0.5, roughnessFactor: 0.5` (lines 1437-1460). Every wall and floor in today's GLB is therefore 50 % metallic. Without an environment map, model-viewer and Scene Viewer render metal dark and grey. Switch to `MeshStandardMaterial({ metalness: 0, roughness: 0.9 })`. This is a quick win that does not depend on which option wins.
2. **Every texture is written as PNG.** That happens unless `texture.userData.mimeType = 'image/jpeg'` is set. WebP is forced back to PNG (line 1392). The current 256 px noise canvas is about 190 KB as PNG, because noise does not compress. Opaque textures should be marked as JPEG.
3. **KTX2 textures are decompressed on export.** `CompressedTexture` goes through `decompress()` and comes out as PNG (line 1384). So KTX2 helps only the in-app GPU. It makes the GLB larger, not smaller.
4. **`InstancedMesh` exports as `EXT_mesh_gpu_instancing`.** Scene Viewer does not list that extension (see section 3), so fixtures must be cloned meshes in the export group, not instances.
5. **Scene Viewer recommends at most 10 materials, with one mesh per material.** The CubiCasa sample already produces 14 room materials plus walls and slab, which is 16. Room floors need **one material per room type**, merged per type, not one per room.

### Fixture data: what it supports and what is missing

The source is `backend/planliftar_engine/cubicasa.py:375-392`. The sample is `app/public/samples/cubicasa.json` (8 doors, 8 windows). `newri-reference.json` has 7 doors and 2 windows. `bungalow.json` has none.

| Field | Meaning in practice | Can we rely on it? |
|---|---|---|
| `position {x,y}` | Centre of the CubiCasa icon polygon, in plan px | Yes, it is the same pixel space as the walls. |
| `scale.width` | **`width_px * 0.01`**: a placeholder ratio, **not metres**. Real width is `(scale.width / 0.01) / ppm` m. (`metadata.pixel_to_meter_ratio`, when present, is that same 0.01.) | Usable after conversion. Example: the CubiCasa door `0.78` means 78 px. |
| `scale.height` | Hardcoded: 2.1 for doors, 1.2 for windows | No. It is a constant. |
| `scale.depth` | Hardcoded to 0.1 | No. Use the wall thickness of the host wall instead. |
| `rotation_degrees` | `90` if the bounding box is taller than it is wide, else `0` | Only 0 or 90. Diagonal walls get the wrong orientation. Prefer the **host wall direction**. |
| Window sill height | Missing | Assume 0.9 m. |
| Door hinge side and swing direction | Missing (the CubiCasa icon has the arc, but the arc is not exported) | No. Render a closed or ajar slab, with no swing arc. |
| Host wall id | Missing | Compute it client-side: project onto the nearest wall within about `max(thickness, width/2)` (the same test as `gapClosure.fixturesOn` and the server's `carve_doors`). |
| Duplicates and fragments | `window_001` and `window_002` are identical in `cubicasa.json`. `newri-reference` has 3 doors of width 0.22 a few px apart, which is one door split into fragments. | Dedupe by position (within about 5 px). Merge collinear fragments on the same wall. |
| Room `type` | `bedroom`, `living_room`, `bathroom`, `kitchen`, `entry`, `storage`, `garage`, `room`. **`null` on every room in the CubiCasa sample.** | Needs a fallback material for an unknown type. |

**Do fixtures cut openings in the walls today?** Partly, and only on the server.
`backend/planliftar_engine/geometry.py:carve_doors` splits wall runs where a **door** crosses them. This leaves a **full-height gap with no lintel**. Windows stay solid wall. The client adds no openings, no lintels, no sills and no frames. So the 3D model today shows doors as floor-to-ceiling slots and windows as nothing at all.

Before any door or window visual can work, the client needs an opening pass, which the shortlist calls step P0:

* **Doors:** find the carved gap (or the host wall), then add a lintel box from `doorH = 2.1` up to `wallH`.
* **Windows:** split the host wall into left and right pieces, a sill box (0 to 0.9 m) and a lintel box (2.1 m to `wallH`).

These are all boxes, so they stay in the single merged wall geometry and keep `scaleBoxUVs`. No CSG library is needed.

---

## 2. Options

### A. Procedural canvas textures per surface (extend today's approach)
Draw 4 to 6 small canvases at startup: plaster wall, wood planks, ceramic tile grid, concrete or exterior render, door wood. Assign them by surface type and by room `type`.
* **Visual gain:** medium. It reads as "materials", but not as photographs. Planks and tile grids are the most convincing at 1:1 scale, because joints give a scale cue and help ARCore tracking.
* **Bundle and offline:** about 3-5 KB of JS. No network request, and nothing to add to the precache.
* **GPU:** 256-512 px maps, about 0.3-1.3 MB of VRAM each with mipmaps. Negligible.
* **GLB:** the canvases export as JPEG if `userData.mimeType` is set, roughly 20-60 KB each at 512 px. Uses no extensions apart from `KHR_texture_transform` (only if `repeat` is used; `scaleBoxUVs` avoids it).
* **Licence:** none needed.
* **Effort:** low, about 1 day. Rooms need UVs in metres (`ShapeGeometry` UV = world XY, scaled per metre).
* **Note:** `Math.random()` gives a different texture on every load. Use a seeded PRNG so screenshots are reproducible.

### B. CC0 PBR texture sets (ambientCG, Poly Haven), bundled small
Take the `Color` map (plus optional `Roughness` and `NormalGL`) of about 5 materials at 512 px (1K for floors), and convert them to JPEG or WebP at about q80.
* **Visual gain:** high in the desktop viewer. Medium in AR, where the camera feed and phone lighting flatten fine detail. A normal map is mostly wasted under a hemisphere light with no environment map.
* **Bundle and offline:** about 30-80 KB per 512 px colour map (JPEG q80). Five colour maps come to about 250-400 KB, and adding roughness maps takes it to about 0.6 MB. `vite.config.ts` `globPatterns` **must add `jpg`/`webp`**, or the textures are not available offline.
* **GPU:** 5-10 maps x about 1.3 MB comes to about 7-13 MB of VRAM uncompressed. That is fine on a mid-range Adreno 6xx or Mali-G57. The real cost is extra texture fetches per fragment when walls fill the screen at a DPR of 2. Skip the normal and roughness maps in AR.
* **GLB:** embeds the same JPEGs. Colour-only adds about 300 KB, and with roughness about 600 KB. That is well under Scene Viewer's recommended 10 MB and the 2048 px texture limit.
* **KTX2 / Basis:** model-viewer supports it, but Scene Viewer's documented extension list is only `KHR_materials_unlit` and `KHR_texture_transform`. There is a third-party report that `KHR_texture_basisu` breaks Scene Viewer AR, and r160's exporter decompresses KTX2 to PNG anyway. KTX2 is therefore **in-app only**, and it costs a 500 KB `basis_transcoder.wasm` in the precache. Not worth it at this scale.
* **Licence:** ambientCG and Poly Haven are both **CC0**, with no attribution required. Credit them in the thesis anyway.
* **Effort:** low to medium, about 1-2 days. A one-off script fetches, resizes and compresses the textures into `app/public/textures/` (a `sharp` or `squoosh` CLI run, done once and committed). Also switch to `MeshStandardMaterial`.

### C1. Pregenerated low-poly door and window GLBs (CC0 kits)
Use, for example, the **Kenney Furniture Kit** or Building Kit (CC0; check that its door and window pieces fit) or **Quaternius** (CC0 on its own site). **Poly Pizza** is mixed CC0 and CC-BY with the licence shown per model, so check each one and record CC-BY credits.
* **Visual gain:** medium to high for fixtures, if the style matches. Kit assets are stylised "game low-poly" and can clash with photo textures.
* **Bundle:** about 20-150 KB per GLB. Two to four assets come to about 100-400 KB. Add `glb` to `globPatterns`.
* **Fitting:** a fixed-proportion asset has to be scaled non-uniformly to the detected width, the wall thickness and the opening height. Frames stretch visibly when the widths vary (0.46 m to 1.2 m in the samples). The model must be measured and pivoted once per asset.
* **GPU:** trivial, about 100-1,000 triangles per fixture.
* **GLB:** clone the meshes into the group, not `InstancedMesh`. The asset materials add to the 10-material budget. Merge or reassign to a shared palette.
* **Effort:** medium, about 2 days, including the async loader in the synchronous `buildFloorplanGroup`. Preload the assets, then build.

### C2. Procedural door and window geometry
* **Door:** frame (3 thin boxes) plus a leaf box (`width - 2*frame`, 40 mm thick, closed or 15 degrees ajar) plus a handle.
* **Window:** frame (4 boxes) plus a mullion plus a glass plane (`MeshStandardMaterial`, `transparent`, opacity 0.3, `depthWrite: false`) plus the sill.

All of this is built from the fixture width, the host wall thickness and the hardcoded heights.
* **Visual gain:** medium. Clean "architectural model" look that always fits exactly.
* **Bundle:** about 2-4 KB of JS. GPU cost is trivial. GLB adds about 1-3 KB of geometry per fixture.
* **Glass:** each transparent material counts against Scene Viewer's limit of 2 alpha materials, so use one shared glass material. In AR, glass through which the camera feed is visible reads well.
* **Effort:** low to medium, about 1-1.5 days. It depends on the P0 opening pass.

### D. Other techniques considered
| Technique | Verdict |
|---|---|
| **Vertex colours** (per-room tint, fake AO at wall bases) | Cheap and works in WebXR and model-viewer. **Scene Viewer docs: vertex colours not supported.** Use only for in-app effects. |
| **Baked ambient occlusion** (darken wall bottoms and corners) | A big realism gain for a box model. Simplest form: a second "skirting" gradient strip texture, or a per-face UV-mapped gradient. A real lightmap needs `uv2`, but Scene Viewer allows **1 UV set (hard limit)**, so only bake AO into the base colour of a shared atlas. Worth trying as a 1-hour add-on on top of A or B (a dark gradient band 0-15 cm above the floor). |
| **Skirting boards and ceiling trim** (thin boxes along the wall base) | Very cheap, adds a strong scale cue, and merges into the wall mesh. Recommended for any option. |
| **Matcap** (`MeshMatcapMaterial`) | Stylised. Not exportable to glTF (it becomes a default PBR material). Reject. |
| **Environment map** (`RoomEnvironment` + PMREM) | Makes `MeshStandardMaterial` look correct in the viewer. In AR, WebXR lighting estimation is the proper route. A PMREM costs about 1-2 ms on load. Viewer only. |
| **KHR_materials_unlit** with baked lighting | Consistent look everywhere and Scene Viewer supports it, but it loses the AR light response. Fallback only. |
| **Generated textures (AI image models)** | Licence and reproducibility are unclear for a thesis. Reject. |
| **Furniture per room type** (bed in a bedroom, and so on) | High "looks real" value, but needs placement logic and is guesswork without detection. Out of scope. Revisit after doors and windows. |

### Options table

| | Visual gain | Precache added | AR GPU (mid Android) | GLB added (CubiCasa plan) | Scene Viewer safe | Licence | Effort |
|---|---|---|---|---|---|---|---|
| A procedural canvases | Medium | about 4 KB JS | Negligible | about 100-250 KB (JPEG) | Yes | n/a | Low |
| B CC0 PBR, colour only, 512 JPEG | High (viewer), medium (AR) | about 300 KB | Low | about 300 KB | Yes | CC0 | Low-Med |
| B + roughness/normal | High+ (viewer only) | about 0.6-0.9 MB | Medium (extra fetches) | about 0.6-0.9 MB | Yes | CC0 | Med |
| B as KTX2 | Same as B | +500 KB transcoder | Lowest VRAM | **PNG (bigger)** | **No / unverified** | CC0 | Med |
| C1 kit GLB fixtures | Med-High (style risk) | 100-400 KB | Negligible | 50-300 KB | Yes (clone, no instancing) | CC0 / check CC-BY | Med |
| C2 procedural fixtures | Medium | about 3 KB JS | Negligible | about 20-50 KB | Yes (1 alpha material) | n/a | Low-Med |
| D baked AO band + skirting | Medium (cheap) | about 1 KB | Negligible | Small | Yes | n/a | Low |
| Material fix (Standard, metalness 0) | Medium (GLB correctness) | 0 | 0 | 0 | Yes | n/a | Trivial |

GLB sizes are estimates from the texture counts above, not measurements. The bake-off measures them.

---

## 3. Format and licence facts (sources)

* Scene Viewer glTF requirements: glTF 2.0 / GLB with **only** `KHR_materials_unlit` and `KHR_texture_transform`. Recommended under 10 MB (the validator errors above 15 MB). Textures at most 2048x2048, PNG or JPG ("JPGs preferred when there is no transparency"), sRGB. Recommended at most 10 materials (2 alpha), 1 UV set, **no vertex colours**, 100k triangles recommended (30-50k ideal). Sources: https://developers.google.com/ar/develop/scene-viewer and https://developers.google.com/ar/develop/java/scene-viewer
* `KHR_texture_basisu` in Scene Viewer AR: reported as unsupported by egjs-view3d (https://naver.github.io/egjs-view3d/docs/options/model/ktxPath). Not in Google's list.
* model-viewer decodes Draco, KTX2 (Basis) and Meshopt (Meshopt needs a decoder set up): https://modelviewer.dev/examples/loading/ and https://opensource.googleblog.com/2021/02/basis-universal-textures.html. That covers only model-viewer's own WebGL view and WebXR mode, not Scene Viewer.
* ambientCG: CC0 1.0, attribution not required. https://docs.ambientcg.com/license/
* Poly Haven: CC0. https://polyhaven.com/license
* Kenney: CC0, attribution not required. https://kenney.nl/support. Furniture Kit page: https://kenney.nl/assets/furniture-kit
* Quaternius: CC0 (author's site). Poly Pizza hosts a mix of CC0 and CC-BY 4.0 with the licence shown per model, so check each model page.
* All of these are compatible with thesis use. Credit CC-BY assets as "Title" by Author (URL), CC-BY 4.0.

---

## 4. Shortlist for a head-to-head prototype

All three options share a common **P0**. Prototype P0 once on a scratch branch, then build each option on top of it.

**P0, shared base (not judged):**
1. Switch the wall, slab and room materials to `MeshStandardMaterial({ metalness: 0, roughness: 0.9 })`. Set `texture.userData.mimeType = 'image/jpeg'` on opaque maps.
2. Normalise fixtures:
   * `widthM = (scale.width / 0.01) / ppm`.
   * Dedupe positions within 5 px.
   * Assign each fixture to its nearest wall when the perpendicular distance is at most `max(thickness, widthPx/2)` and the projection lies inside the segment. Fixtures with no host wall are dropped and logged.
   * Take orientation from the host wall, not from `rotation_degrees`.
3. Openings, as merged boxes:
   * Door: a lintel from 2.1 m to `wallH`. If the wall was not carved server-side, also split it.
   * Window: split the wall, then add a sill (0 to 0.9 m) and a lintel (2.1 m to `wallH`).
   * Keep `scaleBoxUVs` on every new box.
4. Group room floors **by `type`** into one merged mesh per type, with unknown or `null` types in one group. Room UVs are in metres.
5. Use a seeded PRNG for every procedural texture.

The **material budget** for every option is at most 10: wall, slab or exterior, 4 floor types (wood, tile, carpet or default, concrete), door, frame, glass.

### Option 1, "Procedural Plus" (A + C2 + D)
* **Textures** (canvas, 512 px, seeded):
  * Wall plaster: the current texture, regenerated at 512 px.
  * Wood planks: 4 planks of 0.18 m across a 1 m tile, colour jitter, dark 1 px joints, tile = 1 m.
  * Ceramic tile: a 30 cm grid, so 3.33 cells per metre. Use a 0.6 m tile repeat or redraw so that 1 m holds whole cells. Light grout.
  * Concrete: low-frequency noise.
  * Door wood: vertical grain.
* **Mapping:**

  | Room type | Floor |
  |---|---|
  | `bedroom`, `living_room`, `room`, `entry`, `null` | wood |
  | `kitchen`, `bathroom` | tile |
  | `garage`, `storage` | concrete |
  | (slab) | concrete |

* **Fixtures:** procedural, as in C2. Frame 50 mm by the wall thickness. Door leaf 40 mm, closed. Window with one mullion and a shared glass material (opacity 0.3).
* **Extras:** a skirting box 8 cm high and 1 cm proud of both wall faces, plus an AO band (a gradient from 0 to 15 cm, multiplied into the wall canvas bottom row). Because the wall UV tiles every metre vertically, the band has to be a separate thin box with its own gradient texture, or the wall needs a v-clamped second material. The prototype picks the separate box.

### Option 2, "CC0 Photo PBR" (B + C2 + D-skirting)
* The geometry and fixtures are identical to Option 1. Only the textures are swapped.
* **Assets:** from ambientCG, 1K-JPG downloads resized to 512 px. For each, choose a CC0 set that is neutral in colour and has low-contrast seams.
  * Walls: `Plaster00x`.
  * Floors: `WoodFloor0xx`, `Tiles0xx`, `Concrete0xx`.
  * Doors: `Wood0xx`.
  * Record the exact asset ids in `app/public/textures/CREDITS.txt`.
* Run a one-off script in `scripts/`. It writes `*_color.jpg` (q80), plus `*_rough.jpg` for the floors only. Add `jpg` to the Workbox `globPatterns`.
* **Variant 2b (flag):** add roughness maps and normal maps in the viewer only. AR always uses colour only.
* **Loading:** use `TextureLoader` preloaded before the build. If a texture fails to load, fall back to the Option 1 canvas, so the build never blocks or fails offline.

### Option 3, "Kit Fixtures" (A textures + C1)
* Wall and floor textures are as in Option 1, so this option isolates the fixture question.
* **Doors and windows:** CC0 GLBs, for example a Kenney Furniture/Building Kit door and window, or Quaternius. Store them in `app/public/models/fixtures/{door,window}.glb`, each normalised once in Blender or with `gltf-transform` to a 1 m width, 1 m height and 1 m depth unit box with its pivot at the bottom centre. Scale `(widthM, doorH or winH, wallThicknessM)` at runtime. Clone them, do not instance them. Remap the asset materials onto the shared door, frame and glass materials so the budget holds.
* The P0 openings still apply. The asset only fills the hole.

---

## 5. Bake-off: criteria and how to measure

Prototype each option on a throwaway branch or behind `?tex=1|2|3`. Use the same three plans: `cubicasa.json` (with fixtures), `newri-reference.json` (fragmented doors and typed rooms) and `bungalow.json` (typed rooms, no fixtures). Use a fixed ppm and a wall height of 2.5 m.

| # | Metric | How | Pass / target |
|---|---|---|---|
| 1 | GLB size | `planToGlb(...)` then `blob.size`, per plan | Under 2 MB (Scene Viewer recommends 10 MB) |
| 2 | Scene Viewer validity | Inspect the GLB JSON `extensionsUsed`, material count, alpha material count, UV sets, and texture dimensions. Then run the GLB through the Khronos glTF Validator (CLI or https://github.khronos.org/glTF-Validator/). | 0 errors. Only `KHR_texture_transform` or unlit extensions. At most 10 materials, at most 2 alpha. |
| 3 | Precache added | Compare the `vite build` precache manifest total with the baseline (`workbox` prints "precache N entries (X KiB)"). Run it once per option, as a light single build. | Under 600 KB |
| 4 | Offline | DevTools offline mode, hard reload, open the viewer: are the textures present? | Must pass |
| 5 | Desktop FPS | Viewer, orbit for 10 s, `renderer.info` plus a rAF-based FPS counter. Record draw calls, triangles, textures. | Draw calls at most baseline + 8 |
| 6 | Mobile AR FPS (once, on the reference phone) | WebXR session, walls filling the view, 30 s, average and p5 frame time from the `XRFrame` timestamps. Repeat in model-viewer WebXR. | At least 50 fps average, no change in tracking loss |
| 7 | GPU memory | Sum of texture bytes (`w*h*4*1.33` per map) | Under 16 MB |
| 8 | Visual realism | Playwright screenshots from 3 fixed camera poses (aerial 45 degrees, eye level 1.6 m in a room, close-up of a door or window). Use the existing `pnpm screenshots` or e2e setup. Show the images side by side, blind-ranked by 3 or more people on a 1-5 scale for "looks like a real home". | Highest mean wins |
| 9 | Fit correctness | In the close-up shots: do the doors and windows sit inside their openings, aligned to the wall, with no z-fighting and no fixtures floating where no wall is? | 0 defects on the CubiCasa plan |
| 10 | Lighthouse (PWA and performance) | `lighthouse --preset=desktop` and mobile on the viewer route, run once each | Performance drop at most 5 points from the baseline |
| 11 | Load time to first textured frame | `performance.now()` from the build start to the first render with textures | Under 300 ms on desktop |
| 12 | Licence hygiene | A CREDITS file exists. Every asset is CC0, or CC-BY with a credit line. | Must pass |

**Decision rule:** metrics 2, 4 and 12 are gates. Among the options that pass, rank by visual realism (8), then by fit correctness (9), then by GLB and precache size (1, 3). Expected outcome to test against: Option 2 wins the viewer screenshots, but Option 1 is close in AR at a tenth of the size. Option 3 looks best only when the asset style matches, and it scales poorly to unusual widths.

## 6. Open questions
* Do wall heights other than 2.5 m break the 2.1 m door lintel? (If `wallH` is 2.1 m or less, skip the lintel.)
* Should exterior walls (`wall.exterior`) get a different outer-face material? With merged boxes, the two faces of a wall share one material, so this needs a second merged mesh with only the exterior walls. That adds material and mesh cost.
* The server could export the `width_px` and the door-swing arc directly. That would remove the 0.01 placeholder and allow hinge side to be modelled. This is a small backend change for later.
