#!/usr/bin/env python3
"""Bind CFR validation results to the exact code sources persisted by REAmon."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


class EvidenceError(ValueError):
    """Raised when JVM provider, database, and validator evidence disagree."""


SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SAMPLED_INPUT_COUNT = 8197


def load_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EvidenceError(f"cannot read JSON evidence {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise EvidenceError(f"evidence must contain a JSON object: {path}")
    return value


def sha256_file(path: Path) -> str:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()
    except OSError as exc:
        raise EvidenceError(f"cannot hash evidence {path}: {exc}") from exc


def _unavailable(denominator: int) -> dict:
    return {"state": "UNAVAILABLE", "denominator": denominator}


def merge_evidence(*, fixture_manifest: dict, validation: dict,
                   database_evidence: dict, database_evidence_sha256: str) -> dict:
    fixture_id = fixture_manifest.get("fixtureId")
    artifact = fixture_manifest.get("artifact")
    expected_hash = artifact.get("sha256") if isinstance(artifact, dict) else None
    expected_count = fixture_manifest.get("sourceModuleCount")
    if not isinstance(fixture_id, str) or not fixture_id:
        raise EvidenceError("fixture manifest needs a fixtureId")
    if not isinstance(expected_hash, str) or not SHA256_PATTERN.fullmatch(expected_hash):
        raise EvidenceError("fixture manifest needs an artifact SHA-256")
    if type(expected_count) is not int or expected_count <= 0:
        raise EvidenceError("fixture manifest needs a positive sourceModuleCount")
    if validation.get("fixtureId") != fixture_id or database_evidence.get("fixtureId") != fixture_id:
        raise EvidenceError("fixture IDs differ across manifest and receipts")
    if validation.get("artifactSha256") != expected_hash or database_evidence.get("artifactSha256") != expected_hash:
        raise EvidenceError("artifact SHA-256 differs from the enrolled fixture")
    if (not isinstance(database_evidence_sha256, str)
            or not SHA256_PATTERN.fullmatch(database_evidence_sha256)
            or validation.get("databaseIntegrationEvidenceSha256") != database_evidence_sha256):
        raise EvidenceError("validation receipt does not bind the database integration evidence hash")

    source_hashes = validation.get("recoveredSourceSha256ByPath")
    stored_hashes = database_evidence.get("storedSourceHashes")
    if not isinstance(source_hashes, dict) or not isinstance(stored_hashes, dict):
        raise EvidenceError("validation and database evidence must include source hash maps")
    if not all(isinstance(path, str) and isinstance(digest, str) and SHA256_PATTERN.fullmatch(digest)
               for path, digest in source_hashes.items()):
        raise EvidenceError("validation source hash map contains an invalid path or digest")
    if source_hashes != stored_hashes:
        raise EvidenceError("persisted source paths or hashes differ from validated CFR outputs")
    if database_evidence.get("allStoredSourcesHashVerified") is not True:
        raise EvidenceError("database integration did not verify every stored source hash")
    if database_evidence.get("sourceFileCount") != len(source_hashes):
        raise EvidenceError("database source count differs from the validation source inventory")
    if database_evidence.get("persistedCodeUnitCount") != len(stored_hashes):
        raise EvidenceError("persisted code-unit count differs from the stored source inventory")

    inventory_complete = (
        validation.get("truncated") is False
        and validation.get("discoveredSourceFiles") == expected_count
        and validation.get("expectedSourceFiles") == expected_count
        and len(source_hashes) == expected_count
    )
    metrics = {
        "recovered_source_files": {
            "state": "MEASURED",
            "denominator": expected_count,
            "value": min(expected_count, len(source_hashes)),
        },
        "source_inventory_complete": {
            "state": "MEASURED",
            "denominator": 1,
            "value": int(inventory_complete),
        },
    }

    correspondence = validation.get("sourceCorrespondence")
    classes = correspondence.get("classes") if isinstance(correspondence, dict) else None
    classes_expected = correspondence.get("classesExpected") if isinstance(correspondence, dict) else None
    classes_matched = correspondence.get("classesMatched") if isinstance(correspondence, dict) else None
    bytecode_complete = (
        isinstance(classes, dict)
        and type(classes_expected) is int
        and classes_expected == expected_count
        and correspondence.get("measurementComplete") is True
        and len(classes) == classes_expected
    )
    if bytecode_complete:
        measured_matches = 0
        for class_name, record in classes.items():
            if not isinstance(class_name, str) or not isinstance(record, dict):
                raise EvidenceError("bytecode correspondence contains an invalid class record")
            original_hash = record.get("originalJavapSha256")
            recovered_hash = record.get("recoveredJavapSha256")
            matched = record.get("bytecodeMatch")
            if (not isinstance(original_hash, str) or not SHA256_PATTERN.fullmatch(original_hash)
                    or not isinstance(recovered_hash, str) or not SHA256_PATTERN.fullmatch(recovered_hash)
                    or type(matched) is not bool or matched is not (original_hash == recovered_hash)):
                raise EvidenceError(f"bytecode correspondence is inconsistent for {class_name}")
            measured_matches += int(matched)
        if type(classes_matched) is not int or classes_matched != measured_matches:
            raise EvidenceError("bytecode correspondence summary contradicts class hashes")
        metrics["exact_bytecode_classes"] = {
            "state": "MEASURED", "denominator": expected_count, "value": measured_matches,
        }
    else:
        metrics["exact_bytecode_classes"] = _unavailable(expected_count)

    observed_stdout = validation.get("observedRuntimeStdout")
    expected_stdout = validation.get("expectedRuntimeStdout")
    runtime_flag = validation.get("runtimeMatches")
    if isinstance(observed_stdout, str) and isinstance(expected_stdout, str) and type(runtime_flag) is bool:
        metrics["runtime_oracle"] = {
            "state": "MEASURED", "denominator": 1,
            "value": int(runtime_flag and observed_stdout == expected_stdout),
        }
    else:
        metrics["runtime_oracle"] = _unavailable(1)

    behavior = validation.get("behavioralCorrespondence")
    if (isinstance(behavior, dict) and behavior.get("inputCount") == SAMPLED_INPUT_COUNT
            and type(behavior.get("allOutputsMatch")) is bool):
        hashes_match = (behavior.get("originalOutputSha256") == behavior.get("recoveredOutputSha256")
                        and isinstance(behavior.get("originalOutputSha256"), str)
                        and SHA256_PATTERN.fullmatch(behavior["originalOutputSha256"]) is not None)
        metrics["sampled_behavior_oracle"] = {
            "state": "MEASURED", "denominator": 1,
            "value": int(behavior["allOutputsMatch"] and hashes_match),
        }
    else:
        metrics["sampled_behavior_oracle"] = _unavailable(1)

    return {
        "schemaVersion": 1,
        "fixtures": {
            fixture_id: {
                "artifactSha256": expected_hash,
                "metrics": metrics,
            },
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-manifest", required=True, type=Path)
    parser.add_argument("--validation", required=True, type=Path)
    parser.add_argument("--database-evidence", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        evidence_path = args.database_evidence.resolve()
        result = merge_evidence(
            fixture_manifest=load_json(args.fixture_manifest),
            validation=load_json(args.validation),
            database_evidence=load_json(evidence_path),
            database_evidence_sha256=sha256_file(evidence_path),
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(result, stream, indent=2, sort_keys=True)
            stream.write("\n")
        print(f"Merged complete JVM evidence for {next(iter(result['fixtures']))} into {args.output}")
        return 0
    except EvidenceError as exc:
        print(f"JVM evidence merge failed: {exc}", file=sys.stderr)
        return 2
    except FileExistsError:
        print(f"refusing to overwrite evidence: {args.output}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
