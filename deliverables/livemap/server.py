#!/usr/bin/env python3
"""
server.py - Spectator Live Map companion server.

Serves two things side by side:
  1. Static files (index.html, floorplan.json) over plain HTTP on port 8080,
     so the laptop's browser (or anything else on the LAN) can load the page.
  2. A WebSocket broadcast hub on port 8765 (8080's "neighbor"), so the
     Unity Android app can stream phone poses and the browser page can
     subscribe to them.

Hub protocol
------------
The wire format is specified in PROTOCOL.md; this module only routes.

Every client's FIRST message must be JSON: {"role": "phone"} or
{"role": "viewer"}. That message itself is not broadcast - it just tags the
connection. After that the hub fans out in BOTH directions:
  - Any further message from a "phone"-tagged client goes verbatim to every
    "viewer"-tagged client (pose updates, state updates).
  - Any further message from a "viewer"-tagged client goes verbatim to every
    "phone"-tagged client (control patches from the laptop panel).

Viewers were read-only subscribers in v1. They are not any more - that
reverse path is what lets the laptop drive the phone's AR view. There is
deliberately no phone-to-phone or viewer-to-viewer delivery, so a message
can never loop back to its own sender's role and no echo suppression is
needed.

The hub stays dumb on purpose: it does not parse, validate or rewrite
anything past the role handshake. Clamping and validation belong on the
phone, which is the authority over its own state.

TLS (--tls), for phones on a hotspot with no USB cable
------------------------------------------------------
WebXR (ar.html) only runs in a "secure context". Over a cable that is free -
`adb reverse` lets the phone use http://localhost, which Chrome trusts. On a
hotspot there is no cable, so the phone must reach the laptop by IP, and
plain HTTP by IP is not a secure context.

`--tls` serves HTTPS on the static port and WSS on the hub port using a
self-signed certificate generated on the fly (see ensure_cert). Chrome will
show its "Your connection is not private" interstitial once per port -
Advanced -> Proceed - and from then on the origin IS a secure context, so
WebXR works with no cable and no browser flags.

The certificate covers every LAN IP the machine currently has, plus
localhost. If the laptop's address changes (very likely on a phone hotspot,
where the phone hands out DHCP leases), the cert no longer matches and is
regenerated automatically on the next start.

Dependencies: Python 3.8+, stdlib, and the `websockets` package
(pip install websockets). `--tls` additionally needs `cryptography`.

Plan-upload job stub (POST /jobs, GET /jobs/<id>)
--------------------------------------------------
`index.html`'s image-upload picker is a deliberate stub for a backend that
does not exist yet: MitUNet + CubiCasa inference only runs by hand in Kaggle
notebooks today. `planliftar-v1.md` specifies the eventual transport as a
REST async job API (no WebSocket), so this stub mirrors that shape rather
than inventing a different one that would need reworking later:

  - POST /jobs with the image bytes as the raw body -> 202 +
    {"job_id", "status": "queued"}.
  - GET /jobs/<job_id> -> {"status": "queued"|"running"|"done", ...},
    reaching {"status": "done", "result": <plan JSON>} after a short
    simulated delay.

The "result" is always `plans/bungalow.json` - a canned stand-in, never a
real analysis of the uploaded image. Jobs live in a plain dict in memory
(JOBS below); nothing is written to disk, and the uploaded bytes themselves
are read into memory just long enough to discard. Because this server binds
to 0.0.0.0 on a LAN, an unbounded read on POST /jobs would be a real DoS
hazard even for a dev tool, so the body size is capped (MAX_UPLOAD_BYTES)
and anything larger gets 413 before the rest of the body is read.
"""

import argparse
import asyncio
import datetime
import http.server
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import threading
import time
import urllib.parse
import uuid

import websockets

# stdout is block-buffered (not line-buffered) whenever it isn't a real
# terminal - e.g. redirected to a file/log or piped. Without this, the
# startup banner and every "[ws] ... connected/disconnected" line below
# could sit in an internal buffer instead of showing up promptly.
sys.stdout.reconfigure(line_buffering=True)

HTTP_PORT = 8080
WS_PORT = 8765
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(STATIC_DIR, ".certs")
CERT_FILE = os.path.join(CERT_DIR, "livemap-cert.pem")
KEY_FILE = os.path.join(CERT_DIR, "livemap-key.pem")

