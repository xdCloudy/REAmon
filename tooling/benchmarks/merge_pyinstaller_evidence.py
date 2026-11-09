#!/usr/bin/env python3
"""Merge pinned build-oracle and REAmon integration evidence for one fixture."""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

try:
    from .compare_receipts import (
        ReceiptError,
        _manifest_fixtures,
        _manifest_metrics,
        load_json,
        sha256_file,
    )
    from .record_receipt import _validate_evidence
except ImportError:
    from compare_receipts import (
        ReceiptError,
        _manifest_fixtures,
        _manifest_metrics,
        load_json,
        sha256_file,
    )
    from record_receipt import _validate_evidence


def merge_evidence(*, fixture_manifest, evaluation_manifest, build_receipt,
                    enrollment_receipt, integration_evidence, source_hashes=None):
    fixture_hashes = _manifest_fixtures(fixture_manifest)
    metric_definitions = _manifest_metrics(evaluation_manifest)
    required_metrics = {
        "runtime_oracle",
        "extracted_module_count",
        "known_source_value_recall",
        "worker_terminal_page",
        "reconstruction_match",
    }
    if set(metric_definitions) != required_metrics:
        raise ReceiptError("evaluation manifest metric inventory differs from PyInstaller evidence merger")
    if len(fixture_hashes) != 1:
        raise ReceiptError("PyInstaller evidence merger accepts exactly one fixture")
    fixture_id, expected_hash = next(iter(fixture_hashes.items()))
    target = fixture_manifest.get("target", {})
    expected_stdout = target.get("expectedRuntimeStdout")
    expected_module_count = target.get("extractedBytecodeModuleCount")
    known_source_count = target.get("moduleSourceCount")
    if not isinstance(expected_stdout, str) or not expected_stdout:
        raise ReceiptError("fixture manifest expected runtime stdout is required")
    if type(expected_module_count) is not int or expected_module_count < 1:
        raise ReceiptError("fixture manifest extracted module count is required")
    if type(known_source_count) is not int or known_source_count < 1:
        raise ReceiptError("fixture manifest known-source module count is required")

    if not isinstance(build_receipt, dict) or build_receipt.get("artifactSha256") != expected_hash:
        raise ReceiptError("builder receipt artifact SHA-256 does not match fixture manifest")
    if build_receipt.get("expectedRuntimeStdout") != expected_stdout:
        raise ReceiptError("builder receipt runtime oracle expectation differs from fixture manifest")
    if build_receipt.get("runtimeOracle") != "PASSED in Docker build container":
        raise ReceiptError("builder receipt does not prove a passing in-container runtime oracle")
    if build_receipt.get("extractedBytecodeModuleCount") != expected_module_count:
        raise ReceiptError("builder receipt module count differs from fixture manifest")
    page_sizes = build_receipt.get("extractedModulePageSizes")
    if not isinstance(page_sizes, list) or any(type(size) is not int or size < 0 for size in page_sizes):
        raise ReceiptError("builder receipt page sizes are invalid")
    if sum(page_sizes) != expected_module_count:
        raise ReceiptError("builder receipt page sizes do not cover the declared module inventory")

    if not isinstance(enrollment_receipt, dict) or enrollment_receipt.get("schemaVersion") != 1:
        raise ReceiptError("enrollment receipt schemaVersion must be 1")
    enrollment_build = enrollment_receipt.get("build")
    fixture_oracle = enrollment_receipt.get("fixtureOracle")
    inventory = enrollment_receipt.get("extractorInventory")
    if not isinstance(enrollment_build, dict) or enrollment_build.get("artifactSha256") != expected_hash:
        raise ReceiptError("enrollment receipt artifact SHA-256 does not match fixture manifest")
    if not isinstance(fixture_oracle, dict) or fixture_oracle.get("state") != "PASSED":
        raise ReceiptError("enrollment receipt runtime oracle is not passed")
    if fixture_oracle.get("expectedStdout") != expected_stdout or fixture_oracle.get("observedStdout") != expected_stdout:
        raise ReceiptError("enrollment receipt runtime output differs from fixture manifest")
    if not isinstance(inventory, dict) or inventory.get("state") != "PASSED":
        raise ReceiptError("enrollment receipt extractor inventory is not passed")
    if inventory.get("moduleCount") != expected_module_count:
        raise ReceiptError("enrollment receipt module count differs from fixture manifest")
    enrolled_page_sizes = inventory.get("pageSizes")
    if (not isinstance(enrolled_page_sizes, list)
            or any(type(size) is not int or size < 0 for size in enrolled_page_sizes)
            or sum(enrolled_page_sizes) != expected_module_count):
        raise ReceiptError("enrollment receipt pages do not cover the declared module inventory")

    integration = _validate_evidence(integration_evidence, fixture_hashes, metric_definitions)
    observed_metrics = integration[fixture_id]["metrics"]
    extracted_count = observed_metrics["extracted_module_count"]
    if extracted_count["state"] != "MEASURED" or extracted_count["value"] != expected_module_count:
        raise ReceiptError("integration evidence module count does not match fixture inventory")
    known_source_recall = observed_metrics["known_source_value_recall"]
    if known_source_recall["state"] != "MEASURED" or known_source_recall["denominator"] != known_source_count:
        raise ReceiptError("integration evidence lacks the declared known-source denominator")
    if (type(known_source_recall["value"]) is not int
            or not 0 <= known_source_recall["value"] <= known_source_count):
        raise ReceiptError("integration evidence known-source match count is outside its denominator")
    if observed_metrics["runtime_oracle"]["state"] != "UNAVAILABLE":
        raise ReceiptError("integration test runtime metric must remain unavailable until merged with build evidence")
    reconstruction_match = observed_metrics["reconstruction_match"]
    if reconstruction_match["state"] != "MEASURED" or reconstruction_match["denominator"] != known_source_count:
        raise ReceiptError("integration evidence lacks measured source correspondence for the declared modules")
    if (type(reconstruction_match["value"]) is not int
            or not 0 <= reconstruction_match["value"] <= known_source_count):
        raise ReceiptError("integration evidence source correspondence count is outside its denominator")

    merged_metrics = {metric_id: dict(metric) for metric_id, metric in observed_metrics.items()}
    merged_metrics["runtime_oracle"] = {
        "direction": metric_definitions["runtime_oracle"]["direction"],
        "state": "MEASURED",
        "value": 1,
        "denominator": 1,
    }
    return {
        "schemaVersion": 1,
        "producer": "tooling/benchmarks/merge_pyinstaller_evidence.py",
        "provenance": source_hashes or {},
        "fixtures": {
            fixture_id: {
                "artifactSha256": expected_hash,
                "metrics": merged_metrics,
            },
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-manifest", required=True)
    parser.add_argument("--evaluation-manifest", required=True)
    parser.add_argument("--build-receipt", required=True)
    parser.add_argument("--enrollment-receipt", required=True)
    parser.add_argument("--integration-evidence", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    paths = {
        "fixtureManifest": Path(args.fixture_manifest),
        "evaluationManifest": Path(args.evaluation_manifest),
        "buildReceipt": Path(args.build_receipt),
        "enrollmentReceipt": Path(args.enrollment_receipt),
        "integrationEvidence": Path(args.integration_evidence),
    }
    try:
        output = Path(args.output)
        if output.exists():
            raise ReceiptError(f"refusing to overwrite existing evidence: {output}")
        merged = merge_evidence(
            fixture_manifest=load_json(paths["fixtureManifest"]),
            evaluation_manifest=load_json(paths["evaluationManifest"]),
            build_receipt=load_json(paths["buildReceipt"]),
            enrollment_receipt=load_json(paths["enrollmentReceipt"]),
            integration_evidence=load_json(paths["integrationEvidence"]),
            source_hashes={name: sha256_file(path) for name, path in paths.items()},
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        rendered = json.dumps(merged, indent=2, sort_keys=True) + "\n"
        fd, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as destination:
                destination.write(rendered)
                destination.flush()
                os.fsync(destination.fileno())
            os.link(temporary_name, output)
        finally:
            Path(temporary_name).unlink(missing_ok=True)
        print(f"merged evidence for {next(iter(merged['fixtures']))} at {output}")
    except (ReceiptError, OSError, KeyError, TypeError, ValueError) as exc:
        print(f"merge_pyinstaller_evidence: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
