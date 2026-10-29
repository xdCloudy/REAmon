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
import stat
import time
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
WORKSPACE_CONTAINER = os.environ.get("REAMON_WORKSPACE_CONTAINER", "redamon-agent")
WORKER_BROKER_CONTAINER = os.environ.get("REAMON_DOCKER_BROKER_CONTAINER", "reamon-docker-broker")
WORKSPACE_ROOT = os.environ.get("REAMON_WORKSPACE_ROOT", "")
WORKSPACE_HOST_PATH = os.environ.get("REAMON_WORKSPACE_HOST_PATH", "")
WORKSPACE_COMPOSE_PROJECT = os.environ.get("REAMON_WORKSPACE_COMPOSE_PROJECT", "reamon")
WORKSPACE_COMPOSE_SERVICE = os.environ.get("REAMON_WORKSPACE_COMPOSE_SERVICE", "agent")
DOCKER_DESKTOP_HOST_PREFIX = os.environ.get(
    "REAMON_DOCKER_DESKTOP_HOST_PREFIX", "/run/desktop/mnt/host",
).rstrip("/")
PROJECT_WORKER_IMAGE = os.environ.get("REAMON_PROJECT_WORKER_IMAGE", "reamon-project-worker:latest")
PENTEST_WORKER_IMAGE = os.environ.get("REAMON_PENTEST_WORKER_IMAGE", "reamon-kali-sandbox:latest")
TERMINAL_AGENT_CONTAINER = os.environ.get("REAMON_TERMINAL_AGENT_CONTAINER", "redamon-agent")


def _bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    """Read an operator limit without allowing typos or values to remove its ceiling."""
    try:
        configured = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        configured = default
    return min(maximum, max(minimum, configured))


WORKER_MEMORY = _bounded_int_env(
    "REAMON_WORKER_MEMORY_BYTES", 1024**3, 256 * 1024**2, 8 * 1024**3,
)
WORKER_MAX_FILE_BYTES = _bounded_int_env(
    "REAMON_WORKER_MAX_FILE_BYTES", 1024**3, 16 * 1024**2, 8 * 1024**3,
)
WORKER_PIDS = _bounded_int_env("REAMON_WORKER_PIDS", 512, 64, 4096)
WORKER_NANO_CPUS = _bounded_int_env("REAMON_WORKER_NANO_CPUS", 2_000_000_000, 500_000_000, 16_000_000_000)
WORKER_MEMORY_BUDGET = 8 * 1024**3
WORKER_PIDS_BUDGET = 4096
WORKER_NANO_CPUS_BUDGET = 16_000_000_000


def _worker_concurrency_limit(configured: int, memory: int, pids: int, nano_cpus: int) -> int:
    """Bound aggregate project-worker resources as well as each container."""
    return min(
        configured,
        WORKER_MEMORY_BUDGET // memory,
        WORKER_PIDS_BUDGET // pids,
        WORKER_NANO_CPUS_BUDGET // nano_cpus,
    )


WORKER_OUTPUT_LIMIT = 2 * 1024 * 1024
WORKER_CLEANUP_ATTEMPTS = 3
WORKER_SCRATCH_TTL_SECONDS = 24 * 60 * 60
WORKER_MAX_ACTIVE = _worker_concurrency_limit(
    _bounded_int_env("REAMON_WORKER_MAX_ACTIVE", 4, 1, 64),
    WORKER_MEMORY,
    WORKER_PIDS,
    WORKER_NANO_CPUS,
)
WORKER_MAX_ACTIVE_PER_PROJECT = min(
    WORKER_MAX_ACTIVE,
    max(1, int(os.environ.get("REAMON_WORKER_MAX_ACTIVE_PER_PROJECT", "2"))),
)
_WORKER_ADMISSION_LOCK = asyncio.Lock()
WORKER_TOOLS = frozenset({"kali_shell", "execute_code", "execute_playwright", "proxy_brain"})
TERMINAL_TOOL = "kali_terminal"
TERMINAL_MAX_FRAME = 1024 * 1024
TERMINAL_IDLE_TIMEOUT_SECONDS = max(60, min(86_400, int(os.environ.get("REAMON_TERMINAL_IDLE_TIMEOUT_SECONDS", "1800"))))
TERMINAL_MAX_SESSION_SECONDS = max(300, min(6_900, int(os.environ.get("REAMON_TERMINAL_MAX_SESSION_SECONDS", "6900"))))
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_IMAGE_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$")
_EGRESS_TOOLS = frozenset({"kali_shell", "execute_playwright", "proxy_brain"})
_WORKER_ENV = frozenset({
    "PATH", "HOME", "TMPDIR", "LANG", "PYTHONDONTWRITEBYTECODE",
    "PYTHONNOUSERSITE", "PLAYWRIGHT_BROWSERS_PATH", "CAPTURE_PROXY_URL",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "LC_ALL", "REDAMON_AGENT_URL",
    "REDAMON_CTX",
    "REDAMON_USER_ID", "REDAMON_PROJECT_ID", "TERM", "SHELL", "PS1",
})