# --------------------------------------------------------------------------
# Plan-upload job stub state. See the module docstring for the contract.
# --------------------------------------------------------------------------
MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # a "few MB" cap on POST /jobs bodies
JOB_QUEUED_SECS = 1.0    # how long GET /jobs/<id> reports "queued"
JOB_RUNNING_SECS = 1.5   # ...then "running" for this long...
                          # ...then "done" forever after (elapsed-based, no
                          # timer thread needed).
JOB_PATH_RE = re.compile(r"^/jobs/([A-Za-z0-9_-]+)$")

JOBS = {}  # job_id -> creation time.monotonic(), guarded by JOBS_LOCK
JOBS_LOCK = threading.Lock()

# The canned "result" every job resolves to - loaded once at startup, not
# per-request. Never derived from an uploaded image; see module docstring.
with open(os.path.join(STATIC_DIR, "plans", "bungalow.json"), "r", encoding="utf-8") as _f:
    STUB_PLAN_RESULT = json.load(_f)


# --------------------------------------------------------------------------
# LAN IP discovery (best-effort, no external calls made - the UDP "connect"
# below never actually sends a packet, it just asks the OS which local
# interface/IP would be used to reach that address).
# --------------------------------------------------------------------------
def get_lan_ips():
    ips = set()

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ips.add(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass

    return sorted(ips) if ips else ["127.0.0.1"]


# --------------------------------------------------------------------------
# Self-signed certificate for --tls.
#
# The cert must name every address the phone might dial, as a Subject
# Alternative Name - modern browsers ignore the legacy Common Name entirely,
# so a cert without a matching SAN fails before the user is even offered the
# "proceed anyway" interstitial.
# --------------------------------------------------------------------------
def cert_covers(path, ips):
    """True if the cert at path is still valid and lists every ip as a SAN."""
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives.serialization import Encoding  # noqa: F401
    except ImportError:
        return False
    try:
        with open(path, "rb") as fh:
            cert = x509.load_pem_x509_certificate(fh.read())
    except (OSError, ValueError):
        return False
    if not os.path.exists(KEY_FILE):
        return False

    now = datetime.datetime.now(datetime.timezone.utc)
    not_after = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after
    if not_after.tzinfo is None:
        not_after = not_after.replace(tzinfo=datetime.timezone.utc)
    if not_after <= now:
        return False

    try:
        try:
            bc = cert.extensions.get_extension_for_class(x509.BasicConstraints).value
            if not bc.ca:
                return False       # pre-CA cert: regenerate so it can be trusted
        except x509.ExtensionNotFound:
            return False
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return False
    covered = {str(v) for v in san.get_values_for_type(x509.IPAddress)}
    return all(ip in covered for ip in ips)


def ensure_cert(ips, force=False):
    """Return (cert_path, key_path), generating a self-signed pair if needed."""
    if not force and cert_covers(CERT_FILE, ips) and os.path.getsize(KEY_FILE or "") > 0:
        print(f"[tls] reusing {CERT_FILE}")
        return CERT_FILE, KEY_FILE

    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        sys.exit(
            "--tls needs the `cryptography` package: pip install cryptography. "
            "Or run without --tls and use the Chrome-flag route in README.md."
        )

    os.makedirs(CERT_DIR, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "planliftar-livemap")])

    alt = [x509.DNSName("localhost")]
    for ip in ips + ["127.0.0.1"]:
        try:
            alt.append(x509.IPAddress(ipaddress.ip_address(ip)))
        except ValueError:
            continue

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(alt), critical=False)
        # ca=True is what lets this be installed as a trusted certificate on
        # a phone. Chrome refuses to register a service worker on an origin
        # whose certificate it distrusts - clicking through the interstitial
        # is not enough - so without this the PWA can never install and the
        # AR view can never work offline. The chain is length 1: this cert
        # signs itself, and once it is in the trust store it validates.
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(digital_signature=True, key_encipherment=True,
                          key_cert_sign=True, crl_sign=True,
                          content_commitment=False, data_encipherment=False,
                          key_agreement=False, encipher_only=False,
                          decipher_only=False),
            critical=True,
        )
        .sign(key, hashes.SHA256())
    )

    # Write the key FIRST and both via temp-then-rename. A crash between the
    # two writes used to leave a valid-looking cert next to a missing key,
    # which the reuse check above happily accepted and then failed to load.
    key_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    for path, blob in ((KEY_FILE, key_pem), (CERT_FILE, cert.public_bytes(serialization.Encoding.PEM))):
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(blob)
        os.replace(tmp, path)

    print(f"[tls] generated a self-signed cert for {', '.join(ips)} -> {CERT_FILE}")
    return CERT_FILE, KEY_FILE


