"""Supply-chain graph writes stay in the trusted orchestrator."""

import json
import os
import sys
import tempfile
import types
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest import mock

from container_manager import ContainerManager
from models import SupplyChainState, SupplyChainStatus


class _GraphClient:
    calls = []

    def __init__(self, uri):
        type(self).calls.append(("connect", uri))

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def verify_connection(self):
        return True

    def ensure_github_repository(self, user_id, project_id, repository):
        type(self).calls.append(("repository", user_id, project_id, repository))
        return "repo-id"

    def ensure_sbom_document(self, user_id, project_id, filename):
        type(self).calls.append(("sbom", user_id, project_id, filename))
        return "sbom-id"

    def update_graph_from_supply_chain(self, artifact, user_id, project_id, **anchor):
        type(self).calls.append(("write", artifact, user_id, project_id, anchor))
        return {"written": len(artifact.get("packages", []))}


class TestSupplyChainIngest(unittest.TestCase):
    def setUp(self):
        _GraphClient.calls = []
        self.tempdir = tempfile.TemporaryDirectory()
        self.manager = ContainerManager.__new__(ContainerManager)
        self.manager.SUPPLY_CHAIN_OUTPUT_DIR = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def _state(self, **overrides):
        values = {
            "project_id": "project-1",
            "user_id": "owner-1",
            "run_id": "run-1",
            "status": SupplyChainStatus.COMPLETED,
        }
        values.update(overrides)
        return SupplyChainState(**values)

    def _save(self, **overrides):
        data = {
            "project_id": "project-1",
            "user_id": "owner-1",
            "run_id": "run-1",
            "input_file": "package-lock.json",
            "repository": None,
            "artifact": {"packages": [{"name": "fixture", "version": "1.0"}]},
        }
        data.update(overrides)
        path = self.manager.SUPPLY_CHAIN_OUTPUT_DIR / "supply_chain_project-1.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        return data

    def _graph_module(self):
        module = types.ModuleType("graph_db")
        module.Neo4jClient = _GraphClient
        return module

    def _ingest(self, state):
        with mock.patch.dict(sys.modules, {"graph_db": self._graph_module()}), mock.patch.dict(
            os.environ, {"ORCHESTRATOR_NEO4J_URI": "bolt://neo4j:7687"}
        ):
            self.manager._ingest_supply_chain(state)

    def test_repository_artifact_is_anchored_and_ingested(self):
        artifact = self._save(repository="acme/widget", input_file="acme/widget")
        state = self._state()

        self._ingest(state)

        self.assertTrue(state.ingested)
        self.assertIsNone(state.ingest_error)
        self.assertIn(("repository", "owner-1", "project-1", "acme/widget"), _GraphClient.calls)
        self.assertIn(("write", artifact["artifact"], "owner-1", "project-1", {
            "anchor_label": "GithubRepository", "anchor_key": "id", "anchor_value": "repo-id",
        }), _GraphClient.calls)

    def test_uploaded_sbom_is_anchored_and_ingested(self):
        artifact = self._save()
        state = self._state()

        self._ingest(state)

        self.assertTrue(state.ingested)
        self.assertIn(("sbom", "owner-1", "project-1", "package-lock.json"), _GraphClient.calls)
        self.assertIn(("write", artifact["artifact"], "owner-1", "project-1", {
            "anchor_label": "SbomDocument", "anchor_key": "id", "anchor_value": "sbom-id",
        }), _GraphClient.calls)

    def test_stale_or_cross_tenant_artifact_is_never_written(self):
        for field, value in (("run_id", "old-run"), ("user_id", "other-owner"),
                             ("project_id", "other-project")):
            with self.subTest(field=field):
                _GraphClient.calls = []
                self._save(**{field: value})
                state = self._state()

                self._ingest(state)

                self.assertFalse(state.ingested)
                self.assertIn("does not match", state.ingest_error)
                self.assertEqual(_GraphClient.calls, [])

    def test_missing_tenant_refuses_ingest(self):
        self._save()
        state = self._state(user_id="")

        self._ingest(state)

        self.assertFalse(state.ingested)
        self.assertEqual(_GraphClient.calls, [])

    def test_missing_artifact_is_reported_without_graph_access(self):
        state = self._state()

        self._ingest(state)

        self.assertFalse(state.ingested)
        self.assertIn("unavailable", state.ingest_error)
        self.assertEqual(_GraphClient.calls, [])

    def test_successful_exit_ingests_before_removing_container(self):
        self._save()
        state = self._state(container_id="container-1", status=SupplyChainStatus.RUNNING)
        removed = []
        container = SimpleNamespace(
            status="exited",
            attrs={"State": {"ExitCode": 0}},
            remove=lambda: removed.append(True),
        )
        self.manager.supply_chain_states = {"project-1": state}
        self.manager.client = SimpleNamespace(
            containers=SimpleNamespace(get=lambda _container_id: container))

        with mock.patch.dict(sys.modules, {"graph_db": self._graph_module()}), mock.patch.dict(
            os.environ, {"ORCHESTRATOR_NEO4J_URI": "bolt://neo4j:7687"}
        ):
            actual = self.manager._get_supply_chain_status_sync("project-1")

        self.assertEqual(actual.status, SupplyChainStatus.COMPLETED)
        self.assertTrue(actual.ingested)
        self.assertEqual(removed, [True])

    def test_failed_worker_exit_does_not_ingest_saved_artifact(self):
        self._save()
        state = self._state(container_id="container-1", status=SupplyChainStatus.RUNNING)
        container = SimpleNamespace(
            status="exited", attrs={"State": {"ExitCode": 2}}, remove=lambda: None)
        self.manager.supply_chain_states = {"project-1": state}
        self.manager.client = SimpleNamespace(
            containers=SimpleNamespace(get=lambda _container_id: container))

        actual = self.manager._get_supply_chain_status_sync("project-1")

        self.assertEqual(actual.status, SupplyChainStatus.ERROR)
        self.assertEqual(_GraphClient.calls, [])

    def test_scanner_has_no_graph_client_or_credential_access(self):
        scanner = Path(__file__).resolve().parents[2] / "scanners" / "supply_chain_scan" / "main.py"
        source = scanner.read_text(encoding="utf-8")
        self.assertNotIn("Neo4jClient", source)
        self.assertNotIn("NEO4J_PASSWORD", source)


if __name__ == "__main__":
    unittest.main()
