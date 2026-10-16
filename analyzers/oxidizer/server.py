#!/usr/bin/env python3
"""Isolated, resource-bounded Oxidizer analyzer adapter."""
from __future__ import annotations

import hashlib
import json
import os
import re
import select
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
PORT = int(os.environ.get("PORT", "8020"))
PROVIDER_REVISION = os.environ.get("OXIDIZER_PROVIDER_REVISION", "angr-10.0.4")
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("OXIDIZER_TIMEOUT_SECONDS", "900"))))
MAX_FUNCTIONS = min(500, max(1, int(os.environ.get("OXIDIZER_MAX_FUNCTIONS", "300"))))
MAX_OUTPUT_BYTES = min(128 * 1024 * 1024, max(1024 * 1024, int(os.environ.get("OXIDIZER_MAX_OUTPUT_BYTES", str(128 * 1024 * 1024)))))
MAX_REQUEST_BYTES = 64 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
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
    return path


def client_disconnected(connection: socket.socket) -> bool:
    readable, _, _ = select.select([connection], [], [], 0)
    if not readable:
        return False
    try:
        return connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
    except BlockingIOError:
        return False
    except OSError:
        return True


def run_worker(binary: Path, output: Path, log_path: Path, limit: int, cancel_check=lambda: False) -> None:
    environment = {
        **os.environ,
        "HOME": str(output / "home"),
        "TMPDIR": str(output / "tmp"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
    }
    (output / "home").mkdir()
    (output / "tmp").mkdir()
    command = ["python3", "/app/worker.py", str(binary), str(output), str(limit)]
    with log_path.open("wb") as log_file:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT,
            cwd=output, env=environment, start_new_session=True,
        )
        deadline = time.monotonic() + TIMEOUT_SECONDS
        try:
            while process.poll() is None:
                if cancel_check():
                    raise AnalysisError("Oxidizer analysis was cancelled")
                if time.monotonic() >= deadline:
                    raise AnalysisError(f"Oxidizer exceeded {TIMEOUT_SECONDS} seconds")
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
            if process.returncode != 0:
                detail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:].strip()
                raise AnalysisError(detail or f"Oxidizer exited with code {process.returncode}")
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


def analyse(body: dict[str, object], cancel_check=lambda: False) -> dict[str, object]:
    if not SLOTS.acquire(blocking=False):
        raise AnalyzerBusy("The Oxidizer analyzer is busy")
    try:
        return _analyse_locked(body, cancel_check)
    finally:
        SLOTS.release()


def _analyse_locked(body: dict[str, object], cancel_check=lambda: False) -> dict[str, object]:
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
        shutil.rmtree(run_root)
    run_root.mkdir(parents=True)

    digest = hashlib.sha256()
    with binary.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    input_sha256 = digest.hexdigest()

    with tempfile.TemporaryDirectory(prefix="reamon-oxidizer-") as temporary:
        temporary_root = Path(temporary)
        log_path = temporary_root / "worker.log"
        try:
            run_worker(binary, temporary_root, log_path, MAX_FUNCTIONS, cancel_check)
        except OSError as error:
            raise AnalysisError("Could not start the Oxidizer worker") from error
        try:
            result = json.loads((temporary_root / "result.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise AnalysisError("Oxidizer did not return a valid result manifest") from error
        units = result.get("units")
        if not isinstance(units, list) or not units:
            raise AnalysisError("Oxidizer returned no functions")
        total_bytes = 0
        for unit in units:
            relative = unit.get("relativePath") if isinstance(unit, dict) else None
            if not isinstance(relative, str) or not relative or len(relative) > 300:
                raise AnalysisError("Oxidizer returned an invalid function path")
            source_path = (temporary_root / relative).resolve(strict=True)
            try:
                source_path.relative_to(temporary_root.resolve())
            except ValueError as error:
                raise AnalysisError("Oxidizer output escaped its temporary directory") from error
            if source_path.is_symlink() or not source_path.is_file():
                raise AnalysisError("Oxidizer returned a non-regular source file")
            size = source_path.stat().st_size
            total_bytes += size
            if total_bytes > MAX_OUTPUT_BYTES:
                raise AnalysisError("Oxidizer output exceeded the configured size limit")
            destination = run_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_path, destination)
            unit["sizeBytes"] = size
            unit["codeArtifactId"] = destination.relative_to(DERIVED_ROOT).as_posix()
        result["toolVersion"] = str(result.get("toolVersion") or "unknown")[:128]
        rustc_version = result.get("rustcVersion")
        if not isinstance(rustc_version, str) or not rustc_version or len(rustc_version) > 64:
            raise AnalysisError("Oxidizer returned invalid Rust compiler metadata")
        result["rustcVersion"] = rustc_version
        result["sourceSha256"] = input_sha256
        result["providerRevision"] = PROVIDER_REVISION
        result["outputBytes"] = total_bytes
        result["warnings"] = str(result.get("warnings") or "")[-12000:]
        return result


class Handler(BaseHTTPRequestHandler):
    server_version = "REAmonOxidizer/1"

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
            self.send_json(200, {"status": "ok", "provider": "Oxidizer", "revision": PROVIDER_REVISION})
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid content length"})
            return
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "Request body is outside the configured limit"})
            return
        try:
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise AnalysisError("Request must be a JSON object")
            result = analyse(body, lambda: client_disconnected(self.connection))
            self.send_json(200, result)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
        except AnalyzerBusy as error:
            self.send_json(429, {"error": str(error)})
        except AnalysisError as error:
            self.send_json(422, {"error": str(error)[:2000]})
        except Exception:
            self.send_json(500, {"error": "Oxidizer analysis failed unexpectedly"})

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
