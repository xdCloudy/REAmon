#!/usr/bin/env python3
"""Run pinned Kuna analysis and export bounded, address-keyed native evidence."""
from __future__ import annotations

import hashlib
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

KUNA = os.environ.get("KUNA_BIN", "/opt/kuna/kuna")
PROVIDER_REVISION = os.environ.get("KUNA_PROVIDER_REVISION", "")
KUNA_VERSION = os.environ.get("KUNA_VERSION", "unknown")
MAX_FUNCTIONS = min(500, max(1, int(os.environ.get("KUNA_MAX_FUNCTIONS", "200"))))
MAX_FUNCTION_BYTES = min(2 * 1024 * 1024, max(1024, int(os.environ.get("KUNA_MAX_FUNCTION_BYTES", str(1024 * 1024)))))
MAX_ASSEMBLY_BYTES = min(4 * 1024 * 1024, max(1024, int(os.environ.get("KUNA_MAX_ASSEMBLY_BYTES", str(2 * 1024 * 1024)))))
MAX_TOTAL_BYTES = min(128 * 1024 * 1024, max(MAX_FUNCTION_BYTES, int(os.environ.get("KUNA_MAX_OUTPUT_BYTES", str(96 * 1024 * 1024)))))
MAX_GRAPH_BYTES = min(256 * 1024 * 1024, max(MAX_TOTAL_BYTES, int(os.environ.get("KUNA_MAX_GRAPH_BYTES", str(192 * 1024 * 1024)))))
MAX_FUNCTION_SECONDS = min(120, max(1, int(os.environ.get("KUNA_MAX_FUNCTION_SECONDS", "15"))))
MAX_FAILURES = 200
ADDRESS = re.compile(r"^(?:0x)?[0-9a-f]{1,32}$", re.IGNORECASE)


class AnalysisError(Exception):
    pass


def address(value: object) -> tuple[int, str] | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        number = value
    elif isinstance(value, str) and ADDRESS.fullmatch(value.strip()):
        try:
            number = int(value.strip(), 16)
        except ValueError:
            return None
    else:
        return None
    return number, f"0x{number:x}"


def run_bounded(command: list[str], *, timeout: float, max_bytes: int, cancel_check: Callable[[], bool]) -> bytes:
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               cwd="/tmp", env={**os.environ, "PYTHONNOUSERSITE": "1"}, start_new_session=True)
    deadline = time.monotonic() + timeout
    output = bytearray()
    assert process.stdout is not None
    os.set_blocking(process.stdout.fileno(), False)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        while True:
            if cancel_check():
                raise AnalysisError("Kuna analysis was cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AnalysisError(f"Kuna exceeded its {int(timeout)} second command limit")
            for key, _ in selector.select(timeout=min(0.25, remaining)):
                chunk = os.read(key.fileobj.fileno(), min(64 * 1024, max_bytes + 1 - len(output)))
                if chunk:
                    output.extend(chunk)
                    if len(output) > max_bytes:
                        raise AnalysisError("Kuna JSON output exceeded its configured limit")
                else:
                    selector.unregister(key.fileobj)
            if process.poll() is not None and not selector.get_map():
                break
        if process.returncode != 0:
            raise AnalysisError(f"Kuna exited with code {process.returncode}")
        return bytes(output)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        raise
    finally:
        selector.close()
        if process.stdout:
            process.stdout.close()


def run_graph(command: list[str], path: Path, *, timeout: float, cancel_check: Callable[[], bool]) -> None:
    with path.open("wb") as output:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                   cwd="/tmp", env={**os.environ, "PYTHONNOUSERSITE": "1"}, start_new_session=True)
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if cancel_check():
                    raise AnalysisError("Kuna analysis was cancelled")
                if time.monotonic() >= deadline:
                    raise AnalysisError(f"Kuna graph analysis exceeded {int(timeout)} seconds")
                if path.exists() and path.stat().st_size > MAX_GRAPH_BYTES:
                    raise AnalysisError("Kuna graph JSON exceeded its configured limit")
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
            if process.returncode != 0:
                detail = (process.stderr.read(16 * 1024) if process.stderr else b"").decode("utf-8", errors="replace")[-2000:].strip()
                raise AnalysisError(detail or f"Kuna exited with code {process.returncode}")
            if path.stat().st_size > MAX_GRAPH_BYTES:
                raise AnalysisError("Kuna graph JSON exceeded its configured limit")
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            raise


