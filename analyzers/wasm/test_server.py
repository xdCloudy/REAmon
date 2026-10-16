import json
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import server


class Tests(unittest.TestCase):
    def test_scanner_skips_nested_comments_and_strings(self):
        wat = '(module (; (func $fake) ;) (data (i32.const 0) "x ) (func)") (func $real))'
        self.assertEqual(server.funcs(wat), ['(func $real)'])

    def test_scanner_returns_only_top_level_functions(self):
        wat = '(module (func $first (result i32) (i32.const 1)) (func (param i32)))'
        self.assertEqual(server.funcs(wat), [
            '(func $first (result i32) (i32.const 1))',
            '(func (param i32))',
        ])

    def test_small_result_uses_single_result_event(self):
        result = {"status": "completed", "units": [{"name": "$main"}], "warnings": ""}
        self.assertEqual(list(server.stream_result_events(result)), [{"type": "result", "data": result}])

    def test_large_result_is_chunked_with_reconstructable_metadata(self):
        units = [{"name": f"function_{index}", "address": str(index)} for index in range(250)]
        result = {"status": "completed", "functionCount": len(units), "units": units, "warnings": ""}
        events = list(server.stream_result_events(result))

        self.assertEqual(events[0], {
            "type": "result_start",
            "data": {"status": "completed", "functionCount": len(units), "warnings": ""},
            "arrayFields": ["units"],
        })
        chunks = [event["items"] for event in events if event["type"] == "result_chunk"]
        self.assertEqual([unit for chunk in chunks for unit in chunk], units)
        self.assertTrue(all(len(server._event_bytes(event)) <= server.MAX_RESULT_CHUNK_BYTES for event in events))
        self.assertEqual(events[-1], {"type": "result_end"})

    def test_result_item_larger_than_stream_limit_is_rejected(self):
        result = {"units": [{"name": "x" * server.MAX_RESULT_CHUNK_BYTES}]}
        with self.assertRaises(server.AnalysisError):
            list(server.stream_result_events(result))

    def test_http_endpoint_streams_progress_and_result_events(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)

        def fake_go(_body, report_progress, cancel_check):
            self.assertFalse(cancel_check())
            report_progress("Converting the module to WebAssembly Text with WABT")
            return {"status": "completed", "units": [{"name": "$main"}], "warnings": ""}

        thread.start()
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{httpd.server_port}/analyze",
                data=b'{"projectId":"project-1"}',
                headers={"Content-Type": "application/json", "Accept": "application/x-ndjson"},
                method="POST",
            )
            with patch.object(server, "go", side_effect=fake_go):
                with urllib.request.urlopen(request, timeout=3) as response:
                    self.assertIn("application/x-ndjson", response.headers["Content-Type"])
                    events = [json.loads(line) for line in response]
            self.assertEqual(events[0]["type"], "progress")
            self.assertEqual(events[1]["type"], "result")
            self.assertEqual(events[1]["data"]["units"], [{"name": "$main"}])
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
