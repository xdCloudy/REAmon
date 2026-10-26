"""Fail-closed authentication for workspace and session REST controls."""
import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from starlette.requests import Request

from llm_guard import require_configured_master_internal_auth


def _request(key: str = "") -> Request:
    headers = [(b"x-internal-key", key.encode())] if key else []
    return Request({"type": "http", "headers": headers, "client": ("127.0.0.1", 1)})


class ConfiguredMasterAuthTests(unittest.TestCase):
    def test_missing_or_placeholder_master_key_fails_closed(self):
        for env in ({}, {"INTERNAL_API_KEY": "changeme"}):
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True):
                with self.assertRaises(HTTPException) as raised:
                    asyncio.run(require_configured_master_internal_auth(_request()))
                self.assertEqual(raised.exception.status_code, 503)

    def test_only_configured_master_key_is_accepted(self):
        env = {"INTERNAL_API_KEY": "master-secret", "SCANNER_API_KEY": "scanner-secret"}
        with patch.dict(os.environ, env, clear=True):
            asyncio.run(require_configured_master_internal_auth(_request("master-secret")))
            for rejected in ("", "wrong-secret", "scanner-secret"):
                with self.subTest(rejected=rejected), self.assertRaises(HTTPException) as raised:
                    asyncio.run(require_configured_master_internal_auth(_request(rejected)))
                self.assertEqual(raised.exception.status_code, 401)

    def test_equal_master_and_scanner_keys_fail_closed(self):
        env = {"INTERNAL_API_KEY": "same-secret", "SCANNER_API_KEY": "same-secret"}
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(require_configured_master_internal_auth(_request("same-secret")))
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, "Internal and scanner API keys must be distinct")

    def test_workspace_and_session_controls_all_require_strict_auth(self):
        import api

        required_paths = {
            "/workspace/list", "/workspace/tree", "/workspace/download",
            "/workspace/rename", "/workspace", "/workspace/reset",
            "/workspace/jobs", "/workspace/jobs/{job_id}/cancel",
            "/workspace/upload", "/workspace/mkdir", "/workspace/bulk-archive",
            "/workspace/archive-download", "/workspace/preview", "/workspace/properties",
            "/sessions", "/sessions/{session_id}/interact", "/sessions/{session_id}/kill",
            "/jobs/{job_id}/kill", "/session-chat-map", "/non-msf-sessions",
            "/agent-session/stop", "/emergency-stop-all",
            "/kali/exec", "/kali/exec/{job_id}", "/kali/exec/{job_id}/cancel",
            "/mcp/test", "/mcp/reload",
        }
        routes = {route.path: route for route in api.app.routes if hasattr(route, "dependant")}
        missing = {
            path for path in required_paths
            if path not in routes
            or require_configured_master_internal_auth not in {
                dep.call for dep in routes[path].dependant.dependencies
            }
        }
        self.assertEqual(missing, set())

    def test_command_and_mcp_controls_reject_unconfigured_and_scanner_keys(self):
        import httpx
        import api

        requests = (
            ("POST", "/kali/exec", {}),
            ("GET", "/kali/exec/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?project_id=test", None),
            ("POST", "/kali/exec/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/cancel?project_id=test", None),
            ("POST", "/mcp/test", {}),
            ("POST", "/mcp/reload", {}),
        )

        async def send(method, path, body, key=""):
            headers = {"x-internal-key": key} if key else {}
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=api.app), base_url="http://agent.test"
            ) as client:
                return await client.request(method, path, json=body, headers=headers)

        for method, path, body in requests:
            with self.subTest(path=path), patch.dict(os.environ, {}, clear=True):
                response = asyncio.run(send(method, path, body))
                self.assertEqual(response.status_code, 503)

            env = {"INTERNAL_API_KEY": "master-secret", "SCANNER_API_KEY": "scanner-secret"}
            with self.subTest(path=path, credential="scanner"), patch.dict(os.environ, env, clear=True):
                response = asyncio.run(send(method, path, body, "scanner-secret"))
                self.assertEqual(response.status_code, 401)

            with self.subTest(path=path, credential="master"), patch.dict(os.environ, env, clear=True):
                response = asyncio.run(send(method, path, body, "master-secret"))
                self.assertNotEqual(
                    response.json().get("detail"),
                    "Internal API authentication is not configured",
                )

    def test_graph_exec_rejects_scanner_identity_and_accepts_master_service(self):
        import httpx
        import api

        async def post(key):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=api.app), base_url="http://agent.test"
            ) as client:
                return await client.post(
                    "/graph/exec",
                    headers={"x-internal-key": key},
                    json={"op": "invalid", "user_id": "u1", "project_id": "p1"},
                )

        env = {"INTERNAL_API_KEY": "master-secret", "SCANNER_API_KEY": "scanner-secret"}
        with patch.dict(os.environ, env, clear=True):
            scanner_response = asyncio.run(post("scanner-secret"))
            master_response = asyncio.run(post("master-secret"))
        self.assertEqual(scanner_response.status_code, 401)
        # Unknown op is returned by the handler, proving the trusted service key
        # passed auth without invoking Neo4j.
        self.assertEqual(master_response.status_code, 400)
        self.assertIn("unknown op", master_response.json()["error"])

    def test_workspace_route_rejects_direct_unauthenticated_and_scanner_requests(self):
        import httpx
        import api

        async def get_workspace(key=""):
            headers = {"x-internal-key": key} if key else {}
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=api.app), base_url="http://agent.test"
            ) as client:
                return await client.get("/workspace/list", params={"projectId": "test"}, headers=headers)

        env = {"INTERNAL_API_KEY": "master-secret", "SCANNER_API_KEY": "scanner-secret"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(asyncio.run(get_workspace()).status_code, 401)
            self.assertEqual(asyncio.run(get_workspace("scanner-secret")).status_code, 401)

        with patch.dict(os.environ, {}, clear=True):
            response = asyncio.run(get_workspace())
        self.assertEqual(response.status_code, 503)

    def test_workspace_upload_streams_raw_body_without_content_length(self):
        import tempfile
        import httpx
        import api

        async def upload(key, name, blocks):
            async def body():
                for block in blocks:
                    yield block

            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=api.app), base_url="http://agent.test"
            ) as client:
                return await client.post(
                    "/workspace/upload",
                    params={
                        "projectId": "test", "path": "uploads",
                        "overwrite": "false", "filename": name,
                    },
                    headers={"x-internal-key": key},
                    content=body(),
                )

        env = {"INTERNAL_API_KEY": "master-secret"}
        with tempfile.TemporaryDirectory() as workspace, patch.dict(os.environ, env, clear=True), \
                patch.object(api.workspace_fs, "WORKSPACE_ROOT", Path(workspace)):
            destination = Path(workspace) / "test" / "uploads"
            destination.mkdir(parents=True)
            response = asyncio.run(upload("master-secret", "large.bin", [b"first", b"-", b"second"]))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["size"], 12)
            self.assertEqual((destination / "large.bin").read_bytes(), b"first-second")

            collision = asyncio.run(upload("master-secret", "large.bin", [b"replacement"]))
            self.assertEqual(collision.status_code, 409)
            self.assertEqual((destination / "large.bin").read_bytes(), b"first-second")

    def test_configured_master_key_keeps_session_proxy_available(self):
        import httpx
        import api

        class UpstreamResponse:
            status_code = 200

            @staticmethod
            def json():
                return {"sessions": []}

        class UpstreamClient:
            headers_seen = None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def get(self, _url, headers=None):
                type(self).headers_seen = headers
                return UpstreamResponse()

        async def get_sessions():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=api.app), base_url="http://agent.test"
            ) as client:
                with patch.object(api.httpx, "AsyncClient", return_value=UpstreamClient()):
                    return await client.get(
                        "/sessions", headers={"x-internal-key": "master-secret"}
                    )

        with patch.dict(os.environ, {
            "INTERNAL_API_KEY": "master-secret",
            "MCP_AUTH_TOKEN": "progress-secret",
        }, clear=True):
            response = asyncio.run(get_sessions())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"sessions": []})
        self.assertEqual(
            UpstreamClient.headers_seen,
            {"Authorization": "Bearer progress-secret"},
        )


if __name__ == "__main__":
    unittest.main()
