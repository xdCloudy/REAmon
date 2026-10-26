"""Submit signed project-scoped executions to the trusted Docker broker."""
from __future__ import annotations

import base64
import binascii
import json
import os
import subprocess
import urllib.error
import urllib.request
from typing import Any

WORKER_URL = os.environ.get("REAMON_PROJECT_WORKER_URL", "http://docker-broker:8081/worker/execute")
MAX_RESPONSE_BYTES = 6 * 1024 * 1024 + 8192
MAX_OUTPUT_BYTES = 2 * 1024 * 1024 + 64


def prepare_project_worker_paths(project_root: str) -> None:
    """Create only the two writable broker mount points inside a verified project."""
    for name in (".reamon-tmp", "tool-outputs"):
        path = os.path.join(project_root, name)
        if os.path.islink(path):
            raise ValueError(f"project worker path must not be a symlink: {name}")
        os.makedirs(path, mode=0o770, exist_ok=True)
        if os.path.realpath(path) != path or not os.path.isdir(path):
            raise ValueError(f"project worker path is unavailable: {name}")
        os.chown(path, 65534, 65534)
        os.chmod(path, 0o770)


def run_project_worker(
    argv: list[str], *, timeout: int, ctx: str, tool_name: str,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Execute once in a dedicated container and preserve subprocess semantics."""
    scanner_key = os.environ.get("SCANNER_API_KEY", "")
    if not scanner_key or scanner_key == "changeme":
        raise PermissionError("project worker transport is not configured")
    payload = json.dumps({
        "ctx": ctx, "tool": tool_name, "argv": argv, "timeout": timeout,
        "env": env or {},
    }).encode("utf-8")
    request = urllib.request.Request(
        WORKER_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Internal-Key": scanner_key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout + 30) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise RuntimeError("project worker response exceeded its size limit")
            result: Any = json.loads(raw)
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read(4096)).get("error", "worker request failed")
        except (ValueError, AttributeError):
            detail = "worker request failed"
        if exc.code in (401, 403):
            raise PermissionError(str(detail)) from exc
        raise RuntimeError(str(detail)) from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise RuntimeError("project worker is unavailable") from exc
    if not isinstance(result, dict) or not isinstance(result.get("exit_code"), int):
        raise RuntimeError("project worker returned an invalid result")
    def decode_output(name: str) -> str:
        value = result.get(name)
        if not isinstance(value, str):
            raise RuntimeError("project worker returned invalid output")
        try:
            decoded = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RuntimeError("project worker returned invalid output encoding") from exc
        if len(decoded) > MAX_OUTPUT_BYTES:
            raise RuntimeError("project worker output exceeded its size limit")
        return decoded.decode("utf-8", errors="replace")

    stdout = decode_output("stdout_b64")
    stderr = decode_output("stderr_b64")
    if result.get("timed_out") is True:
        raise subprocess.TimeoutExpired(argv, timeout, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(argv, result["exit_code"], stdout, stderr)
