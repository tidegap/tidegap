"""Ed25519 receipt signing (v0.11+, opt-in).

Python mirror of ``packages/core-ts/src/sign.ts``. Where the TS package
uses Node's built-in ``crypto`` (no deps), the Python build pulls in
``cryptography`` only when the caller opts in via the ``signing`` extras
package — keeping ``pip install tidegap`` lightweight for users who only
want the scheduler.

Install with signing enabled:

    pip install "tidegap[signing]"

Without that extra, importing this module is fine, but :func:`sign_receipt`
raises :class:`SigningNotInstalled`. Verification (:func:`verify_receipt`)
of pre-signed receipts also requires the extra. The scheduler itself
silently falls back to writing unsigned receipts when the extra is
absent, so the default install path remains v0.10-compatible.

Cross-language canonical form (audit §0.3): there is exactly ONE
canonical signing payload shared by both ports — the **camelCase wire
rendering** of the receipt (the TS shape; ``tidegap verify`` is the
consumer). :func:`sign_receipt` converts the snake_case receipt dict to
camelCase algorithmically before canonicalization, and numbers are
serialized ECMAScript-style (RFC 8785 / JCS: ``2.0`` → ``"2"``,
``1e-07`` → ``"1e-7"``) via :func:`es_number` so the canonical bytes
match ``JSON.stringify`` exactly. The RETURNED receipt dict still
carries snake_case keys and snake_case signature fields (``signature``,
``signer_public_key``, ``signed_at``) — Python storage and consumers
are unchanged.

``signed_at`` is computed BEFORE canonicalization and is covered by the
signature (v0.12+); only ``signature`` and ``signer_public_key`` sit
outside the signed payload. Replay defence still requires ledger-side
uniqueness (e.g. unique ``task_id``): a validly signed receipt can be
presented twice.

:func:`verify_receipt` accepts a receipt in EITHER key rendering
(camelCase TS receipts included) and falls back to the legacy v0.11
canonical forms for receipts signed by older releases.

The shared fixture
``packages/core-ts/test/fixtures/cross-lang-receipt-vectors.json`` pins
the canonical bytes; both language test suites assert against it
byte-for-byte.

See ``packages/core-ts/src/sign.ts`` for the full design rationale and
key lifecycle.
"""

from __future__ import annotations

import base64
import contextlib
import json
import math
import os
import re
import stat
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from .paths import resolve_tidegap_home

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519

    _HAS_CRYPTO = True
except ImportError:  # pragma: no cover — exercised in non-extra installs
    _HAS_CRYPTO = False


class SigningNotInstalled(ImportError):
    """Raised when signing is invoked without the ``signing`` extras installed."""

    def __init__(self) -> None:
        super().__init__(
            "Receipt signing requires the `cryptography` library. "
            "Install via `pip install 'tidegap[signing]'`."
        )


def is_signing_available() -> bool:
    """Return True iff the ``cryptography`` extra is installed."""
    return _HAS_CRYPTO


VerifyOutcome = Literal["valid", "tampered", "legacy-unsigned", "key-mismatch"]


@dataclass(frozen=True, slots=True)
class SigningKeyPair:
    """An Ed25519 keypair plus the filesystem path the private key lives at.

    ``public_key_base64`` is the raw 32-byte public key — same encoding
    used by the TS port — suitable for embedding directly on a receipt.
    """

    private_key: Any
    public_key: Any
    public_key_base64: str
    private_key_path: str


@dataclass(frozen=True, slots=True)
class VerifyResult:
    outcome: VerifyOutcome
    reason: str
    signer_public_key: str | None = None


def default_signing_key_path() -> Path:
    """Default ``~/.tidegap/signing.key`` location."""
    return resolve_tidegap_home() / "signing.key"


def _write_bytes_atomic(path: Path, data: bytes, mode: int | None = None) -> None:
    """Write ``data`` atomically: same-directory temp file + ``os.replace``.

    Readers never observe a partial file; concurrent first-callers
    converge on one winner. ``mode`` (if given) is applied to the temp
    file BEFORE the rename so the final file never exists with loose
    permissions.
    """
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    try:
        tmp.write_bytes(data)
        if mode is not None:
            # Best-effort chmod — some filesystems (WSL/Windows mounts) refuse it.
            with contextlib.suppress(OSError):
                os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise


