import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server

class FakeProcess:
    pid = os.getpid()
    returncode = 0
    def poll(self):
        return 0
    def wait(self, timeout=None):
        return 0

class JadxServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="reamon-jadx-tests-")
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / "artifacts"
        self.derived = self.root / "derived"
        self.artifacts.mkdir()
        self.apk = self.artifacts / "app.apk"
        self.apk.write_bytes(b"apk")
        self.jar = self.artifacts / "app.jar"
        self.jar.write_bytes(b"jar")
        server.ARTIFACT_ROOT = self.artifacts.resolve()
        server.DERIVED_ROOT = self.derived.resolve()

    def tearDown(self):
        self.temporary.cleanup()

    def test_rejects_input_outside_artifact_volume(self):
        outside = self.root / "outside.apk"
        outside.write_bytes(b"not an imported artifact")
        with self.assertRaisesRegex(server.AnalysisError, "outside"):
            server.resolve_input(str(outside))

    def test_rejects_path_traversal_in_task_ids(self):
        with self.assertRaises(server.AnalysisError):
            server.safe_id("../outside")

    def test_decompile_stores_source_and_returns_a_linked_code_unit(self):
        def fake_popen(args, **kwargs):
            output = Path(args[args.index("-d") + 1])
            source = output / "sources" / "com" / "example" / "MainActivity.java"
            source.parent.mkdir(parents=True)
            source.write_text("package com.example;\npublic class MainActivity {}\n")
            return FakeProcess()

        request = {"projectId": "project-1", "artifactId": "artifact-1", "taskId": "task-1",
                   "runId": "run-1", "artifactPath": str(self.apk)}
        with patch.object(server.subprocess, "Popen", side_effect=fake_popen):
            result = server.analyse(request)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["classCount"], 1)
        self.assertEqual(result["units"][0]["name"], "com.example.MainActivity")
        code_path = result["units"][0]["codeArtifactId"]
        self.assertTrue((self.derived / code_path).is_file())
        self.assertTrue(code_path.startswith("project-1/artifact-1/task-1/run-1/"))

    def test_decompile_passes_java_archive_to_jadx_and_stores_source(self):
        def fake_popen(args, **kwargs):
            self.assertEqual(args[-1], str(self.jar))
            output = Path(args[args.index("-d") + 1])
            source = output / "sources" / "com" / "example" / "Library.java"
            source.parent.mkdir(parents=True)
            source.write_text("package com.example;\npublic class Library {}\n")
            return FakeProcess()

        request = {"projectId": "project-1", "artifactId": "artifact-1", "taskId": "task-1",
                   "runId": "run-1", "artifactPath": str(self.jar)}
        with patch.object(server.subprocess, "Popen", side_effect=fake_popen):
            result = server.analyse(request)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["units"][0]["name"], "com.example.Library")
        self.assertTrue((self.derived / result["units"][0]["codeArtifactId"]).is_file())

    def test_large_output_returns_bounded_partial_results_with_warning(self):
        def fake_popen(args, **kwargs):
            output = Path(args[args.index("-d") + 1])
            for number in range(3):
                source = output / "sources" / f"Class{number}.java"
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text(f"public class Class{number} {{}}\n")
            return FakeProcess()

        request = {"projectId": "project-1", "artifactId": "artifact-1", "taskId": "task-1",
                   "runId": "run-1", "artifactPath": str(self.apk)}
        with patch.object(server, "MAX_SOURCE_FILES", 2), patch.object(server.subprocess, "Popen", side_effect=fake_popen):
            result = server.analyse(request)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["classCount"], 2)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["returnedUnits"], 2)
        self.assertIn("indexed the first 2", result["warnings"])

if __name__ == "__main__":
    unittest.main()