class DockerAPIError(RuntimeError):
    pass


class WorkerAdmissionError(DockerAPIError):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


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


def _worker_image_for_tool(tool: str) -> str:
    """Keep REAmon source execution separate from optional pentest tooling."""
    image = PENTEST_WORKER_IMAGE if tool in {"kali_shell", "execute_playwright", "proxy_brain"} else PROJECT_WORKER_IMAGE
    if not _IMAGE_REF_RE.fullmatch(image):
        raise DockerAPIError("configured project worker image is invalid")
    return image


async def _trusted_agent_container_id() -> str:
    """Resolve the trusted Compose agent without trusting a generated name."""
    from urllib.parse import quote, urlencode

    status, raw = await _docker_request(
        "GET", f"/containers/{quote(TERMINAL_AGENT_CONTAINER, safe='')}/json",
    )
    if status == 404:
        filters = json.dumps({
            "label": [
                f"com.docker.compose.project={WORKSPACE_COMPOSE_PROJECT}",
                f"com.docker.compose.service={WORKSPACE_COMPOSE_SERVICE}",
            ],
            "status": ["running"],
        })
        status, raw = await _docker_request(
            "GET", f"/containers/json?{urlencode({'all': '1', 'filters': filters})}",
        )
        if status != 200:
            raise DockerAPIError("trusted agent container is unavailable")
        try:
            candidates = json.loads(raw or b"[]")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DockerAPIError("Docker returned invalid agent container inventory") from exc
        if not isinstance(candidates, list):
            raise DockerAPIError("Docker returned invalid agent container inventory")
        candidates = [
            item for item in candidates
            if isinstance(item, dict)
            and isinstance(item.get("Id"), str)
            and item.get("State") == "running"
            and isinstance(item.get("Labels"), dict)
            and item["Labels"].get("com.docker.compose.project") == WORKSPACE_COMPOSE_PROJECT
            and item["Labels"].get("com.docker.compose.service") == WORKSPACE_COMPOSE_SERVICE
        ]
        if len(candidates) != 1:
            raise DockerAPIError("trusted agent container is ambiguous or unavailable")
        inspect_ref = candidates[0]["Id"]
        status, raw = await _docker_request(
            "GET", f"/containers/{quote(inspect_ref, safe='')}/json",
        )
    if status != 200:
        raise DockerAPIError("trusted agent container is unavailable")
    container = _json_body(raw, "trusted agent inspect")
    labels = container.get("Config", {}).get("Labels", {})
    state = container.get("State", {})
    if (not isinstance(labels, dict)
            or labels.get("com.docker.compose.project") != WORKSPACE_COMPOSE_PROJECT
            or labels.get("com.docker.compose.service") != WORKSPACE_COMPOSE_SERVICE
            or not isinstance(state, dict)
            or state.get("Running") is not True):
        raise DockerAPIError("trusted agent does not match the configured Compose service")
    container_id = container.get("Id")
    if not isinstance(container_id, str) or not container_id:
        raise DockerAPIError("Docker did not return a trusted agent container ID")
    return container_id


async def _disconnect_terminal_agent(network_id: str, container_id: str | None = None) -> None:
    """Detach the trusted agent endpoint so a terminal network can be removed."""
    from urllib.parse import quote

    agent_id = container_id or await _trusted_agent_container_id()
    status, _ = await _docker_request(
        "POST", f"/networks/{quote(network_id, safe='')}/disconnect",
        {"Container": agent_id, "Force": True},
    )
    if status not in (200, 204, 404):
        raise DockerAPIError("trusted agent could not be detached from terminal network")


