#!/usr/bin/env python3
"""Compare paired benchmark receipts against checked-in fixture contracts."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path


class ReceiptError(ValueError):
    pass


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ReceiptError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value):
    raise ReceiptError(f"invalid non-finite JSON number: {value}")


def load_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"), object_pairs_hook=_unique_object,
                          parse_constant=_reject_constant)
    except (OSError, json.JSONDecodeError) as exc:
        raise ReceiptError(f"cannot read JSON {path}: {exc}") from exc


def load_receipt(path):
    return load_json(path)


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _require(condition, message):
    if not condition:
        raise ReceiptError(message)


def _manifest_fixtures(manifest):
    _require(isinstance(manifest, dict) and manifest.get("schemaVersion") == 1,
             "fixture manifest schemaVersion must be 1")
    if "fixtures" in manifest:
        fixtures = manifest["fixtures"]
        _require(isinstance(fixtures, dict) and fixtures, "fixture manifest fixtures must be a nonempty object")
        output = {}
        for fixture_id, item in fixtures.items():
            artifact = item.get("artifact", {}) if isinstance(item, dict) else {}
            output[fixture_id] = artifact.get("sha256")
    else:
        fixture_id = manifest.get("fixtureId")
        artifact = manifest.get("artifact", {})
        output = {fixture_id: artifact.get("sha256")} if fixture_id else {}
    _require(bool(output), "fixture manifest declares no fixtures")
    for fixture_id, artifact_hash in output.items():
        _require(isinstance(fixture_id, str) and fixture_id, "fixture id must be a nonempty string")
        _require(isinstance(artifact_hash, str) and re.fullmatch(r"[0-9a-f]{64}", artifact_hash),
                 f"fixture {fixture_id} has no valid artifact SHA-256")
    return output


def _manifest_metrics(manifest):
    _require(isinstance(manifest, dict) and manifest.get("schemaVersion") == 1,
             "evaluation manifest schemaVersion must be 1")
    metrics = manifest.get("metrics")
    _require(isinstance(metrics, dict) and metrics, "evaluation manifest metrics must be a nonempty object")
    for metric_id, definition in metrics.items():
        _require(isinstance(definition, dict), f"metric {metric_id} definition must be an object")
        _require(isinstance(definition.get("direction"), str) and definition["direction"] in {"higher", "lower", "equal"},
                 f"metric {metric_id} has invalid direction")
        denominator = definition.get("denominator")
        _require(denominator is None or (isinstance(denominator, int) and denominator >= 0),
                 f"metric {metric_id} has invalid denominator")
    return metrics


def _validate_receipt(receipt, fixture_hashes, metric_definitions, fixture_manifest_hash, evaluation_manifest_hash, label):
    _require(isinstance(receipt, dict), f"{label} receipt must be an object")
    _require(type(receipt.get("schemaVersion")) is int and receipt["schemaVersion"] == 1,
             f"{label} receipt schemaVersion must be 1")
    _require(isinstance(receipt.get("runId"), str) and receipt["runId"], f"{label} receipt runId is required")
    _require(isinstance(receipt.get("commit"), str) and re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", receipt["commit"]),
             f"{label} receipt commit must be a full lowercase git hash")
    if "productSourceCommit" in receipt:
        product_source_commit = receipt["productSourceCommit"]
        _require(isinstance(product_source_commit, str)
                 and re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", product_source_commit),
                 f"{label} productSourceCommit must be a full lowercase git hash")
    _require(receipt.get("fixtureManifestSha256") == fixture_manifest_hash,
             f"{label} fixture manifest hash does not match supplied manifest")
    _require(receipt.get("evaluationManifestSha256") == evaluation_manifest_hash,
             f"{label} evaluation manifest hash does not match supplied manifest")
    _require(isinstance(receipt.get("toolchainManifestSha256"), str) and
             re.fullmatch(r"[0-9a-f]{64}", receipt["toolchainManifestSha256"]),
             f"{label} toolchain manifest hash must be SHA-256")
    _require(receipt.get("worktreeClean") is True or receipt.get("worktreeClean") is False,
             f"{label} worktreeClean must be boolean")
    _require(isinstance(receipt.get("components"), dict) and receipt["components"],
             f"{label} components revision map is required")
    _require("product_source_commit" not in receipt["components"],
             f"{label} product source commit belongs in productSourceCommit, not toolchain components")
    _require(all(isinstance(k, str) and k and isinstance(v, str) and v for k, v in receipt["components"].items()),
             f"{label} components must map names to nonempty revisions")
    fixtures = receipt.get("fixtures")
    _require(isinstance(fixtures, dict), f"{label} fixtures must be an object")
    _require(set(fixtures) == set(fixture_hashes), f"{label} fixture set does not match fixture manifest")
    for fixture_id, expected_hash in fixture_hashes.items():
        record = fixtures[fixture_id]
        _require(isinstance(record, dict), f"{label} fixture {fixture_id} must be an object")
        _require(record.get("artifactSha256") == expected_hash,
                 f"{label} fixture {fixture_id} artifact hash does not match fixture manifest")
        metrics = record.get("metrics")
        _require(isinstance(metrics, dict), f"{label} fixture {fixture_id} metrics must be an object")
        _require(set(metrics) == set(metric_definitions),
                 f"{label} fixture {fixture_id} metric inventory does not match evaluation manifest")
        for metric_id, definition in metric_definitions.items():
            metric = metrics[metric_id]
            _require(isinstance(metric, dict), f"{label} metric {metric_id} must be an object")
            _require(isinstance(metric.get("direction"), str) and metric["direction"] == definition["direction"],
                     f"{label} metric {metric_id} direction does not match evaluation manifest")
            state = metric.get("state")
            _require(isinstance(state, str) and state in {"MEASURED", "UNAVAILABLE"},
                     f"{label} metric {metric_id} has invalid state")
            denominator = metric.get("denominator")
            _require(denominator is None or (isinstance(denominator, int) and denominator >= 0),
                     f"{label} metric {metric_id} has invalid denominator")
            if state == "MEASURED":
                value = metric.get("value")
                _require(isinstance(value, (int, float)) and not isinstance(value, bool),
                         f"{label} measured metric {metric_id} needs a numeric value")
                _require(math.isfinite(value), f"{label} measured metric {metric_id} must be finite")
                _require(denominator is not None, f"{label} measured metric {metric_id} needs a denominator")
            else:
                _require(metric.get("value") is None and isinstance(metric.get("reason"), str) and metric["reason"],
                         f"{label} unavailable metric {metric_id} needs null value and a reason")


def compare_receipts(baseline, candidate, *, fixture_manifest=None, evaluation_manifest=None,
                     fixture_manifest_hash=None, evaluation_manifest_hash=None):
    """Return a deterministic, threshold-free comparison report."""
    if fixture_manifest is None or evaluation_manifest is None:
        # Kept for pure directional tests; production CLI always supplies manifests.
        fixture_hashes = {key: value["artifactSha256"] for key, value in baseline["fixtures"].items()}
        metric_definitions = {key: {"direction": value["direction"], "denominator": None}
                              for key, value in next(iter(baseline["fixtures"].values()))["metrics"].items()}
        fixture_manifest_hash = fixture_manifest_hash or baseline["fixtureManifestSha256"]
        evaluation_manifest_hash = evaluation_manifest_hash or baseline["evaluationManifestSha256"]
    else:
        fixture_hashes = _manifest_fixtures(fixture_manifest)
        metric_definitions = _manifest_metrics(evaluation_manifest)
    _validate_receipt(baseline, fixture_hashes, metric_definitions, fixture_manifest_hash, evaluation_manifest_hash, "baseline")
    _validate_receipt(candidate, fixture_hashes, metric_definitions, fixture_manifest_hash, evaluation_manifest_hash, "candidate")
    _require(baseline["toolchainManifestSha256"] == candidate["toolchainManifestSha256"],
             "toolchain manifest hashes differ")

    incomplete = not baseline["worktreeClean"] or not candidate["worktreeClean"]
    regressions = []
    fixture_reports = {}
    for fixture_id in sorted(fixture_hashes):
        metric_reports = {}
        for metric_id in sorted(metric_definitions):
            before = baseline["fixtures"][fixture_id]["metrics"][metric_id]
            after = candidate["fixtures"][fixture_id]["metrics"][metric_id]
            state = "MEASURED"
            delta = None
            worse = None
            expected_denominator = metric_definitions[metric_id].get("denominator")
            if before["state"] != "MEASURED" or after["state"] != "MEASURED":
                state = "UNAVAILABLE"
                incomplete = True
            elif (before["denominator"] != after["denominator"]
                  or (expected_denominator is not None and before["denominator"] != expected_denominator)):
                state = "INCOMPLETE"
                incomplete = True
            else:
                delta = after["value"] - before["value"]
                direction = metric_definitions[metric_id]["direction"]
                worse = delta < 0 if direction == "higher" else delta > 0 if direction == "lower" else delta != 0
                if worse:
                    regressions.append(f"{fixture_id}:{metric_id}")
            metric_reports[metric_id] = {
                "state": state,
                "direction": metric_definitions[metric_id]["direction"],
                "baseline": before["value"],
                "candidate": after["value"],
                "denominator": before["denominator"] if before["denominator"] == after["denominator"] else None,
                "delta": delta,
                "regressionObserved": worse,
            }
        fixture_reports[fixture_id] = {"artifactSha256": fixture_hashes[fixture_id], "metrics": metric_reports}
    status = "REGRESSION_DETECTED" if regressions else "INCOMPLETE" if incomplete else "NO_REGRESSION_OBSERVED"
    return {
        "schemaVersion": 1,
        "baselineRunId": baseline["runId"],
        "candidateRunId": candidate["runId"],
        "baselineProductSourceCommit": baseline.get("productSourceCommit", baseline["commit"]),
        "candidateProductSourceCommit": candidate.get("productSourceCommit", candidate["commit"]),
        "fixtureManifestSha256": fixture_manifest_hash,
        "evaluationManifestSha256": evaluation_manifest_hash,
        "status": status,
        "regressions": regressions,
        "worktreesClean": baseline["worktreeClean"] and candidate["worktreeClean"],
        "thresholdsApplied": False,
        "certification": "This comparison is bounded evidence and is not a product certification.",
        "fixtures": fixture_reports,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline")
    parser.add_argument("candidate")
    parser.add_argument("--fixture-manifest", required=True)
    parser.add_argument("--evaluation-manifest", required=True)
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    try:
        fixture_hash = sha256_file(args.fixture_manifest)
        evaluation_hash = sha256_file(args.evaluation_manifest)
        report = compare_receipts(load_receipt(args.baseline), load_receipt(args.candidate),
                                  fixture_manifest=load_json(args.fixture_manifest),
                                  evaluation_manifest=load_json(args.evaluation_manifest),
                                  fixture_manifest_hash=fixture_hash,
                                  evaluation_manifest_hash=evaluation_hash)
        rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
        if args.output:
            Path(args.output).write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
    except (ReceiptError, OSError) as exc:
        print(f"compare_receipts: {exc}", file=sys.stderr)
        return 2
    return {"NO_REGRESSION_OBSERVED": 0, "REGRESSION_DETECTED": 1, "INCOMPLETE": 2}[report["status"]]


if __name__ == "__main__":
    raise SystemExit(main())
