import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tooling.benchmarks.run_pyinstaller_pair import ReceiptError, run_pair


class PyInstallerPairRunnerTests(unittest.TestCase):
    def _inputs(self, root):
        values = {}
        for name, value in {
            "fixture": {"schemaVersion": 1},
            "evaluation": {"schemaVersion": 1},
            "build": {"schemaVersion": 1},
            "enrollment": {"schemaVersion": 1},
            "baseline-integration": {"side": "baseline"},
            "candidate-integration": {"side": "candidate"},
            "baseline-toolchain": {"schemaVersion": 1, "components": {"extractor": "rev"}},
            "candidate-toolchain": {"schemaVersion": 1, "components": {"extractor": "rev"}},
        }.items():
            path = root / f"{name}.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            values[name] = path
        return values

    def test_publishes_all_pair_outputs_only_after_comparison(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self._inputs(root)
            baseline_repo = root / "baseline"
            candidate_repo = root / "candidate"
            baseline_repo.mkdir()
            candidate_repo.mkdir()
            output = root / "paired-result"

            with patch("tooling.benchmarks.run_pyinstaller_pair.merge_evidence", return_value={"evidence": True}), \
                    patch("tooling.benchmarks.run_pyinstaller_pair.create_receipt", side_effect=[
                        {"runId": "pair-baseline"}, {"runId": "pair-candidate"},
                    ]) as create_receipt, \
                    patch("tooling.benchmarks.run_pyinstaller_pair.compare_receipts", return_value={
                        "status": "INCOMPLETE",
                    }) as compare:
                report = run_pair(
                    baseline_repo_root=baseline_repo,
                    candidate_repo_root=candidate_repo,
                    fixture_manifest_path=inputs["fixture"],
                    evaluation_manifest_path=inputs["evaluation"],
                    build_receipt_path=inputs["build"],
                    enrollment_receipt_path=inputs["enrollment"],
                    baseline_integration_path=inputs["baseline-integration"],
                    candidate_integration_path=inputs["candidate-integration"],
                    baseline_toolchain_path=inputs["baseline-toolchain"],
                    candidate_toolchain_path=inputs["candidate-toolchain"],
                    output_dir=output,
                    run_prefix="pair",
                    baseline_product_source_commit="3" * 40,
                    candidate_product_source_commit="4" * 40,
                )

            self.assertEqual(report["status"], "INCOMPLETE")
            self.assertEqual(compare.call_count, 1)
            self.assertEqual(create_receipt.call_args_list[0].kwargs["product_source_commit"], "3" * 40)
            self.assertEqual(create_receipt.call_args_list[1].kwargs["product_source_commit"], "4" * 40)
            self.assertEqual(
                {path.name for path in output.iterdir()},
                {"baseline-evidence.json", "baseline-receipt.json", "candidate-evidence.json",
                 "candidate-receipt.json", "comparison.json"},
            )

    def test_refuses_output_inside_a_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            repo.mkdir()
            with self.assertRaisesRegex(ReceiptError, "outside both repository checkouts"):
                run_pair(
                    baseline_repo_root=repo,
                    candidate_repo_root=repo,
                    fixture_manifest_path="unused",
                    evaluation_manifest_path="unused",
                    build_receipt_path="unused",
                    enrollment_receipt_path="unused",
                    baseline_integration_path="unused",
                    candidate_integration_path="unused",
                    baseline_toolchain_path="unused",
                    candidate_toolchain_path="unused",
                    output_dir=repo / "results",
                )

    def test_refuses_different_toolchains(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self._inputs(root)
            inputs["candidate-toolchain"].write_text(
                json.dumps({"schemaVersion": 1, "components": {"extractor": "other"}}),
                encoding="utf-8",
            )
            repo_a = root / "baseline"
            repo_b = root / "candidate"
            repo_a.mkdir()
            repo_b.mkdir()
            with self.assertRaisesRegex(ReceiptError, "toolchain manifests differ"):
                run_pair(
                    baseline_repo_root=repo_a,
                    candidate_repo_root=repo_b,
                    fixture_manifest_path=inputs["fixture"],
                    evaluation_manifest_path=inputs["evaluation"],
                    build_receipt_path=inputs["build"],
                    enrollment_receipt_path=inputs["enrollment"],
                    baseline_integration_path=inputs["baseline-integration"],
                    candidate_integration_path=inputs["candidate-integration"],
                    baseline_toolchain_path=inputs["baseline-toolchain"],
                    candidate_toolchain_path=inputs["candidate-toolchain"],
                    output_dir=root / "paired-result",
                )
            self.assertFalse((root / "paired-result").exists())


if __name__ == "__main__":
    unittest.main()