async def _disconnect_compose_agent_if_attached(network_id: str) -> None:
    """Detach only a verified REAmon agent endpoint from a broker worker network."""
    from urllib.parse import quote

    status, raw = await _docker_request(
        "GET", f"/networks/{quote(network_id, safe='')}",
    )
    if status == 404:
        return
    if status != 200:
        raise DockerAPIError("could not inspect a broker worker network")
    network = _json_body(raw, "worker network inspect")
    attached = network.get("Containers", {})
    if not isinstance(attached, dict):
        raise DockerAPIError("Docker returned invalid worker network attachments")
    for container_id, attachment in attached.items():
        if not isinstance(container_id, str) or not isinstance(attachment, dict):
            raise DockerAPIError("Docker returned invalid worker network attachments")
        status, raw = await _docker_request(
            "GET", f"/containers/{quote(container_id, safe='')}/json",
        )
        if status == 404:
            continue
        if status != 200:
            raise DockerAPIError("could not inspect a worker network attachment")
        container = _json_body(raw, "worker network attachment inspect")
        labels = container.get("Config", {}).get("Labels", {})
        if (isinstance(labels, dict)
                and labels.get("com.docker.compose.project") == WORKSPACE_COMPOSE_PROJECT
                and labels.get("com.docker.compose.service") == WORKSPACE_COMPOSE_SERVICE):
            await _disconnect_terminal_agent(network_id, container_id)


async def _workspace_project_runtime(
    project_id: str, worker_image: str | None = None,
) -> tuple[list[dict[str, Any]], str]:
    from urllib.parse import quote, urlencode

    status, raw = await _docker_request(
        "GET", f"/containers/{quote(WORKSPACE_CONTAINER, safe='')}/json",
    )
    if status == 404:
        filters = json.dumps({
            "label": [
                f"com.docker.compose.project={WORKSPACE_COMPOSE_PROJECT}",
                f"com.docker.compose.service={WORKSPACE_COMPOSE_SERVICE}",
            ],
            "status": ["running"],
        })
        status, raw = await _docker_request(
            "GET", f"/containers/json?{urlencode({'all': '1', 'filters': filters})}",
        )
        if status != 200:
            raise DockerAPIError("agent project workspace container is unavailable")
        try:
            candidates = json.loads(raw or b"[]")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DockerAPIError("Docker returned invalid agent container inventory") from exc
        if not isinstance(candidates, list):
            raise DockerAPIError("Docker returned invalid agent container inventory")
        candidates = [
            item for item in candidates
            if isinstance(item, dict)
            and isinstance(item.get("Id"), str)
            and item.get("State") == "running"
            and isinstance(item.get("Labels"), dict)
            and item["Labels"].get("com.docker.compose.project") == WORKSPACE_COMPOSE_PROJECT
            and item["Labels"].get("com.docker.compose.service") == WORKSPACE_COMPOSE_SERVICE
        ]
        if len(candidates) != 1:
            raise DockerAPIError("agent project workspace container is ambiguous or unavailable")
        container_id = candidates[0]["Id"]
        status, raw = await _docker_request(
            "GET", f"/containers/{quote(container_id, safe='')}/json",
        )
    if status != 200:
        raise DockerAPIError("agent project workspace mount is unavailable")
    container = _json_body(raw, "workspace inspect")
    labels = container.get("Config", {}).get("Labels", {})
    if (not isinstance(labels, dict)
            or labels.get("com.docker.compose.project") != WORKSPACE_COMPOSE_PROJECT
            or labels.get("com.docker.compose.service") != WORKSPACE_COMPOSE_SERVICE):
        raise DockerAPIError("workspace container does not match the configured agent service")
    mounts = container.get("Mounts")
    workspace = next((m for m in mounts or [] if m.get("Destination") == "/workspace"), None)
    source = WORKSPACE_HOST_PATH or (workspace.get("Source") if isinstance(workspace, dict) else None)
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

    _prepare_project_worker_paths(project_id)

    docker_project_root = _docker_daemon_path(project_root, pathmod)
    scratch = os.path.join(docker_project_root, ".reamon-tmp")
    outputs = os.path.join(docker_project_root, "tool-outputs")
    mounts = [
        {"Type": "bind", "Source": docker_project_root, "Target": "/workspace", "ReadOnly": True},
        # Generated-file events are handled by a later worker call, so /tmp
        # must remain project-scoped persistent scratch across those calls.
        {"Type": "bind", "Source": scratch, "Target": "/tmp", "ReadOnly": False},
        {"Type": "bind", "Source": scratch, "Target": "/workspace/.reamon-tmp", "ReadOnly": False},
        {"Type": "bind", "Source": outputs, "Target": "/workspace/tool-outputs", "ReadOnly": False},
    ]
    image_ref = worker_image or PROJECT_WORKER_IMAGE
    if not _IMAGE_REF_RE.fullmatch(image_ref):
        raise DockerAPIError("configured project worker image is invalid")
    status, raw = await _docker_request("GET", f"/images/{quote(image_ref, safe='')}/json")
    if status != 200:
        raise DockerAPIError("configured project worker image is unavailable; rebuild REAmon")
    image_id = _json_body(raw, "worker image inspect").get("Id")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise DockerAPIError("project worker image identity is unavailable")
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


