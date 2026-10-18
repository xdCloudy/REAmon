#!/usr/bin/env python3
"""Isolated adapter for univdreams' editable, assembly-pinned binary format."""
from __future__ import annotations

import hashlib
import json
import os
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
PORT = int(os.environ.get("PORT", "8032"))
UD_BIN = os.environ.get("UNIVDREAMS_BIN", "/usr/local/bin/ud")
VERSION = os.environ.get("UNIVDREAMS_VERSION", "unknown")
REVISION = os.environ.get("UNIVDREAMS_PROVIDER_REVISION", "")
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("UNIVDREAMS_TIMEOUT_SECONDS", "900"))))
MAX_BINARY_BYTES = min(1024**3, max(1024**2, int(os.environ.get("UNIVDREAMS_MAX_BINARY_BYTES", str(512 * 1024**2)))))
MAX_REQUEST_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = min(2 * 1024**2, max(1024**2, int(os.environ.get("UNIVDREAMS_MAX_OUTPUT_BYTES", str(2 * 1024**2)))))
MAX_ROUNDTRIP_BYTES = 512 * 1024**2
SAFE_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    pass


class CommandFailed(AnalysisError):
    pass


def safe_id(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 128 or value[0] not in SAFE_ID_CHARS - frozenset("_-"):
        raise AnalysisError("Invalid analysis identifier")
    if any(char not in SAFE_ID_CHARS for char in value):
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


def run_command(command: list[str], log_path: Path, started: float, cancel_check) -> None:
    with log_path.open("wb") as log:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                   cwd=log_path.parent, env={**os.environ, "HOME": str(log_path.parent),
                                                              "XDG_CACHE_HOME": str(log_path.parent)},
                                   start_new_session=True)
        try:
            while process.poll() is None:
                if cancel_check():
                    raise AnalysisError("univdreams analysis was cancelled")
                if time.monotonic() - started >= TIMEOUT_SECONDS:
                    raise AnalysisError(f"univdreams exceeded {TIMEOUT_SECONDS} seconds")
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
            if process.returncode != 0:
                detail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:].strip()
                raise CommandFailed(detail or f"univdreams exited with code {process.returncode}")
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


def analyze(body: dict[str, object], cancel_check=lambda: False) -> dict[str, object]:
    if not SLOTS.acquire(blocking=False):
        raise AnalysisError("The univdreams analyzer is busy")
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
        input_size = binary.stat().st_size
        started = time.monotonic()

        with tempfile.TemporaryDirectory(prefix="reamon-univdreams-") as temporary:
            temporary_root = Path(temporary)
            working_binary = temporary_root / "input.bin"
            source_path = temporary_root / "module.ud"
            rebuilt_path = temporary_root / "roundtrip.bin"
            shutil.copyfile(binary, working_binary)
            if hash_file(working_binary) != source_hash:
                raise AnalysisError("Temporary input copy did not match the imported artifact")

            run_command([UD_BIN, "decompile", str(working_binary), "--out", str(source_path)],
                        temporary_root / "decompile.log", started, cancel_check)
            if not source_path.is_file() or source_path.stat().st_size <= 0:
                raise AnalysisError("univdreams produced no editable .ud source")
            source_size = source_path.stat().st_size
            if source_size > MAX_OUTPUT_BYTES:
                raise AnalysisError("univdreams source exceeds the configured output limit")

            run_command([UD_BIN, "verify", str(source_path)], temporary_root / "verify.log", started, cancel_check)
            round_trip_error = None
            compile_succeeded = False
            try:
                run_command([UD_BIN, "compile", str(source_path), "--out", str(rebuilt_path)],
                            temporary_root / "compile.log", started, cancel_check)
                compile_succeeded = rebuilt_path.is_file()
                if not compile_succeeded:
                    round_trip_error = "univdreams did not produce a compiled round-trip binary"
            except CommandFailed as error:
                round_trip_error = str(error)[:1200]

            rebuilt_size = rebuilt_path.stat().st_size if compile_succeeded else 0
            if rebuilt_size > MAX_ROUNDTRIP_BYTES:
                rebuilt_path.unlink()
                rebuilt_size = 0
                round_trip_error = "Compiled round-trip output exceeds the configured binary limit"
            if compile_succeeded and rebuilt_size == 0 and round_trip_error is None:
                round_trip_error = "univdreams produced an empty round-trip binary"
            byte_identical = rebuilt_size == input_size and rebuilt_size > 0 and hash_file(rebuilt_path) == source_hash

            source_bytes = source_path.read_bytes()
            source_destination = run_root / "sources" / "module.ud"
            source_destination.parent.mkdir(parents=True)
            source_destination.write_bytes(source_bytes)
            source_digest = hashlib.sha256(source_bytes).hexdigest()
            rebuilt_id = None
            rebuilt_digest = None
            if rebuilt_path.is_file() and rebuilt_size:
                rebuilt_destination = run_root / "evidence" / "roundtrip.bin"
                rebuilt_destination.parent.mkdir(parents=True)
                shutil.copyfile(rebuilt_path, rebuilt_destination)
                rebuilt_id = f"{project_id}/{artifact_id}/{task_id}/{run_id}/evidence/roundtrip.bin"
                rebuilt_digest = hash_file(rebuilt_destination)

        if hash_file(binary) != source_hash:
            raise AnalysisError("Input artifact changed while univdreams was analyzing it")
        elapsed_ms = int((time.monotonic() - started) * 1000)
        return {
            "status": "completed",
            "toolVersion": VERSION,
            "providerRevision": REVISION,
            "sourceSha256": source_hash,
            "sourceBytes": source_size,
            "sourceOutputSha256": source_digest,
            "codeArtifactId": f"{project_id}/{artifact_id}/{task_id}/{run_id}/sources/module.ud",
            "inputBytes": input_size,
            "roundTripAvailable": rebuilt_id is not None,
            "roundTripByteIdentical": byte_identical if rebuilt_id is not None else None,
            "roundTripArtifactId": rebuilt_id,
            "roundTripSha256": rebuilt_digest,
            "roundTripBytes": rebuilt_size,
            "roundTripError": round_trip_error,
            "elapsedMs": elapsed_ms,
            "semantics": "The .ud view is an editable, directive-rich binary representation with assembly pinned to bytes. Exact recompilation is recorded separately; it does not establish recovered original-language source or behavioral equivalence.",
        }
    finally:
        SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "REAmonUnivdreams/1"

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
        if self.path != "/health":
            self.send_json(404, {"error": "Not found"})
            return
        self.send_json(200, {"status": "ok", "toolVersion": VERSION, "providerRevision": REVISION})

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
            self.send_json(500, {"error": "univdreams analysis failed"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
