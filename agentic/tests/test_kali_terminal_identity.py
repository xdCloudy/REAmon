"""The terminal shell identity must come from the verified WebSocket ticket."""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def test_terminal_identity_frame_uses_ticket_claims():
    import api

    claims = {"sub": "owner-1", "pid": "project-1", "sid": "session-1"}
    frame = api._kali_terminal_identity_frame(claims)
    assert json.loads(frame) == {
        "type": "init",
        "user_id": "owner-1",
        "project_id": "project-1",
        "session_id": "session-1",
    }


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
