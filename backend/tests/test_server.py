"""Server tests (FastAPI TestClient). Demo mode: no torch, no GPU, a few seconds.

    cd backend
    python -m pytest tests -q               # fast tests
    python -m pytest tests -q -m slow       # + the real-GPU end-to-end job (~1 min)
"""
from __future__ import annotations

import io
import json
import sys
import time
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from server import Settings, create_app  # noqa: E402

SAMPLE = BACKEND / "samples" / "cubicasa_10052_F1_original.png"


def png_bytes(w=320, h=240, fmt="PNG") -> bytes:
    im = Image.new("RGB", (w, h), "white")
    for x in range(40, w - 40):
        im.putpixel((x, 40), (0, 0, 0))
    buf = io.BytesIO()
    im.save(buf, fmt)
    return buf.getvalue()


def demo_settings(tmp_path, **kw) -> Settings:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True, exist_ok=True)
    (dist / "index.html").write_text("<!doctype html><title>app</title>", encoding="utf-8")
    (dist / "sw.js").write_text("self.addEventListener('fetch',()=>{})", encoding="utf-8")
    (dist / "manifest.webmanifest").write_text("{}", encoding="utf-8")
    (dist / "assets" / "index-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (tmp_path / "config.py").write_text("MAX_UPLOAD_BYTES = 1  # outside dist", encoding="utf-8")
    base = Settings(demo=True, demo_step_s=0.02, static_dir=dist, cert_dir=tmp_path / "certs",
                    allowed_origins=("https://planliftar.vercel.app",),
                    lan_ips=("192.168.1.20",), listen_ports=(8000, 8443),
                    allowed_hosts=("testserver",))     # TestClient's default Host
    return replace(base, **kw)


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(demo_settings(tmp_path))) as c:
        yield c


def post_image(c, data: bytes, ctype="image/png", options=None, name="plan.png"):
    form = {"options": options} if options is not None else None
    return c.post("/api/jobs", files={"image": (name, data, ctype)}, data=form)


def wait_done(c, job_id, timeout=10.0):
    seen = []
    t0 = time.time()
    while time.time() - t0 < timeout:
        body = c.get(f"/api/jobs/{job_id}").json()
        seen.append(body)
        if body["status"] in ("done", "error"):
            return body, seen
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not finish: {seen[-1]}")


# ------------------------------------------------------------------ health
def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["device"] in ("cuda", "cpu")
    assert isinstance(body["engine_version"], str)
    assert set(body["models"]) == {"mitunet", "cubicasa"}
    assert r.headers["cache-control"] == "no-store"


# ------------------------------------------------------- upload validation
def test_missing_image_is_400(client):
    r = client.post("/api/jobs", data={"options": "{}"}, files={"other": ("x", b"y")})
    assert r.status_code == 400 and "image" in r.json()["error"]
    r = client.post("/api/jobs", json={"image": "nope"})
    assert r.status_code == 400


@pytest.mark.parametrize("opts", ["{not json", "[1,2]", '{"use_cubicasa": "yes"}',
                                  '{"preset": "turbo"}'])
def test_bad_options_are_400(client, opts):
    r = post_image(client, png_bytes(), options=opts)
    assert r.status_code == 400, r.text
    assert "error" in r.json()


def test_corrupt_and_tiny_images_are_400(client):
    truncated = png_bytes()[:200]
    assert post_image(client, truncated).status_code == 400
    assert post_image(client, b"").status_code == 400
    assert post_image(client, png_bytes(32, 32)).status_code == 400       # < 64 px


def test_unsupported_types_are_415(client):
    gif = png_bytes(fmt="GIF")
    assert post_image(client, gif, "image/gif", name="a.gif").status_code == 415
    # declared PNG, but the bytes are not PNG/JPEG/WebP
    assert post_image(client, gif, "image/png").status_code == 415
    assert post_image(client, b"hello world, not an image", "text/plain").status_code == 415


