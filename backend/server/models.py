"""Short-lived GLB hosting for Android Scene Viewer (POST/GET /api/models).

Scene Viewer is a separate app: it fetches the model itself, so it needs an
http(s) URL, not the blob: URL the page built the GLB into. The app uploads its
exported GLB here and points <model-viewer src> at the returned URL.

Bounded on purpose (no auth, shared laptop): each model is at most
MODEL_MAX_BYTES, must be a real binary glTF 2.0 container (magic header and
declared length are checked, plus a JSON first chunk), lives MODEL_TTL_S, and
the store keeps at most MODEL_MAX_COUNT / MODEL_MAX_TOTAL_BYTES (oldest
evicted). Ids are 128-bit random, so URLs cannot be guessed.
"""
from __future__ import annotations

import secrets
import struct
import threading
import time
from dataclasses import dataclass

MODEL_MAX_BYTES = 15 * 1024 * 1024
MODEL_MAX_TOTAL_BYTES = 64 * 1024 * 1024
MODEL_MAX_COUNT = 16
MODEL_TTL_S = 15 * 60

GLB_MAGIC = b"glTF"
CHUNK_JSON = 0x4E4F534A


class ModelRejected(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def validate_glb(data: bytes, max_bytes: int = MODEL_MAX_BYTES) -> None:
    if not data:
        raise ModelRejected(400, "empty body: send the .glb file as the request body")
    if len(data) > max_bytes:
        raise ModelRejected(413, f"model is larger than {max_bytes // 2**20} MB")
    if len(data) < 20 or data[:4] != GLB_MAGIC:
        raise ModelRejected(415, "not a binary glTF (.glb) file")
    version, length = struct.unpack_from("<II", data, 4)
    if version != 2:
        raise ModelRejected(415, f"glTF version {version} is not supported (need 2)")
    if length != len(data):
        raise ModelRejected(400, "truncated or padded .glb (header length mismatch)")
    chunk_len, chunk_type = struct.unpack_from("<II", data, 12)
    if chunk_type != CHUNK_JSON or 20 + chunk_len > len(data):
        raise ModelRejected(400, "malformed .glb (first chunk must be JSON)")


@dataclass
class _Model:
    data: bytes
    expires: float


class ModelStore:
    def __init__(self, ttl_s: float = MODEL_TTL_S, max_count: int = MODEL_MAX_COUNT,
                 max_total: int = MODEL_MAX_TOTAL_BYTES):
        self.ttl_s, self.max_count, self.max_total = ttl_s, max_count, max_total
        self._items: dict[str, _Model] = {}       # insertion order = age
        self._lock = threading.Lock()

    def _expire(self, now: float) -> None:
        for k in [k for k, m in self._items.items() if m.expires <= now]:
            del self._items[k]

    def put(self, data: bytes) -> str:
        now = time.monotonic()
        model_id = secrets.token_urlsafe(16)
        with self._lock:
            self._expire(now)
            self._items[model_id] = _Model(data, now + self.ttl_s)
            while (len(self._items) > self.max_count
                   or sum(len(m.data) for m in self._items.values()) > self.max_total):
                del self._items[next(iter(self._items))]
        return model_id

    def get(self, model_id: str) -> bytes | None:
        with self._lock:
            self._expire(time.monotonic())
            m = self._items.get(model_id)
            return m.data if m else None

    def counts(self) -> dict:
        with self._lock:
            return {"models": len(self._items)}
