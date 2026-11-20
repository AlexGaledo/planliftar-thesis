"""/ws: the Live Map hub, deliverables/livemap/PROTOCOL.md on the API origin.

Ported from deliverables/livemap/server.py (handler/broadcast). Semantics are
unchanged and deliberately dumb:

* The first JSON message carrying a known role tags the connection
  ({"role": "phone"} or {"role": "viewer"}) and is never forwarded. Messages
  before that (non-JSON, unknown role) are ignored, as in server.py.
* After tagging, every text message is forwarded VERBATIM: phone -> every
  viewer, viewer -> every phone. No phone-to-phone or viewer-to-viewer
  delivery, so nothing can loop. The hub never parses, validates or rewrites
  poses, state, diag, control or hello messages; the phone is the authority
  over its own state and the viewer asks for it with {"type":"hello"}.
  Unknown `type` values therefore pass through untouched, and clients ignore
  what they do not recognise.

One exception to "never parses": a phone's {"type": "plan", ...} message (the
plan it has open, see PROTOCOL.md) is also CACHED, and replayed to every viewer
that tags itself later, so a laptop that opens the map after the phone entered
AR still gets the plan. Plan messages may be up to PLAN_MAX_BYTES (2 MB, UTF-8
bytes); a larger one is dropped and the phone gets {"type": "plan_rejected",
"reason"}. Each phone (by peer address) may update the plan at most once per
PLAN_MIN_INTERVAL_S; extras are dropped the same way. Every other message is
capped at MAX_MESSAGE_BYTES. Plans never enter a client's general outbox: each
client has one "latest plan" slot that a newer plan replaces and that is sent
before queued messages, so memory per client stays bounded at
OUTBOX_SIZE * MAX_MESSAGE_BYTES + PLAN_MAX_BYTES.

Each client gets its own bounded outbound queue and sender task, so one slow
or stalled phone/viewer cannot hold up the fan-out to the others (oldest
messages are dropped for that client when its queue is full; poses are 10 Hz
and superseded anyway).
"""
from __future__ import annotations

import asyncio
import collections
import json
import time

from starlette.websockets import WebSocket, WebSocketDisconnect

OUTBOX_SIZE = 256
MAX_MESSAGE_BYTES = 256 * 1024
PLAN_MAX_BYTES = 2 * 1024 * 1024
PLAN_MIN_INTERVAL_S = 2.0


class _Client:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.outbox: collections.deque[str] = collections.deque(maxlen=OUTBOX_SIZE)
        self.plan_slot: str | None = None      # latest plan only, never queued
        self.wake = asyncio.Event()
        self.task: asyncio.Task | None = None

    def offer(self, message: str) -> None:
        self.outbox.append(message)            # full: deque drops the oldest
        self.wake.set()

    def offer_plan(self, message: str) -> None:
        self.plan_slot = message               # replaces an unsent older plan
        self.wake.set()

    async def pump(self) -> None:
        try:
            while True:
                await self.wake.wait()
                self.wake.clear()
                while self.plan_slot is not None or self.outbox:
                    if self.plan_slot is not None:
                        msg, self.plan_slot = self.plan_slot, None
                    else:
                        msg = self.outbox.popleft()
                    await self.ws.send_text(msg)
        except Exception:
            pass   # connection gone; the receive loop cleans up


class Hub:
    def __init__(self) -> None:
        self.phones: set[_Client] = set()
        self.viewers: set[_Client] = set()
        self.shared_plan: str | None = None     # last {"type":"plan"} from a phone, verbatim
        self._plan_times: dict[str, float] = {}  # peer host -> last accepted plan (monotonic)

    def counts(self) -> dict:
        return {"phones": len(self.phones), "viewers": len(self.viewers),
                "shared_plan": self.shared_plan is not None}

    @staticmethod
    def _fan_out(targets: set[_Client], message: str) -> None:
        for c in list(targets):
            c.offer(message)

    def _plan_rate_ok(self, host: str) -> bool:
        now = time.monotonic()
        if now - self._plan_times.get(host, -1e9) < PLAN_MIN_INTERVAL_S:
            return False
        if len(self._plan_times) > 1024:       # bounded: forget stale peers
            self._plan_times = {h: t for h, t in self._plan_times.items()
                                if now - t < PLAN_MIN_INTERVAL_S}
        self._plan_times[host] = now
        return True

    async def handle(self, ws: WebSocket) -> None:
        await ws.accept()
        client = _Client(ws)
        client.task = asyncio.create_task(client.pump())
        role = None
        peer = f"{ws.client.host}:{ws.client.port}" if ws.client else "?"
        peer_host = ws.client.host if ws.client else "?"

        def reject_plan(reason: str) -> None:
            client.offer(json.dumps({"type": "plan_rejected", "reason": reason}))
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                raw = msg.get("text")
                if raw is None:
                    data = msg.get("bytes")
                    if data is None:
                        continue
                    try:
                        raw = data.decode("utf-8")
                    except UnicodeDecodeError:
                        continue
                    nbytes = len(data)
                else:
                    nbytes = len(raw.encode("utf-8"))   # bytes, not characters
                if nbytes > PLAN_MAX_BYTES:
                    if role == "phone" and '"plan"' in raw[:4096]:
                        reject_plan("plan larger than 2 MB")
                    continue
                if role is None:
                    if nbytes > MAX_MESSAGE_BYTES:
                        continue
                    try:
                        data = json.loads(raw)
                    except ValueError:
                        continue
                    candidate = data.get("role") if isinstance(data, dict) else None
                    if candidate == "phone":
                        role = "phone"
                        self.phones.add(client)
                    elif candidate == "viewer":
                        role = "viewer"
                        self.viewers.add(client)
                    else:
                        print(f"[ws] {peer} sent unknown role {candidate!r}, ignoring")
                        continue
                    print(f"[ws] {role} connected ({peer}) phones={len(self.phones)} "
                          f"viewers={len(self.viewers)}")
                    if role == "viewer" and self.shared_plan is not None:
                        client.offer_plan(self.shared_plan)   # late joiner gets the plan
                    continue          # the role message itself is never forwarded
                # As in server.py, non-JSON frames are dropped, not forwarded.
                try:
                    data = json.loads(raw)
                except ValueError:
                    continue
                is_plan = (role == "phone" and isinstance(data, dict)
                           and data.get("type") == "plan")
                if is_plan:
                    if not isinstance(data.get("plan"), dict):
                        continue      # malformed: not cached, not forwarded
                    if not self._plan_rate_ok(peer_host):
                        reject_plan(f"plan updates are limited to one per "
                                    f"{PLAN_MIN_INTERVAL_S:g} s")
                        continue
                    self.shared_plan = raw
                    for v in list(self.viewers):
                        v.offer_plan(raw)
                    continue
                if nbytes > MAX_MESSAGE_BYTES:
                    continue
                self._fan_out(self.viewers if role == "phone" else self.phones, raw)
        except WebSocketDisconnect:
            pass
        finally:
            self.phones.discard(client)
            self.viewers.discard(client)
            if client.task:
                client.task.cancel()
            if role:
                print(f"[ws] {role} disconnected ({peer}) phones={len(self.phones)} "
                      f"viewers={len(self.viewers)}")
