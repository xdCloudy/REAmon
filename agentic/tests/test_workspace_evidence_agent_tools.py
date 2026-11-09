"""Regression coverage for the agent's authenticated evidence REST bridge."""
import os
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch

_AGENTIC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _AGENTIC_DIR)

import tools as tools_mod  # noqa: E402


class _Response:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {"evidence": [], "nextCursor": None}

    def json(self):
        return self._payload


class _Client:
    def __init__(self, response):
        self.response = response
        self.post = AsyncMock(return_value=response)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


class WorkspaceEvidenceAgentToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.executor = tools_mod.PhaseAwareToolExecutor.__new__(tools_mod.PhaseAwareToolExecutor)
        self.executor._build_redamon_ctx = Mock(return_value="signed-context")
        self.env = patch.dict(os.environ, {"INTERNAL_API_KEY": "test-internal-key", "WEBAPP_API_URL": "http://webapp:3000/"})
        self.env.start()

    def tearDown(self):
        self.env.stop()

    async def test_list_call_uses_signed_context_and_only_pagination_arguments(self):
        response = _Response(payload={"evidence": [{"id": "e1"}], "nextCursor": "cursor"})
        client = _Client(response)
        with patch("tools.httpx.AsyncClient", return_value=client):
            result = await self.executor._dispatch_workspace_evidence_tool(
                "workspace_list_evidence", {"artifactId": "artifact-1", "limit": 5},
            )

        self.assertTrue(result["success"])
        self.assertEqual(result["output"]["nextCursor"], "cursor")
        client.post.assert_awaited_once_with(
            "http://webapp:3000/api/internal/reamon/workspace/evidence",
            json={"tool": "workspace_list_evidence", "artifactId": "artifact-1", "limit": 5},
            headers={"x-internal-key": "test-internal-key", "x-redamon-ctx": "signed-context"},
        )
        self.executor._build_redamon_ctx.assert_called_once_with("workspace_list_evidence")

    async def test_missing_context_and_unsupported_arguments_fail_closed(self):
        self.executor._build_redamon_ctx.return_value = ""
        missing = await self.executor._dispatch_workspace_evidence_tool("workspace_list_evidence", {})
        self.assertFalse(missing["success"])
        with patch("tools.httpx.AsyncClient") as client:
            invalid = await self.executor._dispatch_workspace_evidence_tool(
                "workspace_get_evidence", {"projectId": "attacker-selected-project", "evidenceId": "e1"},
            )
        self.assertFalse(invalid["success"])
        client.assert_not_called()

    async def test_service_failure_does_not_turn_into_empty_evidence(self):
        client = _Client(_Response(status_code=503, payload={"error": "service unavailable"}))
        self.executor._build_redamon_ctx.return_value = "signed-context"
        with patch("tools.httpx.AsyncClient", return_value=client):
            result = await self.executor._dispatch_workspace_evidence_tool("workspace_list_evidence", {})
        self.assertFalse(result["success"])
        self.assertEqual(result["output"], None)
        self.assertIn("service unavailable", result["error"])

    async def test_code_unit_dispatch_is_signed_bounded_and_returns_persisted_rows(self):
        response = _Response(payload={"codeUnits": [{"id": "unit-1"}], "hasMore": False})
        client = _Client(response)
        with patch("tools.httpx.AsyncClient", return_value=client):
            result = await self.executor._dispatch_workspace_code_unit_tool(
                "workspace_list_code_units", {"search": "main", "limit": 4},
            )
        self.assertTrue(result["success"])
        self.assertEqual(result["output"]["codeUnits"][0]["id"], "unit-1")
        client.post.assert_awaited_once_with(
            "http://webapp:3000/api/internal/reamon/workspace/code-units",
            json={"tool": "workspace_list_code_units", "search": "main", "limit": 4},
            headers={"x-internal-key": "test-internal-key", "x-redamon-ctx": "signed-context"},
        )

    async def test_code_unit_dispatch_rejects_project_override_and_missing_signed_context(self):
        self.executor._build_redamon_ctx.return_value = ""
        missing = await self.executor._dispatch_workspace_code_unit_tool("workspace_get_code_unit", {"codeUnitId": "unit-1"})
        self.assertFalse(missing["success"])
        with patch("tools.httpx.AsyncClient") as client:
            invalid = await self.executor._dispatch_workspace_code_unit_tool(
                "workspace_get_code_unit", {"projectId": "attacker-project", "codeUnitId": "unit-1"},
            )
        self.assertFalse(invalid["success"])
        client.assert_not_called()

    async def test_code_unit_continuation_preserves_source_snapshot_hash(self):
        client = _Client(_Response(payload={"sourceSnapshotHash": "a" * 64, "decompiledSource": {"truncated": False}}))
        with patch("tools.httpx.AsyncClient", return_value=client):
            result = await self.executor._dispatch_workspace_code_unit_tool(
                "workspace_get_code_unit",
                {"codeUnitId": "unit-1", "sourceOffsetBytes": 128, "sourceSnapshotHash": "a" * 64},
            )
        self.assertTrue(result["success"])
        client.post.assert_awaited_once_with(
            "http://webapp:3000/api/internal/reamon/workspace/code-units",
            json={"tool": "workspace_get_code_unit", "codeUnitId": "unit-1", "sourceOffsetBytes": 128, "sourceSnapshotHash": "a" * 64},
            headers={"x-internal-key": "test-internal-key", "x-redamon-ctx": "signed-context"},
        )


if __name__ == "__main__":
    unittest.main()
