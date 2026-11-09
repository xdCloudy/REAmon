"""Run the service image's cookie check against one staged CArchive artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/app")
import server


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-path", type=Path, required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--service-image-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    digest = hashlib.sha256(args.artifact_path.read_bytes()).hexdigest()
    if digest != args.artifact_sha256:
        raise ValueError("staged malformed artifact hash differs from its mutation receipt")
    cookie_accepted = server.has_pyinstaller_cookie(args.artifact_path, args.artifact_path.stat().st_size)
    receipt = {
        "schemaVersion": 1,
        "fixtureId": args.fixture_id,
        "recordedAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "serviceImageId": args.service_image_id,
        "extractorRevision": server.EXTRACTOR_REVISION,
        "artifact": {
            "path": str(args.artifact_path),
            "sha256": digest,
            "sizeBytes": args.artifact_path.stat().st_size,
        },
        "check": "server.has_pyinstaller_cookie",
        "cookieAccepted": cookie_accepted,
        "purpose": "Confirms the malformed CArchive passed the outer cookie check before live endpoint extraction.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
    if not cookie_accepted:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
