from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from tooling.benchmarks.merge_jvm_evidence import EvidenceError, merge_evidence


class MergeJvmEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.artifact_hash = "a" * 64
        self.source_hashes = {
            "org/reamon/fixture/Main.java": "b" * 64,
            "org/reamon/fixture/RuleEngine.java": "c" * 64,
        }
        self.database_evidence = {
            "schemaVersion": 1,
            "fixtureId": "jvm-multimodule-cfr-linux-amd64",
            "artifactSha256": self.artifact_hash,
            "sourceFileCount": 2,
            "persistedCodeUnitCount": 2,
            "storedSourceHashes": dict(self.source_hashes),
            "allStoredSourcesHashVerified": True,
        }
        self.database_path = Path(self.temporary.name) / "database-evidence.json"
        self.database_path.write_text(json.dumps(self.database_evidence), encoding="utf-8")
        self.validation = {
            "fixtureId": "jvm-multimodule-cfr-linux-amd64",
            "artifactSha256": self.artifact_hash,
            "databaseIntegrationEvidenceSha256": hashlib.sha256(self.database_path.read_bytes()).hexdigest(),
            "recoveredSourceSha256ByPath": dict(self.source_hashes),
            "truncated": False,
            "discoveredSourceFiles": 2,
            "expectedSourceFiles": 2,
            "sourceCorrespondence": {
                "classesMatched": 2,
                "classesExpected": 2,
                "measurementComplete": True,
                "classes": {
                    "Main": {
                        "bytecodeMatch": True,
                        "originalJavapSha256": "e" * 64,
                        "recoveredJavapSha256": "e" * 64,
                    },
                    "RuleEngine": {
                        "bytecodeMatch": True,
                        "originalJavapSha256": "f" * 64,
                        "recoveredJavapSha256": "f" * 64,
                    },
                },
            },
            "runtimeMatches": True,
            "observedRuntimeStdout": "expected output",
            "expectedRuntimeStdout": "expected output",
            "behavioralCorrespondence": {
                "inputCount": 8197,
                "allOutputsMatch": True,
                "originalOutputSha256": "d" * 64,
                "recoveredOutputSha256": "d" * 64,
            },
        }
        self.fixture_manifest = {
            "fixtureId": "jvm-multimodule-cfr-linux-amd64",
            "sourceModuleCount": 2,
            "artifact": {"sha256": self.artifact_hash},
        }

    def merge(self):
        return merge_evidence(
            fixture_manifest=self.fixture_manifest,
            validation=self.validation,
            database_evidence=self.database_evidence,
            database_evidence_sha256=hashlib.sha256(self.database_path.read_bytes()).hexdigest(),
        )

    def test_merges_only_hash_correlated_persisted_and_validated_sources(self):
        result = self.merge()
        metrics = result["fixtures"]["jvm-multimodule-cfr-linux-amd64"]["metrics"]
        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(metrics["recovered_source_files"], {"state": "MEASURED", "denominator": 2, "value": 2})
        self.assertEqual(metrics["source_inventory_complete"], {"state": "MEASURED", "denominator": 1, "value": 1})
        self.assertEqual(metrics["exact_bytecode_classes"], {"state": "MEASURED", "denominator": 2, "value": 2})
        self.assertEqual(metrics["runtime_oracle"], {"state": "MEASURED", "denominator": 1, "value": 1})
        self.assertEqual(metrics["sampled_behavior_oracle"], {"state": "MEASURED", "denominator": 1, "value": 1})

    def test_rejects_database_source_hashes_that_differ_from_validation(self):
        self.database_evidence["storedSourceHashes"]["org/reamon/fixture/Main.java"] = "e" * 64
        with self.assertRaisesRegex(EvidenceError, "persisted source paths or hashes differ"):
            self.merge()

    def test_rejects_unbound_database_evidence(self):
        self.validation["databaseIntegrationEvidenceSha256"] = "f" * 64
        with self.assertRaisesRegex(EvidenceError, "does not bind"):
            self.merge()

    def test_unavailable_validation_dimensions_remain_unavailable(self):
        self.validation.pop("behavioralCorrespondence")
        self.validation["sourceCorrespondence"]["measurementComplete"] = False
        metrics = self.merge()["fixtures"]["jvm-multimodule-cfr-linux-amd64"]["metrics"]
        self.assertEqual(metrics["exact_bytecode_classes"]["state"], "UNAVAILABLE")
        self.assertEqual(metrics["sampled_behavior_oracle"]["state"], "UNAVAILABLE")

    def test_behavior_mismatch_is_measured_as_zero(self):
        self.validation["behavioralCorrespondence"]["recoveredOutputSha256"] = "e" * 64
        metrics = self.merge()["fixtures"]["jvm-multimodule-cfr-linux-amd64"]["metrics"]
        self.assertEqual(metrics["sampled_behavior_oracle"], {"state": "MEASURED", "denominator": 1, "value": 0})

    def test_rejects_bytecode_summary_that_contradicts_class_hashes(self):
        self.validation["sourceCorrespondence"]["classes"]["Main"]["bytecodeMatch"] = False
        with self.assertRaisesRegex(EvidenceError, "inconsistent for Main"):
            self.merge()


if __name__ == "__main__":
    unittest.main()