def parse_json(data: bytes, message: str) -> dict[str, object]:
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AnalysisError(message) from error
    if not isinstance(value, dict):
        raise AnalysisError(message)
    return value


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(cancel_check: Callable[[], bool] = lambda: False) -> dict[str, object]:
    if len(sys.argv) != 6:
        raise AnalysisError("Invalid Kuna worker arguments")
    binary = Path(sys.argv[1]).resolve(strict=True)
    temporary_root = Path(sys.argv[2]).resolve(strict=True)
    output_root = Path(sys.argv[3]).resolve(strict=True)
    timeout_seconds = max(60, min(1800, int(sys.argv[4])))
    source_sha256 = sys.argv[5].lower()
    expected_sha256 = digest_file(binary)
    if not re.fullmatch(r"[a-f0-9]{64}", source_sha256) or source_sha256 != expected_sha256:
        raise AnalysisError("Input artifact changed before Kuna analysis started")

    inventory_data = run_bounded(
        [KUNA, "functions", str(binary), "--json", "--sort", "size", "--limit", str(MAX_FUNCTIONS)],
        timeout=min(timeout_seconds, 180), max_bytes=32 * 1024 * 1024, cancel_check=cancel_check,
    )
    inventory = parse_json(inventory_data, "Kuna did not return a valid function inventory")
    rows = inventory.get("functions")
    if not isinstance(rows, list):
        raise AnalysisError(str(inventory.get("error") or "Kuna discovered no function inventory")[:1200])
    selected: dict[int, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        parsed = address(row.get("address_hex", row.get("address")))
        if parsed is None or row.get("kind") in {"data", "external", "import"}:
            continue
        selected.setdefault(parsed[0], str(row.get("name") or f"sub_{parsed[0]:x}")[:500])
    if not selected:
        raise AnalysisError(str(inventory.get("error") or "Kuna discovered no executable function bodies")[:1200])

    graph_path = temporary_root / "graph.json"
    command = [KUNA, "decompile-graph", str(binary), "-o", str(graph_path), "--jobs", "1",
               "--max-fn-seconds", str(MAX_FUNCTION_SECONDS)]
    for address_value in selected:
        command.extend(["--addr", f"0x{address_value:x}"])
    run_graph(command, graph_path, timeout=timeout_seconds, cancel_check=cancel_check)
    try:
        graph = parse_json(graph_path.read_bytes(), "Kuna did not produce a valid function graph")
    except OSError as error:
        raise AnalysisError("Kuna graph output could not be read") from error
    if graph.get("schemaVersion") != 4:
        raise AnalysisError("Kuna returned an unsupported decompile-graph schema")
    graph_functions = graph.get("functions")
    if not isinstance(graph_functions, list):
        raise AnalysisError("Kuna graph did not contain a function inventory")

    function_root = output_root / "functions"
    assembly_root = output_root / "assembly"
    function_root.mkdir(parents=True, exist_ok=True)
    assembly_root.mkdir(parents=True, exist_ok=True)
    units: list[dict[str, object]] = []
    failures: list[str] = []
    output_bytes = 0
    name_by_address: dict[int, str] = {}
    for row in graph_functions:
        if not isinstance(row, dict):
            continue
        parsed = address(row.get("address"))
        if parsed is None or parsed[0] not in selected:
            continue
        address_number, address_text = parsed
        name = str(row.get("name") or selected[address_number])[:500]
        code = row.get("codeC")
        if not isinstance(code, str) or not code.strip():
            error = str(row.get("error") or "Kuna returned no C-like function body")[:300]
            if len(failures) < MAX_FAILURES:
                failures.append(f"{address_text} {name}: {error}")
            continue
        encoded = code.encode("utf-8")
        if len(encoded) > MAX_FUNCTION_BYTES or output_bytes + len(encoded) > MAX_TOTAL_BYTES:
            if len(failures) < MAX_FAILURES:
                failures.append(f"{address_text} {name}: output exceeded the configured size limit")
            continue
        safe_address = f"{address_number:x}"
        code_relative = f"functions/{safe_address}.c"
        code_path = function_root / f"{safe_address}.c"
        code_path.write_bytes(encoded)
        unit: dict[str, object] = {
            "name": name,
            "address": address_text,
            "kind": str(row.get("kind") or "normal")[:32],
            "signature": str(row.get("signature") or "")[:2000],
            "relativePath": code_relative,
            "codeArtifactId": (output_root / code_relative).relative_to(Path(os.environ["REAMON_DERIVED_PATH"]).resolve()).as_posix(),
            "sizeBytes": len(encoded),
            "outputSha256": hashlib.sha256(encoded).hexdigest(),
            "instructionSizeBytes": max(0, min(2**31 - 1, int(row.get("size") or 0))),
        }
        assembly = row.get("assembly")
        if isinstance(assembly, str) and assembly.strip():
            assembly_bytes = assembly.encode("utf-8")
            if len(assembly_bytes) <= MAX_ASSEMBLY_BYTES and output_bytes + len(encoded) + len(assembly_bytes) <= MAX_TOTAL_BYTES:
                assembly_relative = f"assembly/{safe_address}.asm"
                assembly_path = assembly_root / f"{safe_address}.asm"
                assembly_path.write_bytes(assembly_bytes)
                unit.update({
                    "assemblyRelativePath": assembly_relative,
                    "assemblyArtifactId": (output_root / assembly_relative).relative_to(Path(os.environ["REAMON_DERIVED_PATH"]).resolve()).as_posix(),
                    "assemblySizeBytes": len(assembly_bytes),
                    "assemblySha256": hashlib.sha256(assembly_bytes).hexdigest(),
                })
                output_bytes += len(assembly_bytes)
        output_bytes += len(encoded)
        units.append(unit)
        name_by_address[address_number] = name
    if not units:
        raise AnalysisError("Kuna produced no bounded, viewable C-like function bodies")

    calls: list[dict[str, object]] = []
    edges = graph.get("edges")
    if isinstance(edges, list):
        for edge in edges:
            if not isinstance(edge, dict):
                continue
            caller = address(edge.get("callerAddress"))
            callee = address(edge.get("calleeAddress"))
            if caller is None or callee is None or caller[0] not in name_by_address or callee[0] not in name_by_address:
                continue
            calls.append({
                "fromAddress": caller[1],
                "toAddress": callee[1],
                "fromName": name_by_address[caller[0]],
                "toName": name_by_address[callee[0]],
                "kind": str(edge.get("kind") or "call")[:32],
            })
            if len(calls) >= 10_000:
                break

    total_count = inventory.get("total", inventory.get("count", len(rows)))
    total_count = int(total_count) if isinstance(total_count, int) and not isinstance(total_count, bool) else len(rows)
    return {
        "status": "completed",
        "toolVersion": KUNA_VERSION,
        "providerRevision": PROVIDER_REVISION,
        "sourceSha256": expected_sha256,
        "functionCount": max(0, total_count),
        "returnedUnits": len(units),
        "failedFunctionCount": len(failures),
        "truncated": total_count > len(selected) or len(units) < len(selected) or bool(failures),
        "outputBytes": output_bytes,
        "units": units,
        "calls": calls,
        "warnings": "\n".join(failures)[:12_000],
    }


if __name__ == "__main__":
    try:
        result = main()
        result_path = Path(sys.argv[2]).resolve(strict=True) / "result.json"
        result_path.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    except Exception as error:
        print(f"Kuna worker failed: {type(error).__name__}: {str(error)[:1200]}", file=sys.stderr)
        raise SystemExit(1)
