"""
MCP Registry: schema, validation, and storage for user-managed MCP servers.

Servers come from two sources:
- SYSTEM_MCP_SERVERS in tools.py (the 5 baseline servers shipped with the product)
- UserSettings.mcpServers JSON column (user-added via the Settings UI)

Both flow through this module's MCPServer pydantic schema and through
to_mcp_servers_dict() / apply_servers_to_registry().
"""

from __future__ import annotations

import os
import threading
import logging
from typing import Any, Dict, List, Literal, Optional, Set, Tuple

from pydantic import BaseModel, Field, model_validator

logger = logging.getLogger(__name__)


PHASES: Tuple[str, ...] = ("informational", "exploitation", "post_exploitation")
ALL_PHASES: List[str] = list(PHASES)
TRANSPORTS: Tuple[str, ...] = ("sse", "streamable_http", "stdio")

# Tool names that may NOT be used as a manifest tool name (collision = rejection).
# Populated lazily to avoid an import cycle with prompts.tool_registry.
_BUILTIN_NAME_CACHE: Optional[Set[str]] = None

# Server IDs that may NOT be used by user-added servers (system-reserved).
SYSTEM_SERVER_IDS: Set[str] = {
    "network_recon",
    "nmap",
    "nuclei",
    "metasploit",
    "playwright",
}

# =============================================================================
# SCHEMA
# =============================================================================


class ToolSpec(BaseModel):
    """One tool exposed by an MCP server."""

    name: str = Field(min_length=1)
    purpose: str = Field(min_length=1)
    when_to_use: str = Field(min_length=1)
    args_format: str = Field(min_length=1)
    description: str = Field(min_length=1)
    default_phases: Optional[List[Literal["informational", "exploitation", "post_exploitation"]]] = None


class BearerAuth(BaseModel):
    """Bearer-token auth.

    Either `token` (literal, stored as-is in the DB) or `token_env_var`
    (env var name, resolved at request time) must be provided. The token
    is sent verbatim as ``Authorization: Bearer <token>`` on every MCP
    request — no string substitution / interpolation is performed.
    """
    type: Literal["bearer"] = "bearer"
    token: Optional[str] = None
    token_env_var: Optional[str] = None

    @model_validator(mode="after")
    def _at_least_one(self) -> "BearerAuth":
        if not (self.token or self.token_env_var):
            raise ValueError(
                "auth requires a non-empty 'token' (bearer token)"
            )
        return self


class MCPServer(BaseModel):
    """One MCP server definition. Same schema for system + user-added servers."""

    id: str = Field(min_length=1, pattern=r"^[a-zA-Z0-9_][a-zA-Z0-9_-]*$")
    name: str = Field(min_length=1)
    description: str = ""
    enabled: bool = True
    transport: Literal["sse", "streamable_http", "stdio"]
    default_phases: List[Literal["informational", "exploitation", "post_exploitation"]] = Field(
        default_factory=lambda: list(ALL_PHASES)
    )
    tags: List[str] = Field(default_factory=list)

    # HTTP-only fields
    url: Optional[str] = None
    headers: Dict[str, str] = Field(default_factory=dict)
    auth: Optional[BearerAuth] = None
    connect_timeout: int = 60
    read_timeout: int = 600

    # stdio-only fields
    command: Optional[str] = None
    args: List[str] = Field(default_factory=list)
    env: Dict[str, str] = Field(default_factory=dict)
    cwd: Optional[str] = None
    encoding: str = "utf-8"

    tools: List[ToolSpec] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_transport_fields(self) -> "MCPServer":
        if self.transport in ("sse", "streamable_http"):
            if not self.url:
                raise ValueError(f"server '{self.id}': url is required for transport '{self.transport}'")
        elif self.transport == "stdio":
            if not self.command:
                raise ValueError(f"server '{self.id}': command is required for transport 'stdio'")

        # Tool name uniqueness within the server
        seen: Set[str] = set()
        for t in self.tools:
            if t.name in seen:
                raise ValueError(f"server '{self.id}': duplicate tool name '{t.name}'")
            seen.add(t.name)

        return self

# =============================================================================
# VALIDATION (post-parse, cross-server)
# =============================================================================


class ValidationError(BaseModel):
    """Structured error for surfacing validation problems to the UI."""

    server_id: str
    code: str
    message: str


def _builtin_tool_names() -> Set[str]:
    """Lazy import of TOOL_REGISTRY to avoid circular imports."""
    global _BUILTIN_NAME_CACHE
    if _BUILTIN_NAME_CACHE is None:
        try:
            from prompts.tool_registry import TOOL_REGISTRY, _mcp_injected_keys  # type: ignore
            # tradecraft_lookup is a built-in that now lives in the per-session
            # tradecraft overlay (not the global dict), so add it explicitly.
            _BUILTIN_NAME_CACHE = (
                (set(TOOL_REGISTRY.keys()) - set(_mcp_injected_keys)) | {"tradecraft_lookup"}
            )
        except Exception:
            _BUILTIN_NAME_CACHE = set()
    return _BUILTIN_NAME_CACHE


