#!/usr/bin/env python3
"""Isolated, resource-bounded HTTP adapter for the pinned Fission CLI."""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8027"))
VERSION = os.environ.get("FISSION_VERSION", "unknown")
REVISION = os.environ.get("FISSION_PROVIDER_REVISION", "")
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("FISSION_TIMEOUT_SECONDS", "900"))))
MAX_BINARY_BYTES = min(2 * 1024 * 1024 * 1024, max(1024 * 1024, int(os.environ.get("FISSION_MAX_BINARY_BYTES", str(1024 * 1024 * 1024)))))
MAX_REQUEST_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = min(64 * 1024 * 1024, max(1024 * 1024, int(os.environ.get("FISSION_MAX_OUTPUT_BYTES", str(32 * 1024 * 1024)))))
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
SAFE_OUTPUT = re.compile(r"^functions/[0-9a-f]+\.c$")
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    pass


class AnalyzerBusy(AnalysisError):
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
        raise AnalysisError("Input is not a regular artifact file")
    if path.stat().st_size <= 0 or path.stat().st_size > MAX_BINARY_BYTES:
        raise AnalysisError("Input binary is empty or exceeds the configured size limit")
    return path


def hash_file(path: Path) -> str:
    import hashlib
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


def analyze(body: dict[str, object], cancel_check=lambda: False) -> dict[str, object]:
    if not SLOTS.acquire(blocking=False):
        raise AnalyzerBusy("The Fission analyzer is busy")
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
        with tempfile.TemporaryDirectory(prefix="reamon-fission-") as temporary:
            temporary_root = Path(temporary)
            (temporary_root / "home").mkdir()
            (temporary_root / "cache").mkdir()
            log_path = temporary_root / "worker.log"
            command = [sys.executable, "/app/worker.py", str(binary), str(temporary_root), str(run_root), str(TIMEOUT_SECONDS), source_hash]
            with log_path.open("wb") as log:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                           cwd=temporary_root, env={**os.environ, "HOME": str(temporary_root / "home"),
                                           "XDG_CACHE_HOME": str(temporary_root / "cache"), "PYTHONDONTWRITEBYTECODE": "1"},
                                           start_new_session=True)
                deadline = time.monotonic() + TIMEOUT_SECONDS
                try:
                    while process.poll() is None:
                        if cancel_check():
                            raise AnalysisError("Fission analysis was cancelled")
                        if time.monotonic() >= deadline:
                            raise AnalysisError(f"Fission exceeded {TIMEOUT_SECONDS} seconds")
                        try:
                            process.wait(timeout=0.25)
                        except subprocess.TimeoutExpired:
                            pass
                    if process.returncode != 0:
                        detail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:].strip()
                        raise AnalysisError(detail or f"Fission worker exited with code {process.returncode}")
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
            try:
                result = json.loads((temporary_root / "result.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise AnalysisError("Fission did not return a valid result manifest") from error

        if result.get("status") != "completed" or result.get("toolVersion") != VERSION or result.get("providerRevision") != REVISION:
            raise AnalysisError("Fission returned invalid version provenance")
        if result.get("sourceSha256") != source_hash or not isinstance(result.get("units"), list):
            raise AnalysisError("Fission returned invalid input provenance or function records")
        total_bytes = 0
        for unit in result["units"]:
            if not isinstance(unit, dict):
                raise AnalysisError("Fission returned an invalid function record")
            relative = unit.get("relativePath")
            if not isinstance(relative, str) or not SAFE_OUTPUT.fullmatch(relative):
                raise AnalysisError("Fission returned an invalid derived-artifact path")
            path = (run_root / relative).resolve(strict=True)
            try:
                path.relative_to(run_root)
            except ValueError as error:
                raise AnalysisError("Fission output escaped the active run") from error
            if path.is_symlink() or not path.is_file():
                raise AnalysisError("Fission returned a non-regular source file")
            size = path.stat().st_size
            if size <= 0 or size > 2 * 1024 * 1024 or hash_file(path) != unit.get("outputSha256"):
                raise AnalysisError("Fission output hash or size did not match its manifest")
            total_bytes += size
        if total_bytes > MAX_OUTPUT_BYTES or total_bytes != result.get("outputBytes"):
            raise AnalysisError("Fission output exceeded the configured size limit")
        result["outputBytes"] = total_bytes
        return result
    finally:
        SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "REAmonFission/1"

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
            result = analyze(body, lambda: client_disconnected(self.connection))
            self.send_json(200, result)
        except AnalyzerBusy as error:
            self.send_json(429, {"error": str(error)})
        except AnalysisError as error:
            self.send_json(400, {"error": str(error)[:2000]})
        except Exception:
            self.send_json(500, {"error": "Fission analysis failed"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
