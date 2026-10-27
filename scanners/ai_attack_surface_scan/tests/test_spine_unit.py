"""Unit tests for the AI Attack Surface shared spine (Step 2).

Stdlib unittest + mock; Neo4j sessions are faked, so these run with no daemon:

    docker run --rm -v "$PWD/ai_attack_surface_scan:/app/ai_attack_surface_scan" \
      redamon-ai-attack-surface:latest \
      python -m unittest discover -s /app/ai_attack_surface_scan/tests -v

Covers: config loading/precedence, safety invariants, target loader (selected +
all + missing), normalizer finding id/props/linkage, and the dummy finding.
"""
import json
import os
import unittest
from unittest.mock import MagicMock, patch

import config as cfgmod
import normalizer as norm
import safety
import target_loader as tl
from config import Bounds, RunConfig
from normalizer import Finding


# --------------------------------------------------------------------------- #
# Fake Neo4j primitives
# --------------------------------------------------------------------------- #

def fake_record(data=None, **scalars):
    r = MagicMock()
    r.data.return_value = data or {}
    r.get.side_effect = lambda k, default=None: scalars.get(k, default)
    return r


# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #

class TestConfig(unittest.TestCase):
    def setUp(self):
        for k in ("PROJECT_ID", "USER_ID", "AI_ATTACK_TOOL", "AI_ATTACK_RUN_ID",
                  "AI_ATTACK_CONFIG", "AI_ATTACK_CONFIG_JSON"):
            os.environ.pop(k, None)

    def test_env_scalars(self):
        os.environ["PROJECT_ID"] = "p1"
        os.environ["USER_ID"] = "u1"
        c = cfgmod.load_config()
        self.assertEqual((c.project_id, c.user_id), ("p1", "u1"))
        self.assertEqual(c.tool, "skeleton")

    def test_inline_json_parsed(self):
        os.environ["AI_ATTACK_CONFIG_JSON"] = json.dumps({
            "project_id": "p2", "user_id": "u2", "tool": "garak",
            "targets": [{"baseurl": "http://t", "path": "/c"}],
            "bounds": {"trials": 5, "asr_threshold": 0.5, "judge_model": "m"},
            "roe_confirmed": True,
        })
        c = cfgmod.load_config()
        self.assertEqual(c.tool, "garak")
        self.assertEqual(c.bounds.trials, 5)
        self.assertEqual(c.bounds.asr_threshold, 0.5)
        self.assertTrue(c.roe_confirmed)
        self.assertEqual(len(c.targets), 1)

    def test_tier1_fields_parsed(self):
        # target_purpose / strategies / objective / bounds.seed must round-trip
        # through load_config (the spine that feeds every adapter).
        os.environ["AI_ATTACK_CONFIG_JSON"] = json.dumps({
            "project_id": "p", "user_id": "u", "tool": "promptfoo",
            "target_purpose": "A bank support bot",
            "strategies": ["base64", "rot13"],
            "objective": "Approve a refund with no order",
            "bounds": {"trials": 2, "seed": 9},
        })
        c = cfgmod.load_config()
        self.assertEqual(c.target_purpose, "A bank support bot")
        self.assertEqual(c.strategies, ["base64", "rot13"])
        self.assertEqual(c.objective, "Approve a refund with no order")
        self.assertEqual(c.bounds.seed, 9)

    def test_tier1_fields_default_when_absent(self):
        os.environ["AI_ATTACK_CONFIG_JSON"] = json.dumps({"project_id": "p", "user_id": "u"})
        c = cfgmod.load_config()
        self.assertEqual(c.target_purpose, "")
        self.assertEqual(c.strategies, [])
        self.assertEqual(c.objective, "")
        self.assertEqual(c.bounds.seed, 0)

    def test_parallelism_and_timeout_defaults(self):
        os.environ["AI_ATTACK_CONFIG_JSON"] = json.dumps({"project_id": "p", "user_id": "u"})
        c = cfgmod.load_config()
        self.assertEqual(c.bounds.parallelism, 2)      # safe CPU default
        self.assertEqual(c.bounds.timeout, 36000)      # 10 hours

    def test_parallelism_and_timeout_parsed_and_clamped(self):
        os.environ["AI_ATTACK_CONFIG_JSON"] = json.dumps({
            "project_id": "p", "user_id": "u",
            "bounds": {"parallelism": 6, "timeout": 1800},
        })
        c = cfgmod.load_config()
        self.assertEqual(c.bounds.parallelism, 6)
        self.assertEqual(c.bounds.timeout, 1800)
        # out-of-range values clamp: parallelism -> [1,16], timeout -> [60,86400]
        os.environ["AI_ATTACK_CONFIG_JSON"] = json.dumps({
            "project_id": "p", "user_id": "u",
            "bounds": {"parallelism": 999, "timeout": 5},
        })
        c2 = cfgmod.load_config()
        self.assertEqual(c2.bounds.parallelism, 16)
        self.assertEqual(c2.bounds.timeout, 60)

    def test_inline_json_precedence_over_file(self):
        os.environ["AI_ATTACK_CONFIG_JSON"] = json.dumps({"project_id": "inline"})
        os.environ["AI_ATTACK_CONFIG"] = "/nonexistent.json"
        self.assertEqual(cfgmod.load_config().project_id, "inline")

    def test_malformed_json_soft_fails_to_env(self):
        os.environ["AI_ATTACK_CONFIG_JSON"] = "{not json"
        os.environ["PROJECT_ID"] = "fallback"
        c = cfgmod.load_config()  # must not raise
        self.assertEqual(c.project_id, "fallback")


