#!/usr/bin/env python3
"""Compare repeated JVM fixture runs for output and bytecode repeatability."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


class ComparisonError(ValueError):
    """Raised when run receipts do not form a comparable pair."""


SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def _load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ComparisonError(f"cannot read JSON receipt {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ComparisonError(f"receipt must contain a JSON object: {path}")
    return value


def _validate_run(label: str, provider: dict, validation: dict, manifest: dict) -> dict:
    expected_artifact = manifest.get("artifact", {}).get("sha256")
    fixture_id = manifest.get("fixtureId")
    if validation.get("fixtureId") != fixture_id or provider.get("artifactSha256") != expected_artifact:
        raise ComparisonError(f"{label} receipt does not match the enrolled fixture")
    if validation.get("artifactSha256") != expected_artifact:
        raise ComparisonError(f"{label} validation artifact hash differs from the enrolled fixture")
    if provider.get("status") != "completed" or provider.get("truncated") is not False:
        raise ComparisonError(f"{label} provider result is incomplete or truncated")
    if validation.get("truncated") is not False or validation.get("runtimeMatches") is not True:
        raise ComparisonError(f"{label} validation did not pass inventory/runtime gates")
    if validation.get("expectedRuntimeStdout") != manifest.get("expectedRuntimeStdout"):
        raise ComparisonError(f"{label} expected runtime output differs from the fixture manifest")
    if validation.get("observedRuntimeStdout") != manifest.get("expectedRuntimeStdout"):
        raise ComparisonError(f"{label} observed runtime output does not match the fixture oracle")
    if validation.get("discoveredSourceFiles") != manifest.get("sourceModuleCount"):
        raise ComparisonError(f"{label} source inventory count differs from the enrolled denominator")
    if provider.get("sourceFileCount") != manifest.get("sourceModuleCount"):
        raise ComparisonError(f"{label} provider source count differs from the enrolled denominator")
    if validation.get("expectedSourceFiles") != manifest.get("sourceModuleCount"):
        raise ComparisonError(f"{label} expected source inventory differs from the enrolled denominator")
    if provider.get("toolVersion") != validation.get("provider", "").removeprefix("CFR "):
        raise ComparisonError(f"{label} provider version differs between receipts")

    units = provider.get("units")
    if not isinstance(units, list) or len(units) != manifest.get("sourceModuleCount"):
        raise ComparisonError(f"{label} provider unit records differ from the enrolled denominator")
    provider_outputs = {}
    for unit in units:
        if not isinstance(unit, dict) or not isinstance(unit.get("relativePath"), str):
            raise ComparisonError(f"{label} has an invalid provider unit record")
        source_path = unit["relativePath"]
        if source_path in provider_outputs:
            raise ComparisonError(f"{label} repeats a source path: {source_path}")
        provider_outputs[source_path] = unit.get("outputSha256")
    recorded_outputs = validation.get("recoveredSourceSha256ByPath")
    if not isinstance(recorded_outputs, dict) or set(provider_outputs) != set(recorded_outputs):
        raise ComparisonError(f"{label} provider and validation source inventories differ")
    for source_path, digest in provider_outputs.items():
        if not isinstance(digest, str) or not SHA256_PATTERN.fullmatch(digest):
            raise ComparisonError(f"{label} has an invalid source output hash for {source_path}")
        if recorded_outputs.get(source_path) != digest:
            raise ComparisonError(f"{label} output hash differs for {source_path}")

    correspondence = validation.get("sourceCorrespondence")
    classes = correspondence.get("classes") if isinstance(correspondence, dict) else None
    if not isinstance(classes, dict) or not classes:
        raise ComparisonError(f"{label} lacks bytecode correspondence records")
    matched = 0
    for class_name, result in classes.items():
        if not isinstance(result, dict):
            raise ComparisonError(f"{label} has an invalid class record for {class_name}")
        original_hash = result.get("originalJavapSha256")
        recovered_hash = result.get("recoveredJavapSha256")
        if not all(isinstance(value, str) and SHA256_PATTERN.fullmatch(value)
                   for value in (original_hash, recovered_hash)):
            raise ComparisonError(f"{label} has invalid javap hashes for {class_name}")
        if bool(result.get("bytecodeMatch")) != (original_hash == recovered_hash):
            raise ComparisonError(f"{label} bytecode match flag contradicts its hashes for {class_name}")
        matched += result["bytecodeMatch"] is True
    if correspondence.get("classesExpected") != len(classes):
        raise ComparisonError(f"{label} bytecode denominator differs from the class inventory")
    if (correspondence.get("measurementComplete") is not True
            or correspondence.get("classesMatched") != matched
            or correspondence.get("allClassesMatched") is not (matched == len(classes))):
        raise ComparisonError(f"{label} bytecode correspondence summary is inconsistent")

    return {
        "runId": validation.get("runId"),
        "repositoryRevision": validation.get("repositoryRevision"),
        "runnerSha256": validation.get("runnerSha256"),
        "provider": validation.get("provider"),
        "serviceImageId": validation.get("serviceImageId"),
        "artifactSha256": expected_artifact,
        "discoveredSourceFiles": validation.get("discoveredSourceFiles"),
        "truncated": validation.get("truncated"),
        "sourceHashes": recorded_outputs,
        "sourceCorrespondence": correspondence,
        "compileCommand": validation.get("compileCommand"),
        "compileEnvironment": validation.get("compileEnvironment"),
        "expectedRuntimeStdout": validation.get("expectedRuntimeStdout"),
        "observedRuntimeStdout": validation.get("observedRuntimeStdout"),
    }


def compare_runs(*, baseline_provider: dict, baseline_validation: dict,
                 candidate_provider: dict, candidate_validation: dict,
                 manifest: dict) -> dict:
    baseline = _validate_run("baseline", baseline_provider, baseline_validation, manifest)
    candidate = _validate_run("candidate", candidate_provider, candidate_validation, manifest)
    if baseline["runId"] == candidate["runId"]:
        raise ComparisonError("baseline and candidate must be distinct provider runs")
    for field in ("repositoryRevision", "runnerSha256", "provider", "serviceImageId", "artifactSha256",
                  "compileCommand", "compileEnvironment", "expectedRuntimeStdout"):
        if baseline[field] != candidate[field]:
            raise ComparisonError(f"baseline and candidate differ in required comparison scope: {field}")

    source_paths = set(baseline["sourceHashes"]) | set(candidate["sourceHashes"])
    source_matches = sum(
        baseline["sourceHashes"].get(path) == candidate["sourceHashes"].get(path)
        for path in source_paths
    )
    baseline_classes = baseline["sourceCorrespondence"]["classes"]
    candidate_classes = candidate["sourceCorrespondence"]["classes"]
    if set(baseline_classes) != set(candidate_classes):
        raise ComparisonError("baseline and candidate bytecode class inventories differ")
    class_repeatability = {
        name: {
            "baselineOriginalJavapSha256": baseline_classes[name]["originalJavapSha256"],
            "candidateOriginalJavapSha256": candidate_classes[name]["originalJavapSha256"],
            "baselineRecoveredJavapSha256": baseline_classes[name]["recoveredJavapSha256"],
            "candidateRecoveredJavapSha256": candidate_classes[name]["recoveredJavapSha256"],
            "bytecodeMatchBaseline": baseline_classes[name]["bytecodeMatch"],
            "bytecodeMatchCandidate": candidate_classes[name]["bytecodeMatch"],
            "repeatable": baseline_classes[name] == candidate_classes[name],
        }
        for name in sorted(baseline_classes)
    }
    class_repeatable_count = sum(item["repeatable"] for item in class_repeatability.values())
    complete = (baseline["sourceCorrespondence"]["measurementComplete"]
                and candidate["sourceCorrespondence"]["measurementComplete"])
    stable = (
        source_matches == len(source_paths)
        and class_repeatable_count == len(class_repeatability)
        and baseline["observedRuntimeStdout"] == candidate["observedRuntimeStdout"]
    )
    return {
        "schemaVersion": 1,
        "comparisonKind": "same-revision JVM provider repeatability; not a product-change regression claim",
        "status": "NO_VARIATION_OBSERVED" if stable else "VARIATION_OBSERVED",
        "measurementComplete": complete,
        "baselineRunId": baseline["runId"],
        "candidateRunId": candidate["runId"],
        "fixtureId": manifest.get("fixtureId"),
        "artifactSha256": baseline["artifactSha256"],
        "productRevision": baseline["repositoryRevision"],
        "runnerSha256": baseline["runnerSha256"],
        "provider": baseline["provider"],
        "serviceImageId": baseline["serviceImageId"],
        "inventory": {
            "expectedFiles": manifest.get("sourceModuleCount"),
            "baselineFiles": baseline["discoveredSourceFiles"],
            "candidateFiles": candidate["discoveredSourceFiles"],
            "baselineTruncated": baseline["truncated"],
            "candidateTruncated": candidate["truncated"],
        },
        "recoveredSourceHashRepeatability": {
            "matchingFiles": source_matches,
            "expectedFiles": len(source_paths),
        },
        "bytecodeCorrespondence": {
            "method": "javap -p -s -c exact output per class",
            "baselineClassesMatched": baseline["sourceCorrespondence"]["classesMatched"],
            "candidateClassesMatched": candidate["sourceCorrespondence"]["classesMatched"],
            "expectedClasses": len(class_repeatability),
            "repeatableClasses": class_repeatable_count,
            "classes": class_repeatability,
        },
        "compile": {
            "command": baseline["compileCommand"],
            "environment": baseline["compileEnvironment"],
        },
        "runtime": {
            "expectedStdout": baseline["expectedRuntimeStdout"],
            "baselineStdout": baseline["observedRuntimeStdout"],
            "candidateStdout": candidate["observedRuntimeStdout"],
            "bothMatchFixtureOracle": True,
        },
        "interpretation": (
            "Both runs use the same source revision, runner, provider image, artifact, and toolchain. "
            "This measures repeatability and bounded bytecode correspondence only; it does not compare "
            "a product change or prove original-source recovery."
        ),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-manifest", required=True)
    parser.add_argument("--baseline-dir", required=True)
    parser.add_argument("--candidate-dir", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        manifest = _load(Path(args.fixture_manifest))
        baseline_dir = Path(args.baseline_dir)
        candidate_dir = Path(args.candidate_dir)
        report = compare_runs(
            baseline_provider=_load(baseline_dir / "provider-receipt.json"),
            baseline_validation=_load(baseline_dir / "validation-receipt.json"),
            candidate_provider=_load(candidate_dir / "provider-receipt.json"),
            candidate_validation=_load(candidate_dir / "validation-receipt.json"),
            manifest=manifest,
        )
        output = Path(args.output)
        if output.exists():
            raise ComparisonError(f"refusing to overwrite existing comparison: {output}")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"{report['status']}: repeatability comparison written to {output}")
        return {"NO_VARIATION_OBSERVED": 0, "VARIATION_OBSERVED": 1, "INCOMPLETE": 2}[report["status"]]
    except (ComparisonError, OSError, KeyError, TypeError, AttributeError) as exc:
        print(f"compare_jvm_runs: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
