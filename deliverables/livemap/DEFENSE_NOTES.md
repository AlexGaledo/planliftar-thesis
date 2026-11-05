# PlanLiftAR defense notes

Plain-language notes on what the system is made of, what AR is and how it
works, what three.js does for us, and how the browser prototype becomes the
Unity product described in the paper.

---

## 1. The parts we used

Think of it as a pipeline with five stations. Each one hands a file or a
message to the next.

| Station | What it is | Where it lives | What goes in | What comes out |
| --- | --- | --- | --- | --- |
| **Floor plan analysis** | Two neural nets (MitUNet, CubiCasa multi-task net) run on the uploaded image. Rooms-first pipeline: wall mask, gap healing, room regions, walls taken from room borders, consensus check between the two nets. | Kaggle notebook (Python, PyTorch, scikit-image) | Floor plan image (PNG/JPG) | `floorplan.json`: walls as line segments with thickness, room polygons, doors/windows. Units are pixels; real size is unknown. |
| **Plan preparation** | Normalises the JSON and closes small gaps between wall ends so the model is one connected shape. Same code in Python (`plan_ops.py`) and JavaScript (`plan_ops.js`), tested to give identical output. | Runs in the browser before drawing, and in the GLB builder | `floorplan.json` | Same JSON, cleaned, with a few connector walls added |
| **Server** | A small Python program. Serves the two web pages over HTTPS and runs the "hub": a WebSocket relay that forwards phone messages to the laptop and laptop messages to the phone. Makes its own certificate so the phone gets a secure connection with no cable. | `server.py`, laptop | Connections from phone and laptop | Every phone message copied to every laptop viewer, and back |
| **AR page (phone)** | The prototype AR client. Uses WebXR (browser AR) to track the phone and find the floor, three.js to draw the walls over the camera, and a WebSocket to send position. | `ar.html`, Chrome on Android | `floorplan.json`, building length, ARCore tracking | 3D walls on camera; 10 position messages per second |
| **Live map (laptop)** | 2D top-down view of the plan with a moving dot and a heading cone. Also a remote control for the phone (size, rotation). | `index.html`, any browser | `floorplan.json`, position messages | Dot on the map; control messages to the phone |
| **Unity client (scaffolded)** | C# scripts for the same job as the AR page: fetch plan, build walls, tap to place, stream position. Not built into an app yet. | `unity/*.cs` | Same JSON, same hub | Same position messages |
| **Test walker** | Fake phone that streams a scripted walk so the map can be tested without AR. | `fake_phone.py`, or `ar.html?fake=1` | Nothing | Position messages |

Supporting pieces: `PROTOCOL.md` (the message format both clients obey),
`manifest.webmanifest` + `sw.js` (lets the pages install as an app and work
offline), `glb_builder.py` (exports the walls as a 3D file for Unity or any
viewer).

The message format between phone and map is deliberately tiny:

```
{"x": 1420.5, "y": 980.2, "yaw_deg": 37.4}
```

x and y are plan pixels, yaw is which way the phone faces. Anything that can
send this over a WebSocket is a valid phone client. That is what makes the
Unity swap possible.

---

## 2. What AR is, and how it works

**Augmented reality** means drawing virtual objects on top of the live
camera image so they appear to sit in the real room: they stay in place when
you move, get bigger when you walk toward them, and hide behind you when you
walk past.

For that to work the phone must know, every frame, exactly where it is in
the room and which way it points. That is the hard part. Drawing is easy.

### The engine: ARCore

On Android the work is done by **ARCore**, Google's AR engine that ships
with the phone. Our page never touches the sensors directly. Chrome exposes
ARCore to web pages through a standard called **WebXR**, and we call that.

ARCore does three jobs:

**1. Motion tracking (where am I?)**

Analogy: you walk into an unfamiliar room. You notice the corner of a
table, a picture frame, the edge of a rug. As you step sideways those
landmarks shift in your view by different amounts, near things more, far
things less. From that shift you know how far you moved. You do this
without thinking; ARCore does it with the camera at 30 frames per second,
and adds the phone's gyroscope and accelerometer to fill the gaps between
frames and to know how big a step is. The result is a position in metres
and a direction, relative to where the session started. The technical name
is SLAM: simultaneous localisation and mapping.

Gyroscope alone gives only rotation. The camera is what gives position. A
phone that tracks only rotation shows a model that slides along with you,
which is one of the failure modes the page watches for.

**2. Surface detection (where is the floor?)**