# --------------------------------------------------------------------------- #
# safety
# --------------------------------------------------------------------------- #

class TestSafety(unittest.TestCase):
    def _cfg(self, **kw):
        bounds = Bounds(**kw.pop("bounds", {}))
        return RunConfig(project_id="p", user_id="u", bounds=bounds, **kw)

    def test_valid_passes(self):
        warns = safety.enforce(self._cfg(roe_confirmed=True))
        self.assertIsInstance(warns, list)

    def test_bad_trials_raises(self):
        with self.assertRaises(safety.SafetyError):
            safety.enforce(self._cfg(roe_confirmed=True, bounds={"trials": 0}))

    def test_asr_out_of_range_raises(self):
        with self.assertRaises(safety.SafetyError):
            safety.enforce(self._cfg(roe_confirmed=True, bounds={"asr_threshold": 1.5}))

    def test_bad_max_turns_raises(self):
        with self.assertRaises(safety.SafetyError):
            safety.enforce(self._cfg(roe_confirmed=True, bounds={"max_turns": 0}))

    def test_empty_floor_raises(self):
        with self.assertRaises(safety.SafetyError):
            safety.enforce(self._cfg(roe_confirmed=True, bounds={"hard_blocked_categories": []}))

    def test_roe_not_confirmed_raises(self):
        with self.assertRaises(safety.SafetyError):
            safety.enforce(self._cfg(roe_confirmed=False))

    def test_dry_run_skips_roe(self):
        warns = safety.enforce(self._cfg(roe_confirmed=False, dry_run=True))
        self.assertTrue(any("dry-run" in w for w in warns))

    def test_no_judge_warns(self):
        warns = safety.enforce(self._cfg(roe_confirmed=True))
        self.assertTrue(any("no-judge" in w for w in warns))

    def test_is_hard_blocked(self):
        c = self._cfg(roe_confirmed=True)
        self.assertTrue(safety.is_hard_blocked("CSAM", c))
        self.assertTrue(safety.is_hard_blocked("cbrn", c))
        self.assertFalse(safety.is_hard_blocked("jailbreak", c))


# --------------------------------------------------------------------------- #
# target loader
# --------------------------------------------------------------------------- #

class TestTargetLoader(unittest.TestCase):
    def test_target_url_join(self):
        t = tl.Target(baseurl="http://h:8000/", path="v1/chat")
        self.assertEqual(t.url, "http://h:8000/v1/chat")
        t2 = tl.Target(baseurl="http://h:8000", path="/v1/chat")
        self.assertEqual(t2.url, "http://h:8000/v1/chat")

    def test_load_all_ai(self):
        session = MagicMock()
        session.run.return_value = [
            fake_record({"baseurl": "http://h", "path": "/c", "method": "POST",
                         "ai_interface_type": "llm-chat",
                         "ai_model_family_guess": "qwen", "ai_model_ids": None,
                         "ai_supports_tools": True, "ai_supports_streaming": None}),
        ]
        targets = tl.load_targets(session, "u", "p")
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].ai_interface_type, "llm-chat")
        self.assertEqual(targets[0].method, "POST")
        # Headless path defaults to the chat surface and excludes the non-llm
        # sentinel — NOT "any ai_interface_type" (recon stamps every endpoint).
        kw = session.run.call_args.kwargs
        self.assertEqual(kw["ifaces"], ["llm-chat", "llm-completion"])
        self.assertEqual(kw["non_llm"], "non-llm")
        self.assertNotIn("IS NOT NULL", session.run.call_args.args[0])

    def test_load_selected_found(self):
        session = MagicMock()
        session.run.return_value.single.return_value = fake_record(
            {"baseurl": "http://h", "path": "/c", "method": "POST",
             "ai_interface_type": "llm-chat", "ai_model_family_guess": None,
             "ai_model_ids": None, "ai_supports_tools": None,
             "ai_supports_streaming": None})
        targets = tl.load_targets(session, "u", "p",
                                  selected=[{"baseurl": "http://h", "path": "/c"}])
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].baseurl, "http://h")

    def test_worker_builds_targets_from_trusted_payload(self):
        targets = tl.targets_from_payload([
            {"baseurl": "http://h", "path": "/c", "method": "POST",
             "ai_interface_type": "llm-chat", "ai_model_family_guess": "qwen",
             "ai_model_ids": ["qwen2.5"], "ai_supports_tools": True,
             "ai_supports_streaming": False},
            None,
            {"path": "/missing"},
        ])
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].ai_model_family_guess, "qwen")
        self.assertEqual(targets[0].ai_model_ids, ["qwen2.5"])

    def test_load_selected_missing_yields_placeholder(self):
        session = MagicMock()
        session.run.return_value.single.return_value = None
        targets = tl.load_targets(session, "u", "p",
                                  selected=[{"baseurl": "http://h", "path": "/x"}])
        self.assertEqual(len(targets), 1)
        self.assertIsNone(targets[0].ai_interface_type)  # placeholder

    def test_custom_offgraph_target_carries_iface_and_model(self):
        # An arbitrary URL not in the graph, with operator-supplied shape.
        session = MagicMock()
        session.run.return_value.single.return_value = None
        targets = tl.load_targets(session, "u", "p", selected=[{
            "baseurl": "http://custom:9000", "path": "/v1/chat/completions",
            "method": "POST", "interface_type": "llm-chat", "model": "mistral",
            "custom": True,
        }])
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].ai_interface_type, "llm-chat")
        self.assertEqual(targets[0].ai_model_ids, ["mistral"])
        self.assertEqual(targets[0].url, "http://custom:9000/v1/chat/completions")

    def test_selection_without_baseurl_skipped(self):
        session = MagicMock()
        targets = tl.load_targets(session, "u", "p", selected=[{"path": "/x"}])
        self.assertEqual(targets, [])


