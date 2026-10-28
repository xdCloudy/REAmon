"""Run-scoped auth and tenant-bound graph ingest for SubdomainDiscovery."""
import asyncio
import os
import types
import unittest
from unittest import mock

from auth import mint_partial_graph_token, verify_partial_graph_token


class TestPartialGraphToken(unittest.TestCase):
    def setUp(self):
        self.token = mint_partial_graph_token(
            "p1", "u1", "run-1", ["Example.COM", "api.example.com"],
            "internal-test-key", now=1000,
        )

    def test_token_is_scoped_and_normalizes_roots(self):
        scope = verify_partial_graph_token(self.token, "internal-test-key", now=1001)
        self.assertEqual(scope["projectId"], "p1")
        self.assertEqual(scope["userId"], "u1")
        self.assertEqual(scope["runId"], "run-1")
        self.assertEqual(scope["roots"], ["api.example.com", "example.com"])

    def test_wrong_key_and_expired_tokens_fail_closed(self):
        self.assertIsNone(verify_partial_graph_token(self.token, "wrong", now=1001))
        self.assertIsNone(verify_partial_graph_token(self.token, "internal-test-key", now=1000 + 7 * 86400))

    def test_bad_scope_is_rejected_when_minting(self):
        with self.assertRaises(ValueError):
            mint_partial_graph_token("p1", "u1", "run", ["example.com", ""], "key")


class TestSubdomainIngestSpawn(unittest.TestCase):
    def _spawn(self, tool_id):
        import container_manager as cm
        captured = {}
        client = mock.MagicMock()
        client.images.get.return_value = object()
        client.containers.run.side_effect = lambda image, **kwargs: (
            captured.update(kwargs) or types.SimpleNamespace(id="container-id")
        )
        async def run():
            with mock.patch.object(cm.docker, "from_env", return_value=client):
                manager = cm.ContainerManager()
            manager.graph_db_host_path = "/repo/graph_db"
            manager.get_status = mock.AsyncMock(return_value=types.SimpleNamespace(status=cm.ReconStatus.IDLE))
            manager._admit_scan = mock.AsyncMock(return_value=None)
            state = await manager.start_partial_recon(
                "p1", tool_id, {"tool_id": tool_id, "user_id": "u1", "domains": ["example.com"]},
                "/repo/recon",
            )
            self.assertNotEqual(state.status, cm.PartialReconStatus.ERROR, state.error)
        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": "test-internal-key", "SCANNER_API_KEY": "scanner"}):
            asyncio.run(run())
        return captured

    def test_subdomain_worker_has_no_direct_graph_credentials_or_mount(self):
        spawn = self._spawn("SubdomainDiscovery")
        env = spawn["environment"]
        self.assertNotIn("NEO4J_PASSWORD", env)
        self.assertNotIn("NEO4J_USER", env)
        self.assertNotIn("NEO4J_URI", env)
        self.assertTrue(env["PARTIAL_GRAPH_INGEST_TOKEN"])
        self.assertEqual(env["PARTIAL_GRAPH_INGEST_URL"],
                         "http://127.0.0.1:8010/internal/partial-recon/subdomain-ingest")
        self.assertNotIn("/repo/graph_db", spawn["volumes"])

    def test_other_partial_workers_keep_their_existing_graph_access(self):
        spawn = self._spawn("Naabu")
        self.assertIn("NEO4J_PASSWORD", spawn["environment"])
        self.assertIn("/repo/graph_db", spawn["volumes"])


