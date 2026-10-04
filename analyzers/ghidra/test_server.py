import base64
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class GhidraServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="reamon-ghidra-tests-")
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / "artifacts"
        self.derived = self.root / "derived"
        self.artifacts.mkdir()
        self.binary = self.artifacts / "program.elf"
        self.binary.write_bytes(b"ELF")
        server.ARTIFACT_ROOT = self.artifacts.resolve()
        server.DERIVED_ROOT = self.derived.resolve()

    def tearDown(self):
        self.temporary.cleanup()

    def test_rejects_input_outside_artifact_volume(self):
        outside = self.root / "outside.elf"
        outside.write_bytes(b"not an imported artifact")
        with self.assertRaisesRegex(server.AnalysisError, "outside"):
            server.resolve_input(str(outside))

    def test_rejects_path_traversal_in_task_ids(self):
        with self.assertRaises(server.AnalysisError):
            server.safe_id("../outside")

    def test_copies_script_exports_into_a_bounded_result(self):
        source = "int main(void) { return 0; }\n"
        relative = "functions/000000_ram_00401000.c"

        def fake_run(arguments, log_file, cancel_check, home):
            export_root = Path(arguments[arguments.index("ReamonExport.java") + 1])
            function_file = export_root / relative
            function_file.parent.mkdir(parents=True)
            function_file.write_text(source)
            encoded_name = base64.b64encode(b"main").decode("ascii")
            (export_root / "manifest.tsv").write_text(
                f"{encoded_name}\tram:00401000\t32\t{relative}\n"
            )
            (export_root / "summary.txt").write_text(
                "visited=1\ndecompiled=1\nfailed=0\ntruncated=false\n"
            )
            return 0

        request = {
            "projectId": "project-1",
            "artifactId": "artifact-1",
            "taskId": "task-1",
            "runId": "run-1",
            "artifactPath": str(self.binary),
        }
        with patch.object(server, "run_ghidra", side_effect=fake_run):
            result = server.analyse(request)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["functionCount"], 1)
        self.assertEqual(result["visitedFunctionCount"], 1)
        self.assertEqual(result["failedFunctionCount"], 0)
        self.assertEqual(result["codeBytes"], len(source.encode()))
        self.assertEqual(result["units"][0]["name"], "main")
        self.assertEqual(result["units"][0]["address"], "ram:00401000")
        stored = self.derived / result["units"][0]["codeArtifactId"]
        self.assertEqual(stored.read_text(), source)
        self.assertTrue(result["units"][0]["codeArtifactId"].startswith("project-1/artifact-1/task-1/run-1/"))


if __name__ == "__main__":
    unittest.main()
