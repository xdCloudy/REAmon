"""Create a reproducible malformed CArchive control from a pinned fixture."""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from datetime import datetime, timezone
from pathlib import Path


FIXTURE_ID = "pyinstaller-module-structured-source-linux-amd64"
CONTROL_ID = "pyinstaller-malformed-carchive-toc-linux-amd64"
DATA_BOUNDS_CONTROL_ID = "pyinstaller-malformed-carchive-entry-bounds-linux-amd64"
COOKIE = b"MEI\x0c\x0b\x0a\x0b\x0e"
COOKIE_SIZE = 88  # PyInstaller 2.1+ cookie used by the pinned PyInstaller 6 fixture.
CTOC_ENTRY_SIZE = 18


def locate_carchive_toc(data: bytes) -> tuple[int, int, int, int]:
    """Return cookie, TOC, TOC length, and first-entry size-field offsets."""
    offset = data.rfind(COOKIE, max(0, len(data) - 1024 * 1024))
    while offset >= 0:
        if offset + COOKIE_SIZE <= len(data):
            package_size, toc_offset, toc_size = struct.unpack_from(">III", data, offset + 8)
            if 0 < package_size <= offset and toc_size > 0:
                overlay_start = offset + COOKIE_SIZE - package_size
                toc_position = overlay_start + toc_offset
                if (
                    overlay_start >= 0
                    and toc_position >= overlay_start
                    and toc_position + toc_size <= offset
                    and toc_size >= CTOC_ENTRY_SIZE
                ):
                    entry_size = struct.unpack_from(">I", data, toc_position)[0]
                    if CTOC_ENTRY_SIZE <= entry_size <= toc_size:
                        return offset, toc_position, toc_size, toc_position
        offset = data.rfind(COOKIE, max(0, offset - 1_048_576), offset)
    raise ValueError("No bounded PyInstaller 2.1+ CArchive TOC found")


def mutate_first_entry(data: bytes) -> tuple[bytes, dict[str, int]]:
    cookie_offset, toc_offset, toc_size, entry_size_offset = locate_carchive_toc(data)
    mutated = bytearray(data)
    original_entry_size = struct.unpack_from(">I", mutated, entry_size_offset)[0]
    struct.pack_into(">I", mutated, entry_size_offset, CTOC_ENTRY_SIZE - 1)
    return bytes(mutated), {
        "cookieOffset": cookie_offset,
        "tocOffset": toc_offset,
        "tocSize": toc_size,
        "entrySizeOffset": entry_size_offset,
        "originalEntrySize": original_entry_size,
        "mutatedEntrySize": CTOC_ENTRY_SIZE - 1,
    }


def mutate_first_entry_data_position(data: bytes) -> tuple[bytes, dict[str, int]]:
    cookie_offset, toc_offset, toc_size, entry_size_offset = locate_carchive_toc(data)
    package_size = struct.unpack_from(">I", data, cookie_offset + 8)[0]
    overlay_start = cookie_offset + COOKIE_SIZE - package_size
    overlay_size = len(data) - overlay_start
    entry_position_offset = toc_offset + 4
    original_position = struct.unpack_from(">I", data, entry_position_offset)[0]
    invalid_position = overlay_size + 1
    if not 0 <= invalid_position <= 0xFFFFFFFF or invalid_position == original_position:
        raise ValueError("Cannot construct out-of-bounds CArchive entry position")
    mutated = bytearray(data)
    struct.pack_into(">I", mutated, entry_position_offset, invalid_position)
    return bytes(mutated), {
        "cookieOffset": cookie_offset,
        "tocOffset": toc_offset,
        "tocSize": toc_size,
        "entrySizeOffset": entry_size_offset,
        "entryPositionOffset": entry_position_offset,
        "originalEntryPosition": original_position,
        "mutatedEntryPosition": invalid_position,
        "overlaySize": overlay_size,
    }


def build(
    input_path: Path,
    output_path: Path,
    receipt_path: Path,
    mutation: str = "first-entry-size-below-header",
) -> dict[str, object]:
    if output_path.exists() or receipt_path.exists():
        raise FileExistsError("refusing to overwrite malformed-control artifact or receipt")
    source = input_path.read_bytes()
    if mutation == "first-entry-size-below-header":
        malformed, mutation_evidence = mutate_first_entry(source)
        control_id = CONTROL_ID
        mutation_description = "Set the first CArchive TOC entry size below its 18-byte fixed header."
    elif mutation == "first-entry-position-outside-overlay":
        malformed, mutation_evidence = mutate_first_entry_data_position(source)
        control_id = DATA_BOUNDS_CONTROL_ID
        mutation_description = "Set the first CArchive TOC entry data position beyond the archive overlay."
    else:
        raise ValueError(f"unsupported CArchive mutation: {mutation}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(malformed)
    receipt: dict[str, object] = {
        "schemaVersion": 1,
        "fixtureId": control_id,
        "baseFixtureId": FIXTURE_ID,
        "createdAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "mutationId": mutation,
        "mutation": mutation_description,
        "offsets": mutation_evidence,
        "sourceArtifact": {
            "path": input_path.name,
            "sizeBytes": len(source),
            "sha256": hashlib.sha256(source).hexdigest(),
        },
        "malformedArtifact": {
            "path": output_path.name,
            "sizeBytes": len(malformed),
            "sha256": hashlib.sha256(malformed).hexdigest(),
        },
        "hostExecution": "not executed",
    }
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument(
        "--mutation",
        choices=("first-entry-size-below-header", "first-entry-position-outside-overlay"),
        default="first-entry-size-below-header",
    )
    args = parser.parse_args()
    result = build(args.input, args.output, args.receipt, mutation=args.mutation)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
