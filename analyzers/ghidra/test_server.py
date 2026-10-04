import base64
import http.client
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
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
        assembly_relative = "assembly/000000_ram_00401000.asm"
        assembly = "ram:00401000: PUSH RBP\nram:00401001: MOV RBP, RSP\n"

        def fake_run(arguments, log_file, cancel_check, home):
            export_root = Path(arguments[arguments.index("ReamonExport.java") + 1])
            function_file = export_root / relative
            function_file.parent.mkdir(parents=True)
            function_file.write_text(source)
            assembly_file = export_root / assembly_relative
            assembly_file.parent.mkdir(parents=True)
            assembly_file.write_text(assembly)
            encoded_name = base64.b64encode(b"main").decode("ascii")
            (export_root / "manifest.tsv").write_text(
                f"{encoded_name}\tram:00401000\t32\t{relative}\t{assembly_relative}\n"
            )
            encoded_source = base64.b64encode(b"main").decode("ascii")
            encoded_target = base64.b64encode(b"helper").decode("ascii")
            (export_root / "calls.tsv").write_text(
                f"ram:00401000\tram:00402000\t{encoded_source}\t{encoded_target}\n"
            )
            (export_root / "summary.txt").write_text(
                "visited=1\ndecompiled=1\nfailed=0\ntruncated=false\ncallCount=1\ncallsTruncated=false\n"
            )
            return 0

        request = {
            "projectId": "project-1",
            "artifactId": "artifact-1",
            "taskId": "task-1",
            "runId": "run-1",
            "artifactPath": str(self.binary),
        }
        progress = []
        with patch.object(server, "run_ghidra", side_effect=fake_run):
            result = server.analyse(request, report_progress=progress.append)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["functionCount"], 1)
        self.assertEqual(result["visitedFunctionCount"], 1)
        self.assertEqual(result["failedFunctionCount"], 0)
        self.assertEqual(result["codeBytes"], len(source.encode()))
        self.assertEqual(result["units"][0]["name"], "main")
        self.assertEqual(result["units"][0]["address"], "ram:00401000")
        self.assertEqual(result["callCount"], 1)
        self.assertFalse(result["callGraphTruncated"])
        self.assertEqual(result["calls"], [{
            "fromAddress": "ram:00401000", "toAddress": "ram:00402000",
            "fromName": "main", "toName": "helper",
        }])
        stored = self.derived / result["units"][0]["codeArtifactId"]
        self.assertEqual(stored.read_text(), source)
        self.assertTrue(result["units"][0]["codeArtifactId"].startswith("project-1/artifact-1/task-1/run-1/"))
        self.assertEqual(result["units"][0]["disassemblyBytes"], len(assembly.encode()))
        stored_assembly = self.derived / result["units"][0]["disassemblyArtifactId"]
        self.assertEqual(stored_assembly.read_text(), assembly)
        self.assertTrue(result["units"][0]["disassemblyArtifactId"].startswith("project-1/artifact-1/task-1/run-1/"))
        self.assertIn("Analyzing the binary with Ghidra", progress)
        self.assertIn("Saving function 1 of 1", progress)

    def test_analyze_endpoint_streams_progress_and_result_events(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()

        def fake_analyse(body, cancel_check, report_progress):
            self.assertEqual(body, {"taskId": "task-1"})
            report_progress("Saving function 1 of 1")
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
                {"type": "progress", "message": "Saving function 1 of 1"},
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
