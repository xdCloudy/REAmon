"""
Unit tests for the Phase 0 HTTP traffic-capture helper (recon side).

Verifies the pure-Python transaction mapping + gating without docker/network:

  1. Gate: capture_httpx_transactions is a no-op unless CAPTURE_PROXY_ENABLED.
  2. Mapping: an httpx by_url entry -> an ingest transaction dict with the right
     scheme/host/port/path/query, response metadata, and passive signals.
  3. Duration + int parsing edge cases.
  4. No tenant fields are minted client-side (recon never sends user_id/project_id;
     the webapp stamps them from the project owner).

Run:
    python3 -m unittest recon.tests.test_traffic_capture
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
RECON_DIR = PROJECT_ROOT / "recon"

# Load the helper module directly by path so we don't trigger recon/helpers/
# __init__.py (which eagerly imports heavy optional deps like dns). The helper
# itself only needs stdlib + a lazily-imported requests.
_spec = importlib.util.spec_from_file_location(
    "traffic_capture", RECON_DIR / "helpers" / "traffic_capture.py"
)
tc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tc)


SAMPLE_ENTRY = {
    "url": "https://app.example.com:8443/api/v1/users?limit=10",
    "host": "app.example.com",
    "status_code": 200,
    "content_length": 1234,
    "content_type": "application/json",
    "response_time_ms": "0.523456s",
    "ip": "203.0.113.7",
    "headers": {
        "Server": "nginx",
        "Set-Cookie": "sid=abc; Path=/",
        "Content-Type": "application/json",
    },
    "body": '{"users": []}',
    "body_hash": {"body_sha256": "deadbeef", "header_sha256": "cafef00d"},
    "tls": {"version": "TLS 1.3"},
}


class TestTransactionMapping(unittest.TestCase):
    def test_url_is_split_correctly(self):
        txn = tc._build_transaction(SAMPLE_ENTRY["url"], SAMPLE_ENTRY, "informational")
        self.assertIsNotNone(txn)
        self.assertEqual(txn["scheme"], "https")
        self.assertEqual(txn["host"], "app.example.com")
        self.assertEqual(txn["port"], 8443)
        self.assertEqual(txn["path"], "/api/v1/users")
        self.assertEqual(txn["query"], "?limit=10")
        self.assertTrue(txn["isTls"])
        self.assertEqual(txn["tlsVersion"], "TLS 1.3")

    def test_response_metadata(self):
        txn = tc._build_transaction(SAMPLE_ENTRY["url"], SAMPLE_ENTRY, "informational")
        self.assertEqual(txn["statusCode"], 200)
        self.assertEqual(txn["respBodySize"], 1234)
        self.assertEqual(txn["respContentType"], "application/json")
        self.assertEqual(txn["respBodySha"], "deadbeef")
        self.assertEqual(txn["targetIp"], "203.0.113.7")
        self.assertEqual(txn["method"], "GET")
        self.assertEqual(txn["tool"], "httpx")
        # 0.523456s -> ~523 ms
        self.assertEqual(txn["responseTimeMs"], 523)

    def test_passive_signals(self):
        txn = tc._build_transaction(SAMPLE_ENTRY["url"], SAMPLE_ENTRY, "informational")
        self.assertTrue(txn["hasSetCookie"])
        # cookie lacks HttpOnly/Secure/SameSite
        self.assertEqual(txn["cookieFlagIssues"][0]["missing"], ["HttpOnly", "Secure", "SameSite"])
        # nginx response missing CSP/HSTS/etc.
        self.assertIn("content-security-policy", txn["securityHeadersMissing"])

    def test_no_tenant_fields_minted_client_side(self):
        txn = tc._build_transaction(SAMPLE_ENTRY["url"], SAMPLE_ENTRY, "informational")
        # Recon must never send tenant identity; webapp stamps it from the owner.
        self.assertNotIn("userId", txn)
        self.assertNotIn("projectId", txn)

    def test_default_ports(self):
        http_entry = {"url": "http://x.example.com/", "headers": {}}
        txn = tc._build_transaction(http_entry["url"], http_entry, "informational")
        self.assertEqual(txn["port"], 80)
        self.assertEqual(txn["scheme"], "http")
        self.assertFalse(txn["isTls"])

    def test_missing_host_is_skipped(self):
        txn = tc._build_transaction("not-a-url", {"headers": {}}, "informational")
        self.assertIsNone(txn)


class TestHeaderNormalizationRegression(unittest.TestCase):
    """Regression for the production httpx header serialization (underscore keys
    and occasional CRLF string) that made passive signals silently wrong."""

    def test_underscore_form_headers_are_normalized(self):
        # httpx serializes header NAMES with underscores in production.
        entry = {
            "url": "https://t.example.com/",
            "headers": {
                "set_cookie": "sid=abc; Path=/",       # no HttpOnly/Secure/SameSite
                "content_security_policy": "default-src 'self'",
                "x_frame_options": "DENY",
                "strict_transport_security": "max-age=31536000",
                "x_content_type_options": "nosniff",
                "referrer_policy": "no-referrer",
                "permissions_policy": "geolocation=()",
            },
        }
        txn = tc._build_transaction(entry["url"], entry, "informational")
        # Set-Cookie must be detected despite underscore key.
        self.assertTrue(txn["hasSetCookie"])
        # All 6 security headers present (dash-normalized) -> none missing.
        self.assertEqual(txn["securityHeadersMissing"], [])
        # Cookie flag issues correctly detected on the real cookie.
        self.assertEqual(txn["cookieFlagIssues"][0]["missing"], ["HttpOnly", "Secure", "SameSite"])
        # Stored headers are the normalized dash-lowercase dict (usable/queryable).
        self.assertIn("set-cookie", txn["respHeaders"])
        self.assertIn("x-frame-options", txn["respHeaders"])

    def test_crlf_string_headers_are_parsed(self):
        # httpx sometimes emits headers as one CRLF-joined string.
        entry = {
            "url": "https://t.example.com/",
            "headers": "Server: nginx\r\nSet-Cookie: sid=1; Secure; HttpOnly; SameSite=Lax\r\nContent-Type: text/html",
        }
        txn = tc._build_transaction(entry["url"], entry, "informational")
        # respHeaders must NOT be empty (previously coerced to {} and lost).
        self.assertIn("server", txn["respHeaders"])
        self.assertEqual(txn["respHeaders"]["set-cookie"], "sid=1; Secure; HttpOnly; SameSite=Lax")
        self.assertTrue(txn["hasSetCookie"])
        # This cookie has all flags -> no issues.
        self.assertEqual(txn["cookieFlagIssues"], [])

    def test_multiple_set_cookie_all_audited(self):
        entry = {
            "url": "https://t.example.com/",
            "headers": "Set-Cookie: a=1\r\nSet-Cookie: b=2; HttpOnly",
        }
        txn = tc._build_transaction(entry["url"], entry, "informational")
        # Both cookies collapse to a list and both are audited.
        self.assertTrue(txn["hasSetCookie"])
        names = {i["cookie"] for i in txn["cookieFlagIssues"]}
        self.assertEqual(names, {"a", "b"})

    def test_no_headers_all_security_missing(self):
        entry = {"url": "https://t.example.com/", "headers": {}}
        txn = tc._build_transaction(entry["url"], entry, "informational")
        self.assertFalse(txn["hasSetCookie"])
        self.assertEqual(len(txn["securityHeadersMissing"]), 6)


class TestRunIdFallback(unittest.TestCase):
    def _post_and_capture_runid(self, env):
        fake_resp = mock.Mock(status_code=201)
        fake_resp.json.return_value = {"stored": 1}
        # clear=True gives a clean env so only the run-id vars we set are present;
        # unset ones return None (falsy) and exercise the fallback chain.
        base_env = {
            "PROJECT_ID": "p", "WEBAPP_API_URL": "http://w:3000",
            "SCANNER_API_KEY": "k", "SCANNER_SCOPE_TOKEN": "signed-scope",
        }
        base_env.update(env)
        with mock.patch.dict("os.environ", base_env, clear=True), \
             mock.patch("requests.post", return_value=fake_resp) as post:
            tc.capture_httpx_transactions(
                {"by_url": {SAMPLE_ENTRY["url"]: SAMPLE_ENTRY}},
                {"CAPTURE_PROXY_ENABLED": True},
            )
            _, kwargs = post.call_args
            return kwargs["json"]["runId"]

    def test_partial_recon_run_id_fallback(self):
        self.assertEqual(self._post_and_capture_runid({"PARTIAL_RECON_RUN_ID": "partial-1"}), "partial-1")

    def test_ai_attack_run_id_fallback(self):
        self.assertEqual(self._post_and_capture_runid({"AI_ATTACK_RUN_ID": "ai-1"}), "ai-1")

    def test_full_recon_run_id_preferred(self):
        rid = self._post_and_capture_runid({"RECON_RUN_ID": "full-1", "PARTIAL_RECON_RUN_ID": "partial-1"})
        self.assertEqual(rid, "full-1")


class TestDurationParsing(unittest.TestCase):
    def test_seconds_string(self):
        self.assertEqual(tc._parse_duration_ms("1.5s"), 1500)

    def test_ms_string(self):
        self.assertEqual(tc._parse_duration_ms("250ms"), 250)

    def test_float_seconds(self):
        self.assertEqual(tc._parse_duration_ms(0.25), 250)

    def test_none(self):
        self.assertIsNone(tc._parse_duration_ms(None))


class TestGate(unittest.TestCase):
    def test_disabled_is_noop(self):
        with mock.patch.object(tc, "requests", create=True) as req:
            tc.capture_httpx_transactions({"by_url": {SAMPLE_ENTRY["url"]: SAMPLE_ENTRY}},
                                          {"CAPTURE_PROXY_ENABLED": False})
            req.post.assert_not_called()

    def test_enabled_posts(self):
        env = {
            "PROJECT_ID": "proj1",
            "WEBAPP_API_URL": "http://webapp:3000",
            "RECON_RUN_ID": "run-abc",
            "SCANNER_API_KEY": "k",
            "SCANNER_SCOPE_TOKEN": "signed-scope",
        }
        fake_resp = mock.Mock(status_code=201)
        fake_resp.json.return_value = {"stored": 1}
        with mock.patch.dict("os.environ", env, clear=False), \
             mock.patch("requests.post", return_value=fake_resp) as post:
            tc.capture_httpx_transactions({"by_url": {SAMPLE_ENTRY["url"]: SAMPLE_ENTRY}},
                                          {"CAPTURE_PROXY_ENABLED": True})
            self.assertEqual(post.call_count, 1)
            _, kwargs = post.call_args
            payload = kwargs["json"]
            self.assertEqual(payload["source"], "recon")
            self.assertEqual(payload["runId"], "run-abc")
            self.assertEqual(len(payload["transactions"]), 1)
            self.assertEqual(kwargs["headers"]["X-Internal-Key"], "k")
            self.assertEqual(kwargs["headers"]["X-Scanner-Scope"], "signed-scope")


if __name__ == "__main__":
    unittest.main()
