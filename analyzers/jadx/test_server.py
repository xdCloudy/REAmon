import http.client
import json
import os
import tempfile
import threading
import unittest
import zipfile
from http.server import ThreadingHTTPServer
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
        with zipfile.ZipFile(self.apk, "w") as archive:
            archive.writestr("classes.dex", b"dex")
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

    def test_enumerates_all_root_level_multidex_entries(self):
        with zipfile.ZipFile(self.apk, "a") as archive:
            archive.writestr("classes2.dex", b"dex2")
            archive.writestr("classes10.dex", b"dex10")
            archive.writestr("assets/classes3.dex", b"not a dex entry")

        self.assertEqual(server.dex_inputs(self.apk), [f"{self.apk}/classes.dex", f"{self.apk}/classes2.dex", f"{self.apk}/classes10.dex"])
        self.assertEqual(server.dex_inputs(self.jar), [])

    def test_decompile_stores_java_with_its_linked_smali_listing(self):
        source_text = "package com.example;\npublic class MainActivity {}\n"
        smali_text = ".class public Lcom/example/MainActivity;\n.method public onCreate()V\n    return-void\n.end method\n"

        def fake_popen(args, **kwargs):
            if "disassemble" in args:
                output = Path(args[args.index("-o") + 1])
                listing = output / "com" / "example" / "MainActivity.smali"
                listing.parent.mkdir(parents=True, exist_ok=True)
                listing.write_bytes(smali_text.encode())
            else:
                output = Path(args[args.index("-d") + 1])
                source = output / "sources" / "com" / "example" / "MainActivity.java"
                source.parent.mkdir(parents=True)
                source.write_bytes(source_text.encode())
            return FakeProcess()

        request = {"projectId": "project-1", "artifactId": "artifact-1", "taskId": "task-1",
                   "runId": "run-1", "artifactPath": str(self.apk)}
        progress = []
        with patch.object(server.subprocess, "Popen", side_effect=fake_popen):
            result = server.analyse(request, report_progress=progress.append)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["classCount"], 1)
        self.assertEqual(result["javaClassCount"], 1)
        self.assertEqual(result["disassembledClassCount"], 1)
        self.assertEqual(result["codeBytes"], len(source_text.encode()) + len(smali_text.encode()))
        self.assertEqual(result["returnedUnits"], 1)
        self.assertFalse(result["truncated"])
        unit = result["units"][0]
        self.assertEqual(unit["name"], "com.example.MainActivity")
        self.assertEqual(unit["language"], "Java")
        self.assertEqual(unit["disassemblyLanguage"], "Smali")
        self.assertTrue((self.derived / unit["codeArtifactId"]).is_file())
        self.assertTrue((self.derived / unit["disassemblyArtifactId"]).is_file())
        self.assertTrue(unit["codeArtifactId"].startswith("project-1/artifact-1/task-1/run-1/"))
        self.assertIn("Decompiling Android bytecode with JADX", progress)
        self.assertIn("Indexing Java source 1 of 1", progress)

    def test_decompile_passes_java_archive_to_jadx_without_running_baksmali(self):
        def fake_popen(args, **kwargs):
            self.assertEqual(args[-1], str(self.jar))
            self.assertNotIn("disassemble", args)
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
        self.assertIsNone(result["units"][0].get("disassemblyArtifactId"))
        self.assertTrue((self.derived / result["units"][0]["codeArtifactId"]).is_file())

    def test_large_output_returns_bounded_partial_results_with_warning(self):
        def fake_popen(args, **kwargs):
            if "disassemble" in args:
                output = Path(args[args.index("-o") + 1])
                for number in range(3):
                    listing = output / f"Class{number}.smali"
                    listing.parent.mkdir(parents=True, exist_ok=True)
                    listing.write_text(f".class LClass{number};\n")
            else:
                output = Path(args[args.index("-d") + 1])
                for number in range(3):
                    source = output / "sources" / f"Class{number}.java"
                    source.parent.mkdir(parents=True, exist_ok=True)
                    source.write_text(f"public class Class{number} {{}}\n")
            return FakeProcess()

        request = {"projectId": "project-1", "artifactId": "artifact-1", "taskId": "task-1",
                   "runId": "run-1", "artifactPath": str(self.apk)}
        with patch.object(server, "MAX_SOURCE_FILES", 2), patch.object(server, "MAX_RETURNED_UNITS", 1), patch.object(server.subprocess, "Popen", side_effect=fake_popen):
            result = server.analyse(request)

        self.assertEqual(result["status"], "completed")
        self.assertIsNone(result["classCount"])
        self.assertIsNone(result["javaClassCount"])
        self.assertTrue(result["truncated"])
        self.assertEqual(result["returnedUnits"], 1)
        self.assertIn("indexed the first 2", result["warnings"])
        self.assertIn("Only the first 1 of 2 discovered code units", result["warnings"])

    def test_return_limit_warning_counts_smali_only_classes(self):
        def fake_popen(args, **kwargs):
            if "disassemble" in args:
                output = Path(args[args.index("-o") + 1])
                for name in ("Class0", "SmaliOnly"):
                    listing = output / f"{name}.smali"
                    listing.parent.mkdir(parents=True, exist_ok=True)
                    listing.write_text(f".class L{name};\n")
            else:
                output = Path(args[args.index("-d") + 1])
                for number in range(2):
                    source = output / "sources" / f"Class{number}.java"
                    source.parent.mkdir(parents=True, exist_ok=True)
                    source.write_text(f"public class Class{number} {{}}\n")
            return FakeProcess()

        request = {"projectId": "project-1", "artifactId": "artifact-1", "taskId": "task-1",
                   "runId": "run-1", "artifactPath": str(self.apk)}
        with patch.object(server, "MAX_SOURCE_FILES", 2), patch.object(server, "MAX_RETURNED_UNITS", 1), patch.object(server.subprocess, "Popen", side_effect=fake_popen):
            result = server.analyse(request)

        self.assertEqual(result["javaClassCount"], 2)
        self.assertEqual(result["classCount"], 3)
        self.assertEqual(result["returnedUnits"], 1)
        self.assertIn("Only the first 1 of 3 discovered code units", result["warnings"])

    def test_analyze_endpoint_streams_progress_and_result_events(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()

        def fake_analyse(body, cancel_check, report_progress):
            self.assertEqual(body, {"taskId": "task-1"})
            report_progress("Indexing Java source 1 of 1")
            return {"status": "completed", "units": []}

        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(server, "analyse", side_effect=fake_analyse):
                connection.request("POST", "/analyze", body=json.dumps({"taskId": "task-1"}), headers={
                    "Content-Type": "application/json", "Accept": "application/x-ndjson",
                })
                response = connection.getresponse()
                events = [json.loads(line) for line in response.read().splitlines()]

            self.assertEqual(response.status, 200)
            self.assertIn("application/x-ndjson", response.getheader("Content-Type"))
            self.assertEqual(events, [
                {"type": "progress", "message": "Indexing Java source 1 of 1"},
                {"type": "result", "data": {"status": "completed", "units": []}},
            ])
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
