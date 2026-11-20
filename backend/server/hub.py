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

Each client gets its own bounded outbound queue and sender task, so one slow
or stalled phone/viewer cannot hold up the fan-out to the others (oldest
messages are dropped for that client when its queue is full; poses are 10 Hz
and superseded anyway).
"""
from __future__ import annotations

import asyncio
import json

from starlette.websockets import WebSocket, WebSocketDisconnect

OUTBOX_SIZE = 256
MAX_MESSAGE_BYTES = 256 * 1024


class _Client:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.outbox: asyncio.Queue[str] = asyncio.Queue(maxsize=OUTBOX_SIZE)
        self.task: asyncio.Task | None = None

    def offer(self, message: str) -> None:
        if self.outbox.full():
            try:
                self.outbox.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self.outbox.put_nowait(message)

    async def pump(self) -> None:
        try:
            while True:
                msg = await self.outbox.get()
                await self.ws.send_text(msg)
        except Exception:
            pass   # connection gone; the receive loop cleans up


class Hub:
    def __init__(self) -> None:
        self.phones: set[_Client] = set()
        self.viewers: set[_Client] = set()

    def counts(self) -> dict:
        return {"phones": len(self.phones), "viewers": len(self.viewers)}

    @staticmethod
    def _fan_out(targets: set[_Client], message: str) -> None:
        for c in list(targets):
            c.offer(message)

    async def handle(self, ws: WebSocket) -> None:
        await ws.accept()
        client = _Client(ws)
        client.task = asyncio.create_task(client.pump())
        role = None
        peer = f"{ws.client.host}:{ws.client.port}" if ws.client else "?"
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
                if len(raw) > MAX_MESSAGE_BYTES:
                    continue
                if role is None:
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
                    continue          # the role message itself is never forwarded
                # As in server.py, non-JSON frames are dropped, not forwarded.
                try:
                    json.loads(raw)
                except ValueError:
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
