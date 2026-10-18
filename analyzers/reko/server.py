#!/usr/bin/env python3
"""Bounded, isolated adapter for Reko's C-like reconstruction output."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8031"))
VERSION = os.environ.get("REKO_VERSION", "unknown")
REVISION = os.environ.get("REKO_PROVIDER_REVISION", "")
REKO_BIN = os.environ.get("REKO_BIN", "/opt/reko/decompile.dll")
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("REKO_TIMEOUT_SECONDS", "900"))))
MAX_BINARY_BYTES = min(2 * 1024**3, max(1024**2, int(os.environ.get("REKO_MAX_BINARY_BYTES", str(1024**3)))))
MAX_REQUEST_BYTES = 64 * 1024
MAX_FUNCTIONS = min(2000, max(1, int(os.environ.get("REKO_MAX_FUNCTIONS", "256"))))
MAX_FUNCTION_BYTES = min(2 * 1024**2, max(1024, int(os.environ.get("REKO_MAX_FUNCTION_BYTES", str(1024**2)))))
MAX_OUTPUT_BYTES = min(64 * 1024**2, max(1024**2, int(os.environ.get("REKO_MAX_OUTPUT_BYTES", str(32 * 1024**2)))))
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
FUNCTION_HEADER = re.compile(r"(?m)^//\s*([0-9a-fA-F]{1,32}):\s*(.*?)\s*$")
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
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
    if not path.is_file() or path.stat().st_size <= 0 or path.stat().st_size > MAX_BINARY_BYTES:
        raise AnalysisError("Input binary is empty or exceeds the configured size limit")
    return path


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def body_for_function(text: str, start: int, limit: int) -> tuple[str, int] | None:
    """Return one procedure through its balanced closing brace, ignoring literals/comments."""
    brace = text.find("{", start, limit)
    if brace < 0:
        return None
    depth = 0
    state = "code"
    escaped = False
    index = brace
    while index < limit:
        char = text[index]
        next_char = text[index + 1] if index + 1 < limit else ""
        if state == "line_comment":
            if char == "\n":
                state = "code"
        elif state == "block_comment":
            if char == "*" and next_char == "/":
                state = "code"
                index += 1
        elif state in ("string", "char"):
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif (state == "string" and char == '"') or (state == "char" and char == "'"):
                state = "code"
        elif char == "/" and next_char == "/":
            state = "line_comment"
            index += 1
        elif char == "/" and next_char == "*":
            state = "block_comment"
            index += 1
        elif char == '"':
            state = "string"
        elif char == "'":
            state = "char"
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:index + 1].strip() + "\n", index + 1
        index += 1
    return None


def parse_functions(source_root: Path, output_root: Path, artifact_prefix: str, source_hash: str) -> tuple[list[dict[str, object]], int, int, bool, int]:
    units: list[dict[str, object]] = []
    seen: set[str] = set()
    total_bytes = 0
    rejected = 0
    truncated = False
    discovered = 0
    (output_root / "functions").mkdir(parents=True, exist_ok=True)
    for source in sorted(source_root.glob("*.c")):
        raw = source.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            rejected += 1
            continue
        markers = list(FUNCTION_HEADER.finditer(text))
        discovered += len(markers)
        for index, marker in enumerate(markers):
            if len(units) >= MAX_FUNCTIONS:
                truncated = True
                break
            address_number = int(marker.group(1), 16)
            address = f"0x{address_number:x}"
            next_start = markers[index + 1].start() if index + 1 < len(markers) else len(text)
            parsed = body_for_function(text, marker.start(), next_start)
            if address in seen or parsed is None:
                rejected += 1
                continue
            code, _end = parsed
            encoded = code.encode("utf-8")
            if not encoded or len(encoded) > MAX_FUNCTION_BYTES or total_bytes + len(encoded) > MAX_OUTPUT_BYTES:
                rejected += 1
                truncated = True
                continue
            relative = f"functions/{address_number:x}.c"
            target = output_root / relative
            target.write_bytes(encoded)
            output_hash = hashlib.sha256(encoded).hexdigest()
            description = marker.group(2).strip()[:500]
            symbol_match = re.search(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(", description)
            name = symbol_match.group(1) if symbol_match else f"sub_{address_number:x}"
            units.append({
                "name": name,
                "address": address,
                "relativePath": relative,
                "codeArtifactId": f"{artifact_prefix}/{relative}",
                "sizeBytes": len(encoded),
                "outputSha256": output_hash,
                "sourceFile": source.name[:200],
                "inputArtifactSha256": source_hash,
            })
            seen.add(address)
            total_bytes += len(encoded)
        if truncated and len(units) >= MAX_FUNCTIONS:
            break
    return units, total_bytes, rejected, truncated, discovered


def client_disconnected(connection: socket.socket) -> bool:
    try:
        connection.setblocking(False)
        return connection.recv(1, socket.MSG_PEEK) == b""
    except BlockingIOError:
        return False
    except OSError:
        return True
    finally:
        try:
            connection.setblocking(True)
        except OSError:
            pass


def analyze(body: dict[str, object], cancel_check=lambda: False) -> dict[str, object]:
    if not SLOTS.acquire(blocking=False):
        raise AnalysisError("The Reko analyzer is busy")
    try:
        project_id = safe_id(body.get("projectId"))
        artifact_id = safe_id(body.get("artifactId"))
        task_id = safe_id(body.get("taskId"))
        run_id = safe_id(body.get("runId"))
        binary = resolve_input(body.get("artifactPath"))
        run_root = (DERIVED_ROOT / project_id / artifact_id / task_id / run_id).resolve()
        try:
            run_root.relative_to(DERIVED_ROOT)
        except ValueError as error:
            raise AnalysisError("Derived output path is invalid") from error
        if run_root.exists():
            if run_root.is_symlink():
                raise AnalysisError("Derived output path must not be a symbolic link")
            shutil.rmtree(run_root)
        run_root.mkdir(parents=True)
        source_hash = hash_file(binary)
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="reamon-reko-") as temporary:
            temporary_root = Path(temporary)
            working_binary = temporary_root / "input.bin"
            shutil.copyfile(binary, working_binary)
            if hash_file(working_binary) != source_hash:
                raise AnalysisError("Temporary Reko input copy did not match the imported artifact")
            log_path = temporary_root / "reko.log"
            command = ["dotnet", REKO_BIN, "decompile", "--quiet", "--time-limit", str(TIMEOUT_SECONDS), str(working_binary)]
            with log_path.open("wb") as log:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                           cwd=temporary_root, env={**os.environ, "HOME": temporary, "XDG_CACHE_HOME": temporary},
                                           start_new_session=True)
                deadline = time.monotonic() + TIMEOUT_SECONDS
                try:
                    while process.poll() is None:
                        if cancel_check():
                            raise AnalysisError("Reko analysis was cancelled")
                        if time.monotonic() >= deadline:
                            raise AnalysisError(f"Reko exceeded {TIMEOUT_SECONDS} seconds")
                        try:
                            process.wait(timeout=0.25)
                        except subprocess.TimeoutExpired:
                            pass
                    if process.returncode != 0:
                        detail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:].strip()
                        raise AnalysisError(detail or f"Reko exited with code {process.returncode}")
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
            source_root = temporary_root / "input.reko"
            if not source_root.is_dir():
                detail = log_path.read_text(encoding="utf-8", errors="replace")[-1200:].strip()
                raise AnalysisError(detail or "Reko did not produce its expected output directory")
            artifact_prefix = run_root.relative_to(DERIVED_ROOT).as_posix()
            units, total_bytes, rejected, truncated, discovered = parse_functions(source_root, run_root, artifact_prefix, source_hash)
        if not units:
            raise AnalysisError("Reko produced no bounded, address-keyed function output")
        if hash_file(binary) != source_hash:
            raise AnalysisError("Input artifact changed while Reko was analyzing it")
        return {"status": "completed", "toolVersion": VERSION, "providerRevision": REVISION,
                "sourceSha256": source_hash, "functionCount": discovered, "returnedUnits": len(units),
                "failedFunctionCount": rejected, "truncated": truncated, "outputBytes": total_bytes,
                "elapsedMs": int((time.monotonic() - started) * 1000), "units": units}
    finally:
        SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "REAmonReko/1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except OSError:
            return

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"status": "ok", "toolVersion": VERSION, "providerRevision": REVISION})
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid request length"})
            return
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "Request body is empty or too large"})
            return
        try:
            body = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "Request body must be valid JSON"})
            return
        if not isinstance(body, dict):
            self.send_json(400, {"error": "Request body must be a JSON object"})
            return
        try:
            self.send_json(200, analyze(body, lambda: client_disconnected(self.connection)))
        except AnalysisError as error:
            self.send_json(429 if "busy" in str(error).lower() else 400, {"error": str(error)[:2000]})
        except Exception:
            self.send_json(500, {"error": "Reko analysis failed"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
