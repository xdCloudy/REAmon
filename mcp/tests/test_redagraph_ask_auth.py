"""`redagraph ask` uses ticket-derived graph context, never a reusable key.

Run:
    python -m unittest mcp.tests.test_redagraph_ask_auth -v
"""

from __future__ import annotations

import os
import sys
import types
import unittest
from unittest import mock

_mcp_servers_dir = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "servers")
sys.path.insert(0, _mcp_servers_dir)

import redagraph  # noqa: E402


class _Resp:
    status_code = 200

    def json(self):
        return {"cypher": "MATCH (i:IP) RETURN i.address"}

    @property
    def text(self):
        return ""


def _args(question="list ips"):
    return types.SimpleNamespace(question=question, show=False, format="plain")


class RedagraphAskAuthTests(unittest.TestCase):
    def _post_headers(self, env):
        captured = {}

        def fake_post(url, **kw):
            captured["url"] = url
            captured["headers"] = kw.get("headers")
            captured["json"] = kw.get("json")
            return _Resp()

        with mock.patch.dict(os.environ, env, clear=False):
            if "SCANNER_API_KEY" not in env:
                os.environ.pop("SCANNER_API_KEY", None)
            with mock.patch.object(redagraph, "_execute", return_value=[]):
                with mock.patch("requests.post", side_effect=fake_post):
                    redagraph.cmd_ask(_args(), "u1", "p1")
        return captured

    def test_ask_sends_signed_context_to_scoped_query_route(self):
        captured = self._post_headers({"REDAMON_CTX": "signed-terminal-context"})
        self.assertIn("/graph/terminal-query", captured["url"])
        self.assertEqual(captured["json"], {
            "ctx": "signed-terminal-context", "question": "list ips"
        })
        self.assertFalse(captured["headers"])

    def test_ask_without_context_fails_closed(self):
        with mock.patch("requests.post") as post:
            with mock.patch.dict(os.environ, {}, clear=True):
                result = redagraph.cmd_ask(_args(), "u1", "p1")
        self.assertEqual(result, 2)
        post.assert_not_called()

    def test_ask_never_sends_master_or_scanner_keys(self):
        captured = self._post_headers({
            "REDAMON_CTX": "signed-terminal-context",
            "SCANNER_API_KEY": "scan-tok", "INTERNAL_API_KEY": "master-secret",
        })
        self.assertNotIn("master-secret", str(captured))
        self.assertNotIn("scan-tok", str(captured))


if __name__ == "__main__":
    unittest.main()
