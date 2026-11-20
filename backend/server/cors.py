"""CORS for docs/API.md, plus an upload size guard. Pure ASGI (WebSockets pass through).

There is no auth, so instead of `*` the server echoes the request Origin only
when it is one we expect to call us:

* the same origin (the PWA served by this server),
* origins in Settings.allowed_origins (e.g. the Vercel deployment; set with
  --allow-origin or PLANLIFTAR_ALLOWED_ORIGINS; "*" allows any),
* private-LAN / loopback origins (localhost, 127/8, 10/8, 172.16/12,
  192.168/16, *.local), e.g. the Vite dev server or another laptop.

Preflights answer Allow-Methods "GET, POST, OPTIONS" and Allow-Headers
"Content-Type" as the contract says, plus Chrome's Private Network Access
header (Access-Control-Allow-Private-Network), which a public https frontend
needs to reach a 192.168.x.x server.
"""
from __future__ import annotations

import ipaddress
import json
from urllib.parse import urlsplit

ALLOW_METHODS = "GET, POST, OPTIONS"
ALLOW_HEADERS = "Content-Type"


def _is_private_host(host: str) -> bool:
    host = host.strip("[]").lower()
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local


class OriginPolicy:
    def __init__(self, allowed: tuple[str, ...], allow_private_lan: bool = True):
        self.allowed = {o.rstrip("/").lower() for o in allowed}
        self.allow_private_lan = allow_private_lan

    def allows(self, origin: str | None, host_header: str | None = None) -> bool:
        if not origin:
            return True                  # not a browser cross-origin request
        origin = origin.rstrip("/").lower()
        if "*" in self.allowed or origin in self.allowed:
            return True
        parts = urlsplit(origin)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return False
        if host_header and parts.netloc == host_header.lower():
            return True                  # same origin
        return self.allow_private_lan and _is_private_host(parts.hostname)


class CorsAndLimitsMiddleware:
    def __init__(self, app, policy: OriginPolicy, max_body: int):
        self.app = app
        self.policy = policy
        self.max_body = max_body

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        origin = headers.get("origin")
        allowed = origin is not None and self.policy.allows(origin, headers.get("host"))

        if scope["method"] == "OPTIONS" and origin and "access-control-request-method" in headers:
            if not allowed:
                return await _plain(send, 403, b"origin not allowed")
            h = [(b"access-control-allow-origin", origin.encode("latin-1")),
                 (b"access-control-allow-methods", ALLOW_METHODS.encode()),
                 (b"access-control-allow-headers", ALLOW_HEADERS.encode()),
                 (b"access-control-max-age", b"600"),
                 (b"vary", b"Origin")]
            if headers.get("access-control-request-private-network") == "true":
                h.append((b"access-control-allow-private-network", b"true"))
            await send({"type": "http.response.start", "status": 204, "headers": h})
            return await send({"type": "http.response.body", "body": b""})

        # Upload cap: refuse on Content-Length before reading anything, and count
        # bytes for chunked bodies. Multipart overhead gets 1 MB of slack; the
        # image itself is checked exactly in the route.
        limit = self.max_body + 1024 * 1024
        try:
            declared = int(headers.get("content-length", "0"))
        except ValueError:
            declared = 0
        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                if allowed:
                    message = dict(message)
                    message["headers"] = list(message.get("headers", [])) + [
                        (b"access-control-allow-origin", origin.encode("latin-1")),
                        (b"vary", b"Origin")]
            await send(message)

        if declared > limit:
            return await _json(send_wrapper, 413, {"error": f"upload larger than "
                                                   f"{self.max_body // (1024 * 1024)} MB"})
        seen = 0

        async def receive_wrapper():
            # Over the cap: pretend the client went away (Starlette raises
            # ClientDisconnect while parsing) and flag the scope so the route
            # answers 413 instead of 400.
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    scope.setdefault("state", {})["body_too_large"] = True
                    return {"type": "http.disconnect"}
            return message

        await self.app(scope, receive_wrapper, send_wrapper)


async def _plain(send, status, body: bytes):
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"text/plain"),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


async def _json(send, status, payload):
    body = json.dumps(payload).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode()),
                            (b"connection", b"close")]})
    await send({"type": "http.response.body", "body": body})
