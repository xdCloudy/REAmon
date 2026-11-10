import unittest

from tooling.benchmarks.compare_receipts import ReceiptError
from tooling.benchmarks.merge_jvm_evidence import merge_jvm_evidence


class MergeJvmEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture_id = "jvm-multimodule-cfr-linux-amd64"
        self.artifact_hash = "a" * 64
        self.source_paths = [
            "org/reamon/fixture/Main.java",
            "org/reamon/fixture/RuleEngine.java",
        ]
        self.fixture_manifest = {
            "schemaVersion": 1,
            "fixtureId": self.fixture_id,
            "artifact": {"sha256": self.artifact_hash},
            "sourceModuleCount": 2,
            "expectedRuntimeStdout": "low:-15,high:42,high:22",
        }
        self.build_receipt = {
            "fixtureId": self.fixture_id,
            "artifactSha256": self.artifact_hash,
            "sourceSha256ByPath": {path: "b" * 64 for path in self.source_paths},
        }
        self.provider_receipt = {
            "status": "completed",
            "artifactSha256": self.artifact_hash,
            "sourceFileCount": 2,
            "truncated": False,
            "units": [
                {"relativePath": path, "outputSha256": "c" * 64}
                for path in self.source_paths
            ],
        }
        self.validation_receipt = {
            "schemaVersion": 1,
            "fixtureId": self.fixture_id,
            "artifactSha256": self.artifact_hash,
            "recoveredSourceSha256ByPath": {path: "c" * 64 for path in self.source_paths},
            "discoveredSourceFiles": 2,
            "expectedSourceFiles": 2,
            "truncated": False,
            "sourceCorrespondence": {
                "classesExpected": 2,
                "classesMatched": 2,
                "measurementComplete": True,
                "allClassesMatched": True,
                "classes": {
                    "org.reamon.fixture.Main": self.class_result(True),
                    "org.reamon.fixture.RuleEngine": self.class_result(True),
                },
            },
            "expectedRuntimeStdout": "low:-15,high:42,high:22",
            "observedRuntimeStdout": "low:-15,high:42,high:22",
            "runtimeMatches": True,
            "behavioralCorrespondence": {
                "inputCount": 8197,
                "allOutputsMatch": True,
                "originalOutputSha256": "d" * 64,
                "recoveredOutputSha256": "d" * 64,
            },
        }

    @staticmethod
    def class_result(matched):
        return {
            "bytecodeMatch": matched,
            "originalJavapSha256": "e" * 64,
            "recoveredJavapSha256": "e" * 64 if matched else "f" * 64,
        }

    def merge(self):
        return merge_jvm_evidence(
            fixture_manifest=self.fixture_manifest,
            build_receipt=self.build_receipt,
            provider_receipt=self.provider_receipt,
            validation_receipt=self.validation_receipt,
        )

    def test_records_complete_inventory_and_all_oracles(self):
        metrics = self.merge()["fixtures"][self.fixture_id]["metrics"]

        self.assertEqual(metrics["recovered_source_files"], {
            "state": "MEASURED", "value": 2, "denominator": 2,
        })
        self.assertEqual(metrics["source_inventory_complete"]["value"], 1)
        self.assertEqual(metrics["exact_bytecode_classes"]["value"], 2)
        self.assertEqual(metrics["runtime_oracle"]["value"], 1)
        self.assertEqual(metrics["sampled_behavior_oracle"], {
            "state": "MEASURED", "value": 1, "denominator": 1,
        })

    def test_preserves_partial_bytecode_correspondence(self):
        result = self.validation_receipt["sourceCorrespondence"]
        result["classes"]["org.reamon.fixture.RuleEngine"] = self.class_result(False)
        result["classesMatched"] = 1
        result["allClassesMatched"] = False

        metric = self.merge()["fixtures"][self.fixture_id]["metrics"]["exact_bytecode_classes"]

        self.assertEqual(metric, {"state": "MEASURED", "value": 1, "denominator": 2})

    def test_marks_behavior_unavailable_when_full_sample_is_absent(self):
        del self.validation_receipt["behavioralCorrespondence"]

        metric = self.merge()["fixtures"][self.fixture_id]["metrics"]["sampled_behavior_oracle"]

        self.assertEqual(metric["state"], "UNAVAILABLE")
        self.assertIsNone(metric["value"])
        self.assertEqual(metric["denominator"], 1)

    def test_rejects_artifact_hash_mismatch(self):
        self.provider_receipt["artifactSha256"] = "f" * 64

        with self.assertRaisesRegex(ReceiptError, "provider artifact"):
            self.merge()

    def test_rejects_source_hash_map_mismatch(self):
        self.validation_receipt["recoveredSourceSha256ByPath"][self.source_paths[0]] = "f" * 64

        with self.assertRaisesRegex(ReceiptError, "source hashes differ"):
            self.merge()

    def test_rejects_bytecode_match_claim_with_different_javap_hashes(self):
        self.validation_receipt["sourceCorrespondence"]["classes"][
            "org.reamon.fixture.Main"
        ]["recoveredJavapSha256"] = "f" * 64

        with self.assertRaisesRegex(ReceiptError, "hashes disagree"):
            self.merge()

    def test_rejects_runtime_flag_that_disagrees_with_observed_output(self):
        self.validation_receipt["observedRuntimeStdout"] = "wrong output"

        with self.assertRaisesRegex(ReceiptError, "runtime result disagrees"):
            self.merge()


if __name__ == "__main__":
    unittest.main()
