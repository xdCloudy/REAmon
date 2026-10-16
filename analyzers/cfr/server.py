#!/usr/bin/env python3
"""Isolated CFR JVM decompiler adapter."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8022"))
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("CFR_TIMEOUT_SECONDS", "900"))))
MAX_OUTPUT_BYTES = min(1024**3, max(1024**2, int(os.environ.get("CFR_MAX_OUTPUT_BYTES", str(512 * 1024**2)))))
MAX_SOURCE_FILES = min(50000, max(1, int(os.environ.get("CFR_MAX_SOURCE_FILES", "20000"))))
MAX_REQUEST_BYTES = 64 * 1024
MAX_LOG_BYTES = 128 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
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
    if not path.is_file() or path.suffix.lower() not in {".class", ".jar"}:
        raise AnalysisError("CFR accepts JVM .class and .jar artifacts only")
    return path


def output_bytes(root: Path) -> int:
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


def run_cfr(binary: Path, output: Path) -> str:
    log_path = output.parent / "cfr.log"
    command = [
        "java", f"-Xmx{os.environ.get('CFR_JAVA_HEAP', '2g')}",
        "-jar", "/opt/cfr/cfr.jar", str(binary), "--outputdir", str(output),
    ]
    started = time.monotonic()
    with log_path.open("wb") as log_file:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT,
            cwd=output.parent,
            env={**os.environ, "HOME": str(output.parent / "home"), "TMPDIR": str(output.parent / "tmp")},
            start_new_session=True,
        )
        try:
            next_size_check = started
            while process.poll() is None:
                if time.monotonic() - started > TIMEOUT_SECONDS:
                    process.kill()
                    process.wait()
                    raise AnalysisError(f"CFR exceeded {TIMEOUT_SECONDS} seconds")
                if log_path.stat().st_size > MAX_LOG_BYTES:
                    process.kill()
                    process.wait()
                    raise AnalysisError("CFR diagnostics exceeded the configured limit")
                if time.monotonic() >= next_size_check:
                    if output.exists() and output_bytes(output) > MAX_OUTPUT_BYTES:
                        process.kill()
                        process.wait()
                        raise AnalysisError("CFR output exceeded the configured storage limit")
                    next_size_check = time.monotonic() + 1
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    detail = log_path.read_text(encoding="utf-8", errors="replace")[-MAX_LOG_BYTES:].strip()
    if process.returncode != 0:
        raise AnalysisError(detail or f"CFR exited with code {process.returncode}")
    return detail


def analyze(body: dict[str, object]) -> dict[str, object]:
    if not SLOTS.acquire(blocking=False):
        raise AnalysisError("The CFR analyzer is busy")
    try:
        project_id = safe_id(body.get("projectId"))
        artifact_id = safe_id(body.get("artifactId"))
        task_id = safe_id(body.get("taskId"))
        run_id = safe_id(body.get("runId"))
        binary = resolve_input(body.get("artifactPath"))
        input_sha256 = hashlib.sha256()
        with binary.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
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

        with tempfile.TemporaryDirectory(prefix="reamon-cfr-") as temporary:
            temporary_root = Path(temporary)
            (temporary_root / "home").mkdir()
            (temporary_root / "tmp").mkdir()
            generated_root = temporary_root / "sources"
            generated_root.mkdir()
            log = run_cfr(binary, generated_root)
            files: list[tuple[Path, str, int]] = []
            total_bytes = 0
            truncated = False
            stop_scanning = False
            discovered_source_file_count = 0
            for directory, dirs, filenames in os.walk(generated_root, followlinks=False):
                dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
                for filename in sorted(filenames):
                    source = Path(directory) / filename
                    if source.is_symlink() or source.suffix.lower() != ".java":
                        continue
                    discovered_source_file_count += 1
                    relative = source.relative_to(generated_root).as_posix()
                    try:
                        size = source.stat().st_size
                    except OSError:
                        continue
                    if size > 16 * 1024 * 1024:
                        truncated = True
                        continue
                    if total_bytes + size > MAX_OUTPUT_BYTES or len(files) >= MAX_SOURCE_FILES:
                        truncated = True
                        stop_scanning = True
                        break
                    files.append((source, relative, size))
                    total_bytes += size
                if stop_scanning:
                    break

            if not files:
                raise AnalysisError("CFR did not produce any Java source files")

            units = []
            for source, relative, size in files:
                destination = run_root / "sources" / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.resolve().relative_to(run_root.resolve())
                output_digest = hashlib.sha256()
                with source.open("rb") as source_file, destination.open("wb") as output_file:
                    for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                        output_file.write(chunk)
                        output_digest.update(chunk)
                units.append({
                    "name": Path(relative).stem,
                    "relativePath": relative,
                    "codeArtifactId": f"{project_id}/{artifact_id}/{task_id}/{run_id}/sources/{relative}",
                    "language": "Java",
                    "sizeBytes": size,
                    "outputSha256": output_digest.hexdigest(),
                })

        return {
            "status": "completed",
            "toolVersion": "0.152",
            "inputName": binary.name,
            "artifactSha256": input_sha256.hexdigest(),
            "sourceFileCount": discovered_source_file_count,
            "codeBytes": total_bytes,
            "truncated": truncated,
            "units": units,
            "warnings": ("CFR output is an independent Java reconstruction, not proof of original source or behavior. " + log[:4000]).strip(),
        }
    finally:
        SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "reamon-cfr/1"

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ready","provider":"cfr","version":"0.152"}')

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
            self.send_json(500, {"error": "CFR analysis failed"})

    def send_json(self, status: int, body: dict[str, object]) -> None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        print("cfr-analyzer: " + format % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