Among those landmarks, many lie at the same height on a flat level. ARCore
groups them into planes: the floor, a table, a desk. When the page shoots
an imaginary ray out of the centre of the screen and asks "what surface
does this hit?", that is a **hit test**. Where it hits is where the ring
appears. Tapping "Place" puts the floor plan there.

If ARCore has not found a surface yet, the page guesses a floor about 1.4
metres below the camera and shows the ring in amber so nobody mistakes the
guess for a real reading.

**3. Anchors (keep it there)**

ARCore keeps refining its map as you move. Its idea of "2 metres from the
door" can shift a little as it learns the room better. An **anchor** is
like a sticky note on the table: it is attached to the real spot, not to
the coordinate, so when the map shifts the note stays on the table. Our
model is attached to an anchor at the tap point. Small corrections are
smoothed; large ones (ARCore genuinely changed its mind) are applied at
once.

### How the map knows where you are

It does not know where you are in the world. There is no GPS, no compass,
no Wi-Fi positioning. It knows where you are **relative to the model you
placed**.

1. ARCore reports the phone's position in the room.
2. The page converts that into "position relative to the placed model".
3. Metres become plan pixels using the building length you typed.
4. The phone sends `{x, y, yaw_deg}` to the hub ten times a second.
5. The map draws the dot at that pixel.

Walk 2 metres east of the tap point, ARCore reports 2 metres, the scale
converts it to pixels, the dot moves that many pixels. On a tabletop model
at 1:50, 2 centimetres of phone motion over the desk is 1 metre on the
plan. Same maths, the scale is just divided back out.

If the plan is placed rotated, the dot lands rotated. There is no automatic
alignment to the real building; that is why the rotate buttons exist.

---

## 3. What three.js does

**WebGL** is the browser's raw 3D drawing interface. Powerful, but you
write triangles and shader programs by hand. **three.js** is a library on
top of it that gives you objects people actually think in: a scene, a
camera, lights, meshes (shape plus material), and a renderer that draws it
all.

Analogy: WebGL is the plastic-moulding machine. three.js is the LEGO kit,
plus a camera and a lamp, and you snap pieces together.

### The five things every three.js program has

| Thing | Ours |
| --- | --- |
| **Scene** | The container. Holds the reticle ring, the lights, and the placed floor plan group. |
| **Camera** | Normally you position it yourself. In AR, three.js's XR support takes the camera position from ARCore every frame, so the virtual camera moves exactly like the phone. |
| **Meshes** | One box per wall. Width = wall thickness, height = wall height, length = distance from start to end. Rotated to lie along the wall, base at floor level. Plus a thin slab under the whole plan so the walls read as one object resting on the surface. |
| **Materials and lights** | Walls use a lit material with a faint plaster texture drawn on a canvas. A hemisphere light plus one directional light, fixed in the room, so faces meeting at a corner shade differently and the corner is visible. |
| **Renderer** | Draws the scene each frame with a transparent background, so the camera image shows through behind the walls. |

### Where the 3D model comes from

There is no model file. The backend gives 2D line segments. The phone
extrudes them into boxes at runtime, in about 50 lines of code, every time
the plan loads or the building length changes. That is why the same JSON
works for the 2D map, the browser AR page, the Unity client, and the GLB
export: everything builds from lines, nothing ships a mesh.

### The scale trick

Two independent numbers:

- **Building length** sets how many plan pixels make one real metre. It is
  inside the pixel-to-metre conversion, so changing it rebuilds the walls.
- **Model scale** (1:50, 1:1) is a plain uniform scale on the whole group.
  It is not inside the conversion. three.js's `worldToLocal` undoes the
  group's full transform, scale included, so the position sent to the map is
  always in true plan pixels regardless of how small the model is.

### Why it runs smoothly on a phone

The phone GPU cares about how many separate draw orders it receives per
frame and how many pixels it colours, not about triangle count.

- All wall boxes merged into one mesh: 244 draw orders became 1.
- Rendered at 80% resolution inside the AR session; invisible over camera
  passthrough, a third fewer pixels to shade.
- Inside faces of walls skipped (you never stand inside a wall).
- No anti-aliasing, pixel density capped at 2x.
- 36 duplicate walls in the pipeline export skipped before drawing; they
  were drawn twice and flickered.
- Old geometry freed when the model rebuilds, so memory does not fill up.

---

## 4. From this prototype to the Unity product

The paper describes a Unity app. The demo is a browser page. They are two
clients for the same system. Everything except the phone client stays.

### What stays exactly the same

