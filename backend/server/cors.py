"""Request guards, pure ASGI: Host allowlist, Origin/CSRF policy, CORS, upload cap.

There is no auth (MVP decision), so the server limits who can talk to it from a
browser instead:

1. Host allowlist (DNS-rebinding defence). The Host header must name this
   machine: localhost, 127.0.0.1, [::1] or one of its LAN IPs, on a port the
   server listens on, or an extra host given with --allowed-host. Anything else
   gets 421 (HTTP) or a refused upgrade (WebSocket). Because of this check,
   "Origin equals Host" really does mean same-origin.

2. Origin policy (CSRF defence). A request that carries an Origin header must
   come from the same origin, an origin in Settings.allowed_origins
   (--allow-origin / PLANLIFTAR_ALLOWED_ORIGINS, e.g. the Vercel URL; "*" = any),
   or the Vite dev/preview server on localhost (DEV_ORIGINS: its proxy rewrites
   Host but forwards the browser's Origin). Private-LAN origins (192.168.x.x
   etc.) are allowed only with --allow-lan-origins. Any other Origin gets 403 on
   every request, preflight included, and WebSocket upgrades are refused, before
   the app runs. Requests without an Origin (curl, native apps) pass.

3. CORS as docs/API.md says: echo the allowed Origin; preflights answer
   Allow-Methods "GET, POST, OPTIONS" and Allow-Headers "Content-Type", plus
   Chrome's Private Network Access header, which a public https frontend needs
   to reach a 192.168.x.x server.

4. Upload cap on the request body (see the middleware).
"""
from __future__ import annotations

import ipaddress
import json
from urllib.parse import urlsplit

ALLOW_METHODS = "GET, POST, OPTIONS"
ALLOW_HEADERS = "Content-Type"
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")
DEV_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173",       # vite dev
               "http://localhost:4173", "http://127.0.0.1:4173")       # vite preview


def _is_private_host(host: str) -> bool:
    host = host.strip("[]").lower()
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local


def _split_host(value: str, default_port: int | None):
    """'host[:port]' or '[v6][:port]' -> (lowercase host without brackets, port)."""
    try:
        parts = urlsplit("//" + value.strip())
        host, port = parts.hostname, parts.port
    except ValueError:
        return None
    if not host:
        return None
    return host.lower(), (port if port is not None else default_port)


class HostPolicy:
    """Which Host header values name this server.

    Loopback names and LAN IPs are valid on `ports` (empty = any port).
    `extra` (--allowed-host): "name" matches any port, "name:port" only that one.
    """

    def __init__(self, lan_ips=(), ports=(), extra=()):
        self.hosts = {h.lower() for h in (*LOOPBACK_HOSTS, *lan_ips)}
        self.ports = set(ports)
        self.extra_any_port: set[str] = set()
        self.extra_exact: set[tuple] = set()
        for e in extra:
            hp = _split_host(e, None)
            if hp is None:
                continue
            if hp[1] is None:
                self.extra_any_port.add(hp[0])
            else:
                self.extra_exact.add(hp)

    def allows(self, host_header: str | None, scheme: str) -> bool:
        if not host_header:
            return False
        hp = _split_host(host_header, 443 if scheme in ("https", "wss") else 80)
        if hp is None:
            return False
        host, port = hp
        if host in self.extra_any_port or hp in self.extra_exact:
            return True
        return host in self.hosts and (not self.ports or port in self.ports)


class OriginPolicy:
    def __init__(self, allowed=(), allow_private_lan: bool = False):
        self.allowed = {o.rstrip("/").lower() for o in (*allowed, *DEV_ORIGINS)}
        self.allow_private_lan = allow_private_lan

    def allows(self, origin: str | None, host_header: str | None = None) -> bool:
        """Call only after HostPolicy accepted host_header."""
        if not origin:
            return True                  # not a browser cross-origin request
        origin = origin.rstrip("/").lower()
        if "*" in self.allowed or origin in self.allowed:
            return True
        try:
            parts = urlsplit(origin)
            hostname = parts.hostname
        except ValueError:
            return False
        if parts.scheme not in ("http", "https") or not hostname:
            return False
        if host_header and parts.netloc == host_header.lower():
            return True                  # same origin
        return self.allow_private_lan and _is_private_host(hostname)


class CorsAndLimitsMiddleware:
    def __init__(self, app, policy: OriginPolicy, hosts: HostPolicy, max_body: int):
        self.app = app
        self.policy = policy
        self.hosts = hosts
        self.max_body = max_body

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        host = headers.get("host")
        origin = headers.get("origin")

        if scope["type"] == "websocket":
            if not (self.hosts.allows(host, scope.get("scheme", "ws"))
                    and self.policy.allows(origin, host)):
                # Closing before accept makes the server refuse the upgrade (403).
                return await send({"type": "websocket.close", "code": 1008})
            return await self.app(scope, receive, send)

        if not self.hosts.allows(host, scope.get("scheme", "http")):
            return await _json(send, 421, {"error": f"unknown host {host!r}: use this "
                                                    "machine's IP address or localhost"})
        if origin is not None and not self.policy.allows(origin, host):
            return await _json(send, 403, {"error": "origin not allowed"})

        if scope["method"] == "OPTIONS" and origin and "access-control-request-method" in headers:
            h = [(b"access-control-allow-origin", origin.encode("latin-1")),
                 (b"access-control-allow-methods", ALLOW_METHODS.encode()),
                 (b"access-control-allow-headers", ALLOW_HEADERS.encode()),
                 (b"access-control-max-age", b"600"),
                 (b"vary", b"Origin")]
            if headers.get("access-control-request-private-network") == "true":
                h.append((b"access-control-allow-private-network", b"true"))
            await send({"type": "http.response.start", "status": 204, "headers": h})
            return await send({"type": "http.response.body", "body": b""})

        async def send_wrapper(message):
            if message["type"] == "http.response.start" and origin is not None:
                message = dict(message)
                message["headers"] = list(message.get("headers", [])) + [
                    (b"access-control-allow-origin", origin.encode("latin-1")),
                    (b"vary", b"Origin")]
            await send(message)

        # Upload cap: refuse on Content-Length before reading anything, and count
        # bytes for chunked bodies. Multipart overhead gets 1 MB of slack; the
        # image itself is checked exactly in the route.
        limit = self.max_body + 1024 * 1024
        try:
            declared = int(headers.get("content-length", "0"))
        except ValueError:
            declared = 0
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


async def _json(send, status, payload):
    body = json.dumps(payload).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode()),
                            (b"connection", b"close")]})
    await send({"type": "http.response.body", "body": body})
