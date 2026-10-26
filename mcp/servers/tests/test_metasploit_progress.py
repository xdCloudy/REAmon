"""
Unit tests for the Metasploit/Hydra progress and session HTTP handlers, including
client-disconnect guards and the fail-closed bearer-auth boundary.

metasploit_server imports fastmcp (heavy) only for the MCP tool surface, and its
server never starts on import (guarded by __main__). We stub fastmcp and load the
module by path, then exercise the pure HTTP handler method in isolation.

Run: python3 -m pytest mcp/servers/tests/test_metasploit_progress.py -q
  or python3 mcp/servers/tests/test_metasploit_progress.py
"""
import importlib.util
import io
import json
import os
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

# Stub fastmcp so `from fastmcp import FastMCP` + module-level `mcp = FastMCP(...)`
# succeed without the real dependency.
sys.modules.setdefault("fastmcp", mock.MagicMock())

_PATH = Path(__file__).resolve().parents[1] / "metasploit_server.py"
_spec = importlib.util.spec_from_file_location("metasploit_server", _PATH)
msf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(msf)

Handler = msf.SessionProgressHandler

_NETWORK_PATH = Path(__file__).resolve().parents[1] / "network_recon_server.py"
_network_spec = importlib.util.spec_from_file_location("network_recon_server", _NETWORK_PATH)
network = importlib.util.module_from_spec(_network_spec)
_network_spec.loader.exec_module(network)


def _handler(write_side_effect=None, path='/progress', headers=None, handler_cls=Handler):
    """A SessionProgressHandler without running BaseHTTPRequestHandler.__init__ (no
    real socket/request); the HTTP header helpers are stubbed so we isolate the guard
    around the body write."""
    h = handler_cls.__new__(handler_cls)
    h.path = path
    h.headers = headers or {}
    h.wfile = mock.Mock()
    if write_side_effect:
        h.wfile.write.side_effect = write_side_effect
    h.send_response = mock.Mock()
    h.send_header = mock.Mock()
    h.end_headers = mock.Mock()
    return h


class TestSendJsonBrokenPipeGuard(unittest.TestCase):
    def test_happy_path_writes_payload(self):
        h = _handler()
        h._send_json(200, {"ok": True})
        h.wfile.write.assert_called_once()
        self.assertEqual(h.wfile.write.call_args[0][0], b'{"ok": true}')

    def test_broken_pipe_is_swallowed(self):
        h = _handler(write_side_effect=BrokenPipeError(32, "Broken pipe"))
        # Must NOT raise: the pre-fix code let this bubble up, so do_GET then tried to
        # write a 500 to the same dead socket -> the double BrokenPipe traceback.
        h._send_json(200, {"progress": []})

    def test_connection_reset_is_swallowed(self):
        h = _handler(write_side_effect=ConnectionResetError("reset"))
        h._send_json(500, {"error": "boom"})

    def test_serialization_error_still_raises(self):
        # A non-serialisable payload is a real bug, not a disconnect -> must surface,
        # not be swallowed by the pipe guard (json.dumps runs before the socket try).
        h = _handler()
        with self.assertRaises(TypeError):
            h._send_json(200, {"bad": object()})


class TestSendStatusBrokenPipeGuard(unittest.TestCase):
    """The body-less 404/204 paths (do_GET/POST/DELETE/OPTIONS else-branches) must
    also swallow a client disconnect, not just _send_json."""

    def _status_handler(self, side_effect=None):
        h = Handler.__new__(Handler)
        h.send_response = mock.Mock()
        h.end_headers = mock.Mock(side_effect=side_effect)
        return h

    def test_happy_path(self):
        h = self._status_handler()
        h._send_status(404)
        h.send_response.assert_called_once_with(404)
        h.end_headers.assert_called_once()

    def test_broken_pipe_is_swallowed(self):
        h = self._status_handler(side_effect=BrokenPipeError(32, "Broken pipe"))
        h._send_status(404)  # must NOT raise

    def test_connection_reset_is_swallowed(self):
        h = self._status_handler(side_effect=ConnectionResetError("reset"))
        h._send_status(204)  # must NOT raise


