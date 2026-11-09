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


class BenchmarkManifestTests(unittest.TestCase):
    def test_manifest_and_receipt_have_no_duplicate_keys(self):
        manifest = load_json(ROOT / "manifest.json")
        receipt = load_json(ROOT / "enrollment-receipt.json")

        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(receipt["schemaVersion"], 1)

    def test_receipt_hashes_and_inventory_match_manifest(self):
        manifest = load_json(ROOT / "manifest.json")
        receipt = load_json(ROOT / "enrollment-receipt.json")
        builder = manifest["builder"]
        ground_truth = manifest["groundTruth"]
        extractor = manifest["extractor"]

        self.assertEqual(receipt["build"]["artifactSha256"], manifest["artifact"]["sha256"])
        self.assertEqual(receipt["build"]["artifactSizeBytes"], manifest["artifact"]["sizeBytes"])
        self.assertEqual(receipt["build"]["requirementsSha256"], sha256(ROOT / builder["requirements"]))
        self.assertEqual(receipt["build"]["builderDockerfileSha256"], sha256(ROOT / builder["dockerfile"]))
        self.assertEqual(receipt["build"]["groundTruthBuilderSha256"], sha256(ROOT / ground_truth["location"]))
        self.assertEqual(receipt["build"]["groundTruthLicenseSha256"], sha256(ROOT / ground_truth["licenseFile"]))
        self.assertEqual(receipt["build"]["extractorDockerfileSha256"], extractor["dockerfileSha256"])
        self.assertEqual(receipt["build"]["extractorServerSha256"], extractor["serverSha256"])
        self.assertEqual(receipt["build"]["extractorUpstreamGoModSha256"], extractor["upstreamGoModSha256"])

        inventory = receipt["extractorInventory"]
        self.assertEqual(inventory["moduleCount"], manifest["target"]["extractedBytecodeModuleCount"])
        self.assertEqual(sum(inventory["pageSizes"]), inventory["moduleCount"])

    def test_semantic_claim_keeps_its_known_source_denominator(self):
        manifest = load_json(ROOT / "manifest.json")
        receipt = load_json(ROOT / "enrollment-receipt.json")
        oracle = receipt["providerPersistence"]["knownModuleOracle"]

        self.assertEqual(oracle["knownSourceModuleDenominator"], manifest["target"]["moduleSourceCount"])
        self.assertEqual(oracle["matchedModuleCount"], oracle["knownSourceModuleDenominator"])
        self.assertTrue(oracle["valueMatches"])
        self.assertEqual(oracle["remainingExtractedModulesNotSourceCompared"], 110)


if __name__ == "__main__":
    unittest.main()
