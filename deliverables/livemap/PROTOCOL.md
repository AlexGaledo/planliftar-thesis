# Live Map hub protocol

Frozen contract between `server.py` (the hub), `ar.html` / `PoseStreamer.cs`
(phones) and `index.html` (viewers). Change this file and all three clients
together, never one alone.

## Roles

Every client's FIRST message tags the connection and is never forwarded:

```json
{"role": "phone"}      {"role": "viewer"}
```

The hub fans out **both** directions:

- any message from a `phone` goes verbatim to every `viewer`
- any message from a `viewer` goes verbatim to every `phone`

Viewers were read-only in v1. They are not any more — that is what makes the
laptop control panel possible. There is no phone-to-phone or viewer-to-viewer
delivery, so no message can loop.

## Message discrimination

A message with **no `type` field is a pose**. That is deliberate: it keeps
`PoseStreamer.cs` working untouched, since it has always sent bare
`{x, y, yaw_deg}`.

Anything with a `type` field is a control-plane message. A client that does
not recognise a `type` MUST ignore it silently rather than treating it as
data — that is how this protocol grows without breaking older clients.

## Messages

### Pose — phone to viewers

```json
{"x": 1420.5, "y": 980.2, "yaw_deg": 37.4}
```

`x`/`y` are plan pixels, `yaw_deg = 0` faces plan −Y ("up" on the map),
increasing clockwise toward plan +X. Unchanged from v1; see the coordinate
comment at the top of `ar.html`. Sent at ~10 Hz once placed.

Note for miniatures: the pose stays in **true plan px** regardless of the
model's scale, because the phone divides the model scale back out. Moving a
few centimetres over a 1:50 tabletop model sweeps the dot across metres of
plan. That is intended.

### Control — viewer to phones

```json
{"type": "control", "patch": {"model_denom": 40}}
```

`patch` carries only the keys being changed; every key is optional. Phones
apply what they recognise, ignore what they do not, clamp out-of-range
values rather than rejecting the whole patch, and then emit a `state`
message reflecting what actually took effect.

| Key | Type | Range | Effect on the phone |
| --- | --- | --- | --- |
| `real_longest_m` | number | 0.5 – 500 | How long the plan's longest side is in the real world. Sets `ppm = longestPx / value`, so it rebuilds the geometry. |
| `model_denom` | number | 5 – 200 | Miniature factor: the model renders at 1:`model_denom`. A uniform group scale; no rebuild. |
| `auto_fit` | bool | — | Whether the next placement fits the model to the tapped surface. |
| `wall_height_m` | number | 0.1 – 10 | Real-world wall height; rebuilds. |
| `wall_opacity` | number | 0.05 – 1 | Wall material opacity. |
| `rotation_deg` | number | any; wrapped to 0–360 | Yaw of the placed model about the vertical axis, degrees clockwise seen from above. |
| `reset_placement` | `true` | — | Drops the placement and returns to reticle/hit-test mode. |

`rotation_deg` turns the model in place. It does not disturb the pose
stream: the phone derives outgoing plan coordinates by inverting the
placement group's full transform, rotation included, so a rotated model still
reports true plan px and the map's dot and heading cone stay correct.

`real_longest_m` and `model_denom` are independent on purpose. The first says
how big the building is (the export is unitless — `"user_scale_required":
true`), the second says how small the model is. A 20 m building at 1:50 and a
40 m building at 1:100 sit identically on the desk but are not the same plan.

### State — phone to viewers

```json
{"type": "state", "state": {
  "real_longest_m": 20.4, "model_denom": 50, "auto_fit": true,
  "wall_height_m": 2.5, "wall_opacity": 0.35, "rotation_deg": 0, "placed": false,
  "plan_w_m": 20.4, "plan_d_m": 12.2,
  "model_w_cm": 40.8, "model_d_cm": 24.3,
  "xr": "idle"
}}
```

The phone's authoritative view of itself. Viewers should render their panel
from this rather than from what they last sent, so a second panel (or a
reconnect) shows the truth. `xr` is one of `idle`, `active`, `fake`,
`unsupported`.

Emitted on: connect, every applied control patch, placement, and reset.

### Hello — viewer to phones

```json
{"type": "hello"}
```

"Anyone there, tell me your state." Sent by a viewer on connect, because a
panel that opens after the phone did would otherwise have nothing to show.
Phones reply with a `state` message.

## Testing without a phone

`fake_phone.py` implements the phone side of all of the above, so the control
panel can be driven end to end from the laptop alone.
