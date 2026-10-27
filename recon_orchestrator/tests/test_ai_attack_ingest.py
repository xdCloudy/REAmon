"""Run-bound AI attack artifacts cross the graph boundary only in the orchestrator."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import ai_attack_ingest


class TestAiAttackArtifactIngest(unittest.TestCase):
    def _artifact(self, directory, *, user_id="u1", project_id="p1", run_id="r1"):
        path = Path(directory) / "results.json"
        path.write_text(json.dumps({
            "schema_version": 1,
            "metadata": {"user_id": user_id, "project_id": project_id, "run_id": run_id},
            "targets": [{"baseurl": "https://target.invalid", "path": "/chat", "method": "POST"}],
            "findings": [{"baseurl": "https://target.invalid", "path": "/chat", "name": "finding"}],
        }), encoding="utf-8")
        return path

    def test_resolves_selected_targets_inside_the_trusted_tenant_scope(self):
        graph = MagicMock()
        graph.__enter__.return_value = graph
        graph.verify_connection.return_value = True
        session = MagicMock()
        session.run.return_value.single.return_value = SimpleNamespace(data=lambda: {
            "baseurl": "https://target.invalid", "path": "/chat", "method": "POST",
            "ai_interface_type": "llm-chat", "ai_model_family_guess": "qwen",
            "ai_model_ids": ["qwen2.5"], "ai_supports_tools": True,
            "ai_supports_streaming": False,
        })
        graph.driver.session.return_value.__enter__.return_value = session
        with patch.object(ai_attack_ingest, "Neo4jClient", return_value=graph):
            targets = ai_attack_ingest.resolve_targets(
                "u1", "p1", [{"baseurl": "https://target.invalid", "path": "/chat"}],
            )
        self.assertEqual(targets[0]["ai_model_family_guess"], "qwen")
        cypher = session.run.call_args.args[0]
        self.assertIn("user_id: $uid", cypher)
        self.assertIn("project_id: $pid", cypher)
        self.assertEqual(session.run.call_args.kwargs["uid"], "u1")
        self.assertEqual(session.run.call_args.kwargs["pid"], "p1")

    def test_rejects_cross_tenant_or_stale_artifacts_before_graph_access(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = self._artifact(directory, user_id="other-user")
            with patch.object(ai_attack_ingest, "Neo4jClient") as client:
                with self.assertRaisesRegex(ai_attack_ingest.AIArtifactValidationError, "does not match"):
                    ai_attack_ingest.ingest_result_artifact(
                        artifact, user_id="u1", project_id="p1", run_id="r1",
                    )
                client.assert_not_called()

    def test_ingests_matching_artifact_with_tenant_and_resolved_target(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = self._artifact(directory)
            graph = MagicMock()
            graph.__enter__.return_value = graph
            graph.verify_connection.return_value = True
            graph.driver.session.return_value.__enter__.return_value = object()
            fake_normalizer = SimpleNamespace(
                Finding=lambda **values: SimpleNamespace(**values),
                write_finding=MagicMock(return_value="existing"),
            )
            with patch.object(ai_attack_ingest, "Neo4jClient", return_value=graph):
                with patch.object(ai_attack_ingest, "_scanner_module", return_value=fake_normalizer):
                    count = ai_attack_ingest.ingest_result_artifact(
                        artifact, user_id="u1", project_id="p1", run_id="r1",
                    )
            self.assertEqual(count, 1)
            args = fake_normalizer.write_finding.call_args.args
            self.assertEqual(args[2:4], ("u1", "p1"))
            self.assertEqual(fake_normalizer.write_finding.call_args.kwargs["target"].baseurl,
                             "https://target.invalid")


if __name__ == "__main__":
    unittest.main()
