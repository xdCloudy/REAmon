#!/usr/bin/env python3
"""Create a provenance-bound benchmark receipt from measured evidence."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

try:
    from .compare_receipts import (
        ReceiptError,
        _manifest_fixtures,
        _manifest_metrics,
        _validate_receipt,
        load_json,
        sha256_file,
    )
except ImportError:
    from compare_receipts import (
        ReceiptError,
        _manifest_fixtures,
        _manifest_metrics,
        _validate_receipt,
        load_json,
        sha256_file,
    )


def _git(repo_root: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_root), *args],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReceiptError(f"cannot inspect git checkout at {repo_root}: {exc}") from exc
    return result.stdout.strip()


def _validate_evidence(evidence, fixture_hashes, metric_definitions):
    if not isinstance(evidence, dict) or evidence.get("schemaVersion") != 1:
        raise ReceiptError("evidence schemaVersion must be 1")
    fixtures = evidence.get("fixtures")
    if not isinstance(fixtures, dict) or set(fixtures) != set(fixture_hashes):
        raise ReceiptError("evidence fixture set does not match fixture manifest")
    output = {}
    for fixture_id, expected_hash in fixture_hashes.items():
        fixture = fixtures[fixture_id]
        if not isinstance(fixture, dict) or fixture.get("artifactSha256") != expected_hash:
            raise ReceiptError(f"evidence fixture {fixture_id} artifact hash does not match fixture manifest")
        metrics = fixture.get("metrics")
        if not isinstance(metrics, dict) or set(metrics) != set(metric_definitions):
            raise ReceiptError(f"evidence fixture {fixture_id} metric inventory does not match evaluation manifest")
        output[fixture_id] = {"artifactSha256": expected_hash, "metrics": {}}
        for metric_id, definition in metric_definitions.items():
            measured = metrics[metric_id]
            if not isinstance(measured, dict):
                raise ReceiptError(f"evidence metric {fixture_id}:{metric_id} must be an object")
            state = measured.get("state")
            denominator = measured.get("denominator")
            expected_denominator = definition.get("denominator")
            if state not in {"MEASURED", "UNAVAILABLE"}:
                raise ReceiptError(f"evidence metric {fixture_id}:{metric_id} has invalid state")
            if denominator is not None and (type(denominator) is not int or denominator < 0):
                raise ReceiptError(f"evidence metric {fixture_id}:{metric_id} has invalid denominator")
            if expected_denominator is not None and denominator != expected_denominator:
                raise ReceiptError(f"evidence metric {fixture_id}:{metric_id} denominator differs from manifest")
            record = {
                "direction": definition["direction"],
                "state": state,
                "denominator": denominator,
            }
            if state == "MEASURED":
                value = measured.get("value")
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise ReceiptError(f"measured evidence metric {fixture_id}:{metric_id} needs a numeric value")
                record["value"] = value
            else:
                if measured.get("value") is not None:
                    raise ReceiptError(f"unavailable evidence metric {fixture_id}:{metric_id} must have a null value")
                reason = measured.get("reason")
                if not isinstance(reason, str) or not reason.strip():
                    raise ReceiptError(f"unavailable evidence metric {fixture_id}:{metric_id} needs a reason")
                record.update(value=None, reason=reason)
            output[fixture_id]["metrics"][metric_id] = record
    return output


def create_receipt(*, repo_root, fixture_manifest_path, evaluation_manifest_path,
                   evidence_path, toolchain_manifest_path, run_id=None):
    repo_root = Path(repo_root).resolve()
    fixture_manifest_path = Path(fixture_manifest_path).resolve()
    evaluation_manifest_path = Path(evaluation_manifest_path).resolve()
    evidence_path = Path(evidence_path).resolve()
    toolchain_manifest_path = Path(toolchain_manifest_path).resolve()

    fixture_manifest = load_json(fixture_manifest_path)
    evaluation_manifest = load_json(evaluation_manifest_path)
    evidence = load_json(evidence_path)
    toolchain = load_json(toolchain_manifest_path)
    fixture_hashes = _manifest_fixtures(fixture_manifest)
    metric_definitions = _manifest_metrics(evaluation_manifest)
    metrics = _validate_evidence(evidence, fixture_hashes, metric_definitions)
    if not isinstance(toolchain, dict) or toolchain.get("schemaVersion") != 1:
        raise ReceiptError("toolchain manifest schemaVersion must be 1")
    components = toolchain.get("components")
    if not isinstance(components, dict) or not components:
        raise ReceiptError("toolchain manifest components are required")
    if not all(isinstance(key, str) and key and isinstance(value, str) and value
               for key, value in components.items()):
        raise ReceiptError("toolchain manifest components must map names to nonempty revisions")

    commit = _git(repo_root, "rev-parse", "HEAD")
    if len(commit) not in {40, 64} or any(char not in "0123456789abcdef" for char in commit):
        raise ReceiptError("git returned an invalid full commit hash")
    dirty = bool(_git(repo_root, "status", "--porcelain=v1", "--untracked-files=all"))
    receipt = {
        "schemaVersion": 1,
        "runId": run_id or str(uuid.uuid4()),
        "createdAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "commit": commit,
        "worktreeClean": not dirty,
        "fixtureManifestSha256": sha256_file(fixture_manifest_path),
        "evaluationManifestSha256": sha256_file(evaluation_manifest_path),
        "evidenceSha256": sha256_file(evidence_path),
        "toolchainManifestSha256": sha256_file(toolchain_manifest_path),
        "components": components,
        "fixtures": metrics,
    }
    _validate_receipt(
        receipt,
        fixture_hashes,
        metric_definitions,
        receipt["fixtureManifestSha256"],
        receipt["evaluationManifestSha256"],
        "recorded",
    )
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--fixture-manifest", required=True)
    parser.add_argument("--evaluation-manifest", required=True)
    parser.add_argument("--evidence", required=True, help="Measured evidence JSON emitted by the fixture evaluation")
    parser.add_argument("--toolchain-manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--run-id")
    args = parser.parse_args(argv)
    try:
        receipt = create_receipt(
            repo_root=args.repo_root,
            fixture_manifest_path=args.fixture_manifest,
            evaluation_manifest_path=args.evaluation_manifest,
            evidence_path=args.evidence,
            toolchain_manifest_path=args.toolchain_manifest,
            run_id=args.run_id,
        )
        output = Path(args.output)
        if output.exists():
            raise ReceiptError(f"refusing to overwrite existing receipt: {output}")
        output.parent.mkdir(parents=True, exist_ok=True)
        rendered = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
        fd, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as destination:
                destination.write(rendered)
                destination.flush()
                os.fsync(destination.fileno())
            os.link(temporary_name, output)
        finally:
            Path(temporary_name).unlink(missing_ok=True)
        print(f"recorded {receipt['runId']} at {output} (worktreeClean={receipt['worktreeClean']})")
    except (ReceiptError, OSError) as exc:
        print(f"record_receipt: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
