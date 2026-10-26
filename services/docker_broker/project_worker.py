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
TERMINAL_AGENT_CONTAINER = os.environ.get("REAMON_TERMINAL_AGENT_CONTAINER", "redamon-agent")
WORKER_MEMORY = max(256 * 1024**2, int(os.environ.get("REAMON_WORKER_MEMORY_BYTES", str(1024**3))))
WORKER_PIDS = max(64, int(os.environ.get("REAMON_WORKER_PIDS", "512")))
WORKER_NANO_CPUS = max(500_000_000, int(os.environ.get("REAMON_WORKER_NANO_CPUS", "2000000000")))
WORKER_OUTPUT_LIMIT = 2 * 1024 * 1024
WORKER_MAX_ACTIVE = min(64, max(1, int(os.environ.get("REAMON_WORKER_MAX_ACTIVE", "4"))))
WORKER_MAX_ACTIVE_PER_PROJECT = min(
    WORKER_MAX_ACTIVE,
    max(1, int(os.environ.get("REAMON_WORKER_MAX_ACTIVE_PER_PROJECT", "2"))),
)
_WORKER_ADMISSION_LOCK = asyncio.Lock()
WORKER_TOOLS = frozenset({"kali_shell", "execute_code", "execute_playwright", "proxy_brain"})
TERMINAL_TOOL = "kali_terminal"
TERMINAL_MAX_FRAME = 1024 * 1024
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_WORKER_ENV = frozenset({
    "PATH", "HOME", "TMPDIR", "LANG", "PYTHONDONTWRITEBYTECODE",
    "PYTHONNOUSERSITE", "PLAYWRIGHT_BROWSERS_PATH", "CAPTURE_PROXY_URL",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "LC_ALL", "REDAMON_AGENT_URL",
    "REDAMON_CTX",
    "REDAMON_USER_ID", "REDAMON_PROJECT_ID", "TERM", "SHELL", "PS1",
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


def _verify_terminal_context_sync(ctx: str) -> dict[str, str]:
    """Resolve the identity from a short-lived, agent-signed terminal context."""
    if not SCANNER_API_KEY or SCANNER_API_KEY == "changeme":
        raise PermissionError("terminal worker scope verification is unavailable")
    body = json.dumps({"ctx": ctx, "tool": TERMINAL_TOOL}).encode("utf-8")
    request = urllib.request.Request(
        AGENT_SCOPE_URL, data=body,
        headers={"Content-Type": "application/json", "X-Internal-Key": SCANNER_API_KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.loads(response.read(8192).decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise PermissionError("agent terminal-scope verification failed") from exc
    if not isinstance(result, dict):
        raise PermissionError("agent rejected the terminal context")
    identity = {key: result.get(key) for key in ("project_id", "user_id", "session_id", "graph_ctx")}
    if (not isinstance(identity["project_id"], str) or not _PROJECT_ID_RE.fullmatch(identity["project_id"])
            or not isinstance(identity["user_id"], str) or not identity["user_id"]
            or len(identity["user_id"]) > 200
            or not isinstance(identity["session_id"], str) or not identity["session_id"]
            or len(identity["session_id"]) > 200
            or not isinstance(identity["graph_ctx"], str) or len(identity["graph_ctx"]) > 4096):
        raise PermissionError("agent rejected the terminal context")
    return identity  # type: ignore[return-value]


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


def _project_scope_label(project_id: str) -> str:
    """Stable label for per-project admission without storing project IDs in Docker metadata."""
    return hashlib.sha256(project_id.encode("utf-8")).hexdigest()


async def _active_project_worker_count(project_id: str) -> int | None:
    from urllib.parse import urlencode
    filters = json.dumps({
        "label": [
            "reamon.project-worker=1",
            f"reamon.project-scope={_project_scope_label(project_id)}",
        ],
        "status": ["created", "restarting", "running", "paused"],
    })
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
        "Labels": {
            "reamon.project-worker": "1",
            "reamon.project-scope": _project_scope_label(project_id),
        },
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


async def _create_terminal_container(identity: dict[str, str], network_id: str) -> str:
    """Create a short-lived interactive shell with only its project mounted."""
    project_id = identity["project_id"]
    mounts, image_id = await _workspace_project_runtime(project_id)
    env = _worker_environment({
        "REDAMON_AGENT_URL": "http://agent:8080",
        "REDAMON_CTX": identity["graph_ctx"],
        "REDAMON_USER_ID": identity["user_id"],
        "REDAMON_PROJECT_ID": project_id,
        "TERM": "xterm-256color",
        "SHELL": "/bin/bash",
        "PS1": r"\u@reamon:\w\$ ",
    })
    name = f"reamon-terminal-{uuid.uuid4().hex[:20]}"
    body = {
        "Image": image_id,
        "Entrypoint": [
            "/usr/bin/prlimit", "--core=0:0", "--nofile=256:256", "--",
            "/bin/sh", "-c", "find /tmp -type f -mmin +1440 -delete 2>/dev/null || true; exec /bin/bash --login",
        ],
        "WorkingDir": "/workspace",
        "Env": env,
        "User": "65534:65534",
        "OpenStdin": True,
        "StdinOnce": True,
        "AttachStdin": True,
        "AttachStdout": True,
        "AttachStderr": True,
        "Tty": True,
        "Labels": {
            "reamon.project-worker": "1",
            "reamon.project-scope": _project_scope_label(project_id),
            "reamon.terminal-worker": "1",
        },
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
    status, raw = await _docker_request(
        "POST", f"/containers/create?{urlencode({'name': name})}", body,
    )
    if status not in (201, 200):
        raise DockerAPIError("could not create terminal worker")
    container_id = _json_body(raw, "terminal container create").get("Id")
    if not isinstance(container_id, str) or not container_id:
        raise DockerAPIError("Docker did not return a terminal worker ID")
    return container_id


async def _create_admitted_terminal(identity: dict[str, str]) -> tuple[str, str]:
    """Apply the same host, global, and per-project admission limits as tool workers."""
    import broker

    project_id = identity["project_id"]
    async with _WORKER_ADMISSION_LOCK:
        async def create() -> tuple[str, str]:
            active = await _active_worker_count()
            project_active = await _active_project_worker_count(project_id)
            if active is None or project_active is None:
                raise DockerAPIError("terminal worker capacity is unavailable")
            if active >= WORKER_MAX_ACTIVE:
                raise DockerAPIError("worker capacity is full; retry later")
            if project_active >= WORKER_MAX_ACTIVE_PER_PROJECT:
                raise DockerAPIError("this project has reached its active worker limit; retry later")
            network_id = await _create_worker_network(project_id)
            try:
                status, _ = await _docker_request("POST", f"/networks/{network_id}/connect", {
                    "Container": TERMINAL_AGENT_CONTAINER,
                    "EndpointConfig": {"Aliases": ["agent"]},
                })
                if status not in (200, 201):
                    raise DockerAPIError("could not attach the trusted agent endpoint to terminal network")
                container_id = await _create_terminal_container(identity, network_id)
            except Exception:
                await _docker_request("DELETE", f"/networks/{network_id}")
                raise
            return network_id, container_id

        if broker.BROKER_MAX_CONTAINERS <= 0:
            return await create()
        async with broker._CREATE_COUNT_LOCK:
            host_active = await broker._count_broker_owned_active()
            if host_active < 0:
                raise DockerAPIError("host container capacity is unavailable")
            if host_active >= broker.BROKER_MAX_CONTAINERS:
                raise DockerAPIError("host container capacity is full; retry later")
            return await create()


async def _open_terminal_attach(container_id: str) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    reader, writer = await asyncio.open_unix_connection(UPSTREAM_SOCK)
    path = f"/containers/{container_id}/attach?stream=1&stdin=1&stdout=1&stderr=1"
    writer.write((
        f"POST {path} HTTP/1.1\r\nHost: docker\r\n"
        "Connection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n"
    ).encode("ascii"))
    await writer.drain()
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
    except Exception:
        writer.close()
        await writer.wait_closed()
        raise DockerAPIError("could not attach to terminal worker")
    status_line = head.split(b"\r\n", 1)[0]
    if b" 101 " not in status_line and b" 200 " not in status_line:
        writer.close()
        await writer.wait_closed()
        raise DockerAPIError("Docker rejected terminal worker attachment")
    return reader, writer


async def serve_terminal(ctx: str, rows: int, cols: int, reader, writer) -> None:
    """Run one ticket-scoped terminal session over the authenticated broker socket."""
    try:
        identity = await asyncio.to_thread(_verify_terminal_context_sync, ctx)
    except PermissionError as exc:
        await _send_worker_error(writer, 403, str(exc))
        return
    if (isinstance(rows, bool) or not isinstance(rows, int) or not 2 <= rows <= 500
            or isinstance(cols, bool) or not isinstance(cols, int) or not 2 <= cols <= 1000):
        await _send_worker_error(writer, 400, "terminal dimensions are invalid")
        return

    network_id = None
    container_id = None
    attach_writer = None
    try:
        network_id, container_id = await _create_admitted_terminal(identity)
        attach_reader, attach_writer = await _open_terminal_attach(container_id)
        status, _ = await _docker_request("POST", f"/containers/{container_id}/start", timeout=10)
        if status not in (204, 304):
            raise DockerAPIError("terminal worker did not start")
        writer.write(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()

        async def input_to_terminal():
            while True:
                header = await reader.readexactly(5)
                kind, size = header[:1], int.from_bytes(header[1:], "big")
                if size > TERMINAL_MAX_FRAME:
                    raise ValueError("terminal frame exceeded size limit")
                payload = await reader.readexactly(size)
                if kind == b"D":
                    attach_writer.write(payload)
                    await attach_writer.drain()
                elif kind == b"R":
                    dimensions = json.loads(payload or b"{}")
                    h, w = dimensions.get("rows"), dimensions.get("cols")
                    if (isinstance(h, bool) or not isinstance(h, int) or not 2 <= h <= 500
                            or isinstance(w, bool) or not isinstance(w, int) or not 2 <= w <= 1000):
                        raise ValueError("terminal resize dimensions are invalid")
                    from urllib.parse import urlencode
                    await _docker_request("POST", f"/containers/{container_id}/resize?{urlencode({'h': h, 'w': w})}")
                elif kind != b"P":
                    raise ValueError("unknown terminal frame type")

        async def terminal_to_output():
            while True:
                chunk = await attach_reader.read(64 * 1024)
                if not chunk:
                    return
                writer.write(b"O" + len(chunk).to_bytes(4, "big") + chunk)
                await writer.drain()

        # Set initial dimensions once Docker has started the PTY.
        from urllib.parse import urlencode
        await _docker_request("POST", f"/containers/{container_id}/resize?{urlencode({'h': rows, 'w': cols})}")
        incoming = asyncio.create_task(input_to_terminal())
        outgoing = asyncio.create_task(terminal_to_output())
        try:
            done, pending = await asyncio.wait((incoming, outgoing), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                error = task.exception()
                if error:
                    raise error
        finally:
            incoming.cancel()
            outgoing.cancel()
            await asyncio.gather(incoming, outgoing, return_exceptions=True)
    except (DockerAPIError, OSError, ValueError, asyncio.IncompleteReadError, asyncio.TimeoutError) as exc:
        if not writer.is_closing():
            try:
                if container_id is None:
                    await _send_worker_error(writer, 503, str(exc))
            except Exception:
                pass
    finally:
        if attach_writer is not None:
            attach_writer.close()
            try:
                await attach_writer.wait_closed()
            except Exception:
                pass
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


async def _send_worker_error(writer, status: int, message: str) -> None:
    body = json.dumps({"error": message}, separators=(",", ":")).encode("utf-8")
    reason = {400: "Bad Request", 403: "Forbidden", 503: "Service Unavailable"}.get(status, "Error")
    writer.write(
        f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode("ascii") + body
    )
    await writer.drain()


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


async def _create_admitted_worker(
    project_id: str,
    argv: list[str],
    env: list[str],
) -> tuple[int, str | None, str | None, str]:
    """Apply the worker cap and shared host cap before creating a worker."""
    import broker

    async def check_worker_limits() -> tuple[int, str | None, str | None, str]:
        active = await _active_worker_count()
        if active is None:
            return 503, None, None, "worker capacity is unavailable; execution denied"
        if active >= WORKER_MAX_ACTIVE:
            return 429, None, None, "worker capacity is full; retry later"
        project_active = await _active_project_worker_count(project_id)
        if project_active is None:
            return 503, None, None, "project worker capacity is unavailable; execution denied"
        if project_active >= WORKER_MAX_ACTIVE_PER_PROJECT:
            return 429, None, None, "this project has reached its active worker limit; retry later"
        network_id = await _create_worker_network(project_id)
        try:
            container_id = await _create_worker_container(project_id, network_id, argv, env)
        except Exception:
            await _docker_request("DELETE", f"/networks/{network_id}")
            raise
        return 200, network_id, container_id, ""

    async with _WORKER_ADMISSION_LOCK:
        if broker.BROKER_MAX_CONTAINERS <= 0:
            return await check_worker_limits()
        async with broker._CREATE_COUNT_LOCK:
            host_active = await broker._count_broker_owned_active()
            if host_active < 0:
                return 503, None, None, "host container capacity is unavailable; execution denied"
            if host_active >= broker.BROKER_MAX_CONTAINERS:
                return 429, None, None, "host container capacity is full; retry later"
            return await check_worker_limits()


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
        admitted, network_id, container_id, admission_error = await _create_admitted_worker(
            project_id, argv, env,
        )
        if admitted != 200 or not network_id or not container_id:
            return admitted, {"error": admission_error or "worker admission failed"}
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
