from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

import mutate_carchive

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