def load_or_create_signing_key(
    private_key_path: str | os.PathLike[str] | None = None,
) -> SigningKeyPair:
    """Load the local signing keypair, generating + persisting one on first call.

    Mirrors the TS ``loadOrCreateSigningKey()``: idempotent and safe under
    concurrent first-call (files are written atomically via
    write-temp-then-rename; the winning writer's key is what both
    callers converge on next load).
    """
    if not _HAS_CRYPTO:
        raise SigningNotInstalled()
    path = Path(private_key_path) if private_key_path else default_signing_key_path()
    public_path = path.with_suffix(path.suffix + ".pub")

    if path.exists():
        pem = path.read_bytes()
        private_key = serialization.load_pem_private_key(pem, password=None)
        public_key = private_key.public_key()
    else:
        private_key = ed25519.Ed25519PrivateKey.generate()
        public_key = private_key.public_key()
        private_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        public_pem = public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        _write_bytes_atomic(path, private_pem, mode=stat.S_IRUSR | stat.S_IWUSR)
        _write_bytes_atomic(public_path, public_pem)

    raw_pub = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return SigningKeyPair(
        private_key=private_key,
        public_key=public_key,
        public_key_base64=base64.b64encode(raw_pub).decode("ascii"),
        private_key_path=str(path),
    )


# Fields excluded from the signed payload — they are the proof itself.
# NOTE: ``signedAt`` is NOT excluded: since v0.12 it is covered by the
# signature (audit §0.8). These are the *normalized* (camelCase) names.
_SIGNATURE_FIELDS = frozenset({"signature", "signerPublicKey"})

# Every signature-machinery key, in both wire renderings.
_SIGNATURE_FIELDS_ANY_RENDERING = frozenset(
    {"signature", "signerPublicKey", "signer_public_key", "signedAt", "signed_at"}
)

_ES_SAFE_INT = 2**53


def es_number(value: int | float) -> str:
    """Serialize a number exactly like ECMAScript ``JSON.stringify``.

    RFC 8785 (JCS) number formatting: shortest round-trip digits,
    integers without a trailing ``.0`` (``2.0`` → ``"2"``), positional
    notation for magnitudes in ``[1e-6, 1e21)``, ES exponent style
    outside it (``1e-07`` → ``"1e-7"``, ``1e21`` → ``"1e+21"``), and
    ``-0.0`` → ``"0"``. Ints beyond 2**53 are coerced through float —
    JavaScript would have parsed them as IEEE-754 doubles anyway.
    """
    if isinstance(value, bool):  # bool is an int subclass; not a number here.
        raise TypeError("es_number: booleans are not numbers")
    if isinstance(value, int):
        if -_ES_SAFE_INT <= value <= _ES_SAFE_INT:
            return str(value)
        value = float(value)  # beyond safe range JS sees a double
    if not math.isfinite(value):
        raise ValueError(f"canonicalize: refusing non-finite number {value}")
    if value == 0:
        return "0"  # covers -0.0 → "0", matching JSON.stringify(-0)

    # repr() gives the shortest round-trip decimal form; re-render it
    # with ECMAScript's Number::toString notation rules (ECMA-262
    # §6.1.6.1.20). Represent value as 0.<digits> * 10**n.
    text = repr(value)
    sign = ""
    if text.startswith("-"):
        sign, text = "-", text[1:]
    mantissa, _, exp_text = text.partition("e")
    exponent = int(exp_text) if exp_text else 0
    int_part, _, frac_part = mantissa.partition(".")
    combined = int_part + frac_part
    digits = combined.lstrip("0")
    leading_zeros = len(combined) - len(digits)
    digits = digits.rstrip("0")
    n = len(int_part) - leading_zeros + exponent
    k = len(digits)

    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        head = digits if k == 1 else f"{digits[0]}.{digits[1:]}"
        body = f"{head}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + body


def _snake_to_camel(key: str) -> str:
    """``snake_case`` → ``camelCase``; already-camel keys pass through unchanged."""
    return re.sub(r"_([a-z0-9])", lambda m: m.group(1).upper(), key)


def _normalize_keys(value: Any) -> Any:
    """Normalize to the canonical camelCase wire rendering.

    Keys are converted snake→camel *algorithmically* (no hardcoded field
    list — future receipt fields are covered automatically) and
    ``None``-valued object keys are dropped (Python's ``None`` and TS's
    ``undefined`` both mean "field absent"). Lists keep ``None`` elements.
    """
    if isinstance(value, list):
        return [_normalize_keys(v) for v in value]
    if isinstance(value, dict):
        return {_snake_to_camel(k): _normalize_keys(v) for k, v in value.items() if v is not None}
    return value


