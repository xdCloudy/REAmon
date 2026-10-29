"""Inbound API authentication policy for the recon orchestrator (V1-auth).

This is the security-critical decision: which requests may reach the orchestrator,
which holds the real Docker socket. It is a pure, dependency-free function so it can
be unit-tested in isolation (no FastAPI app, no docker, no network).

Threat: network isolation stops bridge peers (the worker) from reaching the
orchestrator, but a host-net peer (a compromised recon container) shares the host
loopback and can still reach 127.0.0.1:8010. So every request must carry the shared
secret ORCHESTRATOR_API_KEY, which is held ONLY by the webapp (deliberately NOT
INTERNAL_API_KEY, which is held by the orchestrator and webapp but is not passed
directly to scan containers; workers receive narrower signed capabilities.
"""
import base64
import hashlib
import hmac
import json
import re
import time

# Exact-path exemptions. Only `/health` (polled unauthenticated by the Docker
# healthcheck). Exact match means no protected route can masquerade as exempt via
# `/health/`, `/health/../recon/running`, query strings, case changes, etc.
AUTH_EXEMPT_PATHS = frozenset({"/health"})
PARTIAL_GRAPH_INGEST_PATH = "/internal/partial-recon/subdomain-ingest"
PARTIAL_GRAPH_FINALIZE_PATH = "/internal/partial-recon/subdomain-finalize"
PARTIAL_TAKEOVER_INPUTS_PATH = "/internal/partial-recon/takeover-inputs"
PARTIAL_TAKEOVER_INGEST_PATH = "/internal/partial-recon/takeover-ingest"
_GRAPH_TOKEN_AUDIENCE = "reamon.partial-graph-capability.v1"
_LEGACY_GRAPH_TOKEN_AUDIENCE = "reamon.partial-subdomain-graph-ingest.v1"
_GRAPH_TOKEN_AUDIENCES = frozenset({_GRAPH_TOKEN_AUDIENCE, _LEGACY_GRAPH_TOKEN_AUDIENCE})
_GRAPH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60
_B64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


def is_orchestrator_request_authorized(
    path: str, method: str, presented_key: str, expected_key: str
) -> bool:
    """Return True if a request may proceed, False if it must be rejected (401).

    - Exempt paths (exact match) and CORS preflight (OPTIONS) are always allowed.
    - Otherwise require a constant-time match against the configured key.
    - Fail-closed: if no key is configured (empty), deny everything non-exempt.
    """
    if path in AUTH_EXEMPT_PATHS or method == "OPTIONS":
        return True
    if not expected_key:
        return False
    # Constant-time comparison: never leak the key length/bytes via timing.
    # compare_digest requires both args be str (or both bytes); presented_key is
    # always a str from the header (defaulting to "").
    return hmac.compare_digest(presented_key, expected_key)


def mint_partial_graph_token(
    project_id: str, user_id: str, run_id: str, roots: list[str], secret: str,
    *, domain_groups: list[dict] | None = None, now: int | None = None,
) -> str:
    """Mint a run-bound token limited to partial subdomain graph operations."""
    if any(not isinstance(value, str) or not value or len(value) > 255
           for value in (project_id, user_id, run_id)):
        raise ValueError("A valid project, user, and run are required")
    if not secret or secret == "changeme":
        raise ValueError("A configured internal signing key is required")
    if not isinstance(roots, list) or not roots or len(roots) > 512:
        raise ValueError("A bounded non-empty root list is required")
    normalized_roots = sorted({
        root.strip().strip(".").lower()
        for root in roots
        if isinstance(root, str) and root.strip()
    })
    if len(normalized_roots) != len(roots) or any(len(root) > 253 for root in normalized_roots):
        raise ValueError("The root list contains an invalid root")
    issued_at = int(time.time() if now is None else now)
    payload = {
        "v": 1,
        "aud": _GRAPH_TOKEN_AUDIENCE,
        "projectId": project_id,
        "userId": user_id,
        "runId": run_id,
        "roots": normalized_roots,
        "iat": issued_at,
        "exp": issued_at + _GRAPH_TOKEN_TTL_SECONDS,
    }
    if domain_groups is not None:
        payload["domainGroupsHash"] = partial_graph_scope_hash(domain_groups)
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).rstrip(b"=").decode("ascii")
    signature = hmac.new(secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
    return encoded + "." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")


def verify_partial_graph_token(token: str, secret: str, *, now: int | None = None) -> dict | None:
    """Verify and return the fixed-purpose scope; malformed tokens fail closed."""
    if not isinstance(token, str) or not token or len(token) > 65536 or not secret or secret == "changeme":
        return None
    parts = token.split(".")
    if len(parts) != 2 or any(not _B64URL.fullmatch(part) for part in parts):
        return None
    encoded, signature_text = parts
    try:
        payload_bytes = _decode_b64url(encoded)
        signature = _decode_b64url(signature_text)
        expected = hmac.new(secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            return None
        payload = json.loads(payload_bytes)
    except (ValueError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    issued_at = payload.get("iat")
    expires_at = payload.get("exp")
    current_time = int(time.time() if now is None else now)
    if (payload.get("v") != 1 or payload.get("aud") not in _GRAPH_TOKEN_AUDIENCES
            or isinstance(issued_at, bool) or not isinstance(issued_at, int)
            or isinstance(expires_at, bool) or not isinstance(expires_at, int)
            or issued_at > current_time + 60
            or expires_at <= current_time
            or expires_at - issued_at > _GRAPH_TOKEN_TTL_SECONDS):
        return None
    if any(not isinstance(payload.get(key), str) or not payload[key] or len(payload[key]) > 255
           for key in ("projectId", "userId", "runId")):
        return None
    roots = payload.get("roots")
    if (not isinstance(roots, list) or not roots or len(roots) > 512
            or any(not isinstance(root, str) or not root or len(root) > 253 for root in roots)
            or roots != sorted(set(roots))):
        return None
    groups_hash = payload.get("domainGroupsHash")
    if groups_hash is not None and (not isinstance(groups_hash, str) or not _SHA256.fullmatch(groups_hash)):
        return None
    return payload


def partial_graph_scope_hash(domain_groups: list[dict] | None) -> str | None:
    """Hash the host-group restriction so a worker cannot widen a signed run."""
    if domain_groups is None:
        return None
    try:
        encoded = json.dumps(domain_groups, separators=(",", ":"), sort_keys=True,
                             ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ValueError("Domain-group scope must be valid JSON") from exc
    if len(encoded) > 64 * 1024:
        raise ValueError("Domain-group scope is too large")
    return hashlib.sha256(encoded).hexdigest()


def _decode_b64url(value: str) -> bytes:
    if not value or not _B64URL.fullmatch(value):
        raise ValueError("invalid base64url")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii") != value:
        raise ValueError("non-canonical base64url")
    return decoded