def test_jpeg_and_webp_accepted(client):
    for fmt, ctype in (("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
        r = post_image(client, png_bytes(fmt=fmt), ctype)
        assert r.status_code == 202, r.text


def test_oversize_upload_is_413(tmp_path):
    s = demo_settings(tmp_path, max_upload_bytes=4096)
    with TestClient(create_app(s)) as c:
        big = png_bytes(800, 800) + b"\0" * 8000        # > 4 KB, < the 1 MB slack
        r = post_image(c, big)
        assert r.status_code == 413, r.text
        # Content-Length beyond limit + slack: refused before the body is read
        r = post_image(c, b"\0" * (4096 + 2 * 1024 * 1024))
        assert r.status_code == 413


def test_default_15mb_limit_is_413(client):
    big = png_bytes() + b"\0" * (15 * 1024 * 1024)
    r = post_image(client, big)
    assert r.status_code == 413


def test_decompression_bomb_is_413(tmp_path):
    with TestClient(create_app(demo_settings(tmp_path, max_image_pixels=100_000))) as c:
        r = post_image(c, png_bytes(400, 400))            # 160k px > 100k cap
        assert r.status_code == 413 and "pixels" in r.json()["error"]


# ------------------------------------------------------------ job lifecycle
def test_job_lifecycle_demo(client):
    r = post_image(client, png_bytes())
    assert r.status_code == 202
    job_id = r.json()["id"]
    body, seen = wait_done(client, job_id)
    assert body["status"] == "done"
    progress = [b["progress"] for b in seen]
    assert progress == sorted(progress) and body["progress"] == 1.0
    assert {b["status"] for b in seen} <= {"queued", "running", "done"}
    assert all(isinstance(b["stage"], str) and b["stage"] for b in seen)
    plan = body["result"]
    assert plan["schema_version"] == "2.0" and plan["walls"] and plan["rooms"]
    assert "demo" in plan["acceptance"]["notes"]
    assert "error" not in body

    ov = client.get(f"/api/jobs/{job_id}/overlay.png")
    assert ov.status_code == 200 and ov.headers["content-type"] == "image/png"
    assert ov.content.startswith(b"\x89PNG")


def test_fast_preset_and_default_options(client):
    app = client.app
    j1 = post_image(client, png_bytes()).json()["id"]
    j2 = post_image(client, png_bytes(), options='{"preset": "fast"}').json()["id"]
    j3 = post_image(client, png_bytes(), options='{"preset": "fast", "use_cubicasa": true}').json()["id"]
    assert app.state.jobs.get(j1).options["use_cubicasa"] is True
    assert app.state.jobs.get(j2).options["use_cubicasa"] is False
    assert app.state.jobs.get(j3).options["use_cubicasa"] is True
    for j in (j1, j2, j3):
        assert wait_done(client, j)[0]["status"] == "done"


def test_unknown_job_and_ttl_expiry(client):
    assert client.get("/api/jobs/nope").status_code == 404
    assert client.get("/api/jobs/nope").json()["error"]
    assert client.get("/api/jobs/nope/overlay.png").status_code == 404
    job_id = post_image(client, png_bytes()).json()["id"]
    wait_done(client, job_id)
    jobs = client.app.state.jobs
    assert jobs.cleanup(now=time.time()) == 0
    assert jobs.cleanup(now=time.time() + 10 * 3600) == 1
    assert client.get(f"/api/jobs/{job_id}").status_code == 404


def test_queue_full_is_503(tmp_path):
    with TestClient(create_app(demo_settings(tmp_path, max_queue=1, demo_step_s=0.3))) as c:
        first = post_image(c, png_bytes())
        assert first.status_code == 202
        for _ in range(50):     # wait until the worker picked it up
            if c.get(f"/api/jobs/{first.json()['id']}").json()["status"] == "running":
                break
            time.sleep(0.02)
        assert post_image(c, png_bytes()).status_code == 202     # waits in the queue
        r = post_image(c, png_bytes())
        assert r.status_code == 503 and "busy" in r.json()["error"]


# ---------------------------------------------------------------------- CORS
def test_cors_preflight_and_headers(client):
    pre = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}
    for origin in ("https://planliftar.vercel.app", "http://localhost:5173"):
        r = client.options("/api/jobs", headers={"Origin": origin, **pre})
        assert r.status_code == 204, origin
        assert r.headers["access-control-allow-origin"] == origin
        assert r.headers["access-control-allow-methods"] == "GET, POST, OPTIONS"
        assert r.headers["access-control-allow-headers"] == "Content-Type"
    r = client.options("/api/health", headers={"Origin": "https://evil.example", **pre})
    assert r.status_code == 403 and "access-control-allow-origin" not in r.headers
    # Chrome Private Network Access
    r = client.options("/api/health", headers={"Origin": "https://planliftar.vercel.app",
                                                "Access-Control-Request-Private-Network": "true",
                                                **pre})
    assert r.headers["access-control-allow-private-network"] == "true"
    r = client.get("/api/health", headers={"Origin": "https://planliftar.vercel.app"})
    assert r.headers["access-control-allow-origin"] == "https://planliftar.vercel.app"
    r = client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and "access-control-allow-origin" not in r.headers


# ------------------------------------------- Host allowlist / Origin (CSRF)
@pytest.mark.parametrize("host", ["evil.example", "evil.example:8000", "192.168.1.99:8000",
                                  "192.168.1.20:9999", "localhost:1234", ""])
def test_unknown_host_is_421(client, host):
    r = client.get("/api/health", headers={"Host": host})
    assert r.status_code == 421, host
    r = client.post(
        "/api/jobs", headers={"Host": host}, files={"image": ("a.png", png_bytes(), "image/png")})
    assert r.status_code == 421


@pytest.mark.parametrize("host", ["localhost:8000", "127.0.0.1:8000", "[::1]:8000",
                                  "192.168.1.20:8443", "testserver"])
def test_known_hosts_pass(client, host):
    assert client.get("/api/health", headers={"Host": host}).status_code == 200


def test_extra_allowed_host_flag(tmp_path):
    s = demo_settings(tmp_path, allowed_hosts=("testserver", "mylaptop.local:8443"))
    with TestClient(create_app(s)) as c:
        assert c.get("/api/health", headers={"Host": "mylaptop.local:8443"}).status_code == 200
        assert c.get("/api/health", headers={"Host": "mylaptop.local:8000"}).status_code == 421


def test_cross_site_post_is_403_before_the_app_runs(client):
    jobs = client.app.state.jobs
    before = jobs.counts()
    for origin in ("https://evil.example", "http://192.168.1.50:3000", "null"):
        r = client.post("/api/jobs", headers={"Origin": origin},
                        files={"image": ("a.png", png_bytes(), "image/png")})
        assert r.status_code == 403, origin
    assert jobs.counts() == before
    # same origin (Origin matches an allowed Host) and the configured origin pass
    for origin in ("http://testserver", "https://planliftar.vercel.app"):
        r = client.post("/api/jobs", headers={"Origin": origin},
                        files={"image": ("a.png", png_bytes(), "image/png")})
        assert r.status_code == 202, origin
    r = client.post("/api/jobs", headers={"Origin": "http://192.168.1.20:8443",
                                          "Host": "192.168.1.20:8443"},
                    files={"image": ("a.png", png_bytes(), "image/png")})
    assert r.status_code == 202


def test_lan_origins_are_opt_in(tmp_path):
    pre = {"Origin": "http://192.168.1.50:5173", "Access-Control-Request-Method": "POST"}
    with TestClient(create_app(demo_settings(tmp_path))) as c:
        assert c.options("/api/jobs", headers=pre).status_code == 403
    with TestClient(create_app(demo_settings(tmp_path, allow_private_lan_origins=True))) as c:
        r = c.options("/api/jobs", headers=pre)
        assert r.status_code == 204
        assert r.headers["access-control-allow-origin"] == "http://192.168.1.50:5173"


def test_ws_rejects_unknown_host(client):
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"Host": "evil.example"}) as ws:
            ws.receive_text()
    with client.websocket_connect("/ws", headers={"Host": "192.168.1.20:8443",
                                                  "Origin": "https://192.168.1.20:8443"}) as ws:
        ws.send_text('{"role":"viewer"}')     # accepted: same origin on a LAN IP