| Piece | Why it does not change |
| --- | --- |
| Floor plan analysis (notebook) | Produces JSON. Does not care who reads it. |
| `floorplan.json` schema | Unity's `FloorPlanData.cs` parses the same fields. |
| Gap closure | `plan_ops.py` runs in the GLB builder; Unity can consume the GLB, or run the same rules in C# later. |
| Server and hub | Unity's `PoseStreamer.cs` connects to the same WebSocket and sends the same message. |
| Live map page | Cannot tell which client sent the message. |
| Coordinate convention | Plan (x, y) becomes world (x, -y), yaw = atan2(forward.x, forward.z). Documented in both `ar.html` and `PoseStreamer.cs` with a note that they must change together. |

### What is swapped

| Browser prototype | Unity product | Unity file |
| --- | --- | --- |
| WebXR session, hit test, anchors | AR Foundation 5.1 on top of ARCore (same engine underneath) | `TapToPlaceFloorPlan.cs` uses `ARRaycastManager`, `ARPlaneManager`, `ARAnchorManager` |
| three.js boxes built from JSON | Unity meshes built from JSON, one box per wall | `FloorPlanMeshBuilder.cs` |
| `fetch()` of the JSON | HTTP upload, then poll for the result | `FloorPlanApiClient.cs` (POST /plans, GET /plans/{id}) |
| Browser WebSocket | .NET `ClientWebSocket` | `PoseStreamer.cs` |
| Building-length field | Tap a wall, type its real length | `ScaleInputUI.cs` |
| 2D map is a separate laptop page | Optional in-app minimap | `MinimapController.cs`, `MinimapUI.cs` |

### What Unity adds that the browser cannot

- iPhone support through ARKit, with the same C# code.
- Occlusion: real objects (a chair, a person) can hide virtual walls using
  the phone's depth sensing.
- Shadows, better materials, physics, navigation meshes, sound.
- A proper installable app with an icon, no certificate warnings, no URL
  to type.

### What the browser had that Unity loses

- Zero install: one link on any ARCore phone.
- Edit a text file, reload, see the change. Unity rebuilds take minutes.
- Laptop remote control was cheap to add because both ends are JavaScript.

### The migration steps

1. Install Unity 2022.3 LTS with Android build support (the `SETUP.md` in
   `unity/` lists the packages and player settings).
2. Create a project, drop the eight C# scripts into `Assets/Scripts`.
3. Build the scene: AR Session, XR Origin with camera and the three AR
   managers, a plane visualiser prefab, the Managers object, a Canvas with
   the scale input widgets.
4. Write the one missing script, a small `FloorPlanFlowController`: upload
   the image, poll for the JSON, build the walls, hand the result to the
   placer, then to the pose streamer. The scaffold deliberately leaves this
   as app-specific glue.
5. Add `link.xml` so the IL2CPP build keeps `System.Net.WebSockets`.
6. Check `FloorPlanData.cs` against the current JSON schema (it was written
   for the earlier `sample_response.json` layout; the field names are
   nearly the same but must be verified).
7. Build and run on a phone, point `PoseStreamer` at the hub address the
   server prints, and confirm the laptop map's dot moves.

Honest estimate: half a day to a day with a working Unity install, more the
first time Unity is set up on a machine. The reason the demo is the browser
version is that it was faster to iterate on and needs no install, not
because Unity cannot do it.

---

## 5. Short answers for likely questions

**Is this real AR or just the gyroscope?**
Real six-degree-of-freedom tracking from ARCore: camera plus inertial
sensors. The page even detects the rotation-only failure and warns.

**Why does the user have to type the building size?**
The export is unitless. A floor plan image has no scale bar the model can
trust, so the pipeline refuses to guess and asks for one real dimension.

**What if tracking is lost?**
The anchor keeps correcting the model when tracking returns. Until then the
page counts lost frames and falls back to an estimated floor shown in
amber.

**Why not GPS?**
Indoor GPS error is 5 to 10 metres, larger than a room.

**Why is Unity in the paper but not in the demo?**
Same architecture, same contracts. The browser client was faster to build
and to show. The Unity client is scaffolded and documented; the remaining
work is scene assembly and one glue script.

**Why is there a laptop map at all?**
So an observer sees where the walker is without wearing the phone. It also
turned into the remote control: size and rotation can be changed from the
laptop mid-demo.

**What is the weakest part?**
The segmentation on the cubicasa plan is poor (one merged region, low
consensus score). The pipeline reports it honestly rather than inventing
walls. Also, the image-upload button in the demo is a stub that returns a
fixed sample plan; real analysis still runs by hand in the notebook.
