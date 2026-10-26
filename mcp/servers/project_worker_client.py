"""Submit signed project-scoped executions to the trusted Docker broker."""
from __future__ import annotations

import base64
import binascii
import asyncio
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


async def run_project_worker_async(
    argv: list[str], *, timeout: int, ctx: str, tool_name: str,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Execute over an async socket so task cancellation disconnects the broker."""
    scanner_key = os.environ.get("SCANNER_API_KEY", "")
    if not scanner_key or scanner_key == "changeme":
        raise PermissionError("project worker transport is not configured")
    payload = json.dumps({
        "ctx": ctx, "tool": tool_name, "argv": argv, "timeout": timeout,
        "env": env or {},
    }, separators=(",", ":")).encode("utf-8")
    from urllib.parse import urlsplit

    endpoint = urlsplit(WORKER_URL)
    if endpoint.scheme != "http" or not endpoint.hostname:
        raise RuntimeError("project worker endpoint is invalid")
    port = endpoint.port or 80
    path = endpoint.path or "/"
    if endpoint.query:
        path += "?" + endpoint.query

    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(endpoint.hostname, port), timeout=10,
        )
        request = (
            f"POST {path} HTTP/1.1\r\nHost: {endpoint.hostname}:{port}\r\n"
            "Content-Type: application/json\r\n"
            f"X-Internal-Key: {scanner_key}\r\nContent-Length: {len(payload)}\r\n"
            "Connection: close\r\n\r\n"
        ).encode("latin1") + payload
        writer.write(request)
        await writer.drain()
        async with asyncio.timeout(timeout + 30):
            header = await reader.readuntil(b"\r\n\r\n")
            if len(header) > 16 * 1024:
                raise RuntimeError("project worker returned oversized headers")
            lines = header[:-4].decode("latin1").split("\r\n")
            status_parts = lines[0].split(" ", 2)
            if len(status_parts) < 2 or not status_parts[1].isdigit():
                raise RuntimeError("project worker returned an invalid response")
            status = int(status_parts[1])
            headers = {}
            for line in lines[1:]:
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.strip().lower()] = value.strip()
            if "transfer-encoding" in headers:
                raise RuntimeError("project worker returned unsupported transfer encoding")
            try:
                length = int(headers.get("content-length", "-1"))
            except ValueError as exc:
                raise RuntimeError("project worker returned an invalid response size") from exc
            if length < 0 or length > MAX_RESPONSE_BYTES:
                raise RuntimeError("project worker response exceeded its size limit")
            raw = await reader.readexactly(length)
        try:
            result: Any = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as exc:
            raise RuntimeError("project worker returned an invalid response") from exc
        if status != 200:
            detail = result.get("error", "worker request failed") if isinstance(result, dict) else "worker request failed"
            if status in (401, 403):
                raise PermissionError(str(detail))
            raise RuntimeError(str(detail))
    except asyncio.CancelledError:
        # Closing the request socket is the broker's cancellation signal. The
        # broker then cancels execution and force-removes the worker container.
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
        raise
    except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, ValueError) as exc:
        raise RuntimeError("project worker is unavailable") from exc
    finally:
        if writer is not None and not writer.is_closing():
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass

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
