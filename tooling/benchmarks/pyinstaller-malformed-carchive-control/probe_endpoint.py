"""Probe the live isolated PyInstaller service and write a bounded receipt."""

from __future__ import annotations

import argparse
import hashlib
import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_CONTROL_ID = "pyinstaller-malformed-carchive-toc-linux-amd64"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def request_json(url: str, payload: dict[str, object] | None = None) -> tuple[int, dict[str, object]]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"} if body is not None else {},
        method="GET" if body is None else "POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status = response.status
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as response:
        status = response.code
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("PyInstaller service response exceeds the 4 MiB probe limit")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("PyInstaller service returned a non-object JSON response")
    return status, result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8029")
    parser.add_argument("--artifact-path", required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--fixture-id", default=DEFAULT_CONTROL_ID)
    parser.add_argument("--artifact-id", default="toc-invalid-v1")
    parser.add_argument("--project-id", default="malformed-control")
    parser.add_argument("--run-id", default="malformed-control-v1")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    artifact_path = Path(args.artifact_path)
    artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    if artifact_hash != args.artifact_sha256:
        raise ValueError("mounted malformed artifact hash does not match its build receipt")

    health_status, health = request_json(f"{args.base_url}/health")
    payload = {
        "projectId": args.project_id,
        "artifactId": args.artifact_id,
        "taskId": "single-request",
        "runId": args.run_id,
        "artifactPath": args.artifact_path,
        "offset": 0,
    }
    response_status, response = request_json(f"{args.base_url}/extract", payload)
    error = response.get("error")
    passed = (
        health_status == 200
        and response_status == 400
        and response.get("status") == "failed"
        and isinstance(error, str)
        and "malformed" in error.lower()
        and "modules" not in response
    )
    receipt: dict[str, object] = {
        "schemaVersion": 1,
        "fixtureId": args.fixture_id,
        "recordedAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "service": {
            "baseUrl": args.base_url,
            "extractorRevision": health.get("extractorRevision"),
            "healthStatus": health_status,
        },
        "artifact": {
            "path": args.artifact_path,
            "sha256": artifact_hash,
            "sizeBytes": artifact_path.stat().st_size,
        },
        "request": payload,
        "response": {"httpStatus": response_status, "body": response},
        "expected": {
            "httpStatus": 400,
            "status": "failed",
            "noRecoveredModules": True,
        },
        "controlResult": "PASS" if passed else "FAIL",
        "scope": "One malformed CArchive control at the isolated PyInstaller provider; no target execution.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