# ------------------------------------------------------------------- ws hub
def test_ws_hub_fan_out(client):
    with client.websocket_connect("/ws") as phone, \
            client.websocket_connect("/ws") as phone2, \
            client.websocket_connect("/ws") as viewer:
        phone.send_text(json.dumps({"role": "phone"}))
        phone2.send_text(json.dumps({"role": "phone"}))
        viewer.send_text(json.dumps({"role": "viewer"}))
        hub = client.app.state.hub
        for _ in range(100):
            if hub.counts() == {"phones": 2, "viewers": 1}:
                break
            time.sleep(0.01)
        assert hub.counts() == {"phones": 2, "viewers": 1}

        # phone -> viewers, verbatim (byte-identical text, incl. spacing)
        pose = '{"x": 1420.5, "y": 980.2,  "yaw_deg": 37.4}'
        phone.send_text(pose)
        assert viewer.receive_text() == pose
        state = json.dumps({"type": "state", "state": {"placed": False, "xr": "idle"}})
        phone.send_text(state)
        assert viewer.receive_text() == state
        phone.send_text("not json")                 # dropped, like server.py
        unknown = '{"type":"future_thing","a":1}'   # unknown types pass through
        phone.send_text(unknown)
        assert viewer.receive_text() == unknown

        # viewer -> phones. phone2 must NOT have received phone's pose (no
        # phone-to-phone delivery): its first message is the viewer's hello.
        hello = '{"type":"hello"}'
        viewer.send_text(hello)
        assert phone2.receive_text() == hello
        assert phone.receive_text() == hello
        control = json.dumps({"type": "control", "patch": {"model_denom": 40}})
        viewer.send_text(control)
        assert phone.receive_text() == control
        assert phone2.receive_text() == control


def test_ws_untagged_messages_are_ignored(client):
    with client.websocket_connect("/ws") as viewer, client.websocket_connect("/ws") as anon:
        viewer.send_text('{"role":"viewer"}')
        anon.send_text('{"x":1,"y":2,"yaw_deg":0}')      # no role yet: ignored
        anon.send_text('{"role":"admin"}')               # unknown role: ignored
        anon.send_text('{"role":"phone"}')
        anon.send_text('{"x":3,"y":4,"yaw_deg":0}')
        assert viewer.receive_text() == '{"x":3,"y":4,"yaw_deg":0}'


