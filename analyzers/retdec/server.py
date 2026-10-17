#!/usr/bin/env python3
"""Isolated RetDec native decompiler adapter."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RETDEC_COMMIT = "9450585772e6f1c18e5f0b2ad5518a18d6bce71e"
ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8023"))
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("RETDEC_TIMEOUT_SECONDS", "900"))))
MAX_OUTPUT_BYTES = min(512 * 1024**2, max(8 * 1024**2, int(os.environ.get("RETDEC_MAX_OUTPUT_BYTES", str(256 * 1024**2)))))
MAX_JSON_BYTES = min(128 * 1024**2, MAX_OUTPUT_BYTES)
MAX_SOURCE_BYTES = 64 * 1024**2
MAX_TOKENS = 2_000_000
MAX_MAPPINGS = 5_000
MAX_REQUEST_BYTES = 64 * 1024
MAX_LOG_BYTES = 128 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
SAFE_ADDRESS = re.compile(r"^0x[0-9a-f]{1,16}$", re.IGNORECASE)
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    pass


def kill_process_tree(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def safe_id(value: object) -> str:
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise AnalysisError("Invalid analysis identifier")
    return value


def resolve_input(value: object) -> Path:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise AnalysisError("Invalid artifact path")
    try:
        candidate = Path(value)
        if candidate.is_symlink():
            raise AnalysisError("Artifact input must not be a symbolic link")
        path = candidate.resolve(strict=True)
        path.relative_to(ARTIFACT_ROOT)
    except AnalysisError:
        raise
    except (OSError, RuntimeError, ValueError) as error:
        raise AnalysisError("Input must resolve to a file inside the read-only artifact volume") from error
    if not path.is_file():
        raise AnalysisError("RetDec input must be a regular file")
    return path


def directory_bytes(root: Path) -> int:
    total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
        for name in files:
            path = Path(directory) / name
            if path.is_symlink():
                continue
            try:
                total += path.stat().st_size
            except OSError:
                continue
    return total


def run_retdec(binary: Path, output: Path, work_root: Path) -> str:
    log_path = work_root / "retdec.log"
    command = ["retdec-decompiler", "-s", "-f", "json", "-o", str(output), str(binary)]
    started = time.monotonic()
    with log_path.open("wb") as log_file:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT,
            cwd=work_root,
            env={**os.environ, "HOME": str(work_root / "home"), "TMPDIR": str(work_root / "tmp")},
            start_new_session=True,
        )
        try:
            next_size_check = started
            while process.poll() is None:
                if time.monotonic() - started > TIMEOUT_SECONDS:
                    kill_process_tree(process)
                    process.wait()
                    raise AnalysisError(f"RetDec exceeded {TIMEOUT_SECONDS} seconds")
                if log_path.stat().st_size > MAX_LOG_BYTES:
                    kill_process_tree(process)
                    process.wait()
                    raise AnalysisError("RetDec diagnostics exceeded the configured limit")
                if time.monotonic() >= next_size_check:
                    if directory_bytes(work_root) > MAX_OUTPUT_BYTES:
                        kill_process_tree(process)
                        process.wait()
                        raise AnalysisError("RetDec output exceeded the configured storage limit")
                    next_size_check = time.monotonic() + 1
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            if process.poll() is None:
                kill_process_tree(process)
                process.wait()
    detail = log_path.read_text(encoding="utf-8", errors="replace")[-MAX_LOG_BYTES:].strip()
    if process.returncode != 0:
        raise AnalysisError(detail or f"RetDec exited with code {process.returncode}")
    return detail


def source_from_tokens(payload: object) -> tuple[str, list[dict[str, object]], bool, int]:
    if not isinstance(payload, dict) or not isinstance(payload.get("tokens"), list):
        raise AnalysisError("RetDec returned malformed token JSON")
    tokens = payload["tokens"]
    if len(tokens) > MAX_TOKENS:
        raise AnalysisError("RetDec token count exceeds the configured limit")
    source_parts: list[str] = []
    mapping_by_line: dict[int, set[str]] = {}
    current_address = ""
    source_bytes = 0
    source_line = 1
    mapping_count = 0
    truncated = False
    for item in tokens:
        if not isinstance(item, dict):
            raise AnalysisError("RetDec returned an invalid token record")
        address = item.get("addr")
        if address is not None:
            if not isinstance(address, str) or (address and not SAFE_ADDRESS.fullmatch(address)):
                raise AnalysisError("RetDec returned an invalid instruction address")
            current_address = address.lower()
            continue
        value = item.get("val")
        if not isinstance(value, str) or not isinstance(item.get("kind"), str):
            raise AnalysisError("RetDec returned an invalid source token")
        encoded_size = len(value.encode("utf-8"))
        source_bytes += encoded_size
        if source_bytes > MAX_SOURCE_BYTES:
            raise AnalysisError("RetDec source exceeded the configured limit")
        source_parts.append(value)
        if not current_address or not value:
            source_line += value.count("\n")
            continue
        for fragment in value.splitlines(keepends=True):
            if mapping_count >= MAX_MAPPINGS:
                truncated = True
            else:
                addresses = mapping_by_line.setdefault(source_line, set())
                if current_address not in addresses:
                    addresses.add(current_address)
                    mapping_count += 1
            source_line += fragment.count("\n")
    source = "".join(source_parts)
    if not source.strip():
        raise AnalysisError("RetDec did not produce viewable C-like source")
    mappings = [
        {"sourceLineNumber": line, "address": address}
        for line, addresses in sorted(mapping_by_line.items())
        for address in sorted(addresses)
    ]
    return source, mappings, truncated, len(tokens)


def copy_evidence(source: Path, destination: Path, run_root: Path, limit: int) -> tuple[int, str]:
    resolved = source.resolve(strict=True)
    resolved.relative_to(source.parent.resolve())
    size = resolved.stat().st_size
    if not resolved.is_file() or size <= 0 or size > limit:
        raise AnalysisError("RetDec evidence file is empty or exceeds its configured limit")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.resolve().relative_to(run_root.resolve())
    digest = hashlib.sha256()
    with resolved.open("rb") as source_file, destination.open("wb") as output_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            output_file.write(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def analyze(body: dict[str, object]) -> dict[str, object]:
    if not SLOTS.acquire(blocking=False):
        raise AnalysisError("The RetDec analyzer is busy")
    try:
        project_id = safe_id(body.get("projectId"))
        artifact_id = safe_id(body.get("artifactId"))
        task_id = safe_id(body.get("taskId"))
        run_id = safe_id(body.get("runId"))
        binary = resolve_input(body.get("artifactPath"))
        input_sha256 = hashlib.sha256()
        with binary.open("rb") as source_file:
            for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                input_sha256.update(chunk)
        run_root = DERIVED_ROOT / project_id / artifact_id / task_id / run_id
        try:
            run_root.resolve().relative_to(DERIVED_ROOT)
        except (OSError, RuntimeError, ValueError) as error:
            raise AnalysisError("Derived output path is invalid") from error
        if run_root.is_symlink():
            raise AnalysisError("Derived output path must not be a symbolic link")
        if run_root.exists():
            shutil.rmtree(run_root)
        run_root.mkdir(parents=True)

        with tempfile.TemporaryDirectory(prefix="reamon-retdec-") as temporary:
            temporary_root = Path(temporary)
            (temporary_root / "home").mkdir()
            (temporary_root / "tmp").mkdir()
            output_json = temporary_root / "program.json"
            log = run_retdec(binary, output_json, temporary_root)
            if not output_json.is_file() or output_json.stat().st_size > MAX_JSON_BYTES:
                raise AnalysisError("RetDec JSON output is missing or exceeds the configured limit")
            raw_json = output_json.read_bytes()
            try:
                payload = json.loads(raw_json)
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                raise AnalysisError("RetDec returned invalid JSON") from error
            source, mappings, mappings_truncated, token_count = source_from_tokens(payload)
            source_path = run_root / "sources" / "program.c"
            source_path.parent.mkdir(parents=True, exist_ok=True)
            source_path.resolve().relative_to(run_root.resolve())
            source_bytes = source.encode("utf-8")
            source_path.write_bytes(source_bytes)
            source_digest = hashlib.sha256(source_bytes).hexdigest()

            raw_path = run_root / "evidence" / "retdec-tokens.json"
            raw_size, raw_digest = copy_evidence(output_json, raw_path, run_root, MAX_JSON_BYTES)
            disassembly_file = temporary_root / "program.json.dsm"
            disassembly_id = None
            disassembly_digest = None
            disassembly_size = 0
            if disassembly_file.is_file():
                disassembly_path = run_root / "evidence" / "program.dsm"
                disassembly_size, disassembly_digest = copy_evidence(disassembly_file, disassembly_path, run_root, MAX_OUTPUT_BYTES)
                disassembly_id = f"{project_id}/{artifact_id}/{task_id}/{run_id}/evidence/program.dsm"

        return {
            "status": "completed",
            "toolVersion": f"retdec@{RETDEC_COMMIT}",
            "inputName": binary.name[:1000],
            "artifactSha256": input_sha256.hexdigest(),
            "sourceBytes": len(source_bytes),
            "sourceSha256": source_digest,
            "tokenCount": token_count,
            "sourceAddressMap": mappings,
            "sourceAddressMapTruncated": mappings_truncated,
            "codeArtifactId": f"{project_id}/{artifact_id}/{task_id}/{run_id}/sources/program.c",
            "disassemblyArtifactId": disassembly_id,
            "disassemblySha256": disassembly_digest,
            "disassemblyBytes": disassembly_size,
            "rawTokenArtifactId": f"{project_id}/{artifact_id}/{task_id}/{run_id}/evidence/retdec-tokens.json",
            "rawTokenSha256": raw_digest,
            "rawTokenBytes": raw_size,
            "warnings": ("RetDec output is generated C-like pseudocode, not recovered original source or proof of behavior. " + log[:2000]).strip(),
        }
    finally:
        SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "reamon-retdec/1"

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return
        self.send_json(200, {"status": "ready", "provider": "retdec", "version": RETDEC_COMMIT})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise AnalysisError("Request body is empty or exceeds the size limit")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise AnalysisError("Request body must be a JSON object")
            response = analyze(body)
            self.send_json(200, response)
        except (AnalysisError, ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)[:2000]})
        except Exception:
            self.send_json(500, {"error": "RetDec analysis failed"})

    def send_json(self, status: int, body: dict[str, object]) -> None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        print("retdec-analyzer: " + format % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
