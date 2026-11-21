"""LAN TLS: a single-use, name-constrained local CA plus a leaf for this machine.

Ported from deliverables/livemap/server.py (ensure_cert and friends); see that
file for the long-form reasoning. In short:

* WebXR, the camera and service workers need a secure context, and plain
  http:// by LAN IP is not one. So the server presents a leaf certificate whose
  SANs list every LAN IP of this machine plus localhost / 127.0.0.1.
* For the PWA to install, the phone must TRUST the issuer, so the issuer (a CA)
  is offered at GET /cert. Two things keep that safe:
    - the CA private key is generated in memory, signs the leaf once and is
      never written to disk, so nothing on disk can mint another certificate;
    - the CA carries NameConstraints permitting only this machine's addresses,
      so even a trusted copy cannot vouch for any other host.
* The leaf key is written owner-only (chmod 600 / icacls) and is never served.
* When the LAN IP changes (phone hotspots hand out new leases) the leaf no
  longer covers it and everything is regenerated; the phone must then install
  the new CA.
"""
from __future__ import annotations

import datetime
import ipaddress
import os
import socket
import ssl
import subprocess
from dataclasses import dataclass
from pathlib import Path


def get_lan_ips() -> list[str]:
    """Best-effort IPv4 LAN addresses. The UDP connect never sends a packet."""
    ips: set[str] = set()
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
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and not ip.startswith("169.254."):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips) if ips else ["127.0.0.1"]


@dataclass(frozen=True)
class CertPaths:
    dir: Path

    @property
    def chain(self) -> Path:       # leaf + CA, what the server presents
        return self.dir / "server-cert.pem"

    @property
    def key(self) -> Path:         # leaf private key: never served
        return self.dir / "server-key.pem"

    @property
    def ca(self) -> Path:          # public CA cert, served at /cert
        return self.dir / "ca.pem"


def cert_covers(paths: CertPaths, ips: list[str]) -> bool:
    """True if the leaf on disk is valid, non-CA, issued by a constrained CA, and
    lists every ip as a SAN."""
    try:
        from cryptography import x509
    except ImportError:
        return False
    try:
        cert = x509.load_pem_x509_certificate(paths.chain.read_bytes())
        ca = x509.load_pem_x509_certificate(paths.ca.read_bytes())
    except (OSError, ValueError):
        return False
    if not paths.key.exists() or paths.key.stat().st_size == 0:
        return False
    now = datetime.datetime.now(datetime.timezone.utc)
    not_after = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after.replace(
        tzinfo=datetime.timezone.utc)
    if not_after <= now + datetime.timedelta(days=1):
        return False
    try:
        if cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
            return False                     # a leaf that is itself a CA: regenerate
    except x509.ExtensionNotFound:
        pass
    try:
        ca.extensions.get_extension_for_class(x509.NameConstraints)
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return False
    covered = {str(v) for v in san.get_values_for_type(x509.IPAddress)}
    return all(ip in covered for ip in ips)


def restrict_key_permissions(path: Path) -> bool:
    """Make the private key owner-only and verify; warn loudly if that failed."""
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    if os.name == "nt":
        user = os.environ.get("USERNAME")
        if user:
            rc = subprocess.call(["icacls", str(path), "/inheritance:r", "/grant:r", user + ":F"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if rc == 0:
                return True
        print(f"[tls] WARNING: could not restrict permissions on {path}")
        return False
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        print(f"[tls] WARNING: {path} is mode {mode:o}, expected 600")
        return False
    return True


def ensure_cert(paths: CertPaths, ips: list[str], force: bool = False) -> CertPaths:
    """Reuse the cert pair if it still covers ips, else issue a fresh CA + leaf."""
    if not force and cert_covers(paths, ips):
        restrict_key_permissions(paths.key)
        print(f"[tls] reusing {paths.chain}")
        return paths

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    paths.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)
    not_before, not_after = now - datetime.timedelta(minutes=5), now + datetime.timedelta(days=365)

    addresses = []
    for ip in list(dict.fromkeys(ips + ["127.0.0.1"])):
        try:
            addresses.append(ipaddress.ip_address(ip))
        except ValueError:
            continue
    alt = [x509.DNSName("localhost")] + [x509.IPAddress(a) for a in addresses]

    def key_usage(**on):
        names = ("digital_signature", "key_encipherment", "key_cert_sign", "crl_sign",
                 "content_commitment", "data_encipherment", "key_agreement",
                 "encipher_only", "decipher_only")
        return x509.KeyUsage(**{n: on.get(n, False) for n in names})

    # CA: in memory only, never persisted.
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "PlanVisAR local CA")])
    permitted = [x509.DNSName("localhost")] + [
        x509.IPAddress(ipaddress.ip_network(f"{a}/{32 if a.version == 4 else 128}"))
        for a in addresses]
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name).issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before).not_valid_after(not_after)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(key_usage(key_cert_sign=True, crl_sign=True), critical=True)
        .add_extension(x509.NameConstraints(permitted_subtrees=permitted, excluded_subtrees=None),
                       critical=True)
        .sign(ca_key, hashes.SHA256())
    )

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "planvisar-server")]))
        .issuer_name(ca_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before).not_valid_after(not_after)
        .add_extension(x509.SubjectAlternativeName(alt), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(key_usage(digital_signature=True, key_encipherment=True), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    del ca_key   # nothing can sign with this CA again

    key_pem = key.private_bytes(serialization.Encoding.PEM,
                                serialization.PrivateFormat.TraditionalOpenSSL,
                                serialization.NoEncryption())
    ca_pem = ca_cert.public_bytes(serialization.Encoding.PEM)
    chain_pem = leaf.public_bytes(serialization.Encoding.PEM) + ca_pem
    # Key first, each via temp-then-rename, so a crash never leaves a cert
    # without its key.
    # The key's temp file is created owner-only and locked down (ACL on
    # Windows) while still empty, so the secret is never readable by others,
    # even briefly. A failed restriction is fatal. Rename keeps the ACL.
    for path, blob in ((paths.key, key_pem), (paths.chain, chain_pem), (paths.ca, ca_pem)):
        tmp = path.with_suffix(path.suffix + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0),
                     0o600 if path == paths.key else 0o644)
        with os.fdopen(fd, "wb") as f:
            if path == paths.key and not restrict_key_permissions(tmp):
                f.close()
                tmp.unlink(missing_ok=True)
                raise RuntimeError(f"could not restrict permissions on {tmp}; refusing to write the TLS key")
            f.write(blob)
        os.replace(tmp, path)
    print(f"[tls] issued a leaf for {', '.join(str(a) for a in addresses)}, localhost "
          "from a single-use, name-constrained local CA (CA key never written to disk)")
    return paths


def make_ssl_context(paths: CertPaths, ips: list[str]) -> ssl.SSLContext:
    """Load the pair, regenerating once if what is on disk is unusable."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    try:
        ensure_cert(paths, ips)
        ctx.load_cert_chain(str(paths.chain), str(paths.key))
    except (ssl.SSLError, OSError) as exc:
        print(f"[tls] existing cert unusable ({exc}); regenerating")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ensure_cert(paths, ips, force=True)
        ctx.load_cert_chain(str(paths.chain), str(paths.key))
    return ctx


def ca_der(paths: CertPaths) -> bytes | None:
    """The PUBLIC CA certificate as DER (what Android's installer expects)."""
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives.serialization import Encoding
        return x509.load_pem_x509_certificate(paths.ca.read_bytes()).public_bytes(Encoding.DER)
    except Exception:
        return None
