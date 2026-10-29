"""Run-scoped auth and tenant-bound graph ingest for SubdomainDiscovery."""
import asyncio
import os
import types
import unittest
from unittest import mock

from auth import mint_partial_graph_token, verify_partial_graph_token


async def _asgi_request(app, path, method, headers, body=b""):
    """Issue a small HTTP request directly through ASGI without httpx/TestClient."""
    sent = []
    receive_count = 0

    async def receive():
        nonlocal receive_count
        receive_count += 1
        if receive_count == 1:
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    encoded_headers = [(key.lower().encode(), value.encode()) for key, value in headers.items()]
    encoded_headers.append((b"host", b"reamon-test"))
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1", "method": method, "scheme": "http",
        "path": path, "raw_path": path.encode(), "query_string": b"",
        "headers": encoded_headers, "client": ("127.0.0.1", 32100),
        "server": ("reamon-test", 80),
    }
    await app(scope, receive, send)
    start = next(message for message in sent if message["type"] == "http.response.start")
    response_body = b"".join(
        message.get("body", b"") for message in sent
        if message["type"] == "http.response.body"
    )
    return start["status"], response_body


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
        self.assertEqual(env["PARTIAL_GRAPH_FINALIZE_URL"],
                         "http://127.0.0.1:8010/internal/partial-recon/subdomain-finalize")
        self.assertNotIn("/repo/graph_db", spawn["volumes"])

    def test_other_partial_workers_keep_their_existing_graph_access(self):
        spawn = self._spawn("Naabu")
        self.assertIn("NEO4J_PASSWORD", spawn["environment"])
        self.assertIn("/repo/graph_db", spawn["volumes"])


