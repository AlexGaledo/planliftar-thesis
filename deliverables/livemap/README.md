# Spectator Live Map

A laptop-side companion for the Unity AR floorplan app. Shows the placed
floorplan (walls + rooms) on a 2D canvas and a live dot + heading cone for
the phone's position, streamed over WiFi.

## What's here

- `server.py` - static file server (port 8080) + WebSocket broadcast hub
  (port 8765), plus a `POST /jobs` / `GET /jobs/<id>` stub for the
  image-upload picker (see "Plan upload" below). Requires Python 3.8+ and
  the `websockets` package.
- `index.html` - the 2D spectator map page: walls, rooms, a live dot with
  heading cone, a trail, and plan-upload controls (JSON and a stubbed
  image path - see "Plan upload" below). No build step, no external assets.
- `ar.html` - "Live Map AR Bridge": a WebXR + three.js page you open **on
  the phone** (not the laptop) as an alternative to running the real
  Unity app. It uses the phone's own camera/ARCore session to place the
  floorplan in AR and streams pose to the same hub, exactly like
  `PoseStreamer.cs` does from the Unity build. See "Live Map AR Bridge
  (ar.html)" below for how it differs from `index.html` and how to run
  it. No build step; its only external dependency is three.js pinned to
  an exact version via CDN import map (`three@0.160.0`).
- `floorplan.json` - a real exported floorplan (copied from
  `out/sample_response.json`) served as demo data.
- `fake_phone.py` - CLI that fakes a phone (or a phone+viewer pair) against
  the hub without any real device. See "Testing without a phone" below.
- `PoseStreamer.cs` (in `../unity/`) - Unity MonoBehaviour that streams the
  phone's pose to the hub. Drop it into the Unity project alongside the
  other scaffold scripts.

## Run it

1. Install the one dependency:

   ```
   pip install websockets
   ```

2. Start the server from this directory:

   ```
   python server.py
   ```

   It prints something like:

   ```
   Static page (open on the laptop):
       http://192.168.1.42:8080

   WebSocket hub (type into the Unity app's Server Address field):
       ws://192.168.1.42:8765
   ```

   (If several IPs are listed, pick the one on the same WiFi network as the
   phone.)

3. On the laptop, open `http://<laptop-ip>:8080` in a browser. It loads the
   floorplan, connects to the hub as a viewer automatically, and shows
   "Disconnected" until a phone starts streaming.

4. In the Unity app, add `PoseStreamer` to a GameObject in the scene (e.g.
   next to `TapToPlaceFloorPlan`), wire up its `Placement` and `Ar Camera`
   fields in the Inspector, and set `Server Address` to
   `ws://<laptop-ip>:8765` (same IP the server printed). Build and run on
   the phone.

5. Tap to place the floorplan on the phone. Once placed, `PoseStreamer`
   starts sending pose updates ~10x/second and the laptop page shows a live
   dot with a heading cone moving over the floorplan, plus a short trail of
   recent positions.

