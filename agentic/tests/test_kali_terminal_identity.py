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


def test_terminal_proxy_uses_ticket_identity_before_browser_frames(monkeypatch):
    import api
    import ws_ticket

    claims = {"sub": "owner-1", "pid": "project-1", "sid": "session-1"}
    monkeypatch.setattr(
        ws_ticket, "authorize_ws", lambda *_args: (True, claims, "ok")
    )
    upstream = _UpstreamSocket()
    monkeypatch.setattr(
        api.websockets,
        "connect",
        lambda *_args, **_kwargs: _UpstreamConnection(upstream),
    )
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

    assert upstream.sent == [
        api._kali_terminal_identity_frame(claims),
        "id\n",
    ]