def make_ssl_context(ips):
    """Load the cert pair, regenerating once if what is on disk is unusable."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    try:
        ctx.load_cert_chain(*ensure_cert(ips))
    except (ssl.SSLError, OSError) as exc:
        print(f"[tls] existing cert unusable ({exc}); regenerating")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(*ensure_cert(ips, force=True))
    return ctx


# --------------------------------------------------------------------------
# Static file server (runs in a background thread; independent of asyncio).
# --------------------------------------------------------------------------
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def address_string(self):
        """Return the raw client IP, skipping BaseHTTPRequestHandler's reverse-DNS.

        The default implementation calls socket.getfqdn(), which for a LAN address
        with no PTR record blocks until the resolver times out - measured at ~4.5s
        for 192.168.x.x here, against 0.007s for 127.0.0.1 (the hosts file), which
        is why this is invisible when testing from the laptop and crippling from
        the phone. send_response() calls log_request() BEFORE writing the body, so
        that delay lands on every single request: every page load, every plan
        fetch, and every /jobs poll.
        """
        return self.client_address[0]

    def log_message(self, fmt, *args):
        print(f"[http] {self.address_string()} - {fmt % args}")

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- GET /jobs/<id>, else fall through to normal static-file serving. --
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/cert":
            self._handle_cert()
            return
        match = JOB_PATH_RE.match(path)
        if match:
            self._handle_job_status(match.group(1))
            return
        super().do_GET()

    def _handle_cert(self):
        """Hand out the TLS certificate so a phone can trust this origin.

        Served as DER, which is the form Android's certificate installer
        expects; the PEM on disk is what the server itself loads. This is the
        PUBLIC certificate only - the private key lives beside it in .certs/
        and is never served, which is also why that directory is gitignored.

        Trusting this makes the phone accept THIS machine's LAN address
        without an interstitial, which is what lets a service worker register
        and the PWA install. Only install it on a device you control.
        """
        try:
            with open(CERT_FILE, "rb") as fh:
                pem = fh.read()
            from cryptography import x509
            from cryptography.hazmat.primitives.serialization import Encoding
            der = x509.load_pem_x509_certificate(pem).public_bytes(Encoding.DER)
        except Exception as exc:                      # no cert, or no cryptography
            self.send_error(404, "no certificate available (%s)" % exc.__class__.__name__)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-x509-ca-cert")
        self.send_header("Content-Length", str(len(der)))
        self.send_header("Content-Disposition", 'attachment; filename="planliftar.crt"')
        self.end_headers()
        self.wfile.write(der)

    # -- POST /jobs (image-upload job stub); nothing else accepts POST. --
    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/jobs":
            self._handle_job_create()
            return
        self.send_error(404, "not found")

    def _handle_job_create(self):
        length_header = self.headers.get("Content-Length")
        try:
            content_length = int(length_header)
        except (TypeError, ValueError):
            self._send_json(411, {"error": "Content-Length required"})
            self.close_connection = True
            return

        if content_length > MAX_UPLOAD_BYTES:
            # Reject BEFORE reading the body - reading an attacker-declared
            # multi-GB Content-Length just to discard it is itself the
            # hazard being guarded against. Closing the connection avoids
            # the unread body desyncing the next request on this socket.
            self._send_json(
                413,
                {"error": f"upload exceeds {MAX_UPLOAD_BYTES} byte limit"},
            )
            self.close_connection = True
            return

        body = self.rfile.read(content_length)
        job_id = uuid.uuid4().hex
        with JOBS_LOCK:
            JOBS[job_id] = time.monotonic()
        print(f"[jobs] created {job_id} ({len(body)} bytes received, discarded - stub, no inference)")
        self._send_json(202, {"job_id": job_id, "status": "queued"})

    def _handle_job_status(self, job_id):
        with JOBS_LOCK:
            created = JOBS.get(job_id)
        if created is None:
            self._send_json(404, {"error": "unknown job_id"})
            return

        elapsed = time.monotonic() - created
        if elapsed < JOB_QUEUED_SECS:
            status = "queued"
        elif elapsed < JOB_QUEUED_SECS + JOB_RUNNING_SECS:
            status = "running"
        else:
            status = "done"

        payload = {"job_id": job_id, "status": status}
        if status == "done":
            # Always the canned sample - see module docstring. This is a
            # stub, not inference over whatever image was uploaded.
            payload["result"] = STUB_PLAN_RESULT
        self._send_json(200, payload)


def run_http_server(ssl_ctx=None):
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), QuietHandler)
    if ssl_ctx is not None:
        httpd.socket = ssl_ctx.wrap_socket(httpd.socket, server_side=True)
    httpd.serve_forever()


# --------------------------------------------------------------------------
# WebSocket broadcast hub.
# --------------------------------------------------------------------------
VIEWERS = set()
PHONES = set()


async def broadcast(targets, message):
    """Send message to every client in targets, dropping ones that died mid-send.

    Iterates over a copy: a client can disconnect while we are awaiting an
    earlier send, and mutating the live set during iteration would raise.
    """
    if not targets:
        return
    stale = []
    for client in list(targets):
        try:
            await client.send(message)
        except websockets.exceptions.ConnectionClosed:
            stale.append(client)
    for client in stale:
        targets.discard(client)


async def handler(websocket):
    role = None
    peer = getattr(websocket, "remote_address", None)

    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
            except (ValueError, TypeError):
                continue

            if role is None:
                candidate = data.get("role")
                if candidate == "phone":
                    role = "phone"
                    PHONES.add(websocket)
                    print(f"[ws] phone connected  ({peer})  phones={len(PHONES)}")
                elif candidate == "viewer":
                    role = "viewer"
                    VIEWERS.add(websocket)
                    print(f"[ws] viewer connected ({peer})  viewers={len(VIEWERS)}")
                else:
                    print(f"[ws] client {peer} sent unknown role {candidate!r}, ignoring")
                # The role-announcement message itself is never broadcast.
                continue

            if role == "phone":
                await broadcast(VIEWERS, raw)
            elif role == "viewer":
                # Control patches / hello from the laptop panel. Forwarded
                # verbatim - see the module docstring for why the hub does
                # not inspect them.
                await broadcast(PHONES, raw)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        PHONES.discard(websocket)
        VIEWERS.discard(websocket)
        if role:
            print(f"[ws] {role} disconnected ({peer})  phones={len(PHONES)} viewers={len(VIEWERS)}")


async def main(use_tls):
    ips = get_lan_ips()
    ssl_ctx = make_ssl_context(ips) if use_tls else None
    scheme, ws_scheme = ("https", "wss") if use_tls else ("http", "ws")

    threading.Thread(target=run_http_server, args=(ssl_ctx,), daemon=True).start()

    print("=" * 60)
    print("Spectator Live Map server starting" + ("  [TLS]" if use_tls else ""))
    print("-" * 60)
    print("Static page (open on the laptop):")
    for ip in ips:
        print(f"    {scheme}://{ip}:{HTTP_PORT}")
    print()
    print("WebSocket hub (type into the Unity app's Server Address field;")
    print("both web pages derive this from their own URL automatically):")
    for ip in ips:
        print(f"    {ws_scheme}://{ip}:{WS_PORT}")
    print()
    if use_tls:
        print("PHONE, no cable (hotspot-friendly). The cert is self-signed, so")
        print("Chrome shows one interstitial PER PORT - tap Advanced -> Proceed:")
        for ip in ips:
            print(f"    1. https://{ip}:{WS_PORT}   <- accept here FIRST (the hub)")
            print( "       It will then answer 'Failed to open a WebSocket")
            print( "       connection ... You cannot access a WebSocket server")
            print( "       directly with a browser.' THAT IS THE CORRECT RESULT -")
            print( "       the point is only to make Chrome store a cert exception")
            print( "       for this port. A blocked wss:// never shows one.")
            print(f"    2. https://{ip}:{HTTP_PORT}/ar.html")
    else:
        print("PHONE: ar.html needs a secure context, which plain http:// by IP")
        print("is not. Either restart with --tls, or allowlist this exact origin")
        print("in chrome://flags/#unsafely-treat-insecure-origin-as-secure:")
        for ip in ips:
            print(f"    http://{ip}:{HTTP_PORT}")
    print("=" * 60)
    sys.stdout.flush()

    async with websockets.serve(handler, "0.0.0.0", WS_PORT, ssl=ssl_ctx):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Spectator Live Map server.")
    parser.add_argument(
        "--tls",
        action="store_true",
        help="serve HTTPS/WSS with a self-signed cert, so a phone on a hotspot "
             "gets the secure context WebXR needs without a USB cable",
    )
    args = parser.parse_args()

    try:
        asyncio.run(main(args.tls))
    except KeyboardInterrupt:
        print("\nShutting down.")
