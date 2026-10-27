"""A stop must not discard the run: SIGTERM has to reach the artifact-save path.

Every stop arrives as SIGTERM (the orchestrator's stop endpoint, and its
shutdown cleanup when the stack restarts). Python's default handler exits on the
spot, so save_results() was skipped and an hour of scanning produced no
recoverable findings. SIGINT was handled, which hid it.

Stubs PyGithub so main.py imports on a bare host, mirroring
test_github_hunt_redaction.

Run: python -m unittest tests.test_github_hunt_sigterm
"""

import os
import signal
import sys
import types
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

_gh = types.ModuleType("github")
_gh.Github = object
_gh.Auth = types.SimpleNamespace(Token=lambda *a, **k: None)
_ghe = types.ModuleType("github.GithubException")
_ghe.RateLimitExceededException = type("RateLimitExceededException", (Exception,), {})
_ghe.GithubException = type("GithubException", (Exception,), {})
_gh.GithubException = _ghe
sys.modules.setdefault("github", _gh)
sys.modules.setdefault("github.GithubException", _ghe)

sys.path.insert(0, os.path.join(REPO_ROOT, "scanners", "github_secret_hunt"))
import main as hunt_main  # noqa: E402


class TestSigtermIsGraceful(unittest.TestCase):
    def setUp(self):
        self._previous = signal.getsignal(signal.SIGTERM)

    def tearDown(self):
        signal.signal(signal.SIGTERM, self._previous)

    def test_sigterm_raises_keyboardinterrupt(self):
        hunt_main._install_sigterm_handler()
        with self.assertRaises(KeyboardInterrupt):
            os.kill(os.getpid(), signal.SIGTERM)

    def test_sigterm_survives_the_per_file_except_exception_guard(self):
        """The scan loops swallow Exception per file/commit to keep going.

        A custom exception would die in those guards and the scan would sail on
        until SIGKILL. KeyboardInterrupt is a BaseException, so it passes through
        — that is the whole reason for the choice.
        """
        hunt_main._install_sigterm_handler()
        with self.assertRaises(KeyboardInterrupt):
            try:
                os.kill(os.getpid(), signal.SIGTERM)
            except Exception:
                self.fail("SIGTERM was swallowed by an `except Exception` guard")

    def test_handler_is_actually_installed(self):
        hunt_main._install_sigterm_handler()
        self.assertNotIn(
            signal.getsignal(signal.SIGTERM),
            (signal.SIG_DFL, signal.SIG_IGN),
            "default SIGTERM disposition kills the process before it can save")


class TestInterruptedRunStillSavesTheIngestArtifact(unittest.TestCase):
    """run() must swallow KeyboardInterrupt itself and save its findings.

    The orchestrator ingests this file after the worker exits. If the exception
    propagated, saved partial findings would not be available to ingest.
    """

    def test_run_returns_findings_after_an_interrupt(self):
        # By path: `github_secret_hunt` resolves to the PACKAGE when
        # /repo/scanners is on PYTHONPATH and to the MODULE when it is not.
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "_ghh_under_test",
            os.path.join(REPO_ROOT, "scanners", "github_secret_hunt",
                         "github_secret_hunt.py"))
        ghh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ghh)

        hunter = ghh.GitHubSecretHunter.__new__(ghh.GitHubSecretHunter)
        hunter.settings = {"GITHUB_OUTPUT_JSON": False}
        hunter.findings = [{"type": "SECRET"}]
        hunter.stats = dict.fromkeys(
            ("repos_scanned", "files_scanned", "commits_scanned", "gists_scanned",
             "secrets_found", "sensitive_files", "high_entropy"), 0)
        hunter.rate_limit_hits = 0
        hunter.target = "acme"
        hunter.scan_organization = lambda: (_ for _ in ()).throw(KeyboardInterrupt())

        saved = {}
        hunter.save_results = lambda status="completed": saved.update(status=status)

        findings = hunter.run()

        self.assertEqual(findings, [{"type": "SECRET"}])
        self.assertEqual(saved.get("status"), "interrupted",
                         "an interrupted run must be saved, and marked as such")

    def test_scanner_entry_point_does_not_connect_to_neo4j(self):
        with open(os.path.join(REPO_ROOT, "scanners", "github_secret_hunt", "main.py"),
                  encoding="utf-8") as source_file:
            source = source_file.read()
        self.assertNotIn("Neo4jClient", source)
        self.assertNotIn("NEO4J_PASSWORD", source)


if __name__ == "__main__":
    unittest.main()
