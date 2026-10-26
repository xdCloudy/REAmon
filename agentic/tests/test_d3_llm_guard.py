"""
D3 — agent billed-LLM endpoint auth + rate limit + spend cap.

Run (from agentic/, or via the throwaway agent image with agentic mounted):
    python -m unittest tests.test_d3_llm_guard -v

Covers: constant-time key auth (INTERNAL_API_KEY / SCANNER_API_KEY / fail-open
/ changeme-excluded), token-bucket rate limiting, daily spend cap, and the
FastAPI dependency end-to-end incl. the exploit-repro (an unauthenticated call
is rejected 401 BEFORE the billed handler runs).
"""

import os
import unittest
from unittest import mock

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import llm_guard
from llm_guard import (
    _DailyCap,
    _TokenBucket,
    _key_ok,
    _valid_keys,
    require_internal_auth,
)


class TestKeyAuth(unittest.TestCase):
    def setUp(self):
        llm_guard._warned_failopen = False

    def test_failopen_when_no_keys(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("INTERNAL_API_KEY", None)
            os.environ.pop("SCANNER_API_KEY", None)
            self.assertEqual(_valid_keys(), [])
            self.assertTrue(_key_ok("anything"))  # fail-open until secret set

    def test_internal_key_accept_reject(self):
        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": "s3cret"}, clear=False):
            os.environ.pop("SCANNER_API_KEY", None)
            self.assertTrue(_key_ok("s3cret"))
            self.assertFalse(_key_ok("wrong"))
            self.assertFalse(_key_ok(""))

    def test_scanner_key_accepted(self):
        with mock.patch.dict(
            os.environ, {"SCANNER_API_KEY": "scan-tok"}, clear=False
        ):
            os.environ.pop("INTERNAL_API_KEY", None)
            self.assertTrue(_key_ok("scan-tok"))
            self.assertFalse(_key_ok("nope"))

    def test_both_keys_either_accepted(self):
        with mock.patch.dict(
            os.environ,
            {"INTERNAL_API_KEY": "master", "SCANNER_API_KEY": "scoped"},
            clear=False,
        ):
            self.assertTrue(_key_ok("master"))
            self.assertTrue(_key_ok("scoped"))
            self.assertFalse(_key_ok("neither"))

    def test_equal_master_and_scanner_keys_reject_all_authentication(self):
        with mock.patch.dict(
            os.environ,
            {"INTERNAL_API_KEY": "same-secret", "SCANNER_API_KEY": "same-secret"},
            clear=False,
        ):
            self.assertFalse(_key_ok("same-secret"))
            self.assertFalse(_key_ok("anything"))

    def test_changeme_placeholder_excluded(self):
        with mock.patch.dict(
            os.environ, {"INTERNAL_API_KEY": "changeme"}, clear=False
        ):
            os.environ.pop("SCANNER_API_KEY", None)
            self.assertEqual(_valid_keys(), [])  # placeholder is not a real key


class TestTokenBucket(unittest.TestCase):
    def test_capacity_then_denied(self):
        b = _TokenBucket(capacity=3, refill_per_sec=0.0)
        self.assertTrue(all(b.allow("k", now=100.0) for _ in range(3)))
        self.assertFalse(b.allow("k", now=100.0))  # 4th denied, no refill

    def test_refill_over_time(self):
        b = _TokenBucket(capacity=1, refill_per_sec=10.0)
        self.assertTrue(b.allow("k", now=0.0))
        self.assertFalse(b.allow("k", now=0.0))       # empty
        self.assertTrue(b.allow("k", now=0.2))        # refilled 2 tokens by t=0.2

    def test_keys_isolated(self):
        b = _TokenBucket(capacity=1, refill_per_sec=0.0)
        self.assertTrue(b.allow("a", now=1.0))
        self.assertTrue(b.allow("b", now=1.0))  # different key, own bucket


class TestDailyCap(unittest.TestCase):
    def test_cap_then_denied(self):
        c = _DailyCap(cap=2, window_sec=86400.0)
        self.assertTrue(c.allow("u", now=0.0))
        self.assertTrue(c.allow("u", now=1.0))
        self.assertFalse(c.allow("u", now=2.0))  # 3rd exceeds cap

    def test_window_rolls(self):
        c = _DailyCap(cap=1, window_sec=100.0)
        self.assertTrue(c.allow("u", now=0.0))
        self.assertFalse(c.allow("u", now=50.0))    # still in window
        self.assertTrue(c.allow("u", now=200.0))    # window rolled


class TestDependencyEndToEnd(unittest.TestCase):
    """Exercise require_internal_auth through a real FastAPI app."""

    def setUp(self):
        llm_guard.reset_state()
        # A guarded route that records whether the billed handler executed.
        self.invoked = {"n": 0}
        app = FastAPI()

        @app.post("/llm/fake", dependencies=[Depends(require_internal_auth)])
        async def fake(payload: dict):
            self.invoked["n"] += 1
            return {"ok": True}

        self.app = app

    def test_d3_unauth_llm_call_blocked_before_invocation(self):
        """EXPLOIT-REPRO: unauth billed call -> 401 and handler never runs."""
        with mock.patch.dict(
            os.environ, {"INTERNAL_API_KEY": "the-secret"}, clear=False
        ):
            client = TestClient(self.app)
            r = client.post("/llm/fake", json={"user_id": "victim", "body_sample": "x" * 5000})
            self.assertEqual(r.status_code, 401)
            self.assertEqual(self.invoked["n"], 0, "billed handler must NOT run")

    def test_valid_key_allows(self):
        with mock.patch.dict(
            os.environ, {"INTERNAL_API_KEY": "the-secret"}, clear=False
        ):
            client = TestClient(self.app)
            r = client.post(
                "/llm/fake",
                json={"user_id": "u"},
                headers={"x-internal-key": "the-secret"},
            )
            self.assertEqual(r.status_code, 200)
            self.assertEqual(self.invoked["n"], 1)

    def test_rate_limit_returns_429(self):
        with mock.patch.dict(
            os.environ, {"INTERNAL_API_KEY": "the-secret"}, clear=False
        ), mock.patch.object(llm_guard, "_rate_limiter", _TokenBucket(2, 0.0)):
            client = TestClient(self.app)
            h = {"x-internal-key": "the-secret"}
            codes = [
                client.post("/llm/fake", json={"user_id": "u"}, headers=h).status_code
                for _ in range(4)
            ]
            self.assertEqual(codes[:2], [200, 200])
            self.assertIn(429, codes[2:], f"expected a 429 after burst, got {codes}")

    def test_failopen_when_secret_unset(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("INTERNAL_API_KEY", None)
            os.environ.pop("SCANNER_API_KEY", None)
            llm_guard._warned_failopen = False
            client = TestClient(self.app)
            r = client.post("/llm/fake", json={"user_id": "u"})  # no key
            self.assertEqual(r.status_code, 200)  # fail-open pre-secret


if __name__ == "__main__":
    unittest.main()
