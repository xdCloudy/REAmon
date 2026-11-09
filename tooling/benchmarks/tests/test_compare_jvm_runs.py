from __future__ import annotations

import unittest

from tooling.benchmarks.compare_jvm_runs import ComparisonError, compare_runs


ARTIFACT = "a" * 64
SOURCE_ONE = "b" * 64
SOURCE_TWO = "c" * 64
BYTECODE_MAIN = "d" * 64
BYTECODE_ENGINE = "e" * 64


def run_pair_inputs():
    manifest = {
        "fixtureId": "jvm-two-class-test",
        "sourceModuleCount": 2,
        "expectedRuntimeStdout": "expected-output",
        "artifact": {"sha256": ARTIFACT},
    }

    def run(run_id: str):
        provider = {
            "status": "completed",
            "toolVersion": "0.152",
            "artifactSha256": ARTIFACT,
            "sourceFileCount": 2,
            "truncated": False,
            "units": [
                {"relativePath": "pkg/Main.java", "outputSha256": SOURCE_ONE},
                {"relativePath": "pkg/Engine.java", "outputSha256": SOURCE_TWO},
            ],
        }
        validation = {
            "fixtureId": manifest["fixtureId"],
            "artifactSha256": ARTIFACT,
            "repositoryRevision": "f" * 40,
            "runnerSha256": "1" * 64,
            "provider": "CFR 0.152",
            "serviceImageId": "sha256:service-image",
            "runId": run_id,
            "discoveredSourceFiles": 2,
            "expectedSourceFiles": 2,
            "truncated": False,
            "recoveredSourceSha256ByPath": {
                "pkg/Main.java": SOURCE_ONE,
                "pkg/Engine.java": SOURCE_TWO,
            },
            "sourceCorrespondence": {
                "method": "javap -p -s -c exact output per expected class, compiled with the same pinned JDK",
                "classesMatched": 2,
                "classesExpected": 2,
                "measurementComplete": True,
                "allClassesMatched": True,
                "classes": {
                    "pkg.Main": {
                        "bytecodeMatch": True,
                        "originalJavapSha256": BYTECODE_MAIN,
                        "recoveredJavapSha256": BYTECODE_MAIN,
                    },
                    "pkg.Engine": {
                        "bytecodeMatch": True,
                        "originalJavapSha256": BYTECODE_ENGINE,
                        "recoveredJavapSha256": BYTECODE_ENGINE,
                    },
                },
            },
            "compileCommand": "javac --release 17",
            "compileEnvironment": "pinned Docker JDK",
            "expectedRuntimeStdout": "expected-output",
            "observedRuntimeStdout": "expected-output",
            "runtimeMatches": True,
        }
        return provider, validation

    return manifest, run("baseline-run"), run("candidate-run")


class CompareJvmRunsTests(unittest.TestCase):
    def test_same_revision_runs_report_repeatable_outputs_and_bytecode(self):
        manifest, baseline, candidate = run_pair_inputs()
        report = compare_runs(
            baseline_provider=baseline[0], baseline_validation=baseline[1],
            candidate_provider=candidate[0], candidate_validation=candidate[1],
            manifest=manifest,
        )

        self.assertEqual(report["status"], "NO_VARIATION_OBSERVED")
        self.assertEqual(report["recoveredSourceHashRepeatability"], {"matchingFiles": 2, "expectedFiles": 2})
        self.assertEqual(report["bytecodeCorrespondence"]["repeatableClasses"], 2)
        self.assertIn("not a product-change", report["comparisonKind"])

    def test_source_output_variation_is_reported_without_claiming_runtime_failure(self):
        manifest, baseline, candidate = run_pair_inputs()
        candidate[0]["units"][1]["outputSha256"] = "2" * 64
        candidate[1]["recoveredSourceSha256ByPath"]["pkg/Engine.java"] = "2" * 64

        report = compare_runs(
            baseline_provider=baseline[0], baseline_validation=baseline[1],
            candidate_provider=candidate[0], candidate_validation=candidate[1],
            manifest=manifest,
        )

        self.assertEqual(report["status"], "VARIATION_OBSERVED")
        self.assertTrue(report["runtime"]["bothMatchFixtureOracle"])

    def test_bytecode_mismatch_is_measured_not_incomplete(self):
        manifest, baseline, candidate = run_pair_inputs()
        candidate[1]["sourceCorrespondence"]["classesMatched"] = 1
        candidate[1]["sourceCorrespondence"]["allClassesMatched"] = False
        candidate[1]["sourceCorrespondence"]["classes"]["pkg.Engine"]["bytecodeMatch"] = False
        candidate[1]["sourceCorrespondence"]["classes"]["pkg.Engine"]["recoveredJavapSha256"] = "2" * 64

        report = compare_runs(
            baseline_provider=baseline[0], baseline_validation=baseline[1],
            candidate_provider=candidate[0], candidate_validation=candidate[1],
            manifest=manifest,
        )

        self.assertEqual(report["status"], "VARIATION_OBSERVED")
        self.assertTrue(report["measurementComplete"])
        self.assertEqual(report["bytecodeCorrespondence"]["candidateClassesMatched"], 1)

    def test_different_artifacts_are_rejected(self):
        manifest, baseline, candidate = run_pair_inputs()
        candidate[0]["artifactSha256"] = "2" * 64

        with self.assertRaisesRegex(ComparisonError, "enrolled fixture"):
            compare_runs(
                baseline_provider=baseline[0], baseline_validation=baseline[1],
                candidate_provider=candidate[0], candidate_validation=candidate[1],
                manifest=manifest,
            )


if __name__ == "__main__":
    unittest.main()