async def _create_worker_network(
    project_id: str, *, allow_egress: bool = False, terminal: bool = False,
) -> str:
    network_name = f"reamon-w-{hashlib.sha256(project_id.encode()).hexdigest()[:10]}-{uuid.uuid4().hex[:8]}"
    labels = {
        "reamon.project-worker": "1",
        "reamon.project-scope": _project_scope_label(project_id),
    }
    if terminal:
        labels["reamon.terminal-worker"] = "1"
    body = {
        "Name": network_name,
        "Driver": "bridge",
        "CheckDuplicate": True,
        "Internal": not allow_egress,
        "Attachable": False,
        "Labels": labels,
    }
    try:
        status, raw = await _docker_request("POST", "/networks/create", body)
    except asyncio.CancelledError:
        # The daemon may finish creating the named network after the caller has
        # gone away, before this coroutine receives its ID.
        try:
            await asyncio.shield(_delete_worker_resource("network", f"/networks/{network_name}"))
        except Exception:
            _log_cleanup_failure("network")
        raise
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


async def reap_orphaned_workers() -> tuple[int, int] | None:
    """Clean broker workers after restart only when this is the sole broker."""
    from urllib.parse import quote, urlencode

    broker_filters = json.dumps({"name": [f"/{WORKER_BROKER_CONTAINER}"]})
    status, raw = await _docker_request(
        "GET", f"/containers/json?all=1&{urlencode({'filters': broker_filters})}",
    )
    if status != 200:
        return None
    try:
        brokers = json.loads(raw or b"[]")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(brokers, list) or len(brokers) != 1:
        return None

    worker_filters = json.dumps({"label": ["reamon.project-worker=1"]})
    status, raw = await _docker_request(
        "GET", f"/containers/json?all=1&{urlencode({'filters': worker_filters})}",
    )
    if status != 200:
        return None
    try:
        workers = json.loads(raw or b"[]")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(workers, list) or any(not isinstance(item, dict)
                                            or not isinstance(item.get("Id"), str) for item in workers):
        return None

    network_filters = json.dumps({"label": ["reamon.project-worker=1"]})
    status, raw = await _docker_request(
        "GET", f"/networks?{urlencode({'filters': network_filters})}",
    )
    if status != 200:
        return None
    try:
        networks = json.loads(raw or b"[]")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(networks, list) or any(not isinstance(item, dict)
                                             or not isinstance(item.get("Id"), str) for item in networks):
        return None

    for worker in workers:
        try:
            await _delete_worker_resource(
                "orphan container", f"/containers/{quote(worker['Id'], safe='')}?force=true&v=true",
            )
        except DockerAPIError:
            return None
    for network in networks:
        await _disconnect_compose_agent_if_attached(network["Id"])
        try:
            await _delete_worker_resource("orphan network", f"/networks/{quote(network['Id'], safe='')}")
        except DockerAPIError:
            return None
    return len(workers), len(networks)


def _project_scope_label(project_id: str) -> str:
    """Stable label for per-project admission without storing project IDs in Docker metadata."""
    return hashlib.sha256(project_id.encode("utf-8")).hexdigest()


