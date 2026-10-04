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

    def test_detects_extensionless_uploaded_apk_blob(self):
        uploaded_blob = self.artifacts / "opaque-artifact-id"
        with zipfile.ZipFile(uploaded_blob, "w") as archive:
            archive.writestr("classes.dex", b"dex")
        self.assertEqual(server.dex_inputs(uploaded_blob), [f"{uploaded_blob}/classes.dex"])

    def test_class_references_are_limited_to_known_classes_and_exclude_self(self):
        text = "invoke-virtual {v0}, Lcom/example/Worker;->run()V\nnew-instance v1, Lcom/example/Other;\nconst-class v2, Lcom/example/Main;"
        references = server.class_references(text, Path("com/example/Main.smali"), {
            "com/example/Main", "com/example/Worker", "com/example/Other",
        })
        self.assertEqual(references, ["com.example.Other", "com.example.Worker"])

    def test_decompile_stores_java_with_its_linked_smali_listing(self):
        source_text = "package com.example;\npublic class MainActivity {}\n"
        worker_source_text = "package com.example;\npublic class Worker {}\n"
        smali_text = ".class public Lcom/example/MainActivity;\n.method public onCreate()V\n    invoke-virtual {v0}, Lcom/example/Worker;->run()V\n    return-void\n.end method\n"

        def fake_popen(args, **kwargs):
            if "disassemble" in args:
                output = Path(args[args.index("-o") + 1])
                listing = output / "com" / "example" / "MainActivity.smali"
                listing.parent.mkdir(parents=True, exist_ok=True)
                listing.write_bytes(smali_text.encode())
                worker = output / "com" / "example" / "Worker.smali"
                worker.write_bytes(b".class public Lcom/example/Worker;\n")
            else:
                output = Path(args[args.index("-d") + 1])
                source = output / "sources" / "com" / "example" / "MainActivity.java"
                source.parent.mkdir(parents=True)
                source.write_bytes(source_text.encode())
                worker_source = output / "sources" / "com" / "example" / "Worker.java"
                worker_source.write_bytes(worker_source_text.encode())
            return FakeProcess()

        request = {"projectId": "project-1", "artifactId": "artifact-1", "taskId": "task-1",
                   "runId": "run-1", "artifactPath": str(self.apk)}
        progress = []
        with patch.object(server.subprocess, "Popen", side_effect=fake_popen):
            result = server.analyse(request, report_progress=progress.append)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["classCount"], 2)
        self.assertEqual(result["javaClassCount"], 2)
        self.assertEqual(result["disassembledClassCount"], 2)
        self.assertEqual(result["codeBytes"], len(source_text.encode()) + len(worker_source_text.encode()) + len(smali_text.encode()) + len(b".class public Lcom/example/Worker;\n"))
        self.assertEqual(result["returnedUnits"], 2)
        self.assertFalse(result["truncated"])
        unit = result["units"][0]
        self.assertEqual(unit["name"], "com.example.MainActivity")
        self.assertEqual(unit["language"], "Java")
        self.assertEqual(unit["disassemblyLanguage"], "Smali")
        self.assertEqual(unit["classReferences"], ["com.example.Worker"])
        self.assertTrue((self.derived / unit["codeArtifactId"]).is_file())
        self.assertTrue((self.derived / unit["disassemblyArtifactId"]).is_file())
        self.assertTrue(unit["codeArtifactId"].startswith("project-1/artifact-1/task-1/run-1/"))
        self.assertIn("Decompiling Android bytecode with JADX", progress)
        self.assertIn("Indexing Java source 1 of 2", progress)

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

class ResultChunkStreamTests(unittest.TestCase):
    def test_large_result_arrays_are_split_into_bounded_events(self):
        units = [{"id": index} for index in range(server.STREAM_RESULT_CHUNK_SIZE * 2 + 1)]
        events = list(server.stream_result_events({"status": "completed", "units": units, "warnings": ""}))

        self.assertEqual(events[0], {"type": "result_start", "data": {"status": "completed", "warnings": ""}, "arrayFields": ["units"]})
        chunks = [event["items"] for event in events if event["type"] == "result_chunk"]
        self.assertEqual([len(chunk) for chunk in chunks], [100, 100, 1])
        self.assertEqual([unit for chunk in chunks for unit in chunk], units)
        self.assertEqual(events[-1], {"type": "result_end"})

    def test_result_chunks_are_bounded_by_bytes_even_below_the_item_limit(self):
        units = [{"id": index, "detail": "x" * (24 * 1024)} for index in range(80)]
        events = list(server.stream_result_events({"status": "completed", "units": units, "warnings": ""}))

        self.assertEqual(events[0]["type"], "result_start")
        self.assertTrue(all(len(json.dumps(event, separators=(",", ":")).encode("utf-8")) <= server.STREAM_RESULT_CHUNK_BYTES for event in events))
        chunks = [event["items"] for event in events if event["type"] == "result_chunk"]
        self.assertEqual([unit for chunk in chunks for unit in chunk], units)


if __name__ == "__main__":
    unittest.main()
