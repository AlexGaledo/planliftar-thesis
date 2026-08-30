#!/usr/bin/env python3
"""
fake_phone.py - synthetic "phone" client for the Spectator Live Map hub
(server.py). Lets you eyeball index.html / ar.html without a real Android
phone or ARCore headset.

Two modes:

1. Phone mode (default): connects to the hub as {"role": "phone"} and
   streams a slow elliptical walking loop of {x, y, yaw_deg} poses across
   the ACTUAL bounding box of floorplan.json (read from disk at startup -
   never hardcoded, since different plans have different extents).

       python fake_phone.py [--host HOST] [--port PORT] [--rate HZ]
                             [--duration SECONDS] [--loop-seconds SECONDS]

       --host          Hub host (default: localhost)
       --port          Hub port (default: 8765)
       --rate          Pose messages per second (default: 10, matching
                        PoseStreamer.cs / ar.html's SEND_HZ)
       --duration      Seconds to stream before exiting; 0 = run forever
                        until Ctrl+C (default: 0)
       --loop-seconds  Seconds for one full lap of the walking loop, i.e.
                        how "slow" it is (default: 60 - one lap/minute,
                        easy to watch on the map for minutes at a time)

2. Viewer self-test (--viewer): an integrated protocol check. Opens two
   real WebSocket connections to the hub in the same process - one tagged
   "viewer", one tagged "phone" - streams a small batch of synthetic poses
   from the phone side, and asserts the viewer side receives the exact
   same raw JSON text, in the same order, with nothing dropped or
   reordered. Prints PASS/FAIL and exits 0/1 accordingly.

       python fake_phone.py --viewer [--host HOST] [--port PORT]
                             [--rate HZ] [--count N]

       --count  Number of synthetic pose messages to send/verify
                (default: 20)

Phone mode also implements the rest of PROTOCOL.md's phone side, so
index.html's control panel can be driven end to end without a real phone:
it maintains the `state` block (seeded from floorplan.json's real bounds
at 100 plan px/meter), replies to `hello`, applies `control` patches with
clamping + recomputed derived fields, and emits `state` on connect, on
every applied patch, and on reset. Pose streaming and control handling
run as two concurrent tasks so neither blocks the other.

Requires: pip install websockets
"""
import argparse
import asyncio
import json
import ssl
import math
import os
import sys

import websockets

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Must match what the pages load, or the fake walk happens on a different
# plan's extents than the map is drawing. Both pages default to
# plans/bungalow.json and accept ?plan=<name>; --plan mirrors that here.
PLANS_DIR = os.path.join(SCRIPT_DIR, "plans")
DEFAULT_PLAN = "bungalow"


def plan_path(name):
    return os.path.join(PLANS_DIR, f"{name}.json")


