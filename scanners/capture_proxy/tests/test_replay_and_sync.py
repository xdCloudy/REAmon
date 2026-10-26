"""
Replay-lineage tag tests + the three-copy sync regression guard.

The X-Redamon-Ctx tag carries `is_replay` / `origin_id` for proxy_replay /
proxy_fuzz. The signing primitive is DUPLICATED verbatim in three places
(capture_proxy/, agentic/, recon/helpers/). If they drift, a replay tag signed by
one side fails to verify on the ingest side (the re-canonicalization check in
verify_tag rejects any field the verifier does not know), silently dropping every
replayed transaction. These tests assert:

  1. is_replay / origin_id round-trip through sign -> verify.
  2. The real replay path: agent-signed tag verifies with the capture_proxy copy.
  3. The three copies are byte-identical (drift guard).
  4. ingest.build_row stamps is_replay / origin_id from the VERIFIED payload.

Run: python3 -m unittest capture_proxy.tests.test_replay_and_sync
"""
from __future__ import annotations

import hashlib
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]           # scanners/capture_proxy/
REPO = Path(__file__).resolve().parents[3]           # repo root
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import redamon_ctx  # noqa: E402  (capture_proxy copy)
from ingest_worker import build_row  # noqa: E402

_COPIES = {
    "capture": REPO / "scanners" / "capture_proxy" / "redamon_ctx.py",
    "agent": REPO / "agentic" / "redamon_ctx.py",
    "recon": REPO / "recon" / "helpers" / "redamon_ctx.py",
}


def _load(name, path):
    spec = importlib.util.spec_from_file_location(f"_rc_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestReplayTagRoundTrip(unittest.TestCase):
    KEY = "test-key"

    def test_is_replay_and_origin_id_survive(self):
        payload = {
            "source": "agent", "project_id": "p1", "user_id": "u1",
            "tool": "proxy_replay", "phase": "exploitation",
            "is_replay": True, "origin_id": "txn-abc-123",
        }
        token = redamon_ctx.sign_tag(payload, self.KEY)
        out = redamon_ctx.verify_tag(token, {"agent": self.KEY})
        self.assertIsNotNone(out)
        self.assertIs(out["is_replay"], True)
        self.assertEqual(out["origin_id"], "txn-abc-123")

    def test_non_replay_tag_has_no_replay_fields(self):
        # None-valued fields are dropped by _canonical, so a normal tag stays lean.
        token = redamon_ctx.sign_tag(
            {"source": "recon", "project_id": "p", "user_id": "u", "tool": "nuclei"},
            self.KEY)
        out = redamon_ctx.verify_tag(token, {"recon": self.KEY})
        self.assertIsNotNone(out)
        self.assertNotIn("is_replay", out)
        self.assertNotIn("origin_id", out)


class TestCrossCopyReplayFlow(unittest.TestCase):
    """The agent signs, the capture_proxy ingest verifies: the real replay path."""

    KEY = "internal-key"

    def test_agent_signed_replay_verifies_on_capture_copy(self):
        rc_agent = _load("agent", _COPIES["agent"])
        rc_capture = _load("capture", _COPIES["capture"])
        token = rc_agent.sign_tag(
            {"source": "agent", "project_id": "p", "user_id": "u",
             "is_replay": True, "origin_id": "o-9"}, self.KEY)
        out = rc_capture.verify_tag(token, {"agent": self.KEY})
        self.assertIsNotNone(out, "agent-signed replay tag was rejected by ingest")
        self.assertIs(out["is_replay"], True)
        self.assertEqual(out["origin_id"], "o-9")

    def test_agent_signed_terminal_context_round_trips_nested_graph_scope(self):
        rc_agent = _load("agent", _COPIES["agent"])
        rc_capture = _load("capture", _COPIES["capture"])
        payload = {
            "source": "agent", "project_id": "p", "user_id": "u",
            "session_id": "s", "tool": "kali_terminal", "phase": "interactive",
            "graph_ctx": "nested-signed-graph-context",
        }
        token = rc_agent.sign_tag(payload, self.KEY)
        out = rc_capture.verify_tag(token, {"agent": self.KEY})
        self.assertIsNotNone(out)
        self.assertEqual(out["graph_ctx"], payload["graph_ctx"])


class TestThreeCopySync(unittest.TestCase):
    def test_copies_are_byte_identical(self):
        digests = {
            name: hashlib.md5(path.read_bytes()).hexdigest()
            for name, path in _COPIES.items()
        }
        self.assertEqual(
            len(set(digests.values())), 1,
            f"redamon_ctx.py copies have drifted: {digests}. "
            f"They MUST stay byte-identical or replay tags get rejected.")


class TestBuildRowReplayLineage(unittest.TestCase):
    def test_build_row_stamps_replay_fields_from_payload(self):
        payload = {
            "source": "agent", "project_id": "p", "user_id": "u",
            "is_replay": True, "origin_id": "origin-1",
        }
        rec = {"method": "get", "host": "t", "path": "/", "scheme": "http"}
        row = build_row(payload, rec, redact=False)
        self.assertIs(row["is_replay"], True)
        self.assertEqual(row["origin_id"], "origin-1")
        self.assertEqual(row["project_id"], "p")
        self.assertEqual(row["user_id"], "u")

    def test_build_row_defaults_non_replay(self):
        payload = {"source": "recon", "project_id": "p", "user_id": "u"}
        rec = {"method": "get", "host": "t", "path": "/"}
        row = build_row(payload, rec, redact=False)
        self.assertIs(row["is_replay"], False)
        self.assertIsNone(row["origin_id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
