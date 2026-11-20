# PlanLiftAR HTTP + WebSocket API

The contract between the PWA in `app/` and the inference server built from
`backend/planliftar_engine`. Both sides implement exactly this. Change it here first,
then both clients.

All paths are relative to the server origin. The frontend's default base is
same-origin `/api`; a LAN laptop server such as `https://192.168.1.42:8443` can be set
in the app's Settings, in which case requests go to `https://192.168.1.42:8443/api/...`.

## CORS

A Vercel-hosted frontend calls the laptop cross-origin, so the server must answer
`OPTIONS` preflights and send:

```
Access-Control-Allow-Origin: <request Origin> (or *)
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

An `https` frontend cannot call an `http` server (mixed content), so a LAN server used
from a deployed frontend must serve TLS with a certificate the device trusts.

## `GET /api/health`

```json
{ "ok": true, "device": "cuda", "engine_version": "0.1.0",
  "models": { "mitunet": true, "cubicasa": true } }
```

`device` is `"cuda"` or `"cpu"`. `models.*` is `false` when that model's weights are
not loaded (the job then runs without it or fails, see `error`).

## `POST /api/jobs`

`multipart/form-data`:

| Field | Required | Notes |
| --- | --- | --- |
| `image` | yes | `image/png`, `image/jpeg` or `image/webp`, at most 15 MB |
| `options` | no | JSON string, e.g. `{"use_cubicasa": true}` |

Responses:

- `202 {"id": "<job id>"}`
- `400 {"error": "..."}` bad or missing image / malformed options
- `413 {"error": "..."}` image larger than 15 MB
- `415 {"error": "..."}` unsupported image type
- `503 {"error": "..."}` models not loaded / queue full

## `GET /api/jobs/{id}`

```json
{ "id": "a1b2", "status": "running", "stage": "segmenting walls (MitUNet)",
  "progress": 0.42 }
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `status` | `"queued" \| "running" \| "done" \| "error"` | terminal: `done`, `error` |
| `stage` | string | human-readable, shown verbatim in the UI |
| `progress` | number 0..1 | monotonic |
| `error` | string? | present when `status = "error"` |
| `result` | PlanJSON? | present when `status = "done"` |

`404 {"error": "..."}` for an unknown or expired job. The frontend polls about once a
second until a terminal status.

A rejected plan is still `status: "done"`; its `result.acceptance.accepted` is
`false`, `reject_reasons` explains why, and walls/rooms may be empty. The app shows
the reasons instead of a model.

## `GET /api/jobs/{id}/overlay.png`

Optional debug overlay (walls/rooms drawn on the input). `404` when not available.
The app shows it as an extra view when it loads and ignores it otherwise.

## PlanJSON

The schema of `deliverables/livemap/plans/*.json`. The app accepts all three forms
the repo uses and normalises them (`app/src/lib/plan/normalize.ts`):

- schema 2.0: `start: {x, y}`, `thickness` in px (preferred, what the server returns)
- schema 1.0: `start: [x, y]`, `thickness_px`, `height_m`
- metre fork: `start: {x, y}`, `thickness` in metres plus
  `metadata.pixel_to_meter_ratio`

```jsonc
{
  "schema_version": "2.0",
  "source": { "image_width_px": 2730, "image_height_px": 2048, "input_scale": 1 },
  "scale": { "units": "relative_px", "user_scale_required": true },
  "walls": [ { "id": "w0", "start": {"x": 114, "y": 380}, "end": {"x": 105, "y": 385},
               "thickness": 29.6, "exterior": true, "between": [1, 2] } ],
  "rooms": [ { "id": "room_2", "type": "kitchen", "polygon": [{"x":119,"y":393}], "area_px": 1041398 } ],
  "fixtures": [ { "id": "door_001", "type": "door", "position": {"x":1404,"y":884},
                  "scale": {"width":0.78,"depth":0.1,"height":2.1}, "rotation_degrees": 90 } ],
  "acceptance": { "accepted": true, "reject_reasons": [], "notes": ["merged_rooms"] }
}
```

Coordinates are pixels of the **full uploaded image** (after EXIF rotation, crop
offset already applied), so the app can draw them straight over the source image.
This holds for large uploads too: an image whose longest side exceeds 4096 px is
analysed on a downscaled copy, and the server maps walls, thickness, rooms
(`area_px` too), fixtures and the px metrics in `acceptance` back to the full
image before answering. `source.input_scale` (analysis px / full px, `1` when not
downscaled) is informational only; clients must not apply it.

## WebSocket hub: `/ws`

Same protocol as `deliverables/livemap/PROTOCOL.md`, served on the same origin at
`/ws` (`wss://` when the page is `https://`). The legacy standalone hub on port 8765
stays reachable from the app's Settings ("Legacy hub, port 8765").

- First message tags the connection: `{"role":"phone"}` or `{"role":"viewer"}`.
- Phone to viewers: poses `{"x","y","yaw_deg"}` (no `type`), `{"type":"state",...}`,
  `{"type":"diag",...}`.
- Phone to viewers: `{"type":"plan","plan_id","name","plan",...}`, the plan the phone
  has open (at most 2 MB). The hub caches the latest one and replays it to every
  viewer that joins later, so the laptop's `/map` can follow a plan it does not
  have in its own library. Too large: the phone gets `{"type":"plan_rejected"}`.
- Viewers to phones: `{"type":"control","patch":{...}}`, `{"type":"hello"}`.
- Unknown `type` values are ignored.

## `POST /api/models`

Hosts a GLB for a short time so Android Scene Viewer (a separate app that fetches
the model itself and cannot read the page's `blob:` URLs) can open it.

- Body: the `.glb` file itself, `Content-Type: model/gltf-binary` (or
  `application/octet-stream`). At most 15 MB.
- Validated by content: binary glTF magic `glTF`, version 2, the header length
  must equal the body length, and the first chunk must be JSON.
- `201 {"id": "<random>", "url": "https://<host>/api/models/<id>.glb", "expires_in_s": 900}`
- `400` empty or malformed GLB, `413` too large, `415` not a GLB / wrong content type.

Models live in memory for 15 minutes (at most 16 models and 64 MB in total, oldest
evicted first). Ids are 128-bit random.

## `GET /api/models/{id}.glb`

The uploaded bytes, `Content-Type: model/gltf-binary`. `404` once expired.
