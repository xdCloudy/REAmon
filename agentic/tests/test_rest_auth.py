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
