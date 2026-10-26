"""The terminal shell identity must come from the verified WebSocket ticket."""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def test_terminal_identity_frame_uses_ticket_claims(monkeypatch):
    import api

    monkeypatch.setenv("INTERNAL_API_KEY", "terminal-test-signing-key")
    claims = {"sub": "owner-1", "pid": "project-1", "sid": "session-1"}
    frame = api._kali_terminal_identity_frame(claims)
    decoded = json.loads(frame)
    assert decoded == {
        "type": "init",
        "user_id": "owner-1",
        "project_id": "project-1",
        "session_id": "session-1",
        "graph_ctx": decoded["graph_ctx"],
    }
    verified = api._verify_terminal_graph_ctx(decoded["graph_ctx"])
    assert verified["user_id"] == "owner-1"
    assert verified["project_id"] == "project-1"
    assert verified["session_id"] == "session-1"


def test_terminal_graph_context_rejects_tampering_and_wrong_tool(monkeypatch):
    import api
    from redamon_ctx import sign_tag

    key = "terminal-test-signing-key"
    monkeypatch.setenv("INTERNAL_API_KEY", key)
    base = {
        "source": "agent", "user_id": "owner-1", "project_id": "project-1",
        "session_id": "session-1", "tool": "kali_terminal",
        "phase": "interactive", "exp": int(api.time.time()) + 60,
    }
    token = sign_tag(base, key)
    assert api._verify_terminal_graph_ctx(token)["project_id"] == "project-1"
    assert api._verify_terminal_graph_ctx(token + "x") is None
    assert api._verify_terminal_graph_ctx(sign_tag({**base, "tool": "proxy_brain"}, key)) is None
    monkeypatch.setenv("SCANNER_API_KEY", key)
    assert api._verify_terminal_graph_ctx(token) is None


def test_scoped_shell_context_resolves_only_verified_project(monkeypatch, tmp_path):
    import api
    import workspace_fs
    from fastapi.responses import JSONResponse
    from redamon_ctx import sign_tag

    key = "execution-test-signing-key"
    monkeypatch.setenv("INTERNAL_API_KEY", key)
    monkeypatch.setenv("SCANNER_API_KEY", "execution-scanner-key")
    monkeypatch.setattr(workspace_fs, "WORKSPACE_ROOT", tmp_path)
    token = sign_tag({
        "source": "agent", "user_id": "owner-1", "project_id": "project-1",
        "tool": "kali_shell", "phase": "informational",
        "exp": int(api.time.time()) + 60,
    }, key)
    response = asyncio.run(api.resolve_execution_context(
        api.ExecutionContextRequest(ctx=token, tool="kali_shell")
    ))
    assert response == {"project_id": "project-1"}
    project_root = tmp_path / "project-1"
    assert project_root.stat().st_mode & 0o777 == 0o755
    assert (project_root / ".reamon-tmp").stat().st_mode & 0o777 == 0o700
    assert (project_root / ".reamon-tmp").stat().st_uid == 65534
    assert (project_root / "tool-outputs").stat().st_mode & 0o777 == 0o777
    assert (project_root / "tool-outputs").stat().st_uid == 65534

    wrong_tool = asyncio.run(api.resolve_execution_context(
        api.ExecutionContextRequest(ctx=token, tool="execute_code")
    ))
    assert isinstance(wrong_tool, JSONResponse)
    assert wrong_tool.status_code == 403

    code_token = sign_tag({
        "source": "agent", "user_id": "owner-1", "project_id": "project-1",
        "tool": "execute_code", "phase": "informational",
        "exp": int(api.time.time()) + 60,
    }, key)
    code_scope = asyncio.run(api.resolve_execution_context(
        api.ExecutionContextRequest(ctx=code_token, tool="execute_code")
    ))
    assert code_scope == {"project_id": "project-1"}

    proxy_token = sign_tag({
        "source": "agent", "user_id": "owner-1", "project_id": "project-1",
        "tool": "proxy_brain", "phase": "informational",
        "exp": int(api.time.time()) + 60,
    }, key)
    proxy_scope = asyncio.run(api.resolve_execution_context(
        api.ExecutionContextRequest(ctx=proxy_token, tool="proxy_brain")
    ))
    assert proxy_scope == {"project_id": "project-1"}

    playwright_token = sign_tag({
        "source": "agent", "user_id": "owner-1", "project_id": "project-1",
        "tool": "execute_playwright", "phase": "informational",
        "exp": int(api.time.time()) + 60,
    }, key)
    playwright_scope = asyncio.run(api.resolve_execution_context(
        api.ExecutionContextRequest(ctx=playwright_token, tool="execute_playwright")
    ))
    assert playwright_scope == {"project_id": "project-1"}