def validate_servers(
    servers: List[MCPServer],
    *,
    is_user_supplied: bool = False,
) -> Tuple[List[MCPServer], List[ValidationError]]:
    """
    Cross-server validation: id uniqueness, system-id collisions (user only),
    builtin-tool-name collisions, cross-server tool-name collisions.

    Returns (valid_servers, errors). A server with any error is dropped from
    the valid list so we never half-register a broken manifest.
    """
    errors: List[ValidationError] = []
    valid: List[MCPServer] = []

    seen_ids: Set[str] = set()
    seen_tool_names: Set[str] = set()
    builtin_names = _builtin_tool_names() if is_user_supplied else set()

    for srv in servers:
        srv_errors: List[ValidationError] = []

        if srv.id in seen_ids:
            srv_errors.append(ValidationError(
                server_id=srv.id, code="duplicate_id",
                message=f"Server id '{srv.id}' is used by another server.",
            ))

        if is_user_supplied and srv.id in SYSTEM_SERVER_IDS:
            srv_errors.append(ValidationError(
                server_id=srv.id, code="system_id_collision",
                message=f"Server id '{srv.id}' is reserved for a system MCP server.",
            ))

        for t in srv.tools:
            if t.name in builtin_names:
                srv_errors.append(ValidationError(
                    server_id=srv.id, code="builtin_name_collision",
                    message=f"Tool name '{t.name}' collides with a built-in tool.",
                ))
            if t.name in seen_tool_names:
                srv_errors.append(ValidationError(
                    server_id=srv.id, code="duplicate_tool_name",
                    message=f"Tool name '{t.name}' is already declared by another server.",
                ))

        if srv_errors:
            errors.extend(srv_errors)
            continue

        seen_ids.add(srv.id)
        for t in srv.tools:
            seen_tool_names.add(t.name)
        valid.append(srv)

    return valid, errors


# =============================================================================
# CONVERSION TO MultiServerMCPClient DICT
# =============================================================================


def _resolve_auth_header(srv: MCPServer) -> Tuple[Dict[str, str], List[str]]:
    """Build auth + custom headers, resolving env vars. Returns (headers, missing_vars).

    Token resolution order:
    1. ``auth.token`` literal — used verbatim.
    2. ``auth.token_env_var`` resolved via os.getenv (legacy fallback,
       not exposed in the UI form).
    """
    headers: Dict[str, str] = {}
    missing: List[str] = []

    if srv.headers:
        # Headers are taken verbatim — no interpolation. Paste exact values.
        headers.update(srv.headers)

    if srv.auth and srv.auth.type == "bearer":
        token: Optional[str] = None
        if srv.auth.token:
            # Literal bearer token — used as-is.
            token = srv.auth.token
        elif srv.auth.token_env_var:
            # Backward-compat alternative: resolve a named env var. Not
            # exposed in the UI form, but kept for any saved server that
            # might still use it.
            token = os.environ.get(srv.auth.token_env_var)
            if not token:
                missing.append(srv.auth.token_env_var)
        if token:
            # Defensive: HTTP headers must be ASCII. If the token still
            # contains the mask placeholder (••••) or any other non-ASCII
            # character, drop the auth entirely rather than crashing httpx
            # with a UnicodeEncodeError. The webapp normally substitutes
            # masked tokens with the real value before reaching here, so
            # this is purely a safety net.
            try:
                token.encode("ascii")
                headers["Authorization"] = f"Bearer {token}"
            except UnicodeEncodeError:
                logger.warning(
                    f"server '{srv.id}': bearer token contains non-ASCII characters "
                    f"(likely the masked placeholder); dropping Authorization header."
                )

    return headers, missing


def to_mcp_servers_dict(
    servers: List[MCPServer],
) -> Tuple[Dict[str, Dict[str, Any]], List[ValidationError]]:
    """
    Convert MCPServer list into the dict shape consumed by MultiServerMCPClient.

    Returns (config_dict, warnings). Disabled servers are skipped entirely.
    Headers and stdio env values are passed through verbatim.
    """
    config: Dict[str, Dict[str, Any]] = {}
    warnings: List[ValidationError] = []

    for srv in servers:
        if not srv.enabled:
            continue

        if srv.transport in ("sse", "streamable_http"):
            headers, missing = _resolve_auth_header(srv)
            for var in missing:
                warnings.append(ValidationError(
                    server_id=srv.id, code="env_var_unset",
                    message=f"Environment variable '{var}' is unset; sent without it.",
                ))
            entry: Dict[str, Any] = {
                "url": srv.url,
                "transport": srv.transport,
                "timeout": srv.connect_timeout,
                "sse_read_timeout": srv.read_timeout,
            }
            if headers:
                entry["headers"] = headers
            config[srv.id] = entry

        elif srv.transport == "stdio":
            entry = {
                "command": srv.command,
                "args": list(srv.args),
                "transport": "stdio",
                "encoding": srv.encoding,
            }
            if srv.env:
                entry["env"] = dict(srv.env)
            if srv.cwd:
                entry["cwd"] = srv.cwd
            config[srv.id] = entry

    return config, warnings


