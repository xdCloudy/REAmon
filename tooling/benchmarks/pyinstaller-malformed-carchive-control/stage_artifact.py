"""Stage or clean one hash-bound malformed fixture in the QA artifact volume."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def stage(
    source: Path,
    mutation_receipt_path: Path,
    artifact_root: Path,
    stage_id: str,
    output: Path,
    fixture_id: str,
) -> dict[str, object]:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", stage_id):
        raise ValueError("stage id contains unsupported characters")
    if output.exists():
        raise FileExistsError(f"refusing existing staging receipt: {output}")
    mutation = json.loads(mutation_receipt_path.read_text(encoding="utf-8-sig"))
    expected_hash = mutation.get("malformedArtifact", {}).get("sha256")
    if mutation.get("fixtureId") != fixture_id or expected_hash != sha256_file(source):
        raise ValueError("artifact does not match the mutation receipt and fixture id")

    root = artifact_root.resolve(strict=True)
    qa_root = root / "qa"
    if qa_root.exists():
        if qa_root.is_symlink() or not qa_root.is_dir():
            raise ValueError("QA staging parent is not a regular directory")
    else:
        qa_root.mkdir()
    stage_root = qa_root / f"pyinstaller-malformed-{stage_id}"
    stage_root.mkdir(exist_ok=False)
    artifact_path = stage_root / "fixture"
    try:
        shutil.copyfile(source, artifact_path)
        if sha256_file(artifact_path) != expected_hash:
            raise ValueError("staged artifact hash differs from the mutation receipt")
        receipt: dict[str, object] = {
            "schemaVersion": 1,
            "fixtureId": fixture_id,
            "stageId": stage_id,
            "sourceSha256": expected_hash,
            "stagedArtifactPath": str(artifact_path),
            "stagedArtifactSha256": sha256_file(artifact_path),
            "staged": True,
            "cleanup": "PENDING",
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        return receipt
    except Exception:
        if artifact_path.exists() and sha256_file(artifact_path) == expected_hash:
            artifact_path.unlink()
        stage_root.rmdir()
        raise


def cleanup(receipt_path: Path, artifact_root: Path) -> dict[str, object]:
    receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
    stage_id = str(receipt.get("stageId", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", stage_id):
        raise ValueError("staging receipt has an invalid stage id")
    root = artifact_root.resolve(strict=True)
    qa_root = root / "qa"
    if qa_root.is_symlink() or not qa_root.is_dir():
        raise ValueError("QA staging parent is not a regular directory")
    expected_root = qa_root / f"pyinstaller-malformed-{stage_id}"
    if expected_root.is_symlink() or not expected_root.is_dir():
        raise ValueError("exact staging directory is missing or is not a regular directory")
    expected_root.resolve(strict=True).relative_to(qa_root.resolve(strict=True))
    artifact_path = expected_root / "fixture"
    if str(artifact_path) != receipt.get("stagedArtifactPath"):
        raise ValueError("staging receipt artifact path differs from the derived exact path")
    if not artifact_path.is_file() or artifact_path.is_symlink():
        raise FileNotFoundError("the exact staged artifact is missing or is not a regular file")
    expected_hash = str(receipt.get("stagedArtifactSha256", ""))
    if sha256_file(artifact_path) != expected_hash or expected_hash != receipt.get("sourceSha256"):
        raise ValueError("staged artifact changed; preserving it for inspection")
    artifact_path.unlink()
    expected_root.rmdir()
    receipt["staged"] = False
    receipt["cleanup"] = "REMOVED_AFTER_HASH_CHECK"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    stage_parser = subparsers.add_parser("stage")
    stage_parser.add_argument("--source", type=Path, required=True)
    stage_parser.add_argument("--mutation-receipt", type=Path, required=True)
    stage_parser.add_argument("--artifact-root", type=Path, default=Path("/data/reamon-artifacts"))
    stage_parser.add_argument("--stage-id", required=True)
    stage_parser.add_argument("--fixture-id", required=True)
    stage_parser.add_argument("--output", type=Path, required=True)
    cleanup_parser = subparsers.add_parser("cleanup")
    cleanup_parser.add_argument("--receipt", type=Path, required=True)
    cleanup_parser.add_argument("--artifact-root", type=Path, default=Path("/data/reamon-artifacts"))
    args = parser.parse_args()
    if args.action == "stage":
        result = stage(
            args.source,
            args.mutation_receipt,
            args.artifact_root,
            args.stage_id,
            args.output,
            args.fixture_id,
        )
    else:
        result = cleanup(args.receipt, args.artifact_root)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
