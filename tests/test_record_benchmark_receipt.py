import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from tooling.benchmarks.record_receipt import ReceiptError, create_receipt, main


@unittest.skipUnless(shutil.which("git"), "git is required to record source provenance")
class RecordBenchmarkReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.fixture_manifest = self.root / "fixture.json"
        self.evaluation_manifest = self.root / "evaluation.json"
        self.evidence = self.root / "evidence.json"
        self.toolchain = self.root / "toolchain.json"
        self.fixture_hash = "a" * 64
        self.fixture_manifest.write_text(json.dumps({
            "schemaVersion": 1,
            "fixtureId": "known-source-fixture",
            "artifact": {"sha256": self.fixture_hash},
        }), encoding="utf-8")
        self.evaluation_manifest.write_text(json.dumps({
            "schemaVersion": 1,
            "metrics": {
                "known_source_recall": {"direction": "higher", "denominator": 70},
                "reconstruction_match": {"direction": "higher", "denominator": 70},
            },
        }), encoding="utf-8")
        self.toolchain.write_text(json.dumps({
            "schemaVersion": 1,
            "components": {"extractor": "revision-abc", "decompiler": "revision-def"},
        }), encoding="utf-8")
        self.write_evidence()
        self.git("init", "-q")
        (self.repo / "source.txt").write_text("tracked source\n", encoding="utf-8")
        self.git("add", "source.txt")
        self.git("-c", "user.name=Benchmark Test", "-c", "user.email=benchmark@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "fixture baseline")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def write_evidence(self, *, denominator=70):
        self.evidence.write_text(json.dumps({
            "schemaVersion": 1,
            "fixtures": {
                "known-source-fixture": {
                    "artifactSha256": self.fixture_hash,
                    "metrics": {
                        "known_source_recall": {
                            "state": "MEASURED", "value": 1.0, "denominator": denominator,
                        },
                        "reconstruction_match": {
                            "state": "UNAVAILABLE", "value": None, "denominator": denominator,
                            "reason": "The fixture run did not compare complete recovered source.",
                        },
                    },
                },
            },
        }), encoding="utf-8")

    def record(self):
        return create_receipt(
            repo_root=self.repo,
            fixture_manifest_path=self.fixture_manifest,
            evaluation_manifest_path=self.evaluation_manifest,
            evidence_path=self.evidence,
            toolchain_manifest_path=self.toolchain,
            run_id="known-run",
        )

    def test_binds_measured_evidence_to_manifests_commit_and_component_revisions(self):
        receipt = self.record()

        self.assertTrue(receipt["worktreeClean"])
        self.assertEqual(receipt["commit"], self.git("rev-parse", "HEAD"))
        self.assertEqual(receipt["runId"], "known-run")
        self.assertEqual(receipt["fixtures"]["known-source-fixture"]["artifactSha256"], self.fixture_hash)
        self.assertEqual(receipt["fixtures"]["known-source-fixture"]["metrics"]["known_source_recall"]["value"], 1.0)
        self.assertEqual(receipt["components"]["extractor"], "revision-abc")
        self.assertEqual(receipt["evidenceSha256"], hashlib.sha256(self.evidence.read_bytes()).hexdigest())

    def test_dirty_checkout_is_recorded_as_dirty_not_rejected_or_hidden(self):
        (self.repo / "local-change.txt").write_text("untracked\n", encoding="utf-8")

        self.assertFalse(self.record()["worktreeClean"])

    def test_denominator_mismatch_is_rejected(self):
        self.write_evidence(denominator=69)

        with self.assertRaisesRegex(ReceiptError, "denominator differs"):
            self.record()

    def test_unavailable_metric_is_preserved_with_reason(self):
        metric = self.record()["fixtures"]["known-source-fixture"]["metrics"]["reconstruction_match"]

        self.assertEqual(metric["state"], "UNAVAILABLE")
        self.assertIsNone(metric["value"])
        self.assertIn("did not compare", metric["reason"])

    def test_cli_writes_a_receipt_without_overwriting_an_existing_run(self):
        output = self.root / "receipts" / "candidate.json"
        args = [
            "--repo-root", str(self.repo),
            "--fixture-manifest", str(self.fixture_manifest),
            "--evaluation-manifest", str(self.evaluation_manifest),
            "--evidence", str(self.evidence),
            "--toolchain-manifest", str(self.toolchain),
            "--output", str(output),
            "--run-id", "candidate-run",
        ]

        with redirect_stdout(StringIO()):
            self.assertEqual(main(args), 0)
        stored = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(stored["runId"], "candidate-run")
        with redirect_stdout(StringIO()):
            self.assertEqual(main(args), 2)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["runId"], "candidate-run")


if __name__ == "__main__":
    unittest.main()
