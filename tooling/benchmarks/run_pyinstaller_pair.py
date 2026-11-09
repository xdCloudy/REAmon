#!/usr/bin/env python3
"""Merge and compare already-measured baseline/candidate PyInstaller evidence."""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import uuid
from pathlib import Path

try:
    from .compare_receipts import ReceiptError, compare_receipts, load_json, sha256_file
    from .merge_pyinstaller_evidence import merge_evidence
    from .record_receipt import create_receipt
except ImportError:
    from compare_receipts import ReceiptError, compare_receipts, load_json, sha256_file
    from merge_pyinstaller_evidence import merge_evidence
    from record_receipt import create_receipt


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _write_json(path: Path, value) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as destination:
        json.dump(value, destination, indent=2, sort_keys=True)
        destination.write("\n")
        destination.flush()
        os.fsync(destination.fileno())


def run_pair(*, baseline_repo_root, candidate_repo_root, fixture_manifest_path,
             evaluation_manifest_path, build_receipt_path, enrollment_receipt_path,
             baseline_integration_path, candidate_integration_path,
             baseline_toolchain_path, candidate_toolchain_path, output_dir,
             run_prefix=None):
    roots = [Path(baseline_repo_root).resolve(), Path(candidate_repo_root).resolve()]
    output = Path(output_dir).resolve()
    if output.exists():
        raise ReceiptError(f"refusing to overwrite existing output directory: {output}")
    if any(_is_within(output, root) for root in roots):
        raise ReceiptError("output directory must be outside both repository checkouts to preserve clean receipts")

    paths = {
        "fixture_manifest": Path(fixture_manifest_path).resolve(),
        "evaluation_manifest": Path(evaluation_manifest_path).resolve(),
        "build_receipt": Path(build_receipt_path).resolve(),
        "enrollment_receipt": Path(enrollment_receipt_path).resolve(),
        "baseline_integration": Path(baseline_integration_path).resolve(),
        "candidate_integration": Path(candidate_integration_path).resolve(),
        "baseline_toolchain": Path(baseline_toolchain_path).resolve(),
        "candidate_toolchain": Path(candidate_toolchain_path).resolve(),
    }
    if sha256_file(paths["baseline_toolchain"]) != sha256_file(paths["candidate_toolchain"]):
        raise ReceiptError("baseline and candidate toolchain manifests differ")

    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        fixture_manifest = load_json(paths["fixture_manifest"])
        evaluation_manifest = load_json(paths["evaluation_manifest"])
        enrollment_receipt = load_json(paths["enrollment_receipt"])
        build_receipt = load_json(paths["build_receipt"])
        toolchain_path = paths["baseline_toolchain"]
        run_prefix = run_prefix or str(uuid.uuid4())
        receipts = {}
        for label, integration_key, repo_root in (
            ("baseline", "baseline_integration", roots[0]),
            ("candidate", "candidate_integration", roots[1]),
        ):
            evidence_path = stage / f"{label}-evidence.json"
            evidence = merge_evidence(
                fixture_manifest=fixture_manifest,
                evaluation_manifest=evaluation_manifest,
                build_receipt=build_receipt,
                enrollment_receipt=enrollment_receipt,
                integration_evidence=load_json(paths[integration_key]),
                source_hashes={
                    "fixtureManifest": sha256_file(paths["fixture_manifest"]),
                    "evaluationManifest": sha256_file(paths["evaluation_manifest"]),
                    "buildReceipt": sha256_file(paths["build_receipt"]),
                    "enrollmentReceipt": sha256_file(paths["enrollment_receipt"]),
                    "integrationEvidence": sha256_file(paths[integration_key]),
                },
            )
            _write_json(evidence_path, evidence)
            receipt = create_receipt(
                repo_root=repo_root,
                fixture_manifest_path=paths["fixture_manifest"],
                evaluation_manifest_path=paths["evaluation_manifest"],
                evidence_path=evidence_path,
                toolchain_manifest_path=toolchain_path,
                run_id=f"{run_prefix}-{label}",
            )
            _write_json(stage / f"{label}-receipt.json", receipt)
            receipts[label] = receipt

        report = compare_receipts(
            receipts["baseline"],
            receipts["candidate"],
            fixture_manifest=fixture_manifest,
            evaluation_manifest=evaluation_manifest,
            fixture_manifest_hash=sha256_file(paths["fixture_manifest"]),
            evaluation_manifest_hash=sha256_file(paths["evaluation_manifest"]),
        )
        _write_json(stage / "comparison.json", report)
        os.replace(stage, output)
        return report
    except Exception:
        if stage.exists():
            for child in stage.iterdir():
                child.unlink()
            stage.rmdir()
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for option in (
        "baseline-repo-root", "candidate-repo-root", "fixture-manifest",
        "evaluation-manifest", "build-receipt", "enrollment-receipt",
        "baseline-integration-evidence", "candidate-integration-evidence",
        "baseline-toolchain-manifest", "candidate-toolchain-manifest", "output-dir",
    ):
        parser.add_argument(f"--{option}", required=True)
    parser.add_argument("--run-prefix", help="Optional stable prefix for both generated run IDs")
    args = parser.parse_args(argv)
    try:
        report = run_pair(
            baseline_repo_root=args.baseline_repo_root,
            candidate_repo_root=args.candidate_repo_root,
            fixture_manifest_path=args.fixture_manifest,
            evaluation_manifest_path=args.evaluation_manifest,
            build_receipt_path=args.build_receipt,
            enrollment_receipt_path=args.enrollment_receipt,
            baseline_integration_path=args.baseline_integration_evidence,
            candidate_integration_path=args.candidate_integration_evidence,
            baseline_toolchain_path=args.baseline_toolchain_manifest,
            candidate_toolchain_path=args.candidate_toolchain_manifest,
            output_dir=args.output_dir,
            run_prefix=args.run_prefix,
        )
        print(f"{report['status']}: paired evidence written to {Path(args.output_dir).resolve()}")
        return {"NO_REGRESSION_OBSERVED": 0, "REGRESSION_DETECTED": 1, "INCOMPLETE": 2}[report["status"]]
    except (ReceiptError, OSError, KeyError, TypeError, ValueError) as exc:
        print(f"run_pyinstaller_pair: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