Phone and laptop must be on the same WiFi network/subnet for this to work
(no cloud relay - it's a direct LAN broadcast hub).

## Plan upload (index.html)

The top-left panel on the map screen has two upload pickers, in addition to
the default `?plan=` query-string flow:

- **Load plan JSON…** - picks a `.json` file and renders it through the same
  path the built-in plans use, entirely client-side (`FileReader`, no
  upload to the server - the map already has everything it needs to draw).
  It is validated first: must parse as JSON, be an object, and have a
  `walls` array whose entries all have numeric
  `start.x`/`start.y`/`end.x`/`end.y` (`rooms` is optional - a plan can be
  walls-only). A bad file shows a specific error and leaves whatever plan
  was already on screen alone, rather than blanking the canvas.
- **Back to built-in** - re-fetches whatever `?plan=` names (`bungalow` by
  default), no page reload needed. Disabled while a built-in plan is
  already showing.
- **Upload floorplan image…** - a **deliberate stub**, clearly labeled as
  such in the UI. There is no inference service - MitUNet + CubiCasa run
  only in Kaggle notebooks by hand today - so this exercises the REST async
  job shape `planliftar-v1.md` specifies for the eventual real one:
  `POST /jobs` with the image bytes -> `202 {job_id, status: "queued"}`,
  then the page polls `GET /jobs/<job_id>` until `status: "done"`, at which
  point it renders the `result` plan through the same shared path. The
  result is always the canned `plans/bungalow.json` after a short simulated
  delay - never an analysis of the uploaded image - and the UI says so
  before, during, and after the "upload" so a demo can't be mistaken for
  working inference. `server.py` caps the accepted body at 5 MB and answers
  `413` (before reading the oversized body) past that.

Both pickers share one caveat, shown as a standing note in the panel: the
live pose stream is in the *loaded plan's* pixel space, so a phone that is
still streaming against a different plan than what's on screen will show
its dot in the wrong place until it loads the same plan too. This feature
is map-screen-only by design; getting an uploaded plan to the phone is out
of scope (see `ar.html`'s own docs below, which it does not touch).

## Live Map AR Bridge (ar.html)

`ar.html` is a second, alternative pose source to the Unity app: a
self-contained WebXR + three.js page you open in **Chrome on the phone
itself**. Tap "Start AR", point the camera at the floor until a ring
(reticle) shows up, tap to place the floorplan, then walk around - the
page streams your pose to the hub exactly like `PoseStreamer.cs` does, so
`index.html` on the laptop shows the same live dot either way. Use
whichever pose source is more convenient; they are interchangeable (only
one "phone" is expected on the hub at a time).

Differences from `index.html` / `PoseStreamer.cs`:

- It renders the floorplan as translucent 3D wall boxes overlaid on the
  camera passthrough (via WebXR hit-test placement), not a 2D canvas.
- It renders a **miniature** by default (1:50), sitting on the surface you
  tapped, rather than a 1:1 building you walk through. See "Miniature
  placement and the Dimensions panel" below.
- It recenters the model on the plan's footprint bounding-box **center**
  (not pixel 0,0), so the model straddles the tap point rather than
  hanging off one corner of it.
- Despite those differences, the outgoing pose convention is identical:
  `{x, y, yaw_deg}` in the same plan-px space and the same heading
  convention `index.html`'s heading cone and `PoseStreamer.cs` use
  (`yaw_deg = 0` points toward plan -Y / "up" on the map, increasing
  clockwise toward plan +X). All three files must stay in sync if this
  ever changes - see the coordinate-convention comment at the top of
  `ar.html`.

**HTTPS/localhost requirement (read this before testing on a phone):**
WebXR only runs in a "secure context" - HTTPS, or the special-cased
`http://localhost`. `server.py` serves `ar.html` as **plain HTTP from a
LAN IP** (e.g. `http://192.168.1.42:8080/ar.html`), which Chrome treats
as insecure, so `navigator.xr` will be `undefined` and "Start AR" stays
disabled there. `ar.html` detects this and shows the fix in its own UI,
but the two options are:

- **`--tls` (recommended, and the only one that works with no cable):**
  start the server as `python server.py --tls`. It generates a self-signed
  certificate covering the laptop's current LAN IPs and serves HTTPS on
  8080 and WSS on 8765. See "No cable: phone hotspot" below.
- **adb reverse (needs a USB cable):** plug the phone into the laptop with
  USB debugging on, then on the laptop run `adb reverse tcp:8080 tcp:8080`
  and `adb reverse tcp:8765 tcp:8765`, and on the **phone** open
  `http://localhost:8080/ar.html` (not the LAN IP). Chrome treats
  `localhost` as secure regardless of what's behind it.
- **Chrome flag (no cable, but must be redone whenever the laptop's IP
  changes):** on the phone, open
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, enable it,
  add the exact origin (e.g. `http://192.168.1.42:8080`), relaunch Chrome,
  then open that same URL + `/ar.html`. `server.py` prints the exact origin
  string to paste when it starts without `--tls`.

### No cable: phone hotspot

Turn on the phone's hotspot, join the laptop to it, and start the server
with TLS:

```
python server.py --tls
```

The banner then prints `https://` and `wss://` URLs instead of `http://`
and `ws://`, along with the exact two URLs to open on the phone. Because
the certificate is self-signed, Chrome shows its "Your connection is not
private" interstitial **once per port** - tap Advanced, then Proceed:

1. `https://<laptop-ip>:8765` - **accept this one first.** It is the hub.
   A blocked `wss://` connection produces no interstitial of its own and
   no useful error, so if you skip this the page will simply sit at
   "Disconnected - reconnecting..." forever with nothing to click.

   Once accepted, this URL answers with **"Failed to open a WebSocket
   connection ... You cannot access a WebSocket server directly with a
   browser."** That is the correct, expected result, not an error to fix:
   you are not meant to read a page here. Getting that message means the
   TLS handshake succeeded and Chrome has stored the exception, which is
   the entire purpose of the visit.
2. `https://<laptop-ip>:8080/ar.html` - the AR page itself.

After both are accepted the origin is a genuine secure context, so WebXR
runs with no cable and no browser flags. The laptop's own browser needs to
accept the same certificate once for `https://<laptop-ip>:8080`.

Both pages derive their WebSocket URL from their own scheme (`wss://` when
served over HTTPS, `ws://` otherwise), so nothing needs configuring by
hand. A page served over HTTPS is not permitted to open a plain `ws://`
socket - the browser blocks it as mixed content, silently.

The certificate is written to `.certs/` and reused across restarts. On a
hotspot the phone hands out DHCP leases, so the laptop's address can
change between sessions; when it does, the stored certificate no longer
covers the new address and is regenerated automatically at startup (you
will have to accept the new one on the phone).

`fake_phone.py --tls` connects to a TLS hub the same way, for testing the
whole thing from the laptop alone.

### Miniature placement and the Dimensions panel

The exported floorplan is unitless - `out/sample_response.json` carries
`"units": "relative_px"` and `"user_scale_required": true` - so nothing in
the pipeline knows how big the building actually is. `ar.html` therefore
keeps **two separate scale factors**, and the Dimensions panel exposes
both:

| Control | Sets | Effect |
| --- | --- | --- |
| "Longest side of the real building" (meters) | `ppm`, plan px per real-world meter | How big the building *is*. Rebuilds the geometry, because `ppm` is inside the plan-to-local mapping. |
| "Model scale - 1:N" slider | `modelDenom` | How small the *model* is. A uniform scale on the placement group only; no rebuild. |

They are deliberately independent: a 20 m building at 1:50 and a 40 m
building at 1:100 are the same size on your desk but are not the same
plan. The default `ppm = 100` makes the sample plan a 20.4 x 12.2 m
building; at 1:50 that renders as a 41 x 24 cm model with 5 cm walls.

**"Fit to the surface I tap"** (on by default) uses the optional WebXR
`plane-detection` feature. When you tap, it reads the polygon of every
detected horizontal plane, keeps the **smallest** one containing the tap
point - tapping a mousepad on a desk on a floor gives three nested planes,
and the tightest one is the one you meant - and picks the scale
denominator that makes the model's longest side fill 80% of that surface's
shorter side. A 24 cm mousepad yields roughly 1:106 (a 19 cm model); a
45 cm placemat yields roughly 1:57 (a 36 cm model). Where the browser
does not support `plane-detection`, no surface size is available: the page
says so, keeps the slider's current value, and you set the size by hand.
Dragging the slider turns auto-fit off, on the assumption that you have
taken over.

The model's base sits at the placement point, flush with the detected
surface, and a translucent slab is drawn at that level. Without the slab
the walls read as disconnected boxes floating in mid-air rather than one
model resting on the table.

Note what the pose stream means once the model is a miniature: the
outgoing `{x, y}` is still true plan px, because `worldToLocal` divides the
group scale back out. So moving the phone a few centimeters across a
tabletop model sweeps the dot across meters of plan - which is the point.
`index.html` needs no changes for either mode.

### Fake mode (?fake=1), no headset/phone needed

Append `?fake=1` to the URL (e.g. `http://localhost:8080/ar.html?fake=1`)
to skip WebXR entirely: the page instead connects to the hub as
`role: phone` and streams a scripted circular walking loop around the
floorplan's footprint center at 10Hz, so you can exercise the
connect/reconnect/send logic from any desktop browser without ARCore.

## Testing without a phone

`fake_phone.py` is a CLI that connects to the hub as `{"role": "phone"}`
and streams a slow elliptical walking loop of `{x, y, yaw_deg}` poses
across the **actual** bounding box of `floorplan.json` (read from the file
at startup, not hardcoded - different plans have different extents):

```
python fake_phone.py [--host HOST] [--port PORT] [--rate HZ]
                      [--duration SECONDS] [--loop-seconds SECONDS]
```

- `--host` / `--port` - hub address (default `localhost:8765`).
- `--rate` - pose messages per second (default 10, matching
  `PoseStreamer.cs` / `ar.html`'s send rate).
- `--duration` - seconds to stream before exiting; `0` (default) runs
  forever until Ctrl+C, so it's useful for eyeballing the map for
  minutes at a time.
- `--loop-seconds` - seconds per full lap of the walking loop (default
  60 - one slow lap per minute).

With `index.html` (or `ar.html?fake=1`, for comparison) open in a
browser, you should see the dot sweep in a slow loop across the
floorplan.

It also has a built-in protocol self-test, `--viewer`: it opens two real
connections to the hub in the same process - one tagged `phone`, one
tagged `viewer` - streams a small batch of synthetic poses, and asserts
the viewer received the exact same messages, verbatim and in order.
Useful as a smoke test after touching `server.py`:

```
python fake_phone.py --viewer --count 20
```

On success it prints `PASS: viewer received every phone message verbatim
and in order` and exits 0; on any mismatch or drop it prints `FAIL` with
the first differing message and exits 1.

## Notes / troubleshooting

- The hub is a simple broadcast: every message from a client tagged
  `role: phone` is fanned out verbatim to every client tagged
  `role: viewer`. Only one phone is expected at a time, but multiple
  viewers (multiple laptops/tabs) all get the same stream.
- If the browser page never leaves "Connecting…", check that port 8765
  isn't blocked by a firewall on the laptop, and that the laptop and phone
  are on the same subnet (some routers isolate WiFi clients from each
  other - "AP/client isolation" - which breaks this).
- `PoseStreamer` sends nothing until `TapToPlaceFloorPlan.IsPlaced` is
  true, so the dot only appears after the user places the floorplan on
  the phone.
