"""Agent-verified project scope helpers for arbitrary Kali execution tools."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request


def resolve_execution_project(ctx: str, tool_name: str) -> str:
    """Verify an opaque agent tag and return only its project ID.

    The Kali service has the scanner credential, not the agent signing key.
    Tenant claims are verified by the agent before being used for filesystem
    setup or namespace selection.
    """
    token = str(ctx or "").strip()
    scanner_key = os.environ.get("SCANNER_API_KEY", "")
    if not token or not scanner_key or scanner_key == "changeme":
        raise PermissionError("missing signed context or scanner credential")
    payload = json.dumps({"ctx": token, "tool": tool_name}).encode("utf-8")
    request = urllib.request.Request(
        os.environ.get("REDAMON_AGENT_URL", "http://agent:8080").rstrip("/")
        + "/execution/resolve-context",
        data=payload,
        headers={"Content-Type": "application/json", "X-Internal-Key": scanner_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.loads(response.read(4096).decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise PermissionError("agent context verification unavailable") from exc
    project_id = result.get("project_id") if isinstance(result, dict) else None
    if not isinstance(project_id, str) or not project_id:
        raise PermissionError("agent rejected the execution context")
    return project_id


def execution_workspace_root(project_id: str) -> str:
    """Return a canonical project path on the shared workspace mount."""
    if (not project_id or len(project_id) > 200
            or any(char in project_id for char in ("/", "\\", "\x00"))
            or project_id in (".", "..") or project_id.startswith(".")):
        raise ValueError("invalid project id for workspace access")
    workspace_root = "/workspace"
    project_root = os.path.join(workspace_root, project_id)
    if not os.path.isdir(project_root) or os.path.realpath(project_root) != project_root:
        raise ValueError("project workspace is unavailable or not a real directory")
    return project_root
