import unittest

from tooling.benchmarks.compare_receipts import ReceiptError
from tooling.benchmarks.merge_pyinstaller_evidence import merge_evidence


class MergePyInstallerEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture_id = "fixture-one"
        self.artifact_hash = "a" * 64
        self.fixture_manifest = {
            "schemaVersion": 1,
            "fixtureId": self.fixture_id,
            "artifact": {"sha256": self.artifact_hash},
            "target": {
                "expectedRuntimeStdout": "2485",
                "extractedBytecodeModuleCount": 180,
                "moduleSourceCount": 70,
            },
        }
        self.evaluation_manifest = {
            "schemaVersion": 1,
            "metrics": {
                "runtime_oracle": {"direction": "equal", "denominator": 1},
                "extracted_module_count": {"direction": "equal", "denominator": 1},
                "known_source_value_recall": {"direction": "higher", "denominator": 70},
                "worker_terminal_page": {"direction": "equal", "denominator": 1},
                "reconstruction_match": {"direction": "higher", "denominator": 70},
            },
        }
        self.build_receipt = {
            "artifactSha256": self.artifact_hash,
            "expectedRuntimeStdout": "2485",
            "runtimeOracle": "PASSED in Docker build container",
            "extractedBytecodeModuleCount": 180,
            "extractedModulePageSizes": [64, 64, 52],
        }
        self.enrollment_receipt = {
            "schemaVersion": 1,
            "build": {"artifactSha256": self.artifact_hash},
            "fixtureOracle": {"state": "PASSED", "expectedStdout": "2485", "observedStdout": "2485"},
            "extractorInventory": {"state": "PASSED", "moduleCount": 180, "pageSizes": [64, 64, 52]},
        }
        self.integration_evidence = {
            "schemaVersion": 1,
            "fixtures": {
                self.fixture_id: {
                    "artifactSha256": self.artifact_hash,
                    "metrics": {
                        "runtime_oracle": {"state": "UNAVAILABLE", "value": None, "denominator": 1, "reason": "separate builder"},
                        "extracted_module_count": {"state": "MEASURED", "value": 180, "denominator": 1},
                        "known_source_value_recall": {"state": "MEASURED", "value": 70, "denominator": 70},
                        "worker_terminal_page": {"state": "MEASURED", "value": 1, "denominator": 1},
                        "reconstruction_match": {"state": "MEASURED", "value": 70, "denominator": 70},
                    },
                },
            },
        }

    def merge(self):
        return merge_evidence(
            fixture_manifest=self.fixture_manifest,
            evaluation_manifest=self.evaluation_manifest,
            build_receipt=self.build_receipt,
            enrollment_receipt=self.enrollment_receipt,
            integration_evidence=self.integration_evidence,
        )

    def test_runtime_oracle_is_measured_only_after_all_source_hashes_match(self):
        metrics = self.merge()["fixtures"][self.fixture_id]["metrics"]

        self.assertEqual(metrics["runtime_oracle"], {
            "direction": "equal", "state": "MEASURED", "value": 1, "denominator": 1,
        })
        self.assertEqual(metrics["known_source_value_recall"]["value"], 70)
        self.assertEqual(metrics["worker_terminal_page"]["state"], "MEASURED")
        self.assertEqual(metrics["reconstruction_match"], {
            "direction": "higher", "state": "MEASURED", "value": 70, "denominator": 70,
        })

    def test_rejects_builder_receipt_for_a_different_artifact(self):
        self.build_receipt["artifactSha256"] = "b" * 64

        with self.assertRaisesRegex(ReceiptError, "builder receipt artifact"):
            self.merge()

    def test_rejects_runtime_output_that_differs_from_the_fixture_contract(self):
        self.enrollment_receipt["fixtureOracle"]["observedStdout"] = "2486"

        with self.assertRaisesRegex(ReceiptError, "runtime output differs"):
            self.merge()

    def test_rejects_incomplete_module_inventory(self):
        self.integration_evidence["fixtures"][self.fixture_id]["metrics"]["extracted_module_count"]["value"] = 179

        with self.assertRaisesRegex(ReceiptError, "integration evidence module count"):
            self.merge()

    def test_rejects_reconstruction_matches_outside_the_source_denominator(self):
        metric = self.integration_evidence["fixtures"][self.fixture_id]["metrics"]["reconstruction_match"]
        metric["value"] = 71

        with self.assertRaisesRegex(ReceiptError, "source correspondence count"):
            self.merge()

    def test_rejects_unavailable_source_correspondence(self):
        metric = self.integration_evidence["fixtures"][self.fixture_id]["metrics"]["reconstruction_match"]
        metric.update(state="UNAVAILABLE", value=None, reason="not measured")

        with self.assertRaisesRegex(ReceiptError, "lacks measured source correspondence"):
            self.merge()

    def test_merges_complete_mutation_negative_controls(self):
        metrics = self.evaluation_manifest["metrics"]
        metrics["negative_control_mutation_rejection"] = {"direction": "higher", "denominator": 70}
        metrics["negative_control_false_acceptance"] = {"direction": "lower", "denominator": 70}
        measurements = self.integration_evidence["fixtures"][self.fixture_id]["metrics"]
        measurements["negative_control_mutation_rejection"] = {
            "state": "MEASURED", "value": 70, "denominator": 70,
        }
        measurements["negative_control_false_acceptance"] = {
            "state": "MEASURED", "value": 0, "denominator": 70,
        }

        merged = self.merge()["fixtures"][self.fixture_id]["metrics"]

        self.assertEqual(merged["negative_control_mutation_rejection"]["value"], 70)
        self.assertEqual(merged["negative_control_false_acceptance"]["value"], 0)

    def test_rejects_incomplete_mutation_negative_control_outcomes(self):
        metrics = self.evaluation_manifest["metrics"]
        metrics["negative_control_mutation_rejection"] = {"direction": "higher", "denominator": 70}
        metrics["negative_control_false_acceptance"] = {"direction": "lower", "denominator": 70}
        measurements = self.integration_evidence["fixtures"][self.fixture_id]["metrics"]
        measurements["negative_control_mutation_rejection"] = {
            "state": "MEASURED", "value": 69, "denominator": 70,
        }
        measurements["negative_control_false_acceptance"] = {
            "state": "MEASURED", "value": 0, "denominator": 70,
        }

        with self.assertRaisesRegex(ReceiptError, "do not account for the declared source denominator"):
            self.merge()

    def test_rejects_malformed_enrollment_page_sizes(self):
        self.enrollment_receipt["extractorInventory"]["pageSizes"] = ["180"]

        with self.assertRaisesRegex(ReceiptError, "enrollment receipt pages"):
            self.merge()


if __name__ == "__main__":
    unittest.main()