async def cleanup_project_workers(project_id: str) -> tuple[int, int]:
    """Remove all broker workers and private networks for a verified project ID."""
    if not isinstance(project_id, str) or not _PROJECT_ID_RE.fullmatch(project_id):
        raise PermissionError("verified project scope is invalid")
    scope = _project_scope_label(project_id)

    from urllib.parse import quote, urlencode

    filters = json.dumps({"label": [
        "reamon.project-worker=1", f"reamon.project-scope={scope}",
    ]})
    query = urlencode({"all": "1", "filters": filters})

    network_query = urlencode({"filters": filters})
    import admission_lock as admission_state

    def valid_scoped_resource(item: Any) -> bool:
        labels = item.get("Labels") if isinstance(item, dict) else None
        return (
            isinstance(item, dict) and isinstance(item.get("Id"), str)
            and isinstance(labels, dict)
            and labels.get("reamon.project-worker") == "1"
            and labels.get("reamon.project-scope") == scope
        )

    async with _WORKER_ADMISSION_LOCK:
        async with admission_state.admission_lock():
            # Fence future admissions before inspecting or mutating Docker. A
            # caller already waiting behind this lock sees the tombstone next.
            await asyncio.to_thread(admission_state.tombstone_project_scope, project_id)
            # Inventory both resource types under the same lock used for worker
            # creation. Docker may return truncated or malformed data; fail closed
            # before making any mutations.
            status, raw = await _docker_request("GET", f"/containers/json?{query}")
            if status != 200:
                raise DockerAPIError("could not enumerate project workers")
            try:
                workers = json.loads(raw or b"[]")
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise DockerAPIError("Docker returned invalid project worker inventory") from exc
            if not isinstance(workers, list) or any(not valid_scoped_resource(item) for item in workers):
                raise DockerAPIError("Docker returned invalid project worker inventory")

            status, raw = await _docker_request("GET", f"/networks?{network_query}")
            if status != 200:
                raise DockerAPIError("could not enumerate project worker networks")
            try:
                networks = json.loads(raw or b"[]")
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise DockerAPIError("Docker returned invalid project network inventory") from exc
            if not isinstance(networks, list) or any(not valid_scoped_resource(item) for item in networks):
                raise DockerAPIError("Docker returned invalid project network inventory")

            # Older broker releases labeled networks globally but omitted the
            # hashed project label. Recover those dedicated networks through
            # inspect data from containers already verified by both worker and
            # project-scope labels. This remains scoped to the target project's
            # workers and also cleans pre-upgrade sessions.
            network_ids = {item["Id"] for item in networks}
            for item in workers:
                worker_id = quote(item["Id"], safe="")
                status, raw = await _docker_request("GET", f"/containers/{worker_id}/json")
                if status == 404:
                    continue
                if status != 200:
                    raise DockerAPIError("could not inspect a project worker")
                try:
                    inspected = json.loads(raw or b"{}")
                    attachments = inspected["NetworkSettings"]["Networks"]
                except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError) as exc:
                    raise DockerAPIError("Docker returned invalid project worker network data") from exc
                if not isinstance(attachments, dict):
                    raise DockerAPIError("Docker returned invalid project worker network data")
                for attachment in attachments.values():
                    if not isinstance(attachment, dict):
                        raise DockerAPIError("Docker returned invalid project worker network data")
                    network_id = attachment.get("NetworkID")
                    if network_id:
                        if not isinstance(network_id, str):
                            raise DockerAPIError("Docker returned invalid project worker network ID")
                        network_ids.add(network_id)

            for item in workers:
                await _delete_worker_resource(
                    "project worker", f"/containers/{quote(item['Id'], safe='')}?force=true&v=true",
                )
            for network_id in sorted(network_ids):
                await _disconnect_compose_agent_if_attached(network_id)
                await _delete_worker_resource("project worker network", f"/networks/{quote(network_id, safe='')}")

    return len(workers), len(network_ids)


def _docker_daemon_path(path: str, pathmod) -> str:
    """Translate a Windows bind source into Docker Desktop's Linux host path."""
    if pathmod is not ntpath:
        return path
    drive, tail = ntpath.splitdrive(path)
    if not re.fullmatch(r"[A-Za-z]:", drive):
        raise DockerAPIError("Docker Desktop workspace source must use a local drive")
    prefix = DOCKER_DESKTOP_HOST_PREFIX or "/run/desktop/mnt/host"
    tail = tail.replace("\\", "/")
    return f"{prefix}/{drive[0].lower()}{tail}"