def load_bounds(path):
    """Read the real x/y extents out of floorplan.json, using the same
    point set index.html/ar.html use to fit the canvas/scene (wall
    start/end + room polygon vertices). Do not hardcode numbers here -
    the README's old snippet used 1100/600, which is not guaranteed to be
    inside any given plan's extents."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    pts = []
    for w in data.get("walls", []):
        if w.get("start"):
            pts.append(w["start"])
        if w.get("end"):
            pts.append(w["end"])
    for r in data.get("rooms", []):
        for p in r.get("polygon", []):
            pts.append(p)

    if not pts:
        raise SystemExit("floorplan.json has no walls/rooms to derive bounds from")

    xs = [p["x"] for p in pts]
    ys = [p["y"] for p in pts]
    return min(xs), max(xs), min(ys), max(ys)


def make_path_fn(min_x, max_x, min_y, max_y, loop_seconds):
    """Returns pose_at(t) -> (x, y, yaw_deg): a slow elliptical loop inset
    from the plan's bounding box (so it stays off the outer walls).

    Heading convention matches index.html/ar.html/PoseStreamer.cs:
    dirX = sin(yaw_deg), dirY = -cos(yaw_deg) (yaw=0 -> plan -Y / "up" on
    the map, increasing yaw rotates clockwise toward plan +X). Given a
    velocity direction (dx, dy), the matching yaw is atan2(dx, -dy).
    """
    cx = (min_x + max_x) / 2.0
    cy = (min_y + max_y) / 2.0
    # Inset 30% from the bbox edges so the loop clears the outer walls.
    rx = (max_x - min_x) / 2.0 * 0.7
    ry = (max_y - min_y) / 2.0 * 0.7
    omega = 2 * math.pi / loop_seconds

    def pose_at(t):
        theta = omega * t
        x = cx + rx * math.cos(theta)
        y = cy + ry * math.sin(theta)
        dx = -rx * math.sin(theta)
        dy = ry * math.cos(theta)
        yaw = math.degrees(math.atan2(dx, -dy))
        return x, y, yaw

    return pose_at


# --------------------------------------------------------------------------
# Phone state (PROTOCOL.md "State" block) - clamping, recompute of derived
# fields, and control-patch application all live here so every emission
# path (connect / hello / control / reset) goes through the same code.
# --------------------------------------------------------------------------
DEFAULT_PPM = 100.0  # seed: plan px per meter, per PROTOCOL.md/the task spec


class PhoneState:
    def __init__(self, min_x, max_x, min_y, max_y):
        self.plan_w_px = max(1e-6, max_x - min_x)
        self.plan_d_px = max(1e-6, max_y - min_y)
        self.longest_px = max(self.plan_w_px, self.plan_d_px)

        # Seed real_longest_m from the bounds at the default 100 px/m, so
        # ppm round-trips to exactly 100 at startup (see _recompute).
        self.real_longest_m = self.longest_px / DEFAULT_PPM
        self.model_denom = 50.0
        self.auto_fit = True
        self.wall_height_m = 2.5
        self.wall_opacity = 0.35
        self.rotation_deg = 0.0
        self.placed = False
        self.xr = "fake"

        self._recompute()

    def _recompute(self):
        ppm = self.longest_px / self.real_longest_m
        self.plan_w_m = self.plan_w_px / ppm
        self.plan_d_m = self.plan_d_px / ppm
        self.model_w_cm = self.plan_w_m * 100.0 / self.model_denom
        self.model_d_cm = self.plan_d_m * 100.0 / self.model_denom

    @staticmethod
    def _clamp(value, lo, hi):
        try:
            value = float(value)
        except (TypeError, ValueError):
            return None
        if value != value:  # NaN
            return None
        return max(lo, min(hi, value))

    def apply_patch(self, patch):
        """Apply a control patch per PROTOCOL.md: clamp every value to its
        stated range, ignore unknown keys, never reject the whole patch
        over one bad key."""
        if not isinstance(patch, dict):
            return
        for key, val in patch.items():
            if key == "real_longest_m":
                c = self._clamp(val, 0.5, 500)
                if c is not None:
                    self.real_longest_m = c
            elif key == "model_denom":
                c = self._clamp(val, 5, 200)
                if c is not None:
                    self.model_denom = c
            elif key == "auto_fit":
                self.auto_fit = bool(val)
            elif key == "wall_height_m":
                c = self._clamp(val, 0.1, 10)
                if c is not None:
                    self.wall_height_m = c
            elif key == "wall_opacity":
                c = self._clamp(val, 0.05, 1)
                if c is not None:
                    self.wall_opacity = c
            elif key == "rotation_deg":
                # Wrapped, not clamped: 370 and -350 both mean 10 degrees.
                try:
                    self.rotation_deg = float(val) % 360.0
                except (TypeError, ValueError):
                    pass
            elif key == "reset_placement":
                if val:
                    self.placed = False
            # Unknown key: ignore silently, per PROTOCOL.md.
        self._recompute()

    def to_dict(self):
        return {
            "real_longest_m": round(self.real_longest_m, 4),
            "model_denom": round(self.model_denom, 4),
            "auto_fit": self.auto_fit,
            "wall_height_m": round(self.wall_height_m, 4),
            "wall_opacity": round(self.wall_opacity, 4),
            "rotation_deg": round(self.rotation_deg, 2),
            "placed": self.placed,
            "plan_w_m": round(self.plan_w_m, 4),
            "plan_d_m": round(self.plan_d_m, 4),
            "model_w_cm": round(self.model_w_cm, 4),
            "model_d_cm": round(self.model_d_cm, 4),
            "xr": self.xr,
        }


async def recv_loop(ws, state):
    """Handle incoming control-plane messages (hello / control) while
    send_loop keeps streaming poses concurrently. A message with no "type"
    is a pose - phones never receive those (the hub doesn't forward
    phone-to-phone) but it's ignored either way; an unrecognised "type" is
    also ignored silently, per PROTOCOL.md."""
    async for raw in ws:
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(data, dict):
            continue

        mtype = data.get("type")
        if mtype == "hello":
            print("[fake_phone] <- hello; replying with state")
            await ws.send(json.dumps({"type": "state", "state": state.to_dict()}))
        elif mtype == "control":
            patch = data.get("patch")
            print(f"[fake_phone] <- control patch: {patch}")
            state.apply_patch(patch)
            new_state = state.to_dict()
            print(f"[fake_phone] -> state: {new_state}")
            await ws.send(json.dumps({"type": "state", "state": new_state}))
        # else: no type (pose) or unrecognised type - ignore silently.


async def send_loop(ws, pose_at, interval, duration, rate):
    loop = asyncio.get_event_loop()
    start = loop.time()
    sent = 0
    report_every = max(1, int(rate * 5))
    while True:
        t = loop.time() - start
        if duration > 0 and t >= duration:
            break
        x, y, yaw = pose_at(t)
        await ws.send(json.dumps({"x": x, "y": y, "yaw_deg": yaw}))
        sent += 1
        if sent % report_every == 0:
            print(f"[fake_phone] sent {sent} poses; last=({x:.1f}, {y:.1f}, {yaw:.1f} deg)")
        await asyncio.sleep(interval)
    print(f"[fake_phone] done, sent {sent} poses total")


# When server.py runs with --tls the hub speaks wss with a self-signed cert.
# Verification is switched off here for the same reason a browser is told to
# proceed past the interstitial: the cert is generated locally and identifies
# nothing worth trusting. This is a LAN test client, never a production one.
def hub_uri(host, port, tls):
    return f"{'wss' if tls else 'ws'}://{host}:{port}"


def hub_ssl(tls):
    if not tls:
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def run_phone(host, port, rate, duration, loop_seconds, tls=False, plan=DEFAULT_PLAN):
    uri = hub_uri(host, port, tls)
    sslctx = hub_ssl(tls)
    min_x, max_x, min_y, max_y = load_bounds(plan_path(plan))
    print(f"[fake_phone] floorplan bounds: x=[{min_x:.1f}, {max_x:.1f}]  y=[{min_y:.1f}, {max_y:.1f}]")
    pose_at = make_path_fn(min_x, max_x, min_y, max_y, loop_seconds)
    interval = 1.0 / rate if rate > 0 else 0.1
    state = PhoneState(min_x, max_x, min_y, max_y)

    async with websockets.connect(uri, ssl=sslctx) as ws:
        await ws.send(json.dumps({"role": "phone"}))
        print(f"[fake_phone] connected to {uri} as phone; rate={rate}Hz, loop={loop_seconds}s/lap"
              + (f", duration={duration}s" if duration > 0 else ", running until Ctrl+C"))
        initial_state = state.to_dict()
        print(f"[fake_phone] -> state (initial): {initial_state}")
        await ws.send(json.dumps({"type": "state", "state": initial_state}))

        recv_task = asyncio.create_task(recv_loop(ws, state))
        send_task = asyncio.create_task(send_loop(ws, pose_at, interval, duration, rate))
        try:
            done, pending = await asyncio.wait(
                {recv_task, send_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc:
                    raise exc
        finally:
            for task in (recv_task, send_task):
                if not task.done():
                    task.cancel()


async def run_selftest(host, port, rate, count, tls=False, plan=DEFAULT_PLAN):
    uri = hub_uri(host, port, tls)
    sslctx = hub_ssl(tls)
    min_x, max_x, min_y, max_y = load_bounds(plan_path(plan))
    pose_at = make_path_fn(min_x, max_x, min_y, max_y, loop_seconds=60.0)
    interval = 1.0 / rate if rate > 0 else 0.1

    sent_raw = []
    received_raw = []
    viewer_tagged = asyncio.Event()

    async def viewer_task():
        async with websockets.connect(uri, ssl=sslctx) as ws:
            await ws.send(json.dumps({"role": "viewer"}))
            viewer_tagged.set()
            while len(received_raw) < count:
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                received_raw.append(raw)

    async def phone_task():
        await viewer_tagged.wait()
        await asyncio.sleep(0.3)  # give the hub time to register the viewer's role tag
        async with websockets.connect(uri, ssl=sslctx) as ws:
            await ws.send(json.dumps({"role": "phone"}))
            for i in range(count):
                x, y, yaw = pose_at(i * interval)
                raw = json.dumps({"x": x, "y": y, "yaw_deg": yaw, "seq": i})
                sent_raw.append(raw)
                await ws.send(raw)
                await asyncio.sleep(interval)

    print(f"[fake_phone] self-test: connecting a viewer and a phone to {uri}, count={count}")
    await asyncio.wait_for(
        asyncio.gather(viewer_task(), phone_task()),
        timeout=max(20.0, count * interval + 10.0),
    )

    ok = sent_raw == received_raw
    print(f"[fake_phone] phone sent {len(sent_raw)} messages; viewer received {len(received_raw)} messages")
    if ok:
        print("[fake_phone] PASS: viewer received every phone message verbatim and in order")
    else:
        print("[fake_phone] FAIL: viewer's messages do not match what the phone sent")
        for i, (s, r) in enumerate(zip(sent_raw, received_raw)):
            if s != r:
                print(f"  first mismatch at index {i}:\n    sent:     {s!r}\n    received: {r!r}")
                break
        if len(sent_raw) != len(received_raw):
            print(f"  length mismatch: sent={len(sent_raw)} received={len(received_raw)}")
    return ok


def main():
    parser = argparse.ArgumentParser(description="Fake phone / viewer self-test for the Spectator Live Map hub.")
    parser.add_argument("--host", default="localhost", help="Hub host (default: localhost)")
    parser.add_argument("--port", type=int, default=8765, help="Hub port (default: 8765)")
    parser.add_argument("--rate", type=float, default=10.0, help="Pose messages per second (default: 10)")
    parser.add_argument("--duration", type=float, default=0.0,
                         help="Phone mode: seconds to stream before exiting; 0 = forever (default: 0)")
    parser.add_argument("--loop-seconds", type=float, default=60.0,
                         help="Phone mode: seconds per full lap of the walking loop (default: 60)")
    parser.add_argument("--viewer", action="store_true",
                         help="Run the viewer self-test instead of streaming as a phone")
    parser.add_argument("--plan", default=DEFAULT_PLAN,
                         help=f"plan name under plans/ to derive the walk path from "
                              f"(default: {DEFAULT_PLAN}); must match the page's ?plan=")
    parser.add_argument("--tls", action="store_true",
                         help="connect with wss:// and accept the hub's self-signed cert "
                              "(use when server.py was started with --tls)")
    parser.add_argument("--count", type=int, default=20,
                         help="Viewer self-test: number of messages to send/verify (default: 20)")
    args = parser.parse_args()

    try:
        if args.viewer:
            ok = asyncio.run(run_selftest(args.host, args.port, args.rate, args.count, args.tls, args.plan))
            sys.exit(0 if ok else 1)
        else:
            asyncio.run(run_phone(args.host, args.port, args.rate, args.duration,
                                  args.loop_seconds, args.tls, args.plan))
    except KeyboardInterrupt:
        print("\n[fake_phone] stopped.")


if __name__ == "__main__":
    main()