def test_scoped_shell_context_rejects_symlink_output_directory(monkeypatch, tmp_path):
    import api
    import workspace_fs
    from fastapi.responses import JSONResponse
    from redamon_ctx import sign_tag

    key = "execution-test-signing-key"
    monkeypatch.setenv("INTERNAL_API_KEY", key)
    monkeypatch.setenv("SCANNER_API_KEY", "execution-scanner-key")
    monkeypatch.setattr(workspace_fs, "WORKSPACE_ROOT", tmp_path)
    project_root = tmp_path / "project-1"
    project_root.mkdir()
    external = tmp_path / "external"
    external.mkdir()
    (project_root / "tool-outputs").symlink_to(external, target_is_directory=True)
    token = sign_tag({
        "source": "agent", "user_id": "owner-1", "project_id": "project-1",
        "tool": "kali_shell", "phase": "informational",
        "exp": int(api.time.time()) + 60,
    }, key)

    response = asyncio.run(api.resolve_execution_context(
        api.ExecutionContextRequest(ctx=token, tool="kali_shell")
    ))

    assert isinstance(response, JSONResponse)
    assert response.status_code == 503
    assert external.stat().st_mode & 0o777 == 0o755


def test_scoped_shell_context_rejects_symlink_project_root(monkeypatch, tmp_path):
    import api
    import workspace_fs
    from fastapi.responses import JSONResponse
    from redamon_ctx import sign_tag

    key = "execution-test-signing-key"
    monkeypatch.setenv("INTERNAL_API_KEY", key)
    monkeypatch.setenv("SCANNER_API_KEY", "execution-scanner-key")
    monkeypatch.setattr(workspace_fs, "WORKSPACE_ROOT", tmp_path)
    external = tmp_path / "external"
    external.mkdir()
    (tmp_path / "project-1").symlink_to(external, target_is_directory=True)
    token = sign_tag({
        "source": "agent", "user_id": "owner-1", "project_id": "project-1",
        "tool": "kali_shell", "phase": "informational",
        "exp": int(api.time.time()) + 60,
    }, key)

    response = asyncio.run(api.resolve_execution_context(
        api.ExecutionContextRequest(ctx=token, tool="kali_shell")
    ))

    assert isinstance(response, JSONResponse)
    assert response.status_code == 503
    assert not (external / "tool-outputs").exists()


def test_scoped_shell_context_rejects_expired_and_unsafe_project_claims(monkeypatch):
    import api
    from fastapi.responses import JSONResponse
    from redamon_ctx import sign_tag

    key = "execution-test-signing-key"
    monkeypatch.setenv("INTERNAL_API_KEY", key)
    monkeypatch.setenv("SCANNER_API_KEY", "execution-scanner-key")
    cases = (
        ("project-1", int(api.time.time()) - 1),
        ("../outside", int(api.time.time()) + 60),
    )
    for project_id, expiry in cases:
        token = sign_tag({
            "source": "agent", "user_id": "owner-1", "project_id": project_id,
            "tool": "kali_shell", "phase": "informational", "exp": expiry,
        }, key)
        response = asyncio.run(api.resolve_execution_context(
            api.ExecutionContextRequest(ctx=token, tool="kali_shell")
        ))
        assert isinstance(response, JSONResponse)
        assert response.status_code == 401


def test_terminal_graph_exec_uses_signed_tenant_not_body_identity(monkeypatch):
    import api
    from fastapi.responses import JSONResponse
    from redamon_ctx import sign_tag

    key = "terminal-test-signing-key"
    monkeypatch.setenv("INTERNAL_API_KEY", key)
    token = sign_tag({
        "source": "agent", "user_id": "owner-1", "project_id": "project-1",
        "session_id": "session-1", "tool": "kali_terminal",
        "phase": "interactive", "exp": int(api.time.time()) + 60,
    }, key)
    observed = {}

    def respond(cypher, params):
        observed["cypher"] = cypher
        observed["params"] = params
        return JSONResponse({"records": []})

    monkeypatch.setattr(api, "_graph_exec_respond", respond)
    response = asyncio.run(api.graph_terminal_exec(api.TerminalGraphExecRequest(
        ctx=token, op="cypher", cypher="MATCH (n:IP) RETURN n",
        user_id="victim", project_id="victim-project",
    )))
    assert response.status_code == 200
    assert observed["params"] == {
        "tenant_user_id": "owner-1", "tenant_project_id": "project-1"
    }


def test_terminal_graph_exec_rejects_invalid_context(monkeypatch):
    import api

    monkeypatch.setenv("INTERNAL_API_KEY", "terminal-test-signing-key")
    response = asyncio.run(api.graph_terminal_exec(
        api.TerminalGraphExecRequest(ctx="forged", op="types")
    ))
    assert response.status_code == 401