class TestProgressHttpAuthentication(unittest.TestCase):
    def setUp(self):
        os.environ["MCP_AUTH_TOKEN"] = "progress-secret"

    def tearDown(self):
        os.environ.pop("MCP_AUTH_TOKEN", None)

    def test_missing_and_wrong_bearer_tokens_are_rejected(self):
        for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "Basic progress-secret"}):
            with self.subTest(headers=headers):
                h = _handler(path="/sessions", headers=headers)
                self.assertFalse(h._require_progress_auth())
                h.send_response.assert_called_once_with(401)
                h.send_header.assert_any_call("WWW-Authenticate", "Bearer")

    def test_matching_bearer_token_is_accepted_case_insensitively(self):
        h = _handler(path="/sessions", headers={"Authorization": "bearer progress-secret"})
        self.assertTrue(h._require_progress_auth())
        h.send_response.assert_not_called()

    def test_unconfigured_token_fails_closed(self):
        os.environ.pop("MCP_AUTH_TOKEN", None)
        h = _handler(path="/progress", headers={"Authorization": "Bearer progress-secret"})
        self.assertFalse(h._require_progress_auth())
        h.send_response.assert_called_once_with(401)

    def test_health_is_the_only_public_path(self):
        h = _handler(path="/health")
        self.assertTrue(h._require_progress_auth(public_health=True))
        private = _handler(path="/health/../sessions")
        self.assertFalse(private._require_progress_auth(public_health=True))

    def test_unauthorized_session_listing_does_not_read_metasploit_state(self):
        h = _handler(path="/sessions")
        with mock.patch.object(msf, "get_msf_console") as get_console:
            h.do_GET()
        get_console.assert_not_called()
        h.send_response.assert_called_once_with(401)

    def test_unauthorized_hydra_progress_does_not_read_cracked_data(self):
        h = _handler(path="/progress", handler_cls=network.HydraProgressHandler)
        with mock.patch.object(network, "get_hydra_progress") as get_progress:
            h.do_GET()
        get_progress.assert_not_called()
        h.send_response.assert_called_once_with(401)

    def test_unauthorized_session_mutation_does_not_parse_or_apply_body(self):
        h = _handler(path="/session-chat-map")
        with mock.patch.object(msf, "get_msf_console") as get_console, \
                mock.patch.object(msf.SessionProgressHandler, "_read_json_body") as read_body:
            h.do_POST()
        get_console.assert_not_called()
        read_body.assert_not_called()
        h.send_response.assert_called_once_with(401)


