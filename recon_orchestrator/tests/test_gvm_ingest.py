"""Run-bound GVM artifact ingest stays inside the trusted orchestrator."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from container_manager import ContainerManager
from models import GvmState, GvmStatus


class GvmIngestTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.manager = ContainerManager.__new__(ContainerManager)
        self.manager.GVM_OUTPUT_DIR = Path(self.tempdir.name)
        self.state = GvmState(
            project_id="project-1",
            user_id="tenant-1",
            run_id="run-1",
            run_started_at="2026-10-27T10:00:00+00:00",
            status=GvmStatus.COMPLETED,
        )

    def write_artifact(self, *, run_id="run-1", aborted=False, status="Done",
                       strategy="both"):
        artifact = {
            "metadata": {
                "project_id": "project-1",
                "user_id": "tenant-1",
                "run_id": run_id,
                "scan_strategy": strategy,
                "targets": {"ips": ["192.0.2.10"], "hostnames": ["example.test"]},
            },
            "aborted": aborted,
            "scans": [{"status": status}],
        }
        (self.manager.GVM_OUTPUT_DIR / "gvm_project-1.json").write_text(
            json.dumps(artifact), encoding="utf-8")

    @mock.patch("graph_db.Neo4jClient")
    def test_complete_matching_run_ingests_then_prunes(self, neo4j_cls):
        self.write_artifact()
        client = neo4j_cls.return_value.__enter__.return_value
        client.verify_connection.return_value = True
        client.update_graph_from_gvm_scan.return_value = {"errors": []}

        self.manager._ingest_gvm(self.state)

        client.update_graph_from_gvm_scan.assert_called_once()
        client.prune_unseen_findings.assert_called_once_with(
            "tenant-1", "project-1", ["gvm"], self.state.run_started_at,
            keep_hosts=[])
        self.assertTrue(self.state.ingested)
        self.assertIsNone(self.state.ingest_error)

    @mock.patch("graph_db.Neo4jClient")
    def test_partial_results_are_ingested_without_pruning(self, neo4j_cls):
        self.write_artifact(aborted=True)
        client = neo4j_cls.return_value.__enter__.return_value
        client.verify_connection.return_value = True
        client.update_graph_from_gvm_scan.return_value = {"errors": []}

        self.manager._ingest_gvm(self.state)

        client.update_graph_from_gvm_scan.assert_called_once()
        client.prune_unseen_findings.assert_not_called()
        self.assertTrue(self.state.ingested)
        self.assertIn("Partial GVM results", self.state.ingest_warning)

    @mock.patch("graph_db.Neo4jClient")
    def test_failed_target_keeps_old_findings(self, neo4j_cls):
        self.write_artifact(status="error")
        client = neo4j_cls.return_value.__enter__.return_value
        client.verify_connection.return_value = True
        client.update_graph_from_gvm_scan.return_value = {"errors": []}

        self.manager._ingest_gvm(self.state)

        client.prune_unseen_findings.assert_not_called()
        self.assertTrue(self.state.ingested)
        self.assertIsNotNone(self.state.ingest_warning)

    @mock.patch("graph_db.Neo4jClient")
    def test_scoped_scan_preserves_findings_for_unselected_targets(self, neo4j_cls):
        self.write_artifact(strategy="ips_only")
        client = neo4j_cls.return_value.__enter__.return_value
        client.verify_connection.return_value = True
        client.update_graph_from_gvm_scan.return_value = {"errors": []}

        self.manager._ingest_gvm(self.state)

        client.prune_unseen_findings.assert_called_once_with(
            "tenant-1", "project-1", ["gvm"], self.state.run_started_at,
            keep_hosts=["example.test"])

    @mock.patch("graph_db.Neo4jClient")
    def test_stale_or_cross_tenant_artifact_is_rejected(self, neo4j_cls):
        self.write_artifact(run_id="another-run")

        self.manager._ingest_gvm(self.state)

        neo4j_cls.assert_not_called()
        self.assertFalse(self.state.ingested)
        self.assertIn("does not match", self.state.ingest_error)

    @mock.patch("graph_db.Neo4jClient")
    def test_graph_unavailable_is_retryable_and_bounded(self, neo4j_cls):
        self.write_artifact()
        client = neo4j_cls.return_value.__enter__.return_value
        client.verify_connection.return_value = False

        self.manager._ingest_gvm(self.state)
        self.assertEqual(self.state.ingest_attempts, 1)
        self.assertIsNotNone(self.state.ingest_retry_at)
        self.state.ingest_retry_at = self.state.ingest_retry_at.replace(year=2020)
        self.manager._ingest_gvm(self.state)
        self.state.ingest_retry_at = self.state.ingest_retry_at.replace(year=2020)
        self.manager._ingest_gvm(self.state)
        self.state.ingest_retry_at = self.state.ingest_retry_at.replace(year=2020)
        self.manager._ingest_gvm(self.state)

        self.assertEqual(self.state.ingest_attempts, 4)
        self.assertFalse(self.state.ingested)
        self.assertEqual(neo4j_cls.call_count, 4)

    @mock.patch("graph_db.Neo4jClient")
    def test_completed_orphan_is_restored_and_ingested_after_restart(self, neo4j_cls):
        self.write_artifact()
        client = neo4j_cls.return_value.__enter__.return_value
        client.verify_connection.return_value = True
        client.update_graph_from_gvm_scan.return_value = {"errors": []}
        container = mock.Mock()
        container.status = "exited"
        container.id = "container-1"
        container.attrs = {"State": {"ExitCode": 0}}
        container.labels = {
            "reamon.gvm.project_id": "project-1",
            "reamon.gvm.user_id": "tenant-1",
            "reamon.gvm.run_id": "run-1",
            "reamon.gvm.started_at": self.state.run_started_at,
        }
        self.manager.gvm_states = {}
        self.manager.client = mock.Mock()
        self.manager.client.containers.get.return_value = container

        restored = self.manager._get_gvm_status_sync("project-1")

        self.assertEqual(restored.status, GvmStatus.COMPLETED)
        self.assertTrue(restored.ingested)
        container.remove.assert_called_once()
        client.update_graph_from_gvm_scan.assert_called_once()


if __name__ == "__main__":
    unittest.main()
