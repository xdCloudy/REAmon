"""The orchestrator owns GitHub Hunt graph writes after scanner isolation."""

import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from container_manager import ContainerManager
from models import GithubHuntState, GithubHuntStatus


class _Session:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def run(self, *_args, **_kwargs):
        return types.SimpleNamespace(single=lambda: None)


class _GraphClient:
    calls = []
    uri = None

    def __init__(self, uri):
        type(self).uri = uri

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def verify_connection(self):
        return True

    @property
    def driver(self):
        return types.SimpleNamespace(session=lambda: _Session())

    def update_graph_from_github_hunt(self, data, user_id, project_id):
        type(self).calls.append((data, user_id, project_id))
        return {"written": len(data["findings"])}


class TestGithubHuntIngest(unittest.TestCase):
    def setUp(self):
        _GraphClient.calls = []
        _GraphClient.uri = None
        self.manager = ContainerManager.__new__(ContainerManager)
        self.tempdir = tempfile.TemporaryDirectory()
        self.manager.GITHUB_HUNT_OUTPUT_DIR = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def _state(self, user_id="owner-1"):
        return GithubHuntState(
            project_id="project-1",
            status=GithubHuntStatus.COMPLETED,
            user_id=user_id,
        )

    def _graph_module(self):
        module = types.ModuleType("graph_db")
        module.Neo4jClient = _GraphClient
        return module

    def test_ingests_saved_scanner_artifact_from_trusted_service(self):
        artifact = {
            "scan_end_time": "2026-10-27T10:00:00",
            "findings": [{"type": "secret", "repository": "fixture"}],
        }
        output = self.manager.GITHUB_HUNT_OUTPUT_DIR / "github_hunt_project-1.json"
        output.write_text(json.dumps(artifact), encoding="utf-8")
        state = self._state()

        with mock.patch.dict(sys.modules, {"graph_db": self._graph_module()}), mock.patch.dict(
            os.environ, {"ORCHESTRATOR_NEO4J_URI": "bolt://neo4j:7687"}
        ):
            self.manager._ingest_github_hunt(state)

        self.assertTrue(state.ingested)
        self.assertEqual(_GraphClient.uri, "bolt://neo4j:7687")
        self.assertEqual(_GraphClient.calls, [(artifact, "owner-1", "project-1")])

    def test_missing_tenant_refuses_graph_write(self):
        output = self.manager.GITHUB_HUNT_OUTPUT_DIR / "github_hunt_project-1.json"
        output.write_text(json.dumps({"findings": [{"type": "secret"}]}), encoding="utf-8")
        state = self._state(user_id="")

        with mock.patch.dict(sys.modules, {"graph_db": self._graph_module()}):
            self.manager._ingest_github_hunt(state)

        self.assertFalse(state.ingested)
        self.assertEqual(_GraphClient.calls, [])

    def test_missing_artifact_does_not_mark_ingest_complete(self):
        state = self._state()

        self.manager._ingest_github_hunt(state)

        self.assertFalse(state.ingested)
        self.assertEqual(state.ingest_attempts, 1)
        self.assertEqual(_GraphClient.calls, [])


if __name__ == "__main__":
    unittest.main()