def _prepare_project_worker_paths(project_id: str) -> None:
    """Prepare worker-writable folders through the broker's trusted workspace bind."""
    if not WORKSPACE_ROOT:
        raise DockerAPIError("broker project workspace is not configured")
    root = os.path.realpath(WORKSPACE_ROOT)
    project_root = os.path.join(root, project_id)
    if (os.path.islink(project_root) or not os.path.isdir(project_root)
            or os.path.realpath(project_root) != project_root):
        raise DockerAPIError("project workspace directory is unavailable")
    for name in (".reamon-tmp", "tool-outputs"):
        path = os.path.join(project_root, name)
        if os.path.islink(path):
            raise DockerAPIError(f"project worker path must not be a symlink: {name}")
        os.makedirs(path, mode=0o770, exist_ok=True)
        if os.path.realpath(path) != path or not os.path.isdir(path):
            raise DockerAPIError(f"project worker path is unavailable: {name}")
        try:
            os.chown(path, 65534, 65534)
            os.chmod(path, 0o770)
        except OSError as exc:
            raise DockerAPIError(f"project worker path permissions are unavailable: {name}") from exc


def _cleanup_stale_project_scratch(project_id: str, *, now: float | None = None) -> int:
    """Remove expired regular files only from an idle project's shared scratch."""
    if not WORKSPACE_ROOT:
        raise DockerAPIError("broker project workspace is not configured")
    root = os.path.realpath(WORKSPACE_ROOT)
    project_root = os.path.join(root, project_id)
    if (os.path.islink(project_root) or not os.path.isdir(project_root)
            or os.path.realpath(project_root) != project_root):
        raise DockerAPIError("project workspace directory is unavailable")
    scratch = os.path.join(project_root, ".reamon-tmp")
    if os.path.islink(scratch):
        raise DockerAPIError("project worker scratch must not be a symlink")
    if not os.path.exists(scratch):
        return 0
    if not os.path.isdir(scratch) or os.path.realpath(scratch) != scratch:
        raise DockerAPIError("project worker scratch directory is unavailable")

    cutoff = (time.time() if now is None else now) - WORKER_SCRATCH_TTL_SECONDS
    reclaimed = 0
    for current, directories, files in os.walk(scratch, followlinks=False):
        directories[:] = [
            name for name in directories
            if not os.path.islink(os.path.join(current, name))
        ]
        for name in files:
            path = os.path.join(current, name)
            try:
                info = os.stat(path, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_mtime >= cutoff:
                continue
            try:
                os.unlink(path)
            except FileNotFoundError:
                continue
            reclaimed += info.st_size
    return reclaimed


def _collect_idle_project_scratch(project_id: str) -> None:
    """Collect stale scratch opportunistically without making admission depend on it."""
    if not WORKSPACE_ROOT:
        return
    try:
        reclaimed = _cleanup_stale_project_scratch(project_id)
    except (DockerAPIError, OSError):
        _log_cleanup_failure("scratch maintenance")
        return
    if reclaimed:
        print(f"[docker-broker] collected {reclaimed} bytes of stale project scratch", flush=True)


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
    tool: str = "execute_code",
) -> str:
    mounts, image_id = await _workspace_project_runtime(project_id, _worker_image_for_tool(tool))
    name = f"reamon-w-{uuid.uuid4().hex[:20]}"
    body = {
        "Image": image_id,
        "Entrypoint": [
            "/usr/bin/prlimit", "--core=0:0", "--nofile=256:256",
            f"--fsize={WORKER_MAX_FILE_BYTES}:{WORKER_MAX_FILE_BYTES}", "--",
            "/bin/sh", "-c", "exec \"$@\"", "reamon-worker",
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
            "CapAdd": ["NET_RAW"] if tool == "kali_shell" else [],
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
    try:
        status, raw = await _docker_request(
            "POST", f"/containers/create?{urlencode({'name': name})}", body,
        )
    except asyncio.CancelledError:
        # A timed-out create can still complete inside Docker. The unique name
        # lets cancellation remove it even when the response ID was never read.
        try:
            await asyncio.shield(_delete_worker_resource(
                "container", f"/containers/{name}?force=true&v=true",
            ))
        except Exception:
            _log_cleanup_failure("container")
        raise
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
    mounts, image_id = await _workspace_project_runtime(project_id, PROJECT_WORKER_IMAGE)
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
            "/usr/bin/prlimit", "--core=0:0", "--nofile=256:256",
            f"--fsize={WORKER_MAX_FILE_BYTES}:{WORKER_MAX_FILE_BYTES}", "--",
            "/bin/sh", "-c", "exec /bin/bash --login",
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
            "CapAdd": [],
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
    import admission_lock as admission_state

    async with _WORKER_ADMISSION_LOCK:
        async with admission_state.admission_lock():
            if admission_state.is_project_scope_tombstoned(project_id):
                raise WorkerAdmissionError(410, "project scope was deleted; worker admission is closed")
            async def create() -> tuple[str, str]:
                active = await _active_worker_count()
                project_active = await _active_project_worker_count(project_id)
                if active is None or project_active is None:
                    raise WorkerAdmissionError(503, "terminal worker capacity is unavailable")
                if active >= WORKER_MAX_ACTIVE:
                    raise WorkerAdmissionError(429, "worker capacity is full; retry later")
                if project_active >= WORKER_MAX_ACTIVE_PER_PROJECT:
                    raise WorkerAdmissionError(429, "this project has reached its active worker limit; retry later")
                if project_active == 0:
                    _collect_idle_project_scratch(project_id)
                network_id = await _create_worker_network(project_id, terminal=True)
                agent_container_id = None
                try:
                    agent_container_id = await _trusted_agent_container_id()
                    status, _ = await _docker_request("POST", f"/networks/{network_id}/connect", {
                        "Container": agent_container_id,
                        "EndpointConfig": {"Aliases": ["agent"]},
                    })
                    if status not in (200, 201):
                        raise DockerAPIError("could not attach the trusted agent endpoint to terminal network")
                    container_id = await _create_terminal_container(identity, network_id)
                except asyncio.CancelledError:
                    if agent_container_id:
                        try:
                            await asyncio.shield(_disconnect_terminal_agent(network_id, agent_container_id))
                        except Exception:
                            _log_cleanup_failure("terminal agent detach")
                    try:
                        await asyncio.shield(_delete_worker_resource("terminal network", f"/networks/{network_id}"))
                    except Exception:
                        _log_cleanup_failure("terminal network")
                    raise
                except Exception:
                    if agent_container_id:
                        try:
                            await _disconnect_terminal_agent(network_id, agent_container_id)
                        except Exception:
                            _log_cleanup_failure("terminal agent detach")
                    try:
                        await _delete_worker_resource("terminal network", f"/networks/{network_id}")
                    except Exception:
                        _log_cleanup_failure("terminal network")
                    raise
                return network_id, container_id

            if broker.BROKER_MAX_CONTAINERS <= 0:
                return await create()
            async with broker._CREATE_COUNT_LOCK:
                host_active = await broker._count_broker_owned_active()
                if host_active < 0:
                    raise WorkerAdmissionError(503, "host container capacity is unavailable")
                if host_active >= broker.BROKER_MAX_CONTAINERS:
                    raise WorkerAdmissionError(429, "host container capacity is full; retry later")
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
                activity[0] = asyncio.get_running_loop().time()
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
                activity[0] = asyncio.get_running_loop().time()
                writer.write(b"O" + len(chunk).to_bytes(4, "big") + chunk)
                await writer.drain()

        # Set initial dimensions once Docker has started the PTY.
        from urllib.parse import urlencode
        await _docker_request("POST", f"/containers/{container_id}/resize?{urlencode({'h': rows, 'w': cols})}")
        loop = asyncio.get_running_loop()
        activity = [loop.time()]
        session_deadline = activity[0] + TERMINAL_MAX_SESSION_SECONDS
        incoming = asyncio.create_task(input_to_terminal())
        outgoing = asyncio.create_task(terminal_to_output())
        try:
            while True:
                now = loop.time()
                timeout = min(
                    session_deadline - now,
                    TERMINAL_IDLE_TIMEOUT_SECONDS - (now - activity[0]),
                )
                if timeout <= 0:
                    raise asyncio.TimeoutError("terminal worker session limit reached")
                done, pending = await asyncio.wait(
                    (incoming, outgoing), timeout=timeout, return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    raise asyncio.TimeoutError("terminal worker idle or lifetime limit reached")
                for task in done:
                    error = task.exception()
                    if error:
                        raise error
                if incoming in done or outgoing in done:
                    break
        finally:
            incoming.cancel()
            outgoing.cancel()
            await asyncio.gather(incoming, outgoing, return_exceptions=True)
    except (DockerAPIError, OSError, ValueError, asyncio.IncompleteReadError, asyncio.TimeoutError) as exc:
        if not writer.is_closing():
            try:
                if container_id is None:
                    status_code = exc.status_code if isinstance(exc, WorkerAdmissionError) else 503
                    await _send_worker_error(writer, status_code, str(exc))
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
            if network_id:
                try:
                    await _disconnect_terminal_agent(network_id)
                except Exception:
                    pass
            try:
                await _remove_worker(container_id, network_id or "")
            except Exception:
                _log_cleanup_failure("terminal")
        elif network_id:
            try:
                await _disconnect_terminal_agent(network_id)
            except Exception:
                _log_cleanup_failure("terminal agent detach")
            try:
                await _delete_worker_resource("terminal network", f"/networks/{network_id}")
            except Exception:
                _log_cleanup_failure("terminal network")
        close = getattr(writer, "close", None)
        if not writer.is_closing() and callable(close):
            close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


async def _send_worker_error(writer, status: int, message: str) -> None:
    body = json.dumps({"error": message}, separators=(",", ":")).encode("utf-8")
    reason = {
        400: "Bad Request", 403: "Forbidden", 410: "Gone", 429: "Too Many Requests",
        503: "Service Unavailable",
    }.get(status, "Error")
    writer.write(
        f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode("ascii") + body
    )
    await writer.drain()


async def _delete_worker_resource(resource: str, path: str) -> None:
    last_error: Exception | None = None
    for attempt in range(WORKER_CLEANUP_ATTEMPTS):
        try:
            status, _ = await _docker_request("DELETE", path)
            if status in (200, 204, 404):
                return
            last_error = DockerAPIError(
                f"Docker rejected project worker {resource} cleanup (HTTP {status})",
            )
        except Exception as exc:
            last_error = exc
        if attempt + 1 < WORKER_CLEANUP_ATTEMPTS:
            await asyncio.sleep(0.1 * (attempt + 1))
    raise DockerAPIError(f"project worker {resource} cleanup incomplete") from last_error


async def _remove_worker(container_id: str, network_id: str) -> None:
    failures: list[Exception] = []
    for resource, path in (
        ("container", f"/containers/{container_id}?force=true&v=true"),
        ("network", f"/networks/{network_id}"),
    ):
        try:
            await _delete_worker_resource(resource, path)
        except Exception as exc:
            failures.append(exc)
    if failures:
        raise DockerAPIError("project worker cleanup incomplete") from failures[0]


def _log_cleanup_failure(resource: str) -> None:
    # Keep leaked-resource failures visible without logging Docker response
    # bodies, which may contain host-specific paths.
    print(f"[docker-broker] project worker {resource} cleanup incomplete; startup cleanup can retry", flush=True)


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
    tool: str,
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
        if project_active == 0:
            _collect_idle_project_scratch(project_id)
        network_id = await _create_worker_network(
            project_id, allow_egress=tool in _EGRESS_TOOLS,
        )
        try:
            container_id = await _create_worker_container(project_id, network_id, argv, env, tool)
        except asyncio.CancelledError:
            try:
                await asyncio.shield(_delete_worker_resource("execution network", f"/networks/{network_id}"))
            except Exception:
                _log_cleanup_failure("execution network")
            raise
        except Exception:
            try:
                await _delete_worker_resource("execution network", f"/networks/{network_id}")
            except Exception:
                _log_cleanup_failure("execution network")
            raise
        return 200, network_id, container_id, ""

    import admission_lock as admission_state

    async with _WORKER_ADMISSION_LOCK:
        async with admission_state.admission_lock():
            if admission_state.is_project_scope_tombstoned(project_id):
                return 410, None, None, "project scope was deleted; worker admission is closed"
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
            project_id, argv, env, tool,
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
                cleanup = asyncio.create_task(_remove_worker(container_id, network_id or ""))
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    try:
                        await cleanup
                    except Exception:
                        _log_cleanup_failure("execution")
                    raise
            except Exception:
                _log_cleanup_failure("execution")
        elif network_id:
            try:
                await _delete_worker_resource("execution network", f"/networks/{network_id}")
            except Exception:
                _log_cleanup_failure("execution network")