def _duplicate_rendering(value: Any) -> str | None:
    """The camelCase name two keys of one object normalize to, at any depth.

    Mirrors ``duplicateRendering`` in ``packages/core-ts/src/sign.ts``. No
    signer writes two renderings of one field (``actualCarbonGCo2`` and
    ``actual_carbon_g_co2``), and normalization keeps only the last of
    them, so a receipt that carries both could show one value and verify
    against the other. ``None`` values do not count: normalization drops
    them.
    """
    if isinstance(value, list):
        for v in value:
            name = _duplicate_rendering(v)
            if name is not None:
                return name
        return None
    if not isinstance(value, dict):
        return None
    seen: set[str] = set()
    for k, v in value.items():
        if v is None:
            continue
        name = _snake_to_camel(k)
        if name in seen:
            return name
        seen.add(name)
        nested = _duplicate_rendering(v)
        if nested is not None:
            return nested
    return None


def _canonicalize(value: Any, *, es_numbers: bool = True) -> str:
    """Deterministic JSON serialization. Mirrors the TS canonicalize().

    - Object keys sorted recursively.
    - ``None``-valued keys dropped (parity with TS dropping ``undefined``).
    - Numbers serialized ECMAScript-style via :func:`es_number` so the
      bytes match ``JSON.stringify`` cross-language (``es_numbers=False``
      reproduces the legacy ≤v0.11 ``json.dumps`` formatting for
      backward-compatible verification only).
    - Non-finite numbers (NaN, ±Inf) raise — the canonical form is total.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"canonicalize: refusing non-finite number {value}")
        return es_number(value) if es_numbers else json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_canonicalize(v, es_numbers=es_numbers) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(k for k, v in value.items() if v is not None)
        return (
            "{"
            + ",".join(
                f"{json.dumps(k, ensure_ascii=False)}:{_canonicalize(value[k], es_numbers=es_numbers)}"
                for k in keys
            )
            + "}"
        )
    raise TypeError(f"canonicalize: unsupported type {type(value).__name__}")


def canonical_receipt_payload(
    receipt: dict[str, Any],
    *,
    exclude_signed_at: bool = False,
) -> str:
    """The exact canonical byte string a receipt's signature covers.

    camelCase-normalized payload minus ``signature``/``signerPublicKey``,
    canonicalized with ES number formatting. Pass ``exclude_signed_at``
    to reproduce the legacy v0.11 form (payloads signed before
    ``signedAt`` entered the signature). Byte-for-byte identical to the
    TS ``canonicalReceiptPayload()``.
    """
    normalized = _normalize_keys(receipt)
    payload = {
        k: v
        for k, v in normalized.items()
        if k not in _SIGNATURE_FIELDS and not (exclude_signed_at and k == "signedAt")
    }
    return _canonicalize(payload)


def _legacy_snake_canonical(receipt: dict[str, Any]) -> str:
    """Legacy ≤v0.11 Python canonical form: raw snake_case keys, no
    ``signed_at``, ``json.dumps`` number formatting."""
    payload = {
        k: v
        for k, v in receipt.items()
        if k not in _SIGNATURE_FIELDS_ANY_RENDERING and v is not None
    }
    return _canonicalize(payload, es_numbers=False)


def sign_receipt(
    receipt: dict[str, Any],
    key_pair: SigningKeyPair,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Return a new dict with signature, signer_public_key, signed_at populated.

    The input receipt is not mutated. The signature covers the ONE
    cross-language canonical form: the camelCase wire rendering of the
    receipt (converted algorithmically) WITH ``signedAt`` included —
    a receipt signed here verifies as-is in the TS ``verifyReceipt``
    (``tidegap verify``) and vice versa. The returned dict still carries
    snake_case keys and snake_case signature fields, so Python storage
    and consumers are unchanged.
    """
    if not _HAS_CRYPTO:
        raise SigningNotInstalled()
    timestamp = (now or datetime.now(UTC)).isoformat()
    claims = {k: v for k, v in receipt.items() if k not in _SIGNATURE_FIELDS_ANY_RENDERING}
    canonical = canonical_receipt_payload({**claims, "signedAt": timestamp}).encode("utf-8")
    sig = key_pair.private_key.sign(canonical)
    return {
        **receipt,
        "signature": base64.b64encode(sig).decode("ascii"),
        "signer_public_key": key_pair.public_key_base64,
        "signed_at": timestamp,
    }


