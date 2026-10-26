"""One-shot, project-scoped execution workers managed by the Docker broker."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import http.client
import json
import ntpath
import os
import re
import socket
import urllib.error
import urllib.request
import uuid
from typing import Any

UPSTREAM_SOCK = os.environ.get("DOCKER_BROKER_UPSTREAM", "/var/run/docker.sock")
AGENT_SCOPE_URL = os.environ.get(
    "AGENT_EXECUTION_SCOPE_URL",
    "http://agent:8080/execution/resolve-context",
)
SCANNER_API_KEY = os.environ.get("SCANNER_API_KEY", "")
WORKSPACE_CONTAINER = os.environ.get("REAMON_WORKSPACE_CONTAINER", "redamon-kali")
WORKER_MEMORY = max(256 * 1024**2, int(os.environ.get("REAMON_WORKER_MEMORY_BYTES", str(1024**3))))
WORKER_PIDS = max(64, int(os.environ.get("REAMON_WORKER_PIDS", "512")))
WORKER_NANO_CPUS = max(500_000_000, int(os.environ.get("REAMON_WORKER_NANO_CPUS", "2000000000")))
WORKER_OUTPUT_LIMIT = 2 * 1024 * 1024
WORKER_MAX_ACTIVE = min(64, max(1, int(os.environ.get("REAMON_WORKER_MAX_ACTIVE", "4"))))
_WORKER_ADMISSION_LOCK = asyncio.Lock()
WORKER_TOOLS = frozenset({"kali_shell", "execute_code", "execute_playwright", "proxy_brain"})
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_WORKER_ENV = frozenset({
    "PATH", "HOME", "TMPDIR", "LANG", "PYTHONDONTWRITEBYTECODE",
    "PYTHONNOUSERSITE", "PLAYWRIGHT_BROWSERS_PATH", "CAPTURE_PROXY_URL",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "LC_ALL", "REDAMON_AGENT_URL",
    "REDAMON_CTX",
})


class DockerAPIError(RuntimeError):
    pass


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float):
        super().__init__("docker", timeout=timeout)
        self._socket_path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._socket_path)
        self.sock = sock


def _verify_context_sync(ctx: str, tool: str) -> str:
    if not SCANNER_API_KEY or SCANNER_API_KEY == "changeme":
        raise PermissionError("worker scope verification is unavailable")
    body = json.dumps({"ctx": ctx, "tool": tool}).encode("utf-8")
    request = urllib.request.Request(
        AGENT_SCOPE_URL,
        data=body,
        headers={"Content-Type": "application/json", "X-Internal-Key": SCANNER_API_KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.loads(response.read(4096).decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise PermissionError("agent worker-scope verification failed") from exc
    project_id = result.get("project_id") if isinstance(result, dict) else None
    if not isinstance(project_id, str) or not _PROJECT_ID_RE.fullmatch(project_id):
        raise PermissionError("agent rejected the worker execution context")
    return project_id


def _docker_request_sync(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    timeout: float = 10,
) -> tuple[int, bytes]:
    payload = json.dumps(body, separators=(",", ":")).encode("utf-8") if body is not None else None
    connection = _UnixHTTPConnection(UPSTREAM_SOCK, timeout)
    try:
        connection.request(
            method,
            path,
            body=payload,
            headers={"Content-Type": "application/json"} if payload is not None else {},
        )
        response = connection.getresponse()
        return response.status, response.read(8 * 1024 * 1024 + 1)
    finally:
        connection.close()


def _json_body(raw: bytes, operation: str) -> dict[str, Any]:
    try:
        value = json.loads(raw or b"{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DockerAPIError(f"Docker returned invalid JSON for {operation}") from exc
    if not isinstance(value, dict):
        raise DockerAPIError(f"Docker returned an invalid response for {operation}")
    return value


async def _docker_request(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    timeout: float = 10,
) -> tuple[int, bytes]:
    status, raw = await asyncio.to_thread(
        _docker_request_sync, method, path, body, timeout=timeout,
    )
    if len(raw) > 8 * 1024 * 1024:
        raise DockerAPIError("Docker response exceeded its size limit")
    return status, raw


async def _workspace_project_runtime(project_id: str) -> tuple[list[dict[str, Any]], str]:
    status, raw = await _docker_request("GET", f"/containers/{WORKSPACE_CONTAINER}/json")
    if status != 200:
        raise DockerAPIError("project workspace mount is unavailable")
    container = _json_body(raw, "workspace inspect")
    image_id = container.get("Image")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise DockerAPIError("running Kali image identity is unavailable")
    mounts = container.get("Mounts")
    workspace = next((m for m in mounts or [] if m.get("Destination") == "/workspace"), None)
    source = workspace.get("Source") if isinstance(workspace, dict) else None
    if not isinstance(source, str) or not source:
        raise DockerAPIError("project workspace mount source is unavailable")

    pathmod = ntpath if ntpath.splitdrive(source)[0] else os.path
    if not pathmod.isabs(source):
        raise DockerAPIError("project workspace mount source is not absolute")
    root = pathmod.normpath(source)
    project_root = pathmod.normpath(pathmod.join(root, project_id))
    try:
        if pathmod.commonpath([root, project_root]).casefold() != root.casefold() or project_root == root:
            raise DockerAPIError("project workspace escaped its root")
    except ValueError as exc:
        raise DockerAPIError("project workspace escaped its root") from exc

    scratch = pathmod.join(project_root, ".reamon-tmp")
    outputs = pathmod.join(project_root, "tool-outputs")
    mounts = [
        {"Type": "bind", "Source": project_root, "Target": "/workspace", "ReadOnly": True},
        {"Type": "bind", "Source": scratch, "Target": "/tmp", "ReadOnly": False},
        {"Type": "bind", "Source": scratch, "Target": "/workspace/.reamon-tmp", "ReadOnly": False},
        {"Type": "bind", "Source": outputs, "Target": "/workspace/tool-outputs", "ReadOnly": False},
    ]
    return mounts, image_id


def _worker_environment(extra: dict[str, str]) -> list[str]:
    if not isinstance(extra, dict):
        raise ValueError("worker environment must be an object")
    env = {
        "PATH": "/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin",
        "HOME": "/tmp",
        "TMPDIR": "/tmp",
        "LANG": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
    }
    for name, value in extra.items():
        if name not in _WORKER_ENV or not isinstance(value, str) or "\x00" in value:
            raise ValueError(f"worker environment override is not allowed: {name}")
        env[name] = value
    return [f"{name}={value}" for name, value in env.items()]


async def _create_worker_network(project_id: str) -> str:
    network_name = f"reamon-w-{hashlib.sha256(project_id.encode()).hexdigest()[:10]}-{uuid.uuid4().hex[:8]}"
    body = {
        "Name": network_name,
        "Driver": "bridge",
        "CheckDuplicate": True,
        "Internal": False,
        "Attachable": False,
        "Labels": {"reamon.project-worker": "1"},
    }
    status, raw = await _docker_request("POST", "/networks/create", body)
    if status not in (201, 200):
        raise DockerAPIError("could not create isolated worker network")
    result = _json_body(raw, "network create")
    network_id = result.get("Id")
    if not isinstance(network_id, str) or not network_id:
        raise DockerAPIError("Docker did not return a worker network ID")
    return network_id


async def _active_worker_count() -> int | None:
    from urllib.parse import urlencode
    filters = json.dumps({"label": ["reamon.project-worker=1"], "status": [
        "created", "restarting", "running", "paused",
    ]})
    status, raw = await _docker_request(
        "GET", f"/containers/json?all=1&{urlencode({'filters': filters})}",
    )
    if status != 200:
        return None
    try:
        containers = json.loads(raw or b"[]")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return len(containers) if isinstance(containers, list) else None


async def _create_worker_container(
    project_id: str,
    network_id: str,
    argv: list[str],
    env: list[str],
) -> str:
    mounts, image_id = await _workspace_project_runtime(project_id)
    name = f"reamon-w-{uuid.uuid4().hex[:20]}"
    body = {
        "Image": image_id,
        "Entrypoint": [
            "/usr/bin/prlimit", "--core=0:0", "--nofile=256:256", "--",
            "/bin/sh", "-c", "find /tmp -type f -mmin +1440 -delete 2>/dev/null || true; exec \"$@\"",
            "reamon-worker",
        ],
        "Cmd": argv,
        "User": "65534:65534",
        "WorkingDir": "/workspace",
        "Env": env,
        "AttachStdout": True,
        "AttachStderr": True,
        "Tty": False,
        "Labels": {"reamon.project-worker": "1", "redamon.broker-owned": "1"},
        "HostConfig": {
            "AutoRemove": False,
            "ReadonlyRootfs": True,
            "NetworkMode": network_id,
            "Memory": WORKER_MEMORY,
            "NanoCpus": WORKER_NANO_CPUS,
            "PidsLimit": WORKER_PIDS,
            "CapDrop": ["ALL"],
            "CapAdd": ["NET_RAW"],
            "SecurityOpt": ["no-new-privileges:true"],
            "Mounts": mounts,
            "Tmpfs": {
                "/var/tmp": "rw,nosuid,nodev,size=64m",
                "/dev/shm": "rw,nosuid,nodev,size=128m",
                "/opt/output": "rw,nosuid,nodev,size=64m",
            },
            "LogConfig": {"Type": "json-file", "Config": {"max-size": "8m", "max-file": "1"}},
        },
    }
    from urllib.parse import urlencode
    status, raw = await _docker_request("POST", f"/containers/create?{urlencode({'name': name})}", body)
    if status not in (201, 200):
        raise DockerAPIError("could not create project worker")
    result = _json_body(raw, "container create")
    container_id = result.get("Id")
    if not isinstance(container_id, str) or not container_id:
        raise DockerAPIError("Docker did not return a project worker ID")
    return container_id


async def _remove_worker(container_id: str, network_id: str) -> None:
    try:
        await _docker_request("DELETE", f"/containers/{container_id}?force=true&v=true")
    finally:
        await _docker_request("DELETE", f"/networks/{network_id}")


def _decode_worker_logs(raw: bytes) -> tuple[bytes, bytes]:
    streams = {1: bytearray(), 2: bytearray()}
    truncated = {1: False, 2: False}
    offset = 0
    while offset < len(raw):
        if len(raw) - offset < 8:
            raise DockerAPIError("Docker returned a truncated worker log frame")
        stream = raw[offset]
        length = int.from_bytes(raw[offset + 4:offset + 8], "big")
        offset += 8
        if stream not in streams or length > len(raw) - offset:
            raise DockerAPIError("Docker returned an invalid worker log frame")
        remaining = WORKER_OUTPUT_LIMIT - len(streams[stream])
        if remaining > 0:
            streams[stream].extend(raw[offset:offset + min(remaining, length)])
        if length > remaining:
            truncated[stream] = True
        offset += length

    values: list[bytes] = []
    for stream in (1, 2):
        value = bytes(streams[stream])
        if truncated[stream]:
            value += b"\n[output truncated after 2 MiB]"
        values.append(value)
    return values[0], values[1]


async def _run_worker(container_id: str, timeout: int) -> tuple[int, bytes, bytes, bool]:
    status, _ = await _docker_request("POST", f"/containers/{container_id}/start", timeout=10)
    if status not in (204, 304):
        raise DockerAPIError("project worker did not start")
    try:
        status, raw = await _docker_request(
            "POST", f"/containers/{container_id}/wait?condition=not-running", timeout=timeout,
        )
    except (asyncio.TimeoutError, TimeoutError):
        await _docker_request("POST", f"/containers/{container_id}/kill?signal=SIGKILL")
        stdout, stderr = await _worker_logs(container_id)
        return 124, stdout, (stderr + b"\n" if stderr else b"") + b"[ERROR] worker command timed out", True
    if status != 200:
        raise DockerAPIError("could not read project worker exit status")
    code = _json_body(raw, "container wait").get("StatusCode")
    if isinstance(code, bool) or not isinstance(code, int):
        raise DockerAPIError("Docker returned an invalid worker exit status")
    stdout, stderr = await _worker_logs(container_id)
    return code, stdout, stderr, False


async def _worker_logs(container_id: str) -> tuple[bytes, bytes]:
    status, raw = await _docker_request(
        "GET", f"/containers/{container_id}/logs?stdout=1&stderr=1&timestamps=0", timeout=15,
    )
    if status != 200:
        raise DockerAPIError("could not read project worker output")
    return _decode_worker_logs(raw)


async def execute(request: Any) -> tuple[int, dict[str, Any]]:
    """Verify the agent scope, execute once in a private container, then remove it."""
    if not isinstance(request, dict):
        return 400, {"error": "request must be an object"}
    ctx = request.get("ctx")
    tool = request.get("tool")
    argv = request.get("argv")
    timeout = request.get("timeout", 300)
    extra_env = request.get("env", {})
    if not isinstance(ctx, str) or not ctx or len(ctx) > 4096:
        return 401, {"error": "signed execution context is required"}
    if not isinstance(tool, str) or tool not in WORKER_TOOLS:
        return 403, {"error": "tool is not enabled for project workers"}
    if not isinstance(argv, list) or not argv or len(argv) > 64 or any(
        not isinstance(item, str) or "\x00" in item or len(item) > 262144 for item in argv
    ):
        return 400, {"error": "command arguments are invalid"}
    if sum(len(item.encode("utf-8")) for item in argv) > 512 * 1024:
        return 413, {"error": "command arguments are too large"}
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 600:
        return 400, {"error": "command timeout is invalid"}
    try:
        env = _worker_environment(extra_env)
        project_id = await asyncio.to_thread(_verify_context_sync, ctx, tool)
    except PermissionError as exc:
        return 403, {"error": str(exc)}
    except (DockerAPIError, ValueError) as exc:
        return 503, {"error": str(exc)}

    container_id = None
    network_id = None
    try:
        async with _WORKER_ADMISSION_LOCK:
            active = await _active_worker_count()
            if active is None:
                return 503, {"error": "worker capacity is unavailable; execution denied"}
            if active >= WORKER_MAX_ACTIVE:
                return 429, {"error": "project worker capacity is full; retry later"}
            network_id = await _create_worker_network(project_id)
            container_id = await _create_worker_container(project_id, network_id, argv, env)
        code, stdout, stderr, timed_out = await _run_worker(container_id, timeout)
        return 200, {
            "exit_code": code,
            "stdout_b64": base64.b64encode(stdout).decode("ascii"),
            "stderr_b64": base64.b64encode(stderr).decode("ascii"),
            "timed_out": timed_out,
        }
    except (DockerAPIError, OSError) as exc:
        return 503, {"error": str(exc)}
    finally:
        if container_id:
            try:
                await _remove_worker(container_id, network_id or "")
            except Exception:
                pass
        elif network_id:
            try:
                await _docker_request("DELETE", f"/networks/{network_id}")
            except Exception:
                pass