class TestIngestAuthMiddleware(unittest.TestCase):
    def test_trusted_graph_client_uses_service_uri_not_worker_localhost_uri(self):
        import api
        with mock.patch.dict(api.os.environ, {
            "NEO4J_URI": "bolt://localhost:7687",
            "ORCHESTRATOR_NEO4J_URI": "bolt://neo4j:7687",
        }), mock.patch("graph_db.Neo4jClient") as graph_client:
            api._trusted_graph_client()
        graph_client.assert_called_once_with(uri="bolt://neo4j:7687")

    def test_graph_input_route_uses_the_trusted_service_uri(self):
        import api
        graph = mock.MagicMock()
        graph.__enter__.return_value = graph
        graph.verify_connection.return_value = True
        graph.get_graph_inputs_for_tool.return_value = {"domain": "example.com", "domains": ["example.com"]}
        with mock.patch.object(api, "container_manager", object()), \
             mock.patch.dict(api.os.environ, {"ORCHESTRATOR_NEO4J_URI": "bolt://neo4j:7687"}), \
             mock.patch("graph_db.Neo4jClient", return_value=graph) as graph_client:
            result = asyncio.run(api.get_graph_inputs("p1", "Nmap", "u1"))
        graph_client.assert_called_once_with(uri="bolt://neo4j:7687")
        self.assertEqual(result["domains"], ["example.com"])

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

    def test_signed_finalization_runs_through_http_middleware_and_route(self):
        import api
        from datetime import datetime, timezone
        from auth import PARTIAL_GRAPH_FINALIZE_PATH

        token = mint_partial_graph_token("p1", "u1", "r1", ["example.com"], "key")
        request_body = b'{"cleanup_orphans":true}'
        active_run = types.SimpleNamespace(
            tool_id="SubdomainDiscovery", status=api.PartialReconStatus.RUNNING,
            roots=["example.com"], started_at=datetime(2026, 10, 29, tzinfo=timezone.utc),
        )
        sweep = mock.Mock(return_value={"skipped": "not armed"})
        source_module = types.ModuleType("helpers.finding_sources")
        source_module.RECON_FINDING_SOURCES = ("nuclei",)
        sweep_module = types.ModuleType("helpers.node_filter_sweep")
        sweep_module.run_node_filter_sweep = sweep
        manager = types.SimpleNamespace(partial_recon_states={"p1": {"r1": active_run}})
        cleanup = mock.Mock(return_value=1)

        async def issue():
            return await _asgi_request(
                api.app, PARTIAL_GRAPH_FINALIZE_PATH, "POST",
                {"X-Partial-Graph-Token": token, "Content-Type": "application/json",
                 "Content-Length": str(len(request_body))},
                request_body,
            )

        with mock.patch.object(api, "container_manager", manager), \
             mock.patch.object(api, "_cleanup_isolated_subdomain_orphans", cleanup), \
             mock.patch.dict(api.os.environ, {"INTERNAL_API_KEY": "key"}), \
             mock.patch.dict("sys.modules", {
                 "helpers.finding_sources": source_module,
                 "helpers.node_filter_sweep": sweep_module,
             }):
            status, response = asyncio.run(issue())
            self.assertEqual(status, 200)
            receipt = __import__("json").loads(response)
            self.assertEqual(receipt["status"], "finalized")
            self.assertEqual(receipt["orphan_user_inputs_deleted"], 1)
            cleanup.assert_called_once_with(verify_partial_graph_token(token, "key"))
            sweep.assert_called_once()

            active_run.status = api.PartialReconStatus.COMPLETED
            status, response = asyncio.run(issue())
        self.assertEqual(status, 409)
        self.assertIn(b"no longer accepting", response)
        cleanup.assert_called_once()

    def test_signed_token_is_accepted_for_the_fixed_finalize_route(self):
        import api
        from auth import PARTIAL_GRAPH_FINALIZE_PATH
        token = mint_partial_graph_token("p1", "u1", "r1", ["example.com"], "key")
        req = types.SimpleNamespace(
            url=types.SimpleNamespace(path=PARTIAL_GRAPH_FINALIZE_PATH),
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

    def test_finalization_uses_trusted_run_scope_and_start_time(self):
        import api
        from datetime import datetime, timezone
        from fastapi import HTTPException

        started_at = datetime(2026, 10, 29, tzinfo=timezone.utc)
        request = types.SimpleNamespace(
            state=types.SimpleNamespace(partial_graph_scope={
                "projectId": "p1", "userId": "u1", "runId": "r1", "roots": ["example.com"],
            }),
            json=lambda: asyncio.sleep(0, result={"cleanup_orphans": False}),
        )
        active_run = types.SimpleNamespace(
            tool_id="SubdomainDiscovery", status=api.PartialReconStatus.RUNNING,
            roots=["example.com"], started_at=started_at,
        )
        sweep = mock.Mock(return_value={"skipped": "not armed"})
        source_module = types.ModuleType("helpers.finding_sources")
        source_module.RECON_FINDING_SOURCES = ("nuclei",)
        sweep_module = types.ModuleType("helpers.node_filter_sweep")
        sweep_module.run_node_filter_sweep = sweep
        modules = {
            "helpers.finding_sources": source_module,
            "helpers.node_filter_sweep": sweep_module,
        }
        manager = types.SimpleNamespace(partial_recon_states={"p1": {"r1": active_run}})
        with mock.patch.object(api, "container_manager", manager), \
             mock.patch.dict("sys.modules", modules):
            receipt = asyncio.run(api.finalize_partial_subdomain_run(request))
        self.assertEqual(receipt["status"], "finalized")
        self.assertEqual(receipt["run_id"], "r1")
        self.assertEqual(sweep.call_args.args[:3], (
            "u1", "p1", started_at.isoformat(),
        ))
        self.assertIs(sweep.call_args.kwargs["client_factory"], api._trusted_graph_client)

        active_run.status = api.PartialReconStatus.COMPLETED
        with mock.patch.object(api, "container_manager", manager):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(api.finalize_partial_subdomain_run(request))
        self.assertEqual(raised.exception.status_code, 409)
        sweep.assert_called_once()

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


class TestScopedPartialOrphanCleanup(unittest.TestCase):
    def test_cleanup_only_targets_user_inputs_for_signed_roots_and_run(self):
        import api
        import uuid

        scope = {
            "projectId": "p1", "userId": "u1", "runId": "r1",
            "roots": ["example.com", "api.example.com"],
        }
        expected_ids = [
            uuid.uuid5(uuid.NAMESPACE_URL, f"reamon:partial-subdomain:r1:{root}").hex
            for root in scope["roots"]
        ]
        graph = mock.MagicMock()
        graph.__enter__.return_value = graph
        graph.verify_connection.return_value = True
        session = graph.driver.session.return_value.__enter__.return_value
        session.run.return_value.single.return_value = {"deleted": 1}
        with mock.patch("graph_db.Neo4jClient", return_value=graph):
            deleted = api._cleanup_isolated_subdomain_orphans(scope)
        query, params = session.run.call_args.args[0], session.run.call_args.kwargs
        self.assertIn("WHERE NOT (ui)-->()", query)
        self.assertEqual(params["ids"], expected_ids)
        self.assertEqual(params["user_id"], "u1")
        self.assertEqual(params["project_id"], "p1")
        self.assertEqual(deleted, 1)


if __name__ == "__main__":
    unittest.main()
