#!/usr/bin/env python3
"""Isolated BYO IDA Pro batch analyzer for REAmon."""
from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
IDA_ROOT = Path("/opt/ida").resolve()
PORT = int(os.environ.get("PORT", "8014"))
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("IDA_TIMEOUT_SECONDS", "1800"))))
MAX_FUNCTIONS = min(1200, max(1, int(os.environ.get("IDA_MAX_FUNCTIONS", "1200"))))
MAX_RESULT_BYTES = min(134217728, max(1048576, int(os.environ.get("IDA_MAX_RESULT_BYTES", "134217728"))))
MAX_OUTPUT_BYTES = min(100663296, max(1048576, int(os.environ.get("IDA_MAX_OUTPUT_BYTES", "100663296"))))
MAX_CALL_EDGES = min(400, max(0, int(os.environ.get("IDA_MAX_CALL_EDGES", "400"))))
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    pass


def safe_id(value):
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise AnalysisError("Invalid analysis identifier")
    return value


def resolve_input(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise AnalysisError("Invalid artifact path")
    try:
        candidate = Path(value).resolve(strict=True)
        candidate.relative_to(ARTIFACT_ROOT)
    except (OSError, RuntimeError, ValueError) as error:
        raise AnalysisError("Input is outside the stored artifact volume") from error
    if not candidate.is_file():
        raise AnalysisError("Input is not a regular file")
    return candidate


def resolve_executable(value):
    if not isinstance(value, str) or len(value) > 4096:
        raise AnalysisError("Invalid IDA executable path")
    try:
        candidate = Path(value).resolve(strict=True)
        candidate.relative_to(IDA_ROOT)
    except (OSError, RuntimeError, ValueError) as error:
        raise AnalysisError("IDA executable must resolve inside /opt/ida") from error
    if candidate.name not in ("idat", "idat64") or not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise AnalysisError("Configured IDA batch executable was not found or is not executable")
    return candidate


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_derived_path(relative):
    candidate = (DERIVED_ROOT / relative).resolve()
    try:
        candidate.relative_to(DERIVED_ROOT)
    except ValueError as error:
        raise AnalysisError("IDA output escaped the derived artifact store") from error
    return candidate


def run_ida(executable, artifact, scratch):
    result_path = scratch / "result.json"
    database_path = scratch / "analysis.i64"
    environment = {
        **os.environ,
        "HOME": str(scratch / "home"),
        "TMPDIR": str(scratch / "tmp"),
        "REAMON_IDA_RESULT_PATH": str(result_path),
        "REAMON_IDA_MAX_FUNCTIONS": str(MAX_FUNCTIONS),
    }
    Path(environment["HOME"]).mkdir()
    Path(environment["TMPDIR"]).mkdir()
    log_path = scratch / "ida.log"
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            [str(executable), "-A", "-S/app/ida-export.py", f"-o{database_path}", str(artifact)],
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True, env=environment,
        )
        deadline = time.monotonic() + TIMEOUT_SECONDS
        while process.poll() is None:
            if time.monotonic() >= deadline:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                raise AnalysisError("IDA analysis exceeded the configured timeout")
            time.sleep(0.2)
        if process.returncode != 0:
            detail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
            raise AnalysisError(f"IDA exited with code {process.returncode}: {detail}".strip())
    if not result_path.is_file() or result_path.stat().st_size <= 0 or result_path.stat().st_size > MAX_RESULT_BYTES:
        raise AnalysisError("IDA returned an empty or oversized result bundle")
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise AnalysisError("IDA exporter returned invalid JSON") from error
    if not isinstance(result, dict) or result.get("status") != "completed" or not isinstance(result.get("units"), list):
        raise AnalysisError("IDA exporter returned an invalid result bundle")
    return result


