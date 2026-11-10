#!/usr/bin/env python3
"""Convert one validated JVM provider run into common matrix evidence."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

try:
    from .compare_receipts import ReceiptError, load_json
except ImportError:
    from compare_receipts import ReceiptError, load_json

EXPECTED_BEHAVIOR_INPUTS = 8_197
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")


def _is_sha256(value):
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def _safe_source_path(value):
    if not isinstance(value, str) or not value or "\\" in value or value.startswith("/"):
        return False
    parts = value.split("/")
    return all(part not in {"", ".", ".."} for part in parts)


def merge_jvm_evidence(*, fixture_manifest, build_receipt, provider_receipt,
                       validation_receipt):
    if not isinstance(fixture_manifest, dict) or fixture_manifest.get("schemaVersion") != 1:
        raise ReceiptError("JVM fixture manifest schemaVersion must be 1")
    fixture_id = fixture_manifest.get("fixtureId")
    artifact = fixture_manifest.get("artifact")
    if not isinstance(fixture_id, str) or not fixture_id or not isinstance(artifact, dict):
        raise ReceiptError("JVM fixture identity and artifact are required")
    artifact_hash = artifact.get("sha256")
    if not _is_sha256(artifact_hash):
        raise ReceiptError("JVM fixture artifact SHA-256 is invalid")
    expected_count = fixture_manifest.get("sourceModuleCount")
    if type(expected_count) is not int or expected_count <= 0:
        raise ReceiptError("JVM expected source-module count is invalid")
    if not isinstance(build_receipt, dict) or build_receipt.get("fixtureId") != fixture_id:
        raise ReceiptError("JVM build receipt fixture does not match the manifest")
    if build_receipt.get("artifactSha256") != artifact_hash:
        raise ReceiptError("JVM build receipt artifact does not match the manifest")
    source_hashes = build_receipt.get("sourceSha256ByPath")
    if (not isinstance(source_hashes, dict) or len(source_hashes) != expected_count
            or not all(_safe_source_path(path) and _is_sha256(digest)
                       for path, digest in source_hashes.items())):
        raise ReceiptError("JVM build receipt source inventory is invalid")

    if not isinstance(provider_receipt, dict) or provider_receipt.get("status") != "completed":
        raise ReceiptError("JVM provider receipt is not completed")
    if provider_receipt.get("artifactSha256") != artifact_hash:
        raise ReceiptError("JVM provider artifact does not match the manifest")
    units = provider_receipt.get("units")
    if not isinstance(units, list):
        raise ReceiptError("JVM provider source inventory is missing")
    provider_hashes = {}
    for unit in units:
        if not isinstance(unit, dict):
            raise ReceiptError("JVM provider source unit is invalid")
        relative_path, digest = unit.get("relativePath"), unit.get("outputSha256")
        if (not isinstance(relative_path, str) or not relative_path
                or not _safe_source_path(relative_path) or not _is_sha256(digest)
                or relative_path in provider_hashes):
            raise ReceiptError("JVM provider source path or hash is invalid")
        provider_hashes[relative_path] = digest

    if not isinstance(validation_receipt, dict) or validation_receipt.get("schemaVersion") != 1:
        raise ReceiptError("JVM validation receipt schemaVersion must be 1")
    if (validation_receipt.get("fixtureId") != fixture_id
            or validation_receipt.get("artifactSha256") != artifact_hash):
        raise ReceiptError("JVM validation receipt does not match the enrolled fixture")
    validation_hashes = validation_receipt.get("recoveredSourceSha256ByPath")
    if not isinstance(validation_hashes, dict) or validation_hashes != provider_hashes:
        raise ReceiptError("JVM validation source hashes differ from provider output")
    expected_paths = set(source_hashes)
    if any(not path.endswith(".java") for path in expected_paths):
        raise ReceiptError("JVM fixture source inventory must contain Java source paths")
    inventory_complete = (
        len(units) == expected_count
        and provider_receipt.get("sourceFileCount") == expected_count
        and validation_receipt.get("discoveredSourceFiles") == expected_count
        and validation_receipt.get("expectedSourceFiles") == expected_count
        and provider_receipt.get("truncated") is False
        and validation_receipt.get("truncated") is False
        and set(provider_hashes) == expected_paths
    )
    class_count = expected_count
    correspondence = validation_receipt.get("sourceCorrespondence")
    if not isinstance(correspondence, dict):
        raise ReceiptError("JVM bytecode-correspondence result is missing")
    if correspondence.get("classesExpected") != class_count:
        raise ReceiptError("JVM bytecode-correspondence denominator differs from the fixture")
    matched_classes = correspondence.get("classesMatched")
    if type(matched_classes) is not int or not 0 <= matched_classes <= class_count:
        raise ReceiptError("JVM bytecode-correspondence count is invalid")
    if correspondence.get("measurementComplete") is not True:
        raise ReceiptError("JVM bytecode-correspondence measurement is incomplete")
    expected_classes = {path[:-5].replace("/", ".") for path in expected_paths}
    class_results = correspondence.get("classes")
    if not isinstance(class_results, dict) or set(class_results) != expected_classes:
        raise ReceiptError("JVM bytecode-correspondence classes differ from the fixture inventory")
    counted_matches = 0
    for class_name, result in class_results.items():
        if not isinstance(result, dict) or not isinstance(result.get("bytecodeMatch"), bool):
            raise ReceiptError(f"JVM bytecode-correspondence result is invalid for {class_name}")
        if not _is_sha256(result.get("originalJavapSha256")) or not _is_sha256(result.get("recoveredJavapSha256")):
            raise ReceiptError(f"JVM bytecode-correspondence hashes are invalid for {class_name}")
        if result["bytecodeMatch"] != (result["originalJavapSha256"] == result["recoveredJavapSha256"]):
            raise ReceiptError(f"JVM bytecode-correspondence hashes disagree for {class_name}")
        counted_matches += int(result["bytecodeMatch"])
    if correspondence.get("classesMatched") != counted_matches:
        raise ReceiptError("JVM bytecode-correspondence matched count disagrees with class results")
    if correspondence.get("allClassesMatched") is not (counted_matches == class_count):
        raise ReceiptError("JVM bytecode-correspondence all-matched flag disagrees with class results")
    runtime_matches = validation_receipt.get("runtimeMatches")
    if not isinstance(runtime_matches, bool):
        raise ReceiptError("JVM runtime-oracle result is missing")
    if (validation_receipt.get("expectedRuntimeStdout")
            != fixture_manifest.get("expectedRuntimeStdout")):
        raise ReceiptError("JVM runtime oracle differs from the fixture manifest")
    observed_stdout = validation_receipt.get("observedRuntimeStdout")
    if not isinstance(observed_stdout, str) or runtime_matches != (
            observed_stdout == fixture_manifest.get("expectedRuntimeStdout")):
        raise ReceiptError("JVM runtime result disagrees with observed fixture output")
    behavior = validation_receipt.get("behavioralCorrespondence")
    behavior_metric = {"state": "UNAVAILABLE", "value": None,
                       "denominator": 1,
                       "reason": "The validation receipt did not include the full sampled behavior oracle."}
    if isinstance(behavior, dict) and behavior.get("inputCount") == EXPECTED_BEHAVIOR_INPUTS:
        if not isinstance(behavior.get("allOutputsMatch"), bool):
            raise ReceiptError("JVM sampled behavior-oracle result is invalid")
        if not _is_sha256(behavior.get("originalOutputSha256")) or not _is_sha256(behavior.get("recoveredOutputSha256")):
            raise ReceiptError("JVM sampled behavior-oracle output hashes are invalid")
        if behavior["allOutputsMatch"] != (
                behavior["originalOutputSha256"] == behavior["recoveredOutputSha256"]):
            raise ReceiptError("JVM sampled behavior-oracle hashes disagree with its result")
        behavior_metric = {
            "state": "MEASURED",
            "value": int(behavior["allOutputsMatch"]),
            "denominator": 1,
        }

    return {
        "schemaVersion": 1,
        "fixtures": {
            fixture_id: {
                "artifactSha256": artifact_hash,
                "metrics": {
                    "recovered_source_files": {
                        "state": "MEASURED", "value": len(expected_paths.intersection(provider_hashes)),
                        "denominator": expected_count,
                    },
                    "source_inventory_complete": {
                        "state": "MEASURED", "value": int(inventory_complete), "denominator": 1,
                    },
                    "exact_bytecode_classes": {
                        "state": "MEASURED", "value": matched_classes, "denominator": class_count,
                    },
                    "runtime_oracle": {
                        "state": "MEASURED", "value": int(runtime_matches), "denominator": 1,
                    },
                    "sampled_behavior_oracle": behavior_metric,
                },
            },
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("fixture-manifest", "build-receipt", "provider-receipt", "validation-receipt", "output"):
        parser.add_argument(f"--{option}", required=True)
    args = parser.parse_args(argv)
    try:
        evidence = merge_jvm_evidence(
            fixture_manifest=load_json(args.fixture_manifest),
            build_receipt=load_json(args.build_receipt),
            provider_receipt=load_json(args.provider_receipt),
            validation_receipt=load_json(args.validation_receipt),
        )
        output = Path(args.output)
        if output.exists():
            raise ReceiptError(f"refusing to overwrite existing evidence: {output}")
        output.parent.mkdir(parents=True, exist_ok=True)
        rendered = json.dumps(evidence, indent=2, sort_keys=True) + "\n"
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as destination:
                destination.write(rendered)
                destination.flush()
                os.fsync(destination.fileno())
            os.link(temporary_name, output)
        finally:
            Path(temporary_name).unlink(missing_ok=True)
        print(f"recorded JVM matrix evidence at {output}")
        return 0
    except (ReceiptError, OSError, KeyError, TypeError, ValueError) as exc:
        print(f"merge_jvm_evidence: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