class TestIngestAuthMiddleware(unittest.TestCase):
    def test_signed_token_is_accepted_only_for_the_fixed_ingest_route(self):
        import api
        token = mint_partial_graph_token("p1", "u1", "r1", ["example.com"], "key")
        req = types.SimpleNamespace(
            url=types.SimpleNamespace(path="/internal/partial-recon/subdomain-ingest"),
            method="POST",
            headers={"X-Partial-Graph-Token": token},
            state=types.SimpleNamespace(),
        )
        called = []
        async def next_handler(request):
            called.append(request.state.partial_graph_scope["runId"])
            return "ok"
        with mock.patch.object(api.os, "environ", {**os.environ, "INTERNAL_API_KEY": "key"}):
            result = asyncio.run(api.require_orchestrator_key(req, next_handler))
        self.assertEqual(result, "ok")
        self.assertEqual(called, ["r1"])

    def test_invalid_token_never_reaches_the_route(self):
        import api
        req = types.SimpleNamespace(
            url=types.SimpleNamespace(path="/internal/partial-recon/subdomain-ingest"),
            method="POST", headers={"X-Partial-Graph-Token": "bad"}, state=types.SimpleNamespace(),
        )
        reached = []
        with mock.patch.object(api.os, "environ", {**os.environ, "INTERNAL_API_KEY": "key"}):
            response = asyncio.run(api.require_orchestrator_key(req, lambda _: reached.append(True)))
        self.assertEqual(response.status_code, 401)
        self.assertEqual(reached, [])

    def test_graph_write_uses_only_signed_tenant_identity(self):
        import api
        from fastapi import HTTPException
        from models import PartialSubdomainIngestRequest

        request = types.SimpleNamespace(state=types.SimpleNamespace(partial_graph_scope={
            "projectId": "p1", "userId": "u1", "runId": "r1", "roots": ["example.com"],
        }))
        body = PartialSubdomainIngestRequest(
            root="example.com",
            recon_data={"domain": "example.com", "subdomains": ["www.example.com"]},
        )
        graph = mock.MagicMock()
        graph.__enter__.return_value = graph
        graph.verify_connection.return_value = True
        graph.update_graph_from_partial_discovery.return_value = {"errors": [], "subdomains_total": 1}
        active_run = types.SimpleNamespace(
            tool_id="SubdomainDiscovery", status=api.PartialReconStatus.RUNNING,
            roots=["example.com"],
        )
        with mock.patch.object(api, "container_manager", types.SimpleNamespace(
            partial_recon_states={"p1": {"r1": active_run}},
        )):
            with mock.patch("graph_db.Neo4jClient", return_value=graph):
                receipt = asyncio.run(api.ingest_partial_subdomain_results(body, request))
        self.assertEqual(receipt["run_id"], "r1")
        graph.update_graph_from_partial_discovery.assert_called_once_with(
            recon_data=body.recon_data, user_id="u1", project_id="p1", user_input_id=None,
        )

        outside = PartialSubdomainIngestRequest(
            root="other.example", recon_data={"domain": "other.example", "subdomains": []},
        )
        with mock.patch.object(api, "container_manager", types.SimpleNamespace(
            partial_recon_states={"p1": {"r1": active_run}},
        )):
            with mock.patch("graph_db.Neo4jClient") as graph_client:
                with self.assertRaises(HTTPException) as raised:
                    asyncio.run(api.ingest_partial_subdomain_results(outside, request))
        self.assertEqual(raised.exception.status_code, 403)
        graph_client.assert_not_called()

    def test_partial_graph_errors_are_reported_without_retryable_http_failure(self):
        import api
        from models import PartialSubdomainIngestRequest

        request = types.SimpleNamespace(state=types.SimpleNamespace(partial_graph_scope={
            "projectId": "p1", "userId": "u1", "runId": "r1", "roots": ["example.com"],
        }))
        body = PartialSubdomainIngestRequest(
            root="example.com",
            recon_data={"domain": "example.com", "subdomains": ["www.example.com"]},
            user_subdomains=["www.example.com"],
        )
        graph = mock.MagicMock()
        graph.__enter__.return_value = graph
        graph.verify_connection.return_value = True
        graph.update_graph_from_partial_discovery.return_value = {
            "errors": ["one DNS record could not be written"], "subdomains_total": 1,
        }
        active_run = types.SimpleNamespace(
            tool_id="SubdomainDiscovery", status=api.PartialReconStatus.RUNNING,
            roots=["example.com"],
        )
        with mock.patch.object(api, "container_manager", types.SimpleNamespace(
            partial_recon_states={"p1": {"r1": active_run}},
        )):
            with mock.patch("graph_db.Neo4jClient", return_value=graph):
                receipt = asyncio.run(api.ingest_partial_subdomain_results(body, request))
        self.assertEqual(receipt["status"], "partial")
        self.assertEqual(receipt["stats"]["errors"], ["one DNS record could not be written"])
        self.assertEqual(graph.update_user_input_status_scoped.call_args.args[1], "partial")

    def test_completed_run_token_is_rejected_before_graph_access(self):
        import api
        from fastapi import HTTPException
        from models import PartialSubdomainIngestRequest

        request = types.SimpleNamespace(state=types.SimpleNamespace(partial_graph_scope={
            "projectId": "p1", "userId": "u1", "runId": "r1", "roots": ["example.com"],
        }))
        body = PartialSubdomainIngestRequest(
            root="example.com", recon_data={"domain": "example.com", "subdomains": []},
        )
        inactive_run = types.SimpleNamespace(
            tool_id="SubdomainDiscovery", status=api.PartialReconStatus.COMPLETED,
            roots=["example.com"],
        )
        with mock.patch.object(api, "container_manager", types.SimpleNamespace(
            partial_recon_states={"p1": {"r1": inactive_run}},
        )):
            with mock.patch("graph_db.Neo4jClient") as graph_client:
                with self.assertRaises(HTTPException) as raised:
                    asyncio.run(api.ingest_partial_subdomain_results(body, request))
        self.assertEqual(raised.exception.status_code, 409)
        graph_client.assert_not_called()


class TestTenantScopedUserInputStatus(unittest.TestCase):
    def test_status_update_matches_all_three_tenant_identity_fields(self):
        from graph_db.mixins.recon.user_input_mixin import UserInputMixin

        session = mock.MagicMock()
        driver = mock.MagicMock()
        driver.session.return_value.__enter__.return_value = session
        writer = UserInputMixin()
        writer.driver = driver
        writer.update_user_input_status_scoped("ui1", "completed", "u1", "p1", {"count": 1})
        query = session.run.call_args.args[0]
        self.assertIn("id: $id, user_id: $user_id, project_id: $project_id", query)
        self.assertEqual(session.run.call_args.kwargs["user_id"], "u1")
        self.assertEqual(session.run.call_args.kwargs["project_id"], "p1")


if __name__ == "__main__":
    unittest.main()
