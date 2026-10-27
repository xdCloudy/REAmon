"""Tests for the main() control flow.

Error paths are unit-tested with everything mocked; the happy path runs against
a live Neo4j (skipped if unreachable) and asserts the phase markers advance in
numeric order (regression for the out-of-order Phase 2-before-1 bug).
"""
import io
import re
import unittest
from contextlib import redirect_stdout
from unittest.mock import MagicMock, patch

import main
import target_loader as tl
from config import Bounds, RunConfig


def _cfg(**kw):
    bounds = kw.pop("bounds", Bounds(judge_model="m"))
    base = dict(project_id="p", user_id="u", tool="skeleton",
                roe_confirmed=True, bounds=bounds)
    base.update(kw)
    return RunConfig(**base)


def _fake_driver(session):
    driver = MagicMock()
    driver.session.return_value.__enter__.return_value = session
    driver.session.return_value.__exit__.return_value = False
    return driver


def _phase_numbers(text):
    return [int(n) for n in re.findall(r"\[Phase (\d+)\]", text)]


class TestMainErrorPaths(unittest.TestCase):
    def test_missing_ids_returns_1(self):
        with patch.object(main, "load_config", return_value=_cfg(project_id="")):
            self.assertEqual(main.run(), 1)

    def test_safety_failure_returns_1(self):
        # RoE not confirmed and not dry-run -> SafetyError -> exit 1.
        with patch.object(main, "load_config", return_value=_cfg(roe_confirmed=False)):
            self.assertEqual(main.run(), 1)

    def test_no_targets_returns_0(self):
        with patch.object(main, "load_config", return_value=_cfg()), \
             patch.object(main, "targets_from_payload", return_value=[]):
            self.assertEqual(main.run(), 0)

    def test_crash_is_caught_and_returns_1(self):
        # main() wraps run(); an unexpected error must become exit 1, not a traceback.
        with patch.object(main, "run", side_effect=RuntimeError("boom")):
            self.assertEqual(main.main(), 1)

    def test_dry_run_writes_nothing(self):
        target = tl.Target(baseurl="http://h", path="/c", ai_interface_type="llm-chat")
        with patch.object(main, "load_config", return_value=_cfg(dry_run=True, roe_confirmed=False)), \
             patch.object(main, "targets_from_payload", return_value=[target]), \
             patch.object(main, "write_result_artifact") as publish:
            self.assertEqual(main.run(), 0)
            publish.assert_not_called()

    def test_phase_order_monotonic_mocked(self):
        target = tl.Target(baseurl="http://h", path="/c", ai_interface_type="llm-chat")
        buf = io.StringIO()
        with patch.object(main, "load_config", return_value=_cfg()), \
             patch.object(main, "targets_from_payload", return_value=[target]), \
             patch.dict("os.environ", {"AI_ATTACK_RESULT_PATH": "/tmp/unused-ai-attack.json"}), \
             patch.object(main, "write_result_artifact"):
            with redirect_stdout(buf):
                main.run()
        phases = _phase_numbers(buf.getvalue())
        self.assertEqual(phases, sorted(phases), f"phases not monotonic: {phases}")
        self.assertEqual(phases, [1, 2, 3, 4])