class TestProjectScopedSessions(unittest.TestCase):
    def setUp(self):
        os.environ["MCP_AUTH_TOKEN"] = "progress-secret"

    def tearDown(self):
        os.environ.pop("MCP_AUTH_TOKEN", None)

    def _authorized_handler(self, path, body=None):
        h = _handler(
            path=path,
            headers={"Authorization": "Bearer progress-secret"},
        )
        encoded = json.dumps(body or {}).encode()
        h.headers["Content-Length"] = str(len(encoded))
        h.rfile = io.BytesIO(encoded)
        return h

    def test_project_listing_filters_legacy_sessions_and_global_jobs(self):
        console = mock.Mock()
        console.get_sessions_data.return_value = {
            "sessions": [
                {"id": 1, "project_id": "p1"},
                {"id": 2, "project_id": "p2"},
                {"id": 3},
            ],
            "non_msf_sessions": [{"id": "n1", "project_id": "p1"}, {"id": "n2"}],
            "jobs": [{"id": 7}],
        }
        h = self._authorized_handler("/sessions?project_id=p1")
        h._send_json = mock.Mock()

        with mock.patch.object(msf, "get_msf_console", return_value=console):
            h.do_GET()

        self.assertEqual(h._send_json.call_args.args[0], 200)
        self.assertEqual(h._send_json.call_args.args[1]["sessions"], [{"id": 1, "project_id": "p1"}])
        self.assertEqual(h._send_json.call_args.args[1]["non_msf_sessions"], [{"id": "n1", "project_id": "p1"}])
        self.assertEqual(h._send_json.call_args.args[1]["jobs"], [])

    def test_interaction_rejects_other_project_and_legacy_session(self):
        for owner in ({"project_id": "p2"}, "legacy-chat-id", None):
            with self.subTest(owner=owner):
                console = mock.Mock()
                if owner is not None:
                    console._chat_session_map = {4: owner}
                else:
                    console._chat_session_map = {}
                h = self._authorized_handler(
                    "/sessions/4/interact",
                    {"project_id": "p1", "command": "whoami"},
                )
                h._send_json = mock.Mock()

                with mock.patch.object(msf, "get_msf_console", return_value=console):
                    h.do_POST()

                h._send_json.assert_called_once_with(404, {"error": "Session not found"})
                console.interact_session.assert_not_called()

    def test_owned_session_can_be_interacted_with_and_stopped(self):
        for action in ("interact", "kill"):
            with self.subTest(action=action):
                console = mock.Mock()
                console._chat_session_map = {4: {"project_id": "p1", "chat_session_id": "chat"}}
                h = self._authorized_handler(
                    f"/sessions/4/{action}",
                    {"project_id": "p1", "command": "whoami"},
                )
                h._send_json = mock.Mock()

                with mock.patch.object(msf, "get_msf_console", return_value=console):
                    h.do_POST()

                if action == "interact":
                    console.interact_session.assert_called_once_with(4, "whoami")
                else:
                    console.kill_session.assert_called_once_with(4)
                self.assertEqual(h._send_json.call_args.args[0], 200)

    def test_project_listing_includes_only_jobs_with_matching_owner(self):
        console = mock.Mock()
        console.get_sessions_data.return_value = {
            "sessions": [],
            "non_msf_sessions": [],
            "jobs": [{"id": 7, "name": "handler"}, {"id": 8, "name": "listener"}, {"id": 9}],
        }
        console.snapshot_job_ownership.return_value = {
            7: {"project_id": "p1", "user_id": "u1"},
            8: {"project_id": "p2", "user_id": "u2"},
        }
        h = self._authorized_handler("/sessions?project_id=p1")
        h._send_json = mock.Mock()

        with mock.patch.object(msf, "get_msf_console", return_value=console):
            h.do_GET()

        response = h._send_json.call_args.args[1]
        self.assertEqual(response["jobs"], [
            {"id": 7, "name": "handler", "project_id": "p1", "user_id": "u1"},
        ])
        console.snapshot_job_ownership.assert_called_once_with()

    def test_live_job_can_be_registered_to_its_project(self):
        console = mock.Mock()
        console.job_exists.return_value = True
        console.register_job_owner.return_value = True
        owner = {"chat_session_id": "chat-1", "project_id": "p1", "user_id": "u1"}
        h = self._authorized_handler("/job-chat-map", {"msf_job_id": 7, **owner})
        h._send_json = mock.Mock()

        with mock.patch.object(msf, "get_msf_console", return_value=console):
            h.do_POST()

        console.job_exists.assert_called_once_with(7)
        console.register_job_owner.assert_called_once_with(7, owner)
        h._send_json.assert_called_once_with(200, {"ok": True})

    def test_job_registration_rejects_missing_metadata_and_non_live_jobs(self):
        cases = (
            {"msf_job_id": 7, "chat_session_id": "chat-1", "project_id": "p1"},
            {"msf_job_id": 7, "chat_session_id": "chat-1", "project_id": "p1", "user_id": "u1"},
            {"msf_job_id": True, "chat_session_id": "chat-1", "project_id": "p1", "user_id": "u1"},
        )
        for body in cases:
            with self.subTest(body=body):
                console = mock.Mock()
                console.job_exists.return_value = False
                h = self._authorized_handler("/job-chat-map", body)
                h._send_json = mock.Mock()

                with mock.patch.object(msf, "get_msf_console", return_value=console):
                    h.do_POST()

                h._send_json.assert_called_once_with(400, {"error": "Missing job ownership metadata"})
                console.register_job_owner.assert_not_called()
                if body["msf_job_id"] is True:
                    console.job_exists.assert_not_called()

    def test_job_registration_rejects_cross_project_reassignment(self):
        console = mock.Mock()
        console.job_exists.return_value = True
        console.register_job_owner.return_value = False
        h = self._authorized_handler("/job-chat-map", {
            "msf_job_id": 7,
            "chat_session_id": "chat-2",
            "project_id": "p2",
            "user_id": "u2",
        })
        h._send_json = mock.Mock()

        with mock.patch.object(msf, "get_msf_console", return_value=console):
            h.do_POST()

        h._send_json.assert_called_once_with(409, {"error": "Job ownership is already assigned"})

    def test_job_kill_rejects_jobs_not_owned_by_requested_project(self):
        console = mock.Mock()
        console.job_belongs_to_project.return_value = False
        h = self._authorized_handler("/jobs/7/kill", {"project_id": "p1"})
        h._send_json = mock.Mock()

        with mock.patch.object(msf, "get_msf_console", return_value=console):
            h.do_POST()

        console.job_belongs_to_project.assert_called_once_with(7, "p1")
        h._send_json.assert_called_once_with(404, {"error": "Job not found"})
        console.kill_job.assert_not_called()

    def test_project_owned_job_can_be_killed(self):
        console = mock.Mock()
        console.job_belongs_to_project.return_value = True
        console.kill_job.return_value = {"ok": True}
        h = self._authorized_handler("/jobs/7/kill", {"project_id": "p1"})
        h._send_json = mock.Mock()

        with mock.patch.object(msf, "get_msf_console", return_value=console):
            h.do_POST()

        console.kill_job.assert_called_once_with(7)
        h._send_json.assert_called_once_with(200, {"ok": True})


class TestJobOwnershipMap(unittest.TestCase):
    def test_job_id_cannot_be_reassigned_across_projects(self):
        console = msf.PersistentMsfConsole.__new__(msf.PersistentMsfConsole)
        console._detail_lock = threading.Lock()
        console._chat_job_map = {}
        owner = {"project_id": "p1", "user_id": "u1", "chat_session_id": "chat-1"}

        self.assertTrue(console.register_job_owner(7, owner))
        self.assertFalse(console.register_job_owner(7, {
            "project_id": "p2", "user_id": "u2", "chat_session_id": "chat-2",
        }))
        self.assertEqual(console.snapshot_job_ownership(), {7: owner})


if __name__ == "__main__":
    unittest.main()
