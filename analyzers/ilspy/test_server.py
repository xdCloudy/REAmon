import json
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


class IlspyServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="reamon-ilspy-tests-")
        self.version_environment = patch.dict(os.environ, {"ILSPY_VERSION": "11.1.0.9782"})
        self.version_environment.start()
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / "artifacts"
        self.derived = self.root / "derived"
        self.artifacts.mkdir()
        self.assembly = self.artifacts / "Example.dll"
        self.assembly.write_bytes(b"managed test assembly")
        server.ARTIFACT_ROOT = self.artifacts.resolve()
        server.DERIVED_ROOT = self.derived.resolve()

    def tearDown(self):
        self.temporary.cleanup()
        self.version_environment.stop()

    def request(self):
        return {
            "projectId": "project-1", "artifactId": "artifact-1", "taskId": "task-1",
            "runId": "run-1", "artifactPath": str(self.assembly),
        }

    def emit_sources(self, args, **_kwargs):
        output = Path(args[args.index("-o") + 1])
        (output / "Example" / "App").mkdir(parents=True)
        (output / "Example" / "App" / "Service.cs").write_text("namespace Example.App;\npublic class Service {}\n")
        (output / "Example" / "Model").mkdir(parents=True)
        (output / "Example" / "Model" / "Item.cs").write_text("namespace Example.Model { public record Item; }\n")
        return FakeProcess()

    def test_rejects_input_outside_artifact_volume(self):
        outside = self.root / "outside.dll"
        outside.write_bytes(b"not an imported artifact")
        with self.assertRaisesRegex(server.AnalysisError, "outside"):
            server.resolve_input(str(outside))

    def test_rejects_path_traversal_in_task_ids(self):
        with self.assertRaises(server.AnalysisError):
            server.safe_id("../outside")

    def test_decompiles_managed_assembly_and_stores_bounded_csharp_units(self):
        request = self.request()
        progress = []
        with patch.object(server.subprocess, "Popen", side_effect=self.emit_sources):
            result = server.analyse(request, report_progress=progress.append)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["toolVersion"], "11.1.0.9782")
        self.assertEqual(result["classCount"], 2)
        self.assertEqual(result["returnedUnits"], 2)
        self.assertFalse(result["truncated"])
        self.assertEqual({unit["language"] for unit in result["units"]}, {"C#"})
        self.assertIn("Example.App.Service", [unit["name"] for unit in result["units"]])
        self.assertTrue(all((self.derived / unit["codeArtifactId"]).is_file() for unit in result["units"]))
        self.assertTrue(any("Decompiling managed assembly" in message for message in progress))

    def test_limits_returned_units_and_reports_the_partial_result(self):
        with patch.object(server, "MAX_RETURNED_UNITS", 1), patch.object(server.subprocess, "Popen", side_effect=self.emit_sources):
            result = server.analyse(self.request())

        self.assertEqual(result["classCount"], 2)
        self.assertEqual(result["returnedUnits"], 1)
        self.assertTrue(result["truncated"])
        self.assertIn("Only the first 1 of 2 discovered C# source files", result["warnings"])

    def test_marks_discovery_count_unknown_if_source_scan_hits_its_bound(self):
        with patch.object(server, "MAX_SOURCE_FILES", 1), patch.object(server.subprocess, "Popen", side_effect=self.emit_sources):
            result = server.analyse(self.request())

        self.assertIsNone(result["classCount"])
        self.assertTrue(result["truncated"])
        self.assertIn("source scan stopped at its configured limit", result["warnings"])

    def test_health_endpoint_reports_pinned_ilspy_version(self):
        from http.server import ThreadingHTTPServer
        from threading import Thread
        import http.client

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=2)
            connection.request("GET", "/health")
            response = connection.getresponse()
            payload = json.loads(response.read())
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, {"status": "ready", "provider": "ilspy", "version": "11.1.0.9782"})
            connection.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

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