def test_ws_rejects_foreign_origin(client):
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"Origin": "https://evil.example"}) as ws:
            ws.receive_text()


# ------------------------------------------------------------- static / SPA
def test_spa_fallback_and_cache_headers(client):
    for path in ("/", "/projects/abc/3d", "/new/job/xyz", "/learn"):
        r = client.get(path)
        assert r.status_code == 200 and "<title>app</title>" in r.text, path
        assert r.headers["cache-control"] == "no-cache"
    sw = client.get("/sw.js")
    assert sw.status_code == 200 and sw.headers["cache-control"] == "no-cache"
    assert "javascript" in sw.headers["content-type"]
    mf = client.get("/manifest.webmanifest")
    assert mf.headers["cache-control"] == "no-cache"
    assert mf.headers["content-type"].startswith("application/manifest+json")
    asset = client.get("/assets/index-abc123.js")
    assert "immutable" in asset.headers["cache-control"]
    assert client.get("/assets/missing-123.js").status_code == 404
    # never the SPA shell for /api or /ws
    r = client.get("/api/does-not-exist")
    assert r.status_code == 404 and r.json() == {"error": "not found"}
    assert client.get("/ws/x").status_code == 404
    # no dot-dirs, no traversal, no key material
    assert client.get("/.certs/server-key.pem").status_code == 404
    for path in ("/%2e%2e/config.py", "/..%2fconfig.py",
                 "/assets/..%5c..%5cconfig.py"):
        r = client.get(path)
        assert "MAX_UPLOAD_BYTES" not in r.text, path


def test_app_not_built_page(tmp_path):
    s = demo_settings(tmp_path, static_dir=tmp_path / "nowhere")
    with TestClient(create_app(s)) as c:
        r = c.get("/")
        assert r.status_code == 404 and "pnpm build" in r.text
        assert c.get("/api/health").status_code == 200


def test_cert_route_serves_only_public_ca(tmp_path):
    from server.tls import CertPaths, ensure_cert
    s = demo_settings(tmp_path)
    with TestClient(create_app(s)) as c:
        assert c.get("/cert").status_code == 404           # TLS off
    s = replace(s, tls=True)
    paths = ensure_cert(CertPaths(s.cert_dir), ["192.168.1.20"])
    with TestClient(create_app(s)) as c:
        r = c.get("/cert")
        assert r.status_code == 200
        assert r.headers["content-type"] == "application/x-x509-ca-cert"
        from cryptography import x509
        ca = x509.load_der_x509_certificate(r.content)
        assert ca.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
        ca.extensions.get_extension_for_class(x509.NameConstraints)
        assert b"PRIVATE KEY" not in r.content
        assert c.get("/.certs/server-key.pem").status_code == 404
    leaf = x509.load_pem_x509_certificate(paths.chain.read_bytes())
    san = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert {str(v) for v in san.get_values_for_type(x509.IPAddress)} >= {"192.168.1.20", "127.0.0.1"}
    assert not paths.ca.read_text().count("PRIVATE KEY")


# ------------------------------------------------------- real GPU, slow
@pytest.mark.slow
def test_real_engine_job_end_to_end(tmp_path):
    """One real job through HTTP on the bundled sample (MitUNet + CubiCasa)."""
    from planliftar_engine import weights
    if not SAMPLE.exists() or not (weights.WEIGHTS_DIR / weights.MITUNET_FILE).exists():
        pytest.skip("sample image or weights not present")
    s = replace(demo_settings(tmp_path), demo=False)
    with TestClient(create_app(s)) as c:
        t0 = time.time()
        while c.get("/api/health").json()["loading"]:
            assert time.time() - t0 < 300
            time.sleep(0.5)
        health = c.get("/api/health").json()
        assert health["ok"] and health["models"]["mitunet"]
        r = post_image(c, SAMPLE.read_bytes(), name=SAMPLE.name)
        assert r.status_code == 202
        body, seen = wait_done(c, r.json()["id"], timeout=600)
        assert body["status"] == "done", body.get("error")
        stages = [b["stage"] for b in seen]
        assert "segmenting walls (MitUNet)" in stages
        plan = body["result"]
        assert plan["schema_version"] == "2.0"
        assert plan["source"]["image_width_px"] == 2730
        assert plan["walls"] and plan["rooms"]
        print(f"\nreal job: {plan['engine']['mode']} total={plan['engine']['total_s']}s "
              f"walls={len(plan['walls'])} rooms={len(plan['rooms'])} "
              f"timings={plan['engine']['timings_s']}")
        assert c.get(f"/api/jobs/{body['id']}/overlay.png").status_code == 200