def verify_receipt(
    receipt: dict[str, Any],
    *,
    trusted_public_key: str | None = None,
) -> VerifyResult:
    """Verify a (possibly signed) receipt — mirrors the TS verifyReceipt().

    Accepts the receipt in EITHER key rendering — snake_case (Python
    ledger rows) or camelCase (TS wire shape) — keys are normalized
    algorithmically before canonicalization.

    Outcomes:
      - ``valid``           — Ed25519 signature matches the canonical payload
                              (v0.12 form with ``signedAt`` covered, or a
                              legacy v0.11 form — the reason says which).
      - ``tampered``        — signed receipt whose signature matches none of
                              the canonical forms of its fields, or that
                              carries two renderings of one field.
      - ``key-mismatch``    — ``trusted_public_key`` set, receipt signed by someone else.
      - ``legacy-unsigned`` — pre-v0.11 receipt (or unsigned by config).
    """
    normalized = _normalize_keys(receipt)
    signature = normalized.get("signature")
    signer = normalized.get("signerPublicKey")
    if not signature or not signer:
        return VerifyResult(
            outcome="legacy-unsigned",
            reason="receipt has no `signature`/`signer_public_key` fields "
            "(pre-v0.11 or unsigned by configuration)",
        )
    duplicate = _duplicate_rendering(receipt)
    if duplicate is not None:
        return VerifyResult(
            outcome="tampered",
            signer_public_key=signer,
            reason=f"receipt carries two renderings of `{duplicate}`; no signer "
            "writes both, so one was added after signing",
        )
    if trusted_public_key and trusted_public_key != signer:
        return VerifyResult(
            outcome="key-mismatch",
            signer_public_key=signer,
            reason=f"expected signer public key {trusted_public_key}, "
            f"receipt was signed by {signer}",
        )
    if not _HAS_CRYPTO:
        raise SigningNotInstalled()
    raw_pub = base64.b64decode(signer)
    if len(raw_pub) != 32:
        raise ValueError(f"signer_public_key must be 32 bytes (got {len(raw_pub)})")
    public_key = ed25519.Ed25519PublicKey.from_public_bytes(raw_pub)
    sig_bytes = base64.b64decode(signature)

    def _matches(canonical: str) -> bool:
        try:
            public_key.verify(sig_bytes, canonical.encode("utf-8"))
        except Exception:  # InvalidSignature
            return False
        return True

    # Verification order (audit §0.3): (a) v0.12 canonical form — camelCase
    # payload WITH signedAt covered; (b) legacy v0.11 form — signedAt
    # excluded; (c) legacy ≤v0.11 Python snake_case rendering (signed the
    # snake dict as-is, json.dumps numbers). Only after every form fails →
    # tampered.
    attempts: list[tuple[str, bool]] = []

    def _push_unique(canonical: str, legacy: bool) -> None:
        if all(canonical != seen for seen, _ in attempts):
            attempts.append((canonical, legacy))

    _push_unique(canonical_receipt_payload(receipt), False)
    _push_unique(canonical_receipt_payload(receipt, exclude_signed_at=True), True)
    _push_unique(_legacy_snake_canonical(receipt), True)

    for canonical, legacy in attempts:
        if not _matches(canonical):
            continue
        reason = (
            "Ed25519 signature verified against legacy v0.11 canonical form "
            f"(signedAt not covered; {len(canonical.encode('utf-8'))} bytes)"
            if legacy
            else "Ed25519 signature verified against canonical payload "
            f"({len(canonical.encode('utf-8'))} bytes)"
        )
        return VerifyResult(outcome="valid", signer_public_key=signer, reason=reason)
    return VerifyResult(
        outcome="tampered",
        signer_public_key=signer,
        reason="Ed25519 signature does not match the canonical payload — "
        "receipt was modified after signing",
    )


__all__ = [
    "SigningKeyPair",
    "SigningNotInstalled",
    "VerifyOutcome",
    "VerifyResult",
    "canonical_receipt_payload",
    "default_signing_key_path",
    "es_number",
    "is_signing_available",
    "load_or_create_signing_key",
    "sign_receipt",
    "verify_receipt",
]