def test_terminal_graph_query_uses_signed_tenant_and_billed_limits(monkeypatch):
    import api
    from types import SimpleNamespace
    from redamon_ctx import sign_tag
    from llm_guard import _daily_cap, _rate_limiter

    key = "terminal-test-signing-key"
    monkeypatch.setenv("INTERNAL_API_KEY", key)
    token = sign_tag({
        "source": "agent", "user_id": "owner-1", "project_id": "project-1",
        "session_id": "session-1", "tool": "kali_terminal",
        "phase": "interactive", "exp": int(api.time.time()) + 60,
    }, key)
    observed = {}

    async def build(user_id, project_id):
        observed["tenant"] = (user_id, project_id)
        return object()

    async def generate(_manager, question, user_id, project_id, for_graph_view):
        observed["generation"] = (question, user_id, project_id, for_graph_view)
        return "MATCH (n:IP) RETURN n.address"

    monkeypatch.setattr(api, "_build_cypher_manager", build)
    monkeypatch.setattr(api, "_generate_validated_cypher", generate)
    rate_keys = []
    daily_keys = []
    monkeypatch.setattr(_rate_limiter, "allow", lambda key: rate_keys.append(key) or True)
    monkeypatch.setattr(_daily_cap, "allow", lambda key: daily_keys.append(key) or True)
    request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    response = asyncio.run(api.graph_terminal_query(
        api.TerminalGraphQueryRequest(ctx=token, question="list IP addresses"), request
    ))
    assert response.status_code == 200
    assert json.loads(response.body) == {"cypher": "MATCH (n:IP) RETURN n.address"}
    assert observed["tenant"] == ("owner-1", "project-1")
    assert observed["generation"] == (
        "list IP addresses", "owner-1", "project-1", False
    )
    assert rate_keys == ["owner-1|127.0.0.1"]
    assert daily_keys == ["owner-1"]


def test_browser_cannot_override_ticket_identity():
    import api

    forged = json.dumps({
        "type": "init",
        "user_id": "victim",
        "project_id": "victim-project",
        "session_id": "victim-session",
    })
    assert api._is_kali_terminal_identity_frame(forged)
    assert api._is_kali_terminal_identity_frame(forged.encode())
    assert not api._is_kali_terminal_identity_frame("whoami\n")


class _BrowserSocket:
    headers = {"origin": "http://localhost", "host": "localhost"}
    query_params = {"ticket": "test-ticket"}

    def __init__(self, frames):
        self.frames = list(frames)

    async def accept(self):
        return None

    async def receive(self):
        if self.frames:
            return self.frames.pop(0)
        raise RuntimeError("browser disconnected")

    async def close(self, **_kwargs):
        return None


class _UpstreamSocket:
    def __init__(self):
        self.sent = []

    async def send(self, data):
        self.sent.append(data)

    def __aiter__(self):
        async def wait_for_close():
            await asyncio.Future()
            yield ""
        return wait_for_close()


class _UpstreamConnection:
    def __init__(self, socket):
        self.socket = socket

    async def __aenter__(self):
        return self.socket

    async def __aexit__(self, *_args):
        return False


def test_terminal_proxy_sends_ticket_identity_to_isolated_worker(monkeypatch):
    import api
    import ws_ticket
    from redamon_ctx import verify_tag

    claims = {"sub": "owner-1", "pid": "project-1", "sid": "session-1"}
    monkeypatch.setenv("INTERNAL_API_KEY", "terminal-test-signing-key")
    monkeypatch.setenv("SCANNER_API_KEY", "terminal-scanner-key")
    monkeypatch.setattr(api, "_REAMON_TERMINAL_WORKER_URL", "tcp://broker:8081/worker/terminal")
    monkeypatch.setattr(
        ws_ticket, "authorize_ws", lambda *_args: (True, claims, "ok")
    )
    reader = asyncio.StreamReader()
    reader.feed_data(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
    reader.feed_eof()

    class WorkerWriter:
        def __init__(self):
            self.data = bytearray()
            self.closed = False

        def write(self, data):
            self.data.extend(data)

        async def drain(self):
            return None

        def close(self):
            self.closed = True

        async def wait_closed(self):
            return None

    worker_writer = WorkerWriter()

    async def open_connection(*_args):
        return reader, worker_writer

    monkeypatch.setattr(api.asyncio, "open_connection", open_connection)
    browser = _BrowserSocket([
        {"text": json.dumps({
            "type": "init",
            "user_id": "victim",
            "project_id": "victim-project",
            "session_id": "victim-session",
        })},
        {"text": "id\n"},
    ])

    asyncio.run(api.kali_terminal_proxy(browser))

    request_head, request_body = bytes(worker_writer.data).split(b"\r\n\r\n", 1)
    request = json.loads(request_body[:int(next(
        line.split(b":", 1)[1].strip() for line in request_head.split(b"\r\n")
        if line.lower().startswith(b"content-length:")
    ))])
    context = verify_tag(request["ctx"], {"agent": "terminal-test-signing-key"})
    assert context["user_id"] == "owner-1"
    assert context["project_id"] == "project-1"
    assert context["session_id"] == "session-1"
    assert context["tool"] == "kali_terminal"
    assert context["phase"] == "interactive"
    assert api._verify_terminal_graph_ctx(context["graph_ctx"])["project_id"] == "project-1"
