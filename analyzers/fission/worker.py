#!/usr/bin/env python3
"""Run the pinned Fission CLI and save bounded per-function evidence."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import selectors
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

FISSION = os.environ.get("FISSION_BIN", "/opt/fission/fission_cli")
RESOURCE_ROOT = os.environ.get("FISSION_RESOURCE_ROOT", "/opt/fission/utils")
VERSION = os.environ.get("FISSION_VERSION", "unknown")
REVISION = os.environ.get("FISSION_PROVIDER_REVISION", "")
MAX_FUNCTIONS = min(256, max(1, int(os.environ.get("FISSION_MAX_FUNCTIONS", "128"))))
MAX_FUNCTION_BYTES = min(2 * 1024 * 1024, max(1024, int(os.environ.get("FISSION_MAX_FUNCTION_BYTES", str(1024 * 1024)))))
MAX_TOTAL_BYTES = min(64 * 1024 * 1024, max(MAX_FUNCTION_BYTES, int(os.environ.get("FISSION_MAX_OUTPUT_BYTES", str(32 * 1024 * 1024)))))
MAX_JSON_BYTES = min(96 * 1024 * 1024, max(1024 * 1024, int(os.environ.get("FISSION_MAX_JSON_BYTES", str(64 * 1024 * 1024)))))
MAX_FUNCTION_MS = min(120_000, max(500, int(os.environ.get("FISSION_FUNCTION_TIMEOUT_MS", "10000"))))
ADDRESS = re.compile(r"^(?:0x)?[0-9a-f]{1,32}$", re.IGNORECASE)


class AnalysisError(Exception):
    pass


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_cli(binary: Path, stdout_path: Path, timeout: int, cancel_check: Callable[[], bool]) -> None:
    command = [FISSION, "--resource-root", RESOURCE_ROOT, "decomp", str(binary),
               "--all", "--limit", str(MAX_FUNCTIONS), "--profile", "balanced",
               "--function-discovery-profile", "balanced", "--timeout-ms", str(MAX_FUNCTION_MS), "--json"]
    with stdout_path.open("wb") as output:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                                   cwd="/tmp", env={**os.environ, "HOME": "/tmp", "XDG_CACHE_HOME": "/tmp"})
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if cancel_check():
                    raise AnalysisError("Fission analysis was cancelled")
                if time.monotonic() >= deadline:
                    raise AnalysisError(f"Fission exceeded {timeout} seconds")
                if stdout_path.stat().st_size > MAX_JSON_BYTES:
                    raise AnalysisError("Fission JSON output exceeded its configured size limit")
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
            if process.returncode != 0:
                raise AnalysisError(f"Fission CLI exited with code {process.returncode}")
            if stdout_path.stat().st_size > MAX_JSON_BYTES:
                raise AnalysisError("Fission JSON output exceeded its configured size limit")
        except BaseException:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise


def main(cancel_check: Callable[[], bool] = lambda: False) -> dict[str, object]:
    if len(sys.argv) != 6:
        raise AnalysisError("Invalid Fission worker arguments")
    binary = Path(sys.argv[1]).resolve(strict=True)
    temporary_root = Path(sys.argv[2]).resolve(strict=True)
    output_root = Path(sys.argv[3]).resolve(strict=True)
    timeout = max(60, min(1800, int(sys.argv[4])))
    expected_input_hash = sys.argv[5].lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected_input_hash) or digest_file(binary) != expected_input_hash:
        raise AnalysisError("Input artifact changed before Fission analysis started")

    working_binary = temporary_root / "analysis-input.bin"
    shutil.copyfile(binary, working_binary)
    if digest_file(working_binary) != expected_input_hash:
        raise AnalysisError("Temporary Fission input copy did not match the imported artifact")
    json_path = temporary_root / "fission-output.json"
    started = time.monotonic()
    run_cli(working_binary, json_path, timeout, cancel_check)
    try:
        raw = json.loads(json_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AnalysisError("Fission did not return valid JSON decompilation results") from error
    if not isinstance(raw, list):
        raise AnalysisError("Fission JSON result must be an array")

    units: list[dict[str, object]] = []
    seen_addresses: set[str] = set()
    output_bytes = 0
    failed = 0
    function_root = output_root / "functions"
    function_root.mkdir(parents=True, exist_ok=True)
    try:
        artifact_prefix = output_root.relative_to(Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()).as_posix()
    except ValueError as error:
        raise AnalysisError("Derived output directory is outside the configured storage root") from error
    for row in raw[:MAX_FUNCTIONS]:
        if cancel_check():
            raise AnalysisError("Fission analysis was cancelled")
        if not isinstance(row, dict):
            failed += 1
            continue
        raw_address = row.get("address")
        if not isinstance(raw_address, str) or not ADDRESS.fullmatch(raw_address.strip()):
            failed += 1
            continue
        address_number = int(raw_address.strip().removeprefix("0x").removeprefix("0X"), 16)
        address = f"0x{address_number:x}"
        code = row.get("code")
        if address in seen_addresses or not isinstance(code, str) or not code.strip():
            failed += 1
            continue
        encoded = code.encode("utf-8")
        if len(encoded) > MAX_FUNCTION_BYTES or output_bytes + len(encoded) > MAX_TOTAL_BYTES:
            failed += 1
            continue
        relative_path = f"functions/{address_number:x}.c"
        target = output_root / relative_path
        target.write_bytes(encoded)
        output_hash = hashlib.sha256(encoded).hexdigest()
        name = row.get("name") if isinstance(row.get("name"), str) and row.get("name").strip() else f"sub_{address_number:x}"
        stats = row.get("preview_build_stats")
        if not isinstance(stats, dict):
            stats = {}
        bounded_stats = {str(key)[:80]: max(0, min(2**31 - 1, value))
                         for key, value in list(stats.items())[:32]
                         if isinstance(key, str) and isinstance(value, int) and not isinstance(value, bool)}
        units.append({
            "name": name[:500],
            "address": address,
            "relativePath": relative_path,
            "codeArtifactId": f"{artifact_prefix}/{relative_path}",
            "sizeBytes": len(encoded),
            "outputSha256": output_hash,
            "engine": str(row.get("engine_used") or "unknown")[:80],
            "previewBuildStats": bounded_stats,
        })
        seen_addresses.add(address)
        output_bytes += len(encoded)

    if not units:
        raise AnalysisError("Fission did not produce any bounded, viewable function output")
    if digest_file(binary) != expected_input_hash:
        raise AnalysisError("Input artifact changed while Fission was analyzing it")
    return {
        "status": "completed",
        "toolVersion": VERSION,
        "providerRevision": REVISION,
        "sourceSha256": expected_input_hash,
        "batchResultCount": len(raw),
        "returnedUnits": len(units),
        "failedFunctionCount": failed,
        "truncated": len(raw) >= MAX_FUNCTIONS,
        "outputBytes": output_bytes,
        "elapsedMs": int((time.monotonic() - started) * 1000),
        "units": units,
    }


if __name__ == "__main__":
    try:
        result = main()
        Path(sys.argv[2], "result.json").write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    except (AnalysisError, OSError, ValueError) as error:
        print(str(error)[:2000], file=sys.stderr)
        raise SystemExit(1)