class TestRunToolDispatch(unittest.TestCase):
    def test_skeleton_returns_dummies(self):
        targets = [tl.Target(baseurl="http://h", path="/c", ai_interface_type="llm-chat")]
        findings = main.run_tool(_cfg(tool="skeleton"), targets)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].source, "skeleton")

    def test_garak_dispatch_isolates_per_target_failures(self):
        from normalizer import Finding
        t_bad = tl.Target(baseurl="http://a", path="/c")
        t_ok = tl.Target(baseurl="http://b", path="/c")

        def fake_run(target, *a, **k):
            if target.baseurl == "http://a":
                raise RuntimeError("garak boom")
            return [Finding(source="garak", chip="jailbreak", name="n",
                            baseurl="http://b", path="/c", ai_owasp_llm_id="LLM01",
                            ai_payload_class="garak-dan")]

        with patch("adapters.garak.run", side_effect=fake_run):
            findings = main.run_tool(_cfg(tool="garak"), [t_bad, t_ok])
        # The failing target is isolated; the healthy one still yields its finding.
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].baseurl, "http://b")

    def test_pyrit_dispatch_isolates_and_passes_auth(self):
        from normalizer import Finding
        t_bad = tl.Target(baseurl="http://a", path="/c")
        t_ok = tl.Target(baseurl="http://b", path="/c")
        captured = {}

        def fake_run(target, bounds, output_dir, run_id, **k):
            if target.baseurl == "http://a":
                raise RuntimeError("pyrit boom")
            captured.update(k)
            return [Finding(source="pyrit", chip="jailbreak", name="n", baseurl="http://b",
                            path="/c", ai_owasp_llm_id="LLM01", ai_payload_class="pyrit-crescendo")]

        cfg = _cfg(tool="pyrit")
        cfg.probes = ["crescendo"]
        cfg.judge_base_url = "http://localhost:11434"
        cfg.auth_header = "Authorization"
        cfg.auth_scheme = "Bearer"
        cfg.api_key = "tok"
        with patch("adapters.pyrit.run", side_effect=fake_run):
            findings = main.run_tool(cfg, [t_bad, t_ok])
        self.assertEqual(len(findings), 1)        # bad target isolated
        self.assertEqual(findings[0].source, "pyrit")
        self.assertEqual(captured["attacks"], ["crescendo"])
        self.assertEqual(captured["judge_base_url"], "http://localhost:11434")
        self.assertEqual(captured["auth_header"], "Authorization")
        self.assertEqual(captured["api_key"], "tok")

    def test_giskard_dispatch_isolates_and_passes_detectors(self):
        from normalizer import Finding
        t_bad = tl.Target(baseurl="http://a", path="/c")
        t_ok = tl.Target(baseurl="http://b", path="/c")
        captured = {}

        def fake_run(target, bounds, output_dir, run_id, **k):
            if target.baseurl == "http://a":
                raise RuntimeError("giskard boom")
            captured.update(k)
            return [Finding(source="giskard", chip="prompt-injection", name="n", baseurl="http://b",
                            path="/c", ai_owasp_llm_id="LLM01", ai_payload_class="giskard-x")]

        cfg = _cfg(tool="giskard")
        cfg.probes = ["prompt_injection"]
        cfg.judge_base_url = "http://localhost:11434"
        with patch("adapters.giskard.run", side_effect=fake_run):
            findings = main.run_tool(cfg, [t_bad, t_ok])
        self.assertEqual(len(findings), 1)            # bad target isolated
        self.assertEqual(findings[0].source, "giskard")
        self.assertEqual(captured["detectors"], ["prompt_injection"])
        self.assertEqual(captured["judge_base_url"], "http://localhost:11434")

    def test_promptfoo_dispatch_isolates_and_passes_plugins(self):
        from normalizer import Finding
        t_bad = tl.Target(baseurl="http://a", path="/c")
        t_ok = tl.Target(baseurl="http://b", path="/c")
        captured = {}

        def fake_run(target, bounds, output_dir, run_id, **k):
            if target.baseurl == "http://a":
                raise RuntimeError("promptfoo boom")
            captured.update(k)
            return [Finding(source="promptfoo", chip="toxicity", name="n", baseurl="http://b",
                            path="/c", ai_owasp_llm_id="safety", ai_payload_class="promptfoo-beavertails")]

        cfg = _cfg(tool="promptfoo")
        cfg.probes = ["beavertails"]
        cfg.judge_base_url = "http://localhost:11434"
        cfg.auth_header = "Authorization"
        cfg.auth_scheme = "Bearer"
        cfg.api_key = "tok"
        with patch("adapters.promptfoo.run", side_effect=fake_run):
            findings = main.run_tool(cfg, [t_bad, t_ok])
        self.assertEqual(len(findings), 1)            # bad target isolated
        self.assertEqual(findings[0].source, "promptfoo")
        self.assertEqual(captured["plugins"], ["beavertails"])
        self.assertEqual(captured["judge_base_url"], "http://localhost:11434")
        self.assertEqual(captured["api_key"], "tok")

    def test_garak_passes_probes_and_judge_through(self):
        from normalizer import Finding
        captured = {}

        def fake_run(target, bounds, output_dir, run_id, **k):
            captured.update(k)
            return []

        cfg = _cfg(tool="garak")
        cfg.probes = ["dan.Dan_11_0"]
        cfg.judge_base_url = "http://localhost:11434"
        cfg.target_model = "qwen2.5:0.5b"
        with patch("adapters.garak.run", side_effect=fake_run):
            main.run_tool(cfg, [tl.Target(baseurl="http://b", path="/c")])
        self.assertEqual(captured["probes"], ["dan.Dan_11_0"])
        self.assertEqual(captured["judge_base_url"], "http://localhost:11434")
        self.assertEqual(captured["target_model"], "qwen2.5:0.5b")


class TestResultArtifact(unittest.TestCase):
    def test_result_artifact_retains_run_identity_targets_and_findings(self):
        import json
        import tempfile
        from normalizer import Finding

        target = tl.Target(baseurl="https://example.invalid", path="/chat", method="POST")
        finding = Finding(source="garak", chip="prompt-injection", name="injection",
                          baseurl=target.baseurl, path=target.path, evidence="fixture")
        cfg = _cfg(project_id="project-1", user_id="user-1", run_id="run-1")
        with tempfile.TemporaryDirectory() as directory:
            result_path = f"{directory}/result.json"
            main.write_result_artifact(result_path, cfg, [target], [finding])
            with open(result_path, encoding="utf-8") as stream:
                payload = json.load(stream)
        self.assertEqual(payload["metadata"], {
            "project_id": "project-1", "user_id": "user-1", "run_id": "run-1", "tool": "skeleton",
        })
        self.assertEqual(payload["targets"][0]["baseurl"], target.baseurl)
        self.assertEqual(payload["findings"][0]["evidence"], "fixture")


if __name__ == "__main__":
    unittest.main(verbosity=2)
