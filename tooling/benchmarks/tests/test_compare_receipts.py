import copy
import hashlib
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from tooling.benchmarks.compare_receipts import ReceiptError, compare_receipts, load_receipt, main


HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64


def sample_receipt(run_id, commit, *, recall=0.7, warnings=2, warning_state="MEASURED"):
    return {
        "schemaVersion": 1,
        "runId": run_id,
        "commit": commit,
        "fixtureManifestSha256": HASH_A,
        "evaluationManifestSha256": HASH_B,
        "toolchainManifestSha256": HASH_C,
        "worktreeClean": True,
        "components": {"reamon": commit},
        "fixtures": {
            "fixture-one": {
                "artifactSha256": "d" * 64,
                "metrics": {
                    "known_source_value_recall": {"state": "MEASURED", "value": recall, "denominator": 70, "direction": "higher"},
                    "false_recovery_count": {"state": warning_state, "value": warnings if warning_state == "MEASURED" else None, "denominator": 180 if warning_state == "MEASURED" else None, "direction": "lower", **({} if warning_state == "MEASURED" else {"reason": "oracle unavailable"})},
                },
            }
        },
    }


class ReceiptComparisonTests(unittest.TestCase):
    def test_compares_identical_fixture_and_denominators_without_thresholds(self):
        report = compare_receipts(sample_receipt("base", "1" * 40), sample_receipt("candidate", "2" * 40, recall=1.0, warnings=1))

        self.assertEqual(report["status"], "NO_REGRESSION_OBSERVED")
        self.assertAlmostEqual(report["fixtures"]["fixture-one"]["metrics"]["known_source_value_recall"]["delta"], 0.3)
        self.assertFalse(report["thresholdsApplied"])

    def test_reports_directional_regression(self):
        report = compare_receipts(sample_receipt("base", "1" * 40), sample_receipt("candidate", "2" * 40, recall=0.6, warnings=3))

        self.assertEqual(report["status"], "REGRESSION_DETECTED")
        metrics = report["fixtures"]["fixture-one"]["metrics"]
        self.assertTrue(metrics["known_source_value_recall"]["regressionObserved"])
        self.assertTrue(metrics["false_recovery_count"]["regressionObserved"])

    def test_unavailable_metric_makes_the_report_incomplete(self):
        baseline = sample_receipt("base", "1" * 40, warning_state="UNAVAILABLE")
        report = compare_receipts(baseline, sample_receipt("candidate", "2" * 40))

        self.assertEqual(report["status"], "INCOMPLETE")
        self.assertEqual(report["fixtures"]["fixture-one"]["metrics"]["false_recovery_count"]["state"], "UNAVAILABLE")

    def test_denominator_mismatch_is_not_scored(self):
        candidate = sample_receipt("candidate", "2" * 40)
        candidate["fixtures"]["fixture-one"]["metrics"]["known_source_value_recall"]["denominator"] = 69
        report = compare_receipts(sample_receipt("base", "1" * 40), candidate)

        self.assertEqual(report["status"], "INCOMPLETE")
        self.assertEqual(report["fixtures"]["fixture-one"]["metrics"]["known_source_value_recall"]["state"], "INCOMPLETE")

    def test_product_source_commit_is_not_a_toolchain_component(self):
        baseline = sample_receipt("base", "1" * 40)
        baseline["components"]["product_source_commit"] = baseline["commit"]

        with self.assertRaisesRegex(ReceiptError, "product source commit belongs in productSourceCommit"):
            compare_receipts(baseline, sample_receipt("candidate", "2" * 40))

    def test_comparison_reports_product_source_revisions_separately_from_harness_commits(self):
        baseline = sample_receipt("base", "1" * 40)
        candidate = sample_receipt("candidate", "2" * 40)
        baseline["productSourceCommit"] = "3" * 40
        candidate["productSourceCommit"] = "4" * 40

        report = compare_receipts(baseline, candidate)

        self.assertEqual(report["baselineProductSourceCommit"], "3" * 40)
        self.assertEqual(report["candidateProductSourceCommit"], "4" * 40)

    def test_present_product_source_commit_cannot_be_null(self):
        baseline = sample_receipt("base", "1" * 40)
        baseline["productSourceCommit"] = None

        with self.assertRaisesRegex(ReceiptError, "productSourceCommit must be a full lowercase git hash"):
            compare_receipts(baseline, sample_receipt("candidate", "2" * 40))

    def test_mismatched_artifact_is_rejected(self):
        candidate = sample_receipt("candidate", "2" * 40)
        candidate["fixtures"]["fixture-one"]["artifactSha256"] = "e" * 64

        with self.assertRaisesRegex(ReceiptError, "artifact hash does not match fixture manifest"):
            compare_receipts(sample_receipt("base", "1" * 40), candidate)

    def test_duplicate_json_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt_path = Path(directory) / "duplicate.json"
            receipt_path.write_text('{"schemaVersion":1,"schemaVersion":1}', encoding="utf-8")

            with self.assertRaisesRegex(ReceiptError, "duplicate JSON key"):
                load_receipt(receipt_path)

    def test_non_finite_json_numbers_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt_path = Path(directory) / "non-finite.json"
            receipt_path.write_text('{"value":NaN}', encoding="utf-8")
            with self.assertRaisesRegex(ReceiptError, "non-finite JSON number"):
                load_receipt(receipt_path)

    def test_manifest_hash_and_metric_inventory_are_required(self):
        baseline = sample_receipt("base", "1" * 40)
        candidate = sample_receipt("candidate", "2" * 40)
        fixture_manifest = {"schemaVersion": 1, "fixtureId": "fixture-one", "artifact": {"sha256": "d" * 64}}
        evaluation_manifest = {"schemaVersion": 1, "metrics": {
            "known_source_value_recall": {"direction": "higher", "denominator": 70},
            "false_recovery_count": {"direction": "lower", "denominator": 180},
        }}
        with self.assertRaisesRegex(ReceiptError, "does not match supplied manifest"):
            compare_receipts(baseline, candidate, fixture_manifest=fixture_manifest,
                             evaluation_manifest=evaluation_manifest, fixture_manifest_hash=HASH_B,
                             evaluation_manifest_hash=HASH_C)
        candidate["fixtures"]["fixture-one"]["metrics"].pop("false_recovery_count")
        with self.assertRaisesRegex(ReceiptError, "metric inventory"):
            compare_receipts(baseline, candidate, fixture_manifest=fixture_manifest,
                             evaluation_manifest=evaluation_manifest, fixture_manifest_hash=HASH_A,
                             evaluation_manifest_hash=HASH_B)

    def test_dirty_worktree_makes_comparison_incomplete(self):
        candidate = sample_receipt("candidate", "2" * 40)
        candidate["worktreeClean"] = False
        report = compare_receipts(sample_receipt("base", "1" * 40), candidate)
        self.assertEqual(report["status"], "INCOMPLETE")
        self.assertFalse(report["worktreesClean"])

    def test_denominator_outside_contract_is_incomplete(self):
        baseline = sample_receipt("base", "1" * 40)
        candidate = sample_receipt("candidate", "2" * 40)
        candidate["fixtures"]["fixture-one"]["metrics"]["known_source_value_recall"]["denominator"] = 69
        fixture_manifest = {"schemaVersion": 1, "fixtureId": "fixture-one", "artifact": {"sha256": "d" * 64}}
        evaluation_manifest = {"schemaVersion": 1, "metrics": {
            "known_source_value_recall": {"direction": "higher", "denominator": 70},
            "false_recovery_count": {"direction": "lower", "denominator": 180},
        }}
        report = compare_receipts(baseline, candidate, fixture_manifest=fixture_manifest,
                                  evaluation_manifest=evaluation_manifest,
                                  fixture_manifest_hash=HASH_A, evaluation_manifest_hash=HASH_B)
        metric = report["fixtures"]["fixture-one"]["metrics"]["known_source_value_recall"]
        self.assertEqual(report["status"], "INCOMPLETE")
        self.assertEqual(metric["state"], "INCOMPLETE")
        self.assertIsNone(metric["delta"])

    def test_cli_verifies_manifest_bytes_and_writes_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture_path = root / "fixture.json"
            evaluation_path = root / "evaluation.json"
            baseline_path = root / "baseline.json"
            candidate_path = root / "candidate.json"
            output_path = root / "comparison.json"
            fixture_path.write_text(json.dumps({"schemaVersion": 1, "fixtureId": "fixture-one", "artifact": {"sha256": "d" * 64}}), encoding="utf-8")
            evaluation_path.write_text(json.dumps({"schemaVersion": 1, "metrics": {
                "known_source_value_recall": {"direction": "higher", "denominator": 70},
                "false_recovery_count": {"direction": "lower", "denominator": 180},
            }}), encoding="utf-8")
            fixture_hash = hashlib.sha256(fixture_path.read_bytes()).hexdigest()
            evaluation_hash = hashlib.sha256(evaluation_path.read_bytes()).hexdigest()
            baseline = sample_receipt("base", "1" * 40)
            candidate = sample_receipt("candidate", "2" * 40, recall=1.0)
            for receipt in (baseline, candidate):
                receipt["fixtureManifestSha256"] = fixture_hash
                receipt["evaluationManifestSha256"] = evaluation_hash
            baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
            candidate_path.write_text(json.dumps(candidate), encoding="utf-8")

            with redirect_stdout(io.StringIO()):
                result = main([str(baseline_path), str(candidate_path), "--fixture-manifest", str(fixture_path),
                               "--evaluation-manifest", str(evaluation_path), "--output", str(output_path)])
            self.assertEqual(result, 0)
            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8"))["status"], "NO_REGRESSION_OBSERVED")


if __name__ == "__main__":
    unittest.main()
