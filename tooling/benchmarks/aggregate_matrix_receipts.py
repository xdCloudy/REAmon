#!/usr/bin/env python3
"""Combine per-fixture benchmark receipts into one matched matrix comparison."""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

try:
    from .compare_receipts import (
        ReceiptError,
        _manifest_fixtures,
        _manifest_metrics,
        _validate_receipt,
        compare_receipts,
        load_json,
        sha256_file,
    )
except ImportError:
    from compare_receipts import (
        ReceiptError,
        _manifest_fixtures,
        _manifest_metrics,
        _validate_receipt,
        compare_receipts,
        load_json,
        sha256_file,
    )


def _config_path(base: Path, value: object, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ReceiptError(f"matrix config {label} path is required")
    path = Path(value)
    return (base / path).resolve() if not path.is_absolute() else path.resolve()


def _aggregate_side(*, label, parts, fixture_hashes, fixture_manifest_hash,
                    evaluation_manifest_hash, toolchain_manifest_hash,
                    components, metric_definitions, run_id):
    fixtures = {}
    receipt_hashes = {}
    commits = set()
    clean_states = set()

    for fixture_id, part in parts.items():
        fixture_manifest_path = part["fixtureManifestPath"]
        fixture_manifest = load_json(fixture_manifest_path)
        part_hashes = _manifest_fixtures(fixture_manifest)
        if set(part_hashes) != {fixture_id}:
            raise ReceiptError(f"{label} {fixture_id} part manifest must declare exactly that fixture")
        if part_hashes[fixture_id] != fixture_hashes[fixture_id]:
            raise ReceiptError(f"{label} {fixture_id} artifact hash differs from matrix manifest")
        fixture_manifest_hash_part = sha256_file(fixture_manifest_path)
        receipt = part["receipt"]
        receipt_path = part["receiptPath"]
        _validate_receipt(
            receipt,
            part_hashes,
            metric_definitions,
            fixture_manifest_hash_part,
            evaluation_manifest_hash,
            f"{label} {fixture_id}",
        )
        if receipt.get("toolchainManifestSha256") != toolchain_manifest_hash:
            raise ReceiptError(f"{label} {fixture_id} toolchain manifest hash differs from matrix toolchain")
        if receipt.get("components") != components:
            raise ReceiptError(f"{label} {fixture_id} component revisions differ from matrix toolchain")
        commits.add(receipt["commit"])
        clean_states.add(receipt["worktreeClean"])
        fixtures[fixture_id] = receipt["fixtures"][fixture_id]
        receipt_hashes[fixture_id] = sha256_file(receipt_path)

    if len(commits) != 1:
        raise ReceiptError(f"{label} fixture receipts do not share one source commit")

    return {
        "schemaVersion": 1,
        "runId": run_id,
        "createdAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "commit": next(iter(commits)),
        "worktreeClean": clean_states == {True},
        "fixtureManifestSha256": fixture_manifest_hash,
        "evaluationManifestSha256": evaluation_manifest_hash,
        "toolchainManifestSha256": toolchain_manifest_hash,
        "components": components,
        "fixtures": fixtures,
        "constituentReceiptSha256": receipt_hashes,
    }


def combine_matrix(*, config_path, output_dir, run_prefix="matrix"):
    config_path = Path(config_path).resolve()
    output = Path(output_dir).resolve()
    if output.exists():
        raise ReceiptError(f"refusing to overwrite existing output directory: {output}")
    if not isinstance(run_prefix, str) or not run_prefix.strip():
        raise ReceiptError("run prefix must be a nonempty string")

    config = load_json(config_path)
    if not isinstance(config, dict) or config.get("schemaVersion") != 1:
        raise ReceiptError("matrix config schemaVersion must be 1")
    base = config_path.parent
    fixture_manifest_path = _config_path(base, config.get("fixtureManifest"), "fixtureManifest")
    evaluation_manifest_path = _config_path(base, config.get("evaluationManifest"), "evaluationManifest")
    toolchain_manifest_path = _config_path(base, config.get("toolchainManifest"), "toolchainManifest")
    fixture_manifest = load_json(fixture_manifest_path)
    evaluation_manifest = load_json(evaluation_manifest_path)
    toolchain_manifest = load_json(toolchain_manifest_path)
    fixture_hashes = _manifest_fixtures(fixture_manifest)
    metric_definitions = _manifest_metrics(evaluation_manifest)
    if not isinstance(toolchain_manifest, dict) or toolchain_manifest.get("schemaVersion") != 1:
        raise ReceiptError("matrix toolchain manifest schemaVersion must be 1")
    components = toolchain_manifest.get("components")
    if not isinstance(components, dict) or not components:
        raise ReceiptError("matrix toolchain manifest components are required")
    if not all(isinstance(key, str) and key and isinstance(value, str) and value
               for key, value in components.items()):
        raise ReceiptError("matrix toolchain components must map names to nonempty revisions")

    cases = config.get("fixtures")
    if not isinstance(cases, dict) or set(cases) != set(fixture_hashes):
        raise ReceiptError("matrix config fixture set must exactly match the matrix manifest")

    parts = {"baseline": {}, "candidate": {}}
    for fixture_id, item in cases.items():
        if not isinstance(item, dict):
            raise ReceiptError(f"matrix config fixture {fixture_id} must be an object")
        fixture_path = _config_path(base, item.get("fixtureManifest"), f"{fixture_id}.fixtureManifest")
        for label in ("baseline", "candidate"):
            receipt_path = _config_path(base, item.get(f"{label}Receipt"), f"{fixture_id}.{label}Receipt")
            parts[label][fixture_id] = {
                "fixtureManifestPath": fixture_path,
                "receiptPath": receipt_path,
                "receipt": load_json(receipt_path),
            }

    fixture_manifest_hash = sha256_file(fixture_manifest_path)
    evaluation_manifest_hash = sha256_file(evaluation_manifest_path)
    toolchain_manifest_hash = sha256_file(toolchain_manifest_path)
    baseline = _aggregate_side(
        label="baseline", parts=parts["baseline"], fixture_hashes=fixture_hashes,
        fixture_manifest_hash=fixture_manifest_hash, evaluation_manifest_hash=evaluation_manifest_hash,
        toolchain_manifest_hash=toolchain_manifest_hash, components=components,
        metric_definitions=metric_definitions, run_id=f"{run_prefix}-baseline",
    )
    candidate = _aggregate_side(
        label="candidate", parts=parts["candidate"], fixture_hashes=fixture_hashes,
        fixture_manifest_hash=fixture_manifest_hash, evaluation_manifest_hash=evaluation_manifest_hash,
        toolchain_manifest_hash=toolchain_manifest_hash, components=components,
        metric_definitions=metric_definitions, run_id=f"{run_prefix}-candidate",
    )
    report = compare_receipts(
        baseline, candidate, fixture_manifest=fixture_manifest,
        evaluation_manifest=evaluation_manifest,
        fixture_manifest_hash=fixture_manifest_hash,
        evaluation_manifest_hash=evaluation_manifest_hash,
    )
    result = {
        "baseline": baseline,
        "candidate": candidate,
        "comparison": report,
        "provenance": {
            "configSha256": sha256_file(config_path),
            "fixtureManifestSha256": fixture_manifest_hash,
            "evaluationManifestSha256": evaluation_manifest_hash,
            "toolchainManifestSha256": toolchain_manifest_hash,
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        for name, value in result.items():
            path = stage / f"{name}.json"
            with path.open("x", encoding="utf-8", newline="\n") as destination:
                json.dump(value, destination, indent=2, sort_keys=True)
                destination.write("\n")
                destination.flush()
                os.fsync(destination.fileno())
        os.rename(stage, output)
    except Exception:
        if stage.exists():
            for child in stage.iterdir():
                child.unlink()
            stage.rmdir()
        raise
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Matrix config with manifests and paired per-fixture receipts")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--run-prefix", default="matrix")
    args = parser.parse_args(argv)
    try:
        report = combine_matrix(config_path=args.config, output_dir=args.output_dir, run_prefix=args.run_prefix)
        print(f"{report['status']}: matrix evidence written to {Path(args.output_dir).resolve()}")
        return {"NO_REGRESSION_OBSERVED": 0, "REGRESSION_DETECTED": 1, "INCOMPLETE": 2}[report["status"]]
    except (ReceiptError, OSError, KeyError, TypeError, ValueError) as exc:
        print(f"aggregate_matrix_receipts: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
