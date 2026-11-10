import hashlib
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicate_keys)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class StructuredSourceBenchmarkManifestTests(unittest.TestCase):
    def test_evaluation_contract_matches_fixture_identity_and_denominators(self):
        manifest = load_json(ROOT / "manifest.json")
        evaluation = load_json(ROOT / "evaluation-manifest.json")

        self.assertEqual(manifest["status"], "fixture-enrollment-verified")
        self.assertEqual(evaluation["schemaVersion"], 1)
        self.assertEqual(evaluation["fixtureId"], manifest["fixtureId"])
        self.assertEqual(evaluation["metrics"]["known_source_value_recall"]["denominator"], 70)
        self.assertEqual(evaluation["metrics"]["reconstruction_match"]["denominator"], 70)
        self.assertIn("function and branch", evaluation["metrics"]["reconstruction_match"]["description"])
        self.assertEqual(evaluation["metrics"]["negative_control_mutation_rejection"]["denominator"], 70)
        self.assertEqual(evaluation["metrics"]["negative_control_false_acceptance"]["denominator"], 70)

    def test_builder_contract_is_pinned_and_ground_truth_is_not_analyzer_input(self):
        manifest = load_json(ROOT / "manifest.json")
        enrollment = load_json(ROOT / "enrollment-receipt.json")

        self.assertEqual(manifest["status"], "fixture-enrollment-verified")
        self.assertEqual(manifest["target"]["extractedBytecodeModuleCount"], 180)
        self.assertEqual(manifest["target"]["moduleSourceCount"], 70)
        self.assertEqual(manifest["artifact"]["path"], "pyinstaller-module-structured-source")
        self.assertEqual(enrollment["fixtureId"], manifest["fixtureId"])
        self.assertEqual(enrollment["build"]["artifactSha256"], manifest["artifact"]["sha256"])
        self.assertEqual(enrollment["build"]["artifactSizeBytes"], manifest["artifact"]["sizeBytes"])
        self.assertEqual(enrollment["fixtureOracle"]["state"], "PASSED")
        self.assertEqual(enrollment["extractorInventory"]["moduleCount"], 180)
        self.assertEqual(sum(enrollment["extractorInventory"]["pageSizes"]), 180)
        self.assertTrue(manifest["groundTruth"]["hiddenFromAnalyzerInput"])
        self.assertEqual(
            manifest["groundTruth"]["licenseSha256"],
            sha256(ROOT / manifest["groundTruth"]["licenseFile"]),
        )
        self.assertEqual(
            manifest["extractor"]["dockerfileSha256"],
            enrollment["extractorInventory"]["extractorDockerfileSha256"],
        )
        self.assertEqual(
            manifest["extractor"]["serverSha256"],
            enrollment["extractorInventory"]["extractorServerSha256"],
        )
        self.assertEqual(
            manifest["extractor"]["upstreamGoModSha256"],
            enrollment["extractorInventory"]["extractorUpstreamGoModSha256"],
        )
        self.assertEqual(manifest["builder"]["dockerfileSha256"], sha256(ROOT / "Dockerfile"))
        self.assertEqual(manifest["builder"]["requirementsSha256"], sha256(ROOT / "requirements.txt"))
        self.assertEqual(manifest["groundTruth"]["sha256"], sha256(ROOT / "build_fixture.py"))

    def test_current_builder_pins_reproducible_artifact_inputs(self):
        manifest = load_json(ROOT / "manifest.json")
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

        self.assertEqual(manifest["fixtureVersion"], 2)
        self.assertIn("SOURCE_DATE_EPOCH=1767225600", dockerfile)
        self.assertIn("PYTHONHASHSEED=0", dockerfile)
        self.assertIn("--work-root /tmp/reamon-pyi-structured-build", dockerfile)
        self.assertIn("Version 1 manifest", manifest["artifact"]["note"])


if __name__ == "__main__":
    unittest.main()
