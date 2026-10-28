"""Worker sends graph writes through its fixed-purpose ingest capability."""
import io
import json
import unittest
from unittest import mock

from recon.partial_recon_modules.subdomain_discovery import _ingest_graph_result


class _Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return b'{"status":"ingested","stats":{"subdomains_total":1}}'


class TestPartialSubdomainIngest(unittest.TestCase):
    def test_sends_scoped_json_and_token(self):
        with mock.patch("urllib.request.urlopen", return_value=_Response()) as open_url:
            result = _ingest_graph_result(
                "http://127.0.0.1:8010/internal/partial-recon/subdomain-ingest",
                "scoped-token", "example.com",
                {"domain": "example.com", "subdomains": ["www.example.com"]}, [],
            )
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_header("X-partial-graph-token"), "scoped-token")
        self.assertEqual(json.loads(request.data)["root"], "example.com")
        self.assertEqual(result["status"], "ingested")

    def test_mismatched_configuration_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "both be configured"):
            _ingest_graph_result("url", "", "example.com", {}, [])


if __name__ == "__main__":
    unittest.main()
