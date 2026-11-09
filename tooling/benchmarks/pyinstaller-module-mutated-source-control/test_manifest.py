import hashlib
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[2]


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


class MutatedSourceControlManifestTests(unittest.TestCase):
    def test_evaluation_contract_matches_the_mutated_fixture_and_full_denominators(self):
        manifest = load_json(ROOT / "manifest.json")
        evaluation = load_json(ROOT / "evaluation-manifest.json")

        self.assertEqual(manifest["status"], "fixture-enrollment-verified")
        self.assertEqual(evaluation["fixtureId"], manifest["fixtureId"])
        self.assertEqual(evaluation["metrics"]["reconstruction_match"]["denominator"], 70)
        self.assertEqual(evaluation["metrics"]["negative_control_original_source_false_acceptance"]["denominator"], 70)
        self.assertEqual(manifest["integration"]["artifactVolumePath"], "/data/qa/pyinstaller-module-mutated-source-control/fixture")

    def test_build_and_enrollment_receipts_bind_the_mutated_behavior_and_artifact(self):
        manifest = load_json(ROOT / "manifest.json")
        enrollment = load_json(ROOT / "enrollment-receipt.json")

        self.assertEqual(manifest["artifact"]["sha256"], enrollment["build"]["artifactSha256"])
        self.assertEqual(manifest["artifact"]["sizeBytes"], enrollment["build"]["artifactSizeBytes"])
        self.assertEqual(enrollment["fixtureOracle"]["state"], "PASSED")
        self.assertEqual(enrollment["fixtureOracle"]["branchAssertions"], 2)
        self.assertIn("under/at-or-above", enrollment["sourceOracle"]["shape"])
        self.assertFalse(enrollment["sourceOracle"]["visibleToAnalyzer"])
        self.assertEqual(enrollment["extractorInventory"]["moduleCount"], 180)
        self.assertEqual(sum(enrollment["extractorInventory"]["pageSizes"]), 180)

    def test_pinned_builder_and_extractor_inputs_match_the_manifest(self):
        manifest = load_json(ROOT / "manifest.json")

        self.assertEqual(manifest["target"]["moduleSourceCount"], 70)
        self.assertEqual(manifest["target"]["extractedBytecodeModuleCount"], 180)
        self.assertEqual(manifest["artifact"]["path"], "pyinstaller-module-structured-source-mutated")
        self.assertEqual(manifest["groundTruth"]["licenseSha256"], sha256(ROOT / manifest["groundTruth"]["licenseFile"]))
        self.assertEqual(manifest["extractor"]["serverSha256"], sha256(REPO_ROOT / "analyzers" / "pyinstaller" / "server.py"))
        self.assertEqual(manifest["builder"]["dockerfileSha256"], sha256(ROOT / "Dockerfile"))
        self.assertEqual(manifest["builder"]["requirementsSha256"], sha256(ROOT / "requirements.txt"))
        self.assertEqual(manifest["groundTruth"]["sha256"], sha256(ROOT / "build_fixture.py"))


if __name__ == "__main__":
    unittest.main()