# =============================================================================
# CURRENT-STATE HOLDER (single source of truth for the running agent)
# =============================================================================


_state_lock = threading.RLock()
_current_servers: List[MCPServer] = []
_current_errors: List[ValidationError] = []
_current_warnings: List[ValidationError] = []


def set_current(
    servers: List[MCPServer],
    errors: Optional[List[ValidationError]] = None,
    warnings: Optional[List[ValidationError]] = None,
) -> None:
    """Replace the registry's current state. Called by orchestrator on (re)load."""
    global _current_servers, _current_errors, _current_warnings
    with _state_lock:
        _current_servers = list(servers)
        _current_errors = list(errors or [])
        _current_warnings = list(warnings or [])


def current() -> List[MCPServer]:
    """Snapshot of currently-registered servers (system + user)."""
    with _state_lock:
        return list(_current_servers)


def current_errors() -> List[ValidationError]:
    with _state_lock:
        return list(_current_errors)


def current_warnings() -> List[ValidationError]:
    with _state_lock:
        return list(_current_warnings)


def default_phases_for(tool_name: str) -> List[str]:
    """Read-time fallback for is_tool_allowed_in_phase. Defaults to all phases."""
    for srv in current():
        if not srv.enabled:
            continue
        for t in srv.tools:
            if t.name == tool_name:
                return list(t.default_phases) if t.default_phases else list(srv.default_phases)
    return list(ALL_PHASES)


def manifest_tool_names() -> Set[str]:
    """All tool names currently declared by any enabled MCP server."""
    out: Set[str] = set()
    for srv in current():
        if not srv.enabled:
            continue
        for t in srv.tools:
            out.add(t.name)
    return out


def manifest_tool_phase_view() -> Dict[str, List[str]]:
    """Map of tool_name -> default_phases for every currently-declared tool."""
    out: Dict[str, List[str]] = {}
    for srv in current():
        if not srv.enabled:
            continue
        for t in srv.tools:
            out[t.name] = list(t.default_phases) if t.default_phases else list(srv.default_phases)
    return out


# =============================================================================
# PARSING ENTRYPOINT
# =============================================================================


def parse_user_servers(raw: Any) -> Tuple[List[MCPServer], List[ValidationError]]:
    """
    Parse and validate user-supplied mcpServers JSON (a list of dicts from
    UserSettings.mcpServers). Returns (valid_servers, errors).
    """
    if raw is None:
        return [], []
    if not isinstance(raw, list):
        return [], [ValidationError(
            server_id="<root>", code="invalid_payload",
            message="mcpServers must be a list",
        )]

    parsed: List[MCPServer] = []
    errors: List[ValidationError] = []

    for i, entry in enumerate(raw):
        if isinstance(entry, dict) and entry.get("transport") == "stdio":
            errors.append(ValidationError(
                server_id=str(entry.get("id", f"<index {i}>")),
                code="stdio_disabled",
                message=(
                    "stdio MCP servers are disabled until they can run in an "
                    "isolated per-user worker"
                ),
            ))
            continue
        try:
            parsed.append(MCPServer.model_validate(entry))
        except Exception as exc:
            sid = entry.get("id", f"<index {i}>") if isinstance(entry, dict) else f"<index {i}>"
            errors.append(ValidationError(
                server_id=str(sid), code="schema_invalid",
                message=str(exc),
            ))

    valid, cross_errors = validate_servers(parsed, is_user_supplied=True)
    errors.extend(cross_errors)
    return valid, errors


def _mask_secret(value: str) -> str:
    """Mask a secret like the webapp's user-settings route does."""
    if not value:
        return ""
    if len(value) <= 4:
        return "••••"
    return "••••••••" + value[-4:]


def redact_for_api(servers: List[MCPServer]) -> List[Dict[str, Any]]:
    """
    Render servers safe for API responses. Every secret-bearing value is masked:
    the literal auth token, custom header values (they routinely carry API keys),
    and stdio env values. Header/env *keys* are kept (they are references, not
    secrets) so the manifest still describes the server's shape.
    """
    out: List[Dict[str, Any]] = []
    for srv in servers:
        d = srv.model_dump()
        auth = d.get("auth")
        if isinstance(auth, dict) and auth.get("token"):
            auth["token"] = _mask_secret(auth["token"])
        hdrs = d.get("headers")
        if isinstance(hdrs, dict) and hdrs:
            d["headers"] = {k: _mask_secret(str(v)) for k, v in hdrs.items()}
        env = d.get("env")
        if isinstance(env, dict) and env:
            d["env"] = {k: _mask_secret(str(v)) for k, v in env.items()}
        out.append(d)
    return out
