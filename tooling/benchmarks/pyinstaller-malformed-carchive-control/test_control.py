from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

import mutate_carchive
import stage_artifact

MANIFEST = Path(__file__).with_name("manifest.json")


def synthetic_archive() -> bytes:
    data = bytearray(512)
    archive_start = 100
    toc_offset = 40
    toc_position = archive_start + toc_offset
    cookie_offset = 400
    package_size = cookie_offset + mutate_carchive.COOKIE_SIZE - archive_start
    data[toc_position : toc_position + 18] = bytes(18)
    struct.pack_into(">I", data, toc_position, 22)
    data[toc_position + 18 : toc_position + 22] = b"mod\0"
    data[cookie_offset : cookie_offset + 8] = mutate_carchive.COOKIE
    struct.pack_into(">III", data, cookie_offset + 8, package_size, toc_offset, 22)
    return bytes(data)


def test_mutation_preserves_cookie_and_invalidates_only_first_toc_entry_size():
    source = synthetic_archive()
    mutated, info = mutate_carchive.mutate_first_entry(source)

    differences = [index for index, (before, after) in enumerate(zip(source, mutated)) if before != after]
    field_offsets = set(range(info["entrySizeOffset"], info["entrySizeOffset"] + 4))
    assert differences
    assert set(differences) <= field_offsets
    assert mutated[info["cookieOffset"] :] == source[info["cookieOffset"] :]
    assert struct.unpack_from(">I", mutated, info["entrySizeOffset"])[0] == 17
    assert struct.unpack_from(">III", mutated, info["cookieOffset"] + 8) == (
        388,
        40,
        22,
    )


def test_data_position_mutation_preserves_cookie_and_exceeds_overlay_bounds():
    source = synthetic_archive()
    mutated, info = mutate_carchive.mutate_first_entry_data_position(source)

    differences = [index for index, (before, after) in enumerate(zip(source, mutated)) if before != after]
    field_offsets = set(range(info["entryPositionOffset"], info["entryPositionOffset"] + 4))
    assert differences
    assert set(differences) <= field_offsets
    assert mutated[info["cookieOffset"] :] == source[info["cookieOffset"] :]
    assert info["mutatedEntryPosition"] == info["overlaySize"] + 1
    assert struct.unpack_from(">I", mutated, info["entryPositionOffset"])[0] == info["overlaySize"] + 1


def test_mutator_refuses_input_without_a_bounded_carchive_toc():
    with pytest.raises(ValueError, match="No bounded PyInstaller"):
        mutate_carchive.mutate_first_entry(bytes(512))


def test_mutator_rejects_output_or_receipt_overwrite(tmp_path):
    source = tmp_path / "source.exe"
    output = tmp_path / "malformed.exe"
    receipt = tmp_path / "receipt.json"
    source.write_bytes(synthetic_archive())
    output.write_bytes(b"preserve")

    with pytest.raises(FileExistsError, match="refusing to overwrite"):
        mutate_carchive.build(source, output, receipt)


def test_manifest_declares_bounded_malformed_input_acceptance():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    assert manifest["fixtureId"] == mutate_carchive.CONTROL_ID
    assert manifest["mutation"]["preservesOuterCookie"] is True
    assert manifest["expectedProviderOutcome"] == {
        "httpStatus": 400,
        "status": "failed",
        "noRecoveredModules": True,
        "errorContains": "malformed",
    }


def test_data_bounds_manifest_declares_a_distinct_malformed_control():
    manifest = json.loads(
        MANIFEST.with_name("manifest-data-bounds.json").read_text(encoding="utf-8")
    )

    assert manifest["fixtureId"] == mutate_carchive.DATA_BOUNDS_CONTROL_ID
    assert manifest["mutation"]["field"] == "first CArchive TOC entry data position"
    assert manifest["mutation"]["invalidValue"] == "one byte beyond overlay size"
    assert manifest["expectedProviderOutcome"]["httpStatus"] == 400


def test_stager_verifies_receipt_and_cleanup_removes_only_the_hash_matched_file(tmp_path):
    artifact_root = tmp_path / "artifact-root"
    artifact_root.mkdir()
    source = tmp_path / "malformed"
    source.write_bytes(b"synthetic malformed archive")
    digest = stage_artifact.sha256_file(source)
    mutation_receipt = tmp_path / "mutation.json"
    mutation_receipt.write_text(
        json.dumps({"fixtureId": mutate_carchive.DATA_BOUNDS_CONTROL_ID,
                    "malformedArtifact": {"sha256": digest}}),
        encoding="utf-8",
    )
    staging_receipt = tmp_path / "staging.json"

    staged = stage_artifact.stage(
        source,
        mutation_receipt,
        artifact_root,
        "test-stage",
        staging_receipt,
        mutate_carchive.DATA_BOUNDS_CONTROL_ID,
    )
    staged_path = Path(staged["stagedArtifactPath"])
    assert staged_path.read_bytes() == source.read_bytes()

    cleaned = stage_artifact.cleanup(staging_receipt, artifact_root)
    assert cleaned["cleanup"] == "REMOVED_AFTER_HASH_CHECK"
    assert not staged_path.exists()
    assert not staged_path.parent.exists()


def test_stager_preserves_changed_artifact_during_cleanup(tmp_path):
    artifact_root = tmp_path / "artifact-root"
    artifact_root.mkdir()
    source = tmp_path / "malformed"
    source.write_bytes(b"synthetic malformed archive")
    digest = stage_artifact.sha256_file(source)
    mutation_receipt = tmp_path / "mutation.json"
    mutation_receipt.write_text(
        json.dumps({"fixtureId": mutate_carchive.DATA_BOUNDS_CONTROL_ID,
                    "malformedArtifact": {"sha256": digest}}),
        encoding="utf-8",
    )
    staging_receipt = tmp_path / "staging.json"
    staged = stage_artifact.stage(
        source,
        mutation_receipt,
        artifact_root,
        "changed-stage",
        staging_receipt,
        mutate_carchive.DATA_BOUNDS_CONTROL_ID,
    )
    staged_path = Path(staged["stagedArtifactPath"])
    staged_path.write_bytes(b"changed")

    with pytest.raises(ValueError, match="changed; preserving"):
        stage_artifact.cleanup(staging_receipt, artifact_root)
    assert staged_path.read_bytes() == b"changed"
