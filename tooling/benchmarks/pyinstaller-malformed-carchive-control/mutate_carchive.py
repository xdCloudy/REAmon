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


def build(input_path: Path, output_path: Path, receipt_path: Path) -> dict[str, object]:
    if output_path.exists() or receipt_path.exists():
        raise FileExistsError("refusing to overwrite malformed-control artifact or receipt")
    source = input_path.read_bytes()
    malformed, mutation = mutate_first_entry(source)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(malformed)
    receipt: dict[str, object] = {
        "schemaVersion": 1,
        "fixtureId": CONTROL_ID,
        "baseFixtureId": FIXTURE_ID,
        "createdAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "mutation": "Set the first CArchive TOC entry size below the 18-byte fixed header.",
        "offsets": mutation,
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
    args = parser.parse_args()
    result = build(args.input, args.output, args.receipt)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
