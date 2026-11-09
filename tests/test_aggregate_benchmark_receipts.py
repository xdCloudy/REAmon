from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from tooling.benchmarks.aggregate_matrix_receipts import ReceiptError, combine_matrix


class AggregateBenchmarkReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fixtures = {
            "native-fixture": "a" * 64,
            "managed-fixture": "b" * 64,
        }
        self.matrix_manifest = self.root / "matrix-fixtures.json"
        self.write_json(self.matrix_manifest, {
            "schemaVersion": 1,
            "fixtures": {
                fixture_id: {"artifact": {"sha256": digest}}
                for fixture_id, digest in self.fixtures.items()
            },
        })
        self.evaluation_manifest = self.root / "evaluation.json"
        self.write_json(self.evaluation_manifest, {
            "schemaVersion": 1,
            "metrics": {
                "inventory": {"direction": "equal", "denominator": 1},
                "source_match": {"direction": "higher", "denominator": None},
            },
        })
        self.toolchain_manifest = self.root / "toolchain.json"
        self.components = {"native-decompiler": "v1", "managed-decompiler": "v2"}
        self.write_json(self.toolchain_manifest, {"schemaVersion": 1, "components": self.components})
        self.config = self.root / "matrix.json"
        self.parts = {"baseline": {}, "candidate": {}}
        cases = {}
        self.evaluation_hash = self.digest(self.evaluation_manifest)
        self.toolchain_hash = self.digest(self.toolchain_manifest)

        for index, (fixture_id, artifact_hash) in enumerate(self.fixtures.items(), start=1):
            fixture_manifest_path = self.root / f"{fixture_id}.json"
            self.write_json(fixture_manifest_path, {
                "schemaVersion": 1,
                "fixtureId": fixture_id,
                "artifact": {"sha256": artifact_hash},
            })
            case = {"fixtureManifest": fixture_manifest_path.name}
            for label, commit in (("baseline", "1" * 40), ("candidate", "2" * 40)):
                receipt_path = self.root / f"{label}-{fixture_id}.json"
                receipt = {
                    "schemaVersion": 1,
                    "runId": f"{label}-{fixture_id}",
                    "commit": commit,
                    "worktreeClean": True,
                    "fixtureManifestSha256": self.digest(fixture_manifest_path),
                    "evaluationManifestSha256": self.evaluation_hash,
                    "toolchainManifestSha256": self.toolchain_hash,
                    "components": self.components,
                    "fixtures": {
                        fixture_id: {
                            "artifactSha256": artifact_hash,
                            "metrics": {
                                "inventory": {
                                    "direction": "equal", "state": "MEASURED",
                                    "value": 8, "denominator": 1,
                                },
                                "source_match": {
                                    "direction": "higher", "state": "MEASURED",
                                    "value": index, "denominator": index + 1,
                                },
                            },
                        },
                    },
                }
                self.write_json(receipt_path, receipt)
                case[f"{label}Receipt"] = receipt_path.name
                self.parts[label][fixture_id] = receipt_path
            cases[fixture_id] = case

        self.write_json(self.config, {
            "schemaVersion": 1,
            "fixtureManifest": self.matrix_manifest.name,
            "evaluationManifest": self.evaluation_manifest.name,
            "toolchainManifest": self.toolchain_manifest.name,
            "fixtures": cases,
        })

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def write_json(path: Path, value):
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    @staticmethod
    def digest(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def read_part(self, label, fixture_id):
        return json.loads(self.parts[label][fixture_id].read_text(encoding="utf-8"))

    def save_part(self, label, fixture_id, value):
        self.write_json(self.parts[label][fixture_id], value)

    def test_combines_complete_matrix_and_preserves_per_fixture_provenance(self):
        output = self.root / "aggregate"

        report = combine_matrix(config_path=self.config, output_dir=output, run_prefix="test-run")

        self.assertEqual(report["status"], "NO_REGRESSION_OBSERVED")
        baseline = json.loads((output / "baseline.json").read_text(encoding="utf-8"))
        self.assertEqual(baseline["commit"], "1" * 40)
        self.assertEqual(set(baseline["fixtures"]), set(self.fixtures))
        self.assertEqual(set(baseline["constituentReceiptSha256"]), set(self.fixtures))
        self.assertEqual(baseline["fixtures"]["managed-fixture"]["metrics"]["source_match"]["denominator"], 3)

    def test_missing_fixture_is_rejected_before_output(self):
        config = json.loads(self.config.read_text(encoding="utf-8"))
        config["fixtures"].pop("managed-fixture")
        self.write_json(self.config, config)
        output = self.root / "missing-fixture-output"

        with self.assertRaisesRegex(ReceiptError, "exactly match"):
            combine_matrix(config_path=self.config, output_dir=output)
        self.assertFalse(output.exists())

    def test_fixture_parts_from_different_commits_are_rejected(self):
        part = self.read_part("baseline", "managed-fixture")
        part["commit"] = "3" * 40
        self.save_part("baseline", "managed-fixture", part)

        with self.assertRaisesRegex(ReceiptError, "do not share one source commit"):
            combine_matrix(config_path=self.config, output_dir=self.root / "mixed-commit-output")

    def test_fixture_parts_with_different_toolchains_are_rejected(self):
        part = self.read_part("candidate", "managed-fixture")
        part["toolchainManifestSha256"] = "f" * 64
        self.save_part("candidate", "managed-fixture", part)

        with self.assertRaisesRegex(ReceiptError, "toolchain manifest hash differs"):
            combine_matrix(config_path=self.config, output_dir=self.root / "mixed-toolchain-output")

    def test_denominator_mismatch_remains_incomplete_in_aggregate(self):
        part = self.read_part("candidate", "managed-fixture")
        part["fixtures"]["managed-fixture"]["metrics"]["source_match"]["denominator"] = 2
        self.save_part("candidate", "managed-fixture", part)

        report = combine_matrix(config_path=self.config, output_dir=self.root / "denominator-output")

        self.assertEqual(report["status"], "INCOMPLETE")
        metric = report["fixtures"]["managed-fixture"]["metrics"]["source_match"]
        self.assertEqual(metric["state"], "INCOMPLETE")
        self.assertIsNone(metric["delta"])

    def test_existing_output_is_never_overwritten(self):
        output = self.root / "existing-output"
        output.mkdir()
        marker = output / "keep.txt"
        marker.write_text("preserve", encoding="utf-8")

        with self.assertRaisesRegex(ReceiptError, "refusing to overwrite"):
            combine_matrix(config_path=self.config, output_dir=output)
        self.assertEqual(marker.read_text(encoding="utf-8"), "preserve")


if __name__ == "__main__":
    unittest.main()