def analyse(body):
    project_id = safe_id(body.get("projectId"))
    artifact_id = safe_id(body.get("artifactId"))
    task_id = safe_id(body.get("taskId"))
    run_id = safe_id(body.get("runId"))
    artifact = resolve_input(body.get("artifactPath"))
    executable = resolve_executable(body.get("executablePath"))
    source_hash = file_sha256(artifact)
    with tempfile.TemporaryDirectory(prefix="reamon-ida-") as temporary:
        result = run_ida(executable, artifact, Path(temporary))
        if result.get("sourceSha256", "").lower() != source_hash:
            raise AnalysisError("IDA exporter input hash does not match the artifact")
        units = []
        total_output = 0
        run_prefix = f"{project_id}/{artifact_id}/{task_id}/{run_id}/ida/"
        for unit in result["units"][:MAX_FUNCTIONS]:
            if not isinstance(unit, dict):
                continue
            name = unit.get("name")
            address = unit.get("address")
            pseudocode = unit.get("pseudocode")
            disassembly = unit.get("disassembly")
            size_bytes = unit.get("sizeBytes")
            if not isinstance(name, str) or not name or len(name) > 500:
                continue
            if not isinstance(address, str) or not re.fullmatch(r"0x[0-9a-fA-F]{1,16}", address):
                continue
            if not isinstance(pseudocode, str) or not pseudocode or len(pseudocode.encode("utf-8")) > 2 * 1024 * 1024:
                continue
            if not isinstance(disassembly, str) or len(disassembly.encode("utf-8")) > 2 * 1024 * 1024:
                continue
            if not isinstance(size_bytes, int) or size_bytes < 1 or size_bytes > 64 * 1024 * 1024:
                continue
            digits = address[2:].lower().zfill(16)
            relative_path = f"functions/{digits}.c"
            disassembly_relative = f"assembly/{digits}.asm"
            code_path = safe_derived_path(run_prefix + relative_path)
            disassembly_path = safe_derived_path(run_prefix + disassembly_relative)
            code_path.parent.mkdir(parents=True, exist_ok=True)
            disassembly_path.parent.mkdir(parents=True, exist_ok=True)
            code_bytes = pseudocode.encode("utf-8")
            disassembly_bytes = disassembly.encode("utf-8")
            total_output += len(code_bytes) + len(disassembly_bytes)
            if total_output > MAX_OUTPUT_BYTES:
                result["truncated"] = True
                break
            code_path.write_bytes(code_bytes)
            disassembly_path.write_bytes(disassembly_bytes)
            units.append({
                "name": name,
                "address": address,
                "relativePath": relative_path,
                "codeArtifactId": run_prefix + relative_path,
                "codeSha256": hashlib.sha256(code_bytes).hexdigest(),
                "sizeBytes": size_bytes,
                "disassemblyArtifactId": run_prefix + disassembly_relative,
                "disassemblySha256": hashlib.sha256(disassembly_bytes).hexdigest(),
            })
        if not units:
            raise AnalysisError("IDA produced no Hex-Rays pseudocode. Confirm the Pro/Hex-Rays license is available to the analyzer runtime.")
        calls = []
        for edge in result.get("calls", [])[:MAX_CALL_EDGES]:
            if not isinstance(edge, dict):
                continue
            if not re.fullmatch(r"0x[0-9a-fA-F]{1,16}", str(edge.get("fromAddress", ""))):
                continue
            if not re.fullmatch(r"0x[0-9a-fA-F]{1,16}", str(edge.get("toAddress", ""))):
                continue
            calls.append({
                "fromAddress": edge["fromAddress"], "toAddress": edge["toAddress"],
                "fromName": str(edge.get("fromName", ""))[:500],
                "toName": str(edge.get("toName", ""))[:500],
            })
        return {
            "status": "completed",
            "idaVersion": str(result.get("idaVersion", "unknown"))[:128],
            "architecture": str(result.get("architecture", ""))[:128],
            "sourceSha256": source_hash,
            "functionCount": max(0, int(result.get("functionCount", 0))),
            "failedFunctionCount": max(0, int(result.get("failedFunctionCount", 0))),
            "truncated": bool(result.get("truncated")) or len(result["units"]) > len(units),
            "units": units,
            "calls": calls,
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "REAmon-IDA/1.0"

    def send_json(self, status, payload):
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path == "/health":
            return self.send_json(200, {"status": "ok", "provider": "ida"})
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/analyze":
            return self.send_json(404, {"error": "Not found"})
        if not SLOTS.acquire(blocking=False):
            return self.send_json(429, {"error": "IDA analyzer is busy"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 65536:
                return self.send_json(413, {"error": "Invalid IDA request size"})
            try:
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("request must be an object")
                result = analyse(body)
            except AnalysisError as error:
                return self.send_json(400, {"error": str(error)[:4000]})
            except Exception:
                return self.send_json(500, {"error": "IDA analysis failed unexpectedly"})
            return self.send_json(200, result)
        finally:
            SLOTS.release()

    def log_message(self, format, *args):
        print("[ida-analyzer] " + format % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