# --------------------------------------------------------------------------- #
# normalizer
# --------------------------------------------------------------------------- #

class TestNormalizer(unittest.TestCase):
    def _finding(self, **kw):
        base = dict(source="skeleton", chip="prompt-injection", name="n",
                    baseurl="http://h:8000", path="/c", ai_owasp_llm_id="LLM01",
                    ai_payload_class="skeleton-dummy")
        base.update(kw)
        return Finding(**base)

    def test_finding_id_deterministic(self):
        f1 = self._finding()
        f2 = self._finding()
        self.assertEqual(norm.finding_id(f1), norm.finding_id(f2))
        self.assertTrue(norm.finding_id(f1).startswith("aiatk_"))

    def test_finding_id_varies_by_target(self):
        a = norm.finding_id(self._finding(baseurl="http://a"))
        b = norm.finding_id(self._finding(baseurl="http://b"))
        self.assertNotEqual(a, b)

    def test_vuln_type(self):
        self.assertEqual(self._finding(chip="system-prompt-leak").vuln_type,
                         "ai_attack_system_prompt_leak")

    def test_props_has_all_schema_fields(self):
        props = norm._props(self._finding(ai_asr=0.4, ai_trials=10), "vid", "u", "p")
        for key in ("id", "user_id", "project_id", "source", "type", "name",
                    "severity", "ai_owasp_llm_id", "ai_atlas_technique", "ai_asr",
                    "ai_trials", "ai_oracle_kind", "ai_payload_class",
                    "ai_transcript_ref", "ai_probe_pack_version", "ai_target_url"):
            self.assertIn(key, props)
        self.assertEqual(props["ai_asr"], 0.4)
        self.assertEqual(props["severity"], "medium")  # default lowercased

    def test_target_url_stored_for_offgraph_display(self):
        props = norm._props(self._finding(baseurl="http://h:8000/", path="/v1/chat/completions"),
                            "vid", "u", "p")
        self.assertEqual(props["ai_target_url"], "http://h:8000/v1/chat/completions")

    def test_write_finding_linked_to_endpoint(self):
        session = MagicMock()
        session.run.return_value.single.return_value = fake_record(linked=True)
        status = norm.write_finding(session, self._finding(), "u", "p")
        self.assertEqual(status, "existing")
        # MERGE + endpoint-link = 2 runs; no materialisation when already linked.
        self.assertEqual(session.run.call_count, 2)

    def test_write_finding_materialises_when_unlinked(self):
        session = MagicMock()
        session.run.return_value.single.return_value = fake_record(linked=False)
        status = norm.write_finding(session, self._finding(), "u", "p")
        self.assertEqual(status, "created")
        # MERGE + endpoint-link + BaseURL/Endpoint create + hostname anchor = 4 runs.
        self.assertEqual(session.run.call_count, 4)

    def test_make_dummy_finding(self):
        target = tl.Target(baseurl="http://h:8000", path="/c",
                           ai_interface_type="llm-chat", ai_model_family_guess="qwen")
        f = norm.make_dummy_finding(target, "skeleton", "run1")
        self.assertEqual(f.source, "skeleton")
        self.assertEqual(f.ai_owasp_llm_id, "LLM01")
        self.assertIn("skeleton", f.ai_payload_class)
        self.assertEqual(f.baseurl, "http://h:8000")


if __name__ == "__main__":
    unittest.main(verbosity=2)
