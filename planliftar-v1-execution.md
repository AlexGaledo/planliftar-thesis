# PlanLiftAR v1 — Execution Plan

Four phases, strictly ordered. Each phase has one deliverable and one gate; a
phase does not start until the previous gate passes.

## Delegation model

- **Fable (orchestrator)** — architecture, phase gating, all reviews, and the
  judgment-heavy code only: nearest-label wall derivation, consensus scoring +
  routing, acceptance barrier, door carving. Never delegated.
- **Sonnet subagent** — self-contained non-trivial chunks with a clear spec:
  QA visualization cells, GLB extrusion (Cell 11), helper functions
  (`pairwise_iou`, `hungarian_match`, `draw_virtual_wall`), Unity C# scripts
  from a written spec. Fable reviews every diff before it lands.
- **Haiku subagent / opencode MCP (`delegate_code_task`)** — trivial +
  mechanical work: config cells, constants, kernel-metadata.json, renames,
  copy, markdown, plotting tweaks. Fable reviews diff; if diff wrong or
  `no_changes`, Fable does it directly (one retry max per global policy).
- Anything spanning files, touching the export contract, or where "what is the
  right change" is part of the question: Fable, no delegation.

## Phase 1 — Geometry core (plan Cells 0–6)

Scaffold `planliftar-geometry-v2.ipynb` + `kernel-metadata.json`, push via
Kaggle CLI. Prob-map inference, hysteresis healing, thickness-relative sealing,
virtual door seals, rooms-first extraction, nearest-label wall derivation.
Cache `wall_prob.npy` as private dataset after first GPU run; iterate CPU-only.

- Delegate: Cells 0–1 (unchanged copies), config cell, metadata, QA plots.
- Fable: Cells 4–6 logic, review all.
- **Gate:** sample plan yields closed room polygons, component-count healing
  metric logged, zero stitching code in repo.

## Phase 2 — Consensus, barrier, export (plan Cells 7, 9, 10; Cell 8 optional tail)

IoU cross-check vs CubiCasa, self-contained invariants, routing rule (merged
open-plan accepted), acceptance report, JSON export with door spans carved out.
Watershed (Cell 8) last, only if reject rate on samples demands it.

- Delegate: helper functions, report serialization, three-panel QA figure.
- Fable: routing logic, invariants, carve-out, review.
- **Gate (amended 2026-08-29, user decision):** barrier correct on both paths
  (sample accepted; corrupted plan rejected with machine-readable reasons),
  consensus computed and reported, doorways open in exported walls. The 0.7
  consensus threshold is a config value whose calibration is deferred to
  multi-sample validation — open-plan and glass/sauna geometry cap the score on
  plan 6044 (honest 0.30). A second, simpler sample run sanity-checks that
  consensus rises when rooms partition cleanly.

## Phase 3 — Stage A AR proof (Cell 11 + phone)

GLB extrusion cell (trimesh; walls as boxes, fixed height, door gaps; baked
handwritten scale), host GLB, open via Scene Viewer link on Android phone.
Phone prereqs: ARCore support check, Google Play Services for AR, Chrome.

- Delegate: extrusion cell (Sonnet, spec'd), model-viewer HTML page (opencode).
- Fable: geometry-to-mesh mapping review on the actual sample.
- **Gate:** floorplan walls stand in AR via live camera, walkable, proportions
  correct, doorways open. THE v1 visible milestone.

## Phase 4 — Stage B Unity dev build

Unity + AR Foundation (Android). REST client against mock server first (static
JSON file server), then real contract. Mesh builder consumes existing schema.
Tap-floor anchor, single-dimension scale input, dev APK sideloaded.
Also: live minimap — orthographic top-down camera over the placed model rendered
to a corner RenderTexture panel, with a player marker + heading cone driven by
the AR camera pose in anchor space (user request 2026-08-29). DONE as scaffold:
MinimapController.cs + MinimapUI.cs, culling-mask sharing, OnFloorPlanPlaced hook.
Also: laptop live-map companion (user request 2026-08-29) — the app streams its
plan-space pose over the LAN (WebSocket), a small server on the laptop serves a
browser page drawing the exported floorplan JSON with a live player dot/heading
cone. Spectator top-down view while the phone walks the model. Depends on the
Stage B app; impossible under Scene Viewer (no pose access).
Placement origin polish: mesh builder currently maps plan px (0,0) (top-left of
drawing) to the tap anchor — recenter so the tap = plan footprint center (as the
GLB already does), or let the user place by a chosen entry point such as a door
fixture. (User question 2026-08-29.) Walls render
translucent on purpose (user preference from Stage A).

- Delegate: C# boilerplate (plane detection setup, UI input field, REST client)
  as spec'd Sonnet tasks; project settings via opencode.
- Fable: mesh builder integration, anchor/scale math, review.
- **Gate:** APK on phone places geometry on detected floor, one typed dimension
  scales model 1:1, stable anchor while walking, doorways passable.

## Standing rules

- Every delegated diff reviewed by Fable before commit. Wrong diff → Fable
  redoes directly, no second retry.
- If opencode returns `every model in the fallback chain failed`: stop
  delegating for the session, Fable writes directly.
- Kaggle GPU only for Phase 1 first run + occasional re-inference; everything
  else CPU or local.
- Phase gates are hard: no Phase N+1 work while gate N unmet.
