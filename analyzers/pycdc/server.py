#!/usr/bin/env python3
"""Isolated pycdc adapter for Python bytecode."""
from __future__ import annotations
import json
import os
import re
import shutil
import signal
import socket
import select
import subprocess
import tempfile
import threading
import hashlib
import time
from pathlib import PurePosixPath
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8014"))
TIMEOUT_SECONDS = min(600, max(10, int(os.environ.get("PYCDC_TIMEOUT_SECONDS", "180"))))
MAX_INPUT_BYTES = min(512 * 1024 * 1024, max(1024, int(os.environ.get("PYCDC_MAX_INPUT_BYTES", str(128 * 1024 * 1024)))))
MAX_OUTPUT_BYTES = min(128 * 1024 * 1024, max(1024, int(os.environ.get("PYCDC_MAX_OUTPUT_BYTES", str(32 * 1024 * 1024)))))
MAX_DISASSEMBLY_BYTES = 2 * 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
SLOTS = threading.BoundedSemaphore(2)

class AnalysisError(Exception):
    pass

def safe_id(value: object) -> str:
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise AnalysisError("Invalid analysis identifier")
    return value

def resolve_input(value: object, extension: object) -> Path:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise AnalysisError("Invalid Python bytecode path")
    try:
        candidate = Path(value).resolve(strict=True)
        candidate.relative_to(ARTIFACT_ROOT)
    except (OSError, RuntimeError, ValueError) as error:
        raise AnalysisError("Input is outside the read-only artifact volume") from error
    if not isinstance(extension, str) or extension.lower().lstrip(".") not in {"pyc", "pyo"}:
        raise AnalysisError("Input profile must identify Python bytecode")
    if not candidate.is_file():
        raise AnalysisError("Input must be a regular Python bytecode artifact")
    size = candidate.stat().st_size
    if size < 16 or size > MAX_INPUT_BYTES:
        raise AnalysisError("Python bytecode size is outside the configured limit")
    with candidate.open("rb") as stream:
        header = stream.read(4)
    if len(header) != 4 or header[2:] != b"\r\n":
        raise AnalysisError("Input does not have a recognized Python bytecode header")
    return candidate

def terminate(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()

def disassemble(source_path: Path, output_path: Path, log_path: Path, report_progress, cancel_check) -> str:
    started = time.monotonic()
    next_progress = started + 5
    with output_path.open("wb") as output, log_path.open("wb") as log:
        try:
            process = subprocess.Popen(
                ["/usr/local/bin/pycdc", "dis", str(source_path)],
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=log,
                cwd=output_path.parent,
                env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp"},
                start_new_session=True,
            )
        except OSError as error:
            return f"pycdc disassembler could not start: {type(error).__name__}"
        try:
            while process.poll() is None:
                if cancel_check():
                    terminate(process)
                    raise AnalysisError("Python bytecode analysis was cancelled")
                if output_path.stat().st_size > MAX_DISASSEMBLY_BYTES:
                    terminate(process)
                    return "pycdc disassembly exceeded the 2 MiB evidence limit"
                if time.monotonic() - started > TIMEOUT_SECONDS:
                    terminate(process)
                    return f"pycdc disassembly exceeded the {TIMEOUT_SECONDS} second time limit"
                now = time.monotonic()
                if now >= next_progress:
                    report_progress("Saving bounded Python bytecode disassembly")
                    next_progress = now + 5
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
        except BaseException:
            terminate(process)
            raise
    if process.returncode != 0:
        detail = log_path.read_bytes()[-2048:].decode("utf-8", errors="replace").strip()
        return detail or f"pycdc disassembly exited with status {process.returncode}"
    size = output_path.stat().st_size
    if size <= 0:
        return "pycdc produced no disassembly output"
    if size > MAX_DISASSEMBLY_BYTES:
        return "pycdc disassembly exceeded the 2 MiB evidence limit"
    return ""


def analyze(body: object, report_progress=lambda _message: None, cancel_check=lambda: False) -> dict[str, object]:
    if not isinstance(body, dict):
        raise AnalysisError("Request must be an object")
    project_id = safe_id(body.get("projectId"))
    artifact_id = safe_id(body.get("artifactId"))
    task_id = safe_id(body.get("taskId"))
    run_id = safe_id(body.get("runId"))
    source_path = resolve_input(body.get("artifactPath"), body.get("extension"))
    source_relative_path = body.get("artifactRelativePath")
    if not isinstance(source_relative_path, str) or not source_relative_path or len(source_relative_path) > 1000:
        raise AnalysisError("Python bytecode logical path is invalid")
    source_relative_path = source_relative_path.replace("\\", "/")
    if len(source_relative_path) > 1000:
        raise AnalysisError("Python bytecode path exceeds the supported length")
    if not SLOTS.acquire(blocking=False):
        raise AnalysisError("All Python bytecode analysis slots are busy")
    try:
        source_key = hashlib.sha256(source_relative_path.encode("utf-8")).hexdigest()[:12]
        logical_name = PurePosixPath(source_relative_path).name
        source_stem = Path(logical_name).stem
        safe_stem = re.sub(r"[^A-Za-z0-9_.-]", "_", source_stem).strip(".-")[:160] or "module"
        output_name = f"{source_key}-{safe_stem}.py"
        disassembly_name = f"{source_key}-{safe_stem}.dis"
        run_root = DERIVED_ROOT / project_id / artifact_id / task_id / run_id
        output_directory = run_root / "pycdc"
        output_directory.mkdir(parents=True, exist_ok=True)
        try:
            output_directory.resolve(strict=True).relative_to(DERIVED_ROOT)
        except (OSError, RuntimeError, ValueError) as error:
            raise AnalysisError("Output directory is outside the derived-data volume") from error
        staging_directory = Path(tempfile.mkdtemp(prefix=".pycdc-", dir=output_directory))
        output_path = staging_directory / output_name
        disassembly_path = staging_directory / disassembly_name
        log_path = staging_directory / "pycdc.log"
        try:
            with log_path.open("wb") as log:
                report_progress("Starting isolated pycdc decompilation")
                started = time.monotonic()
                deadline = started + TIMEOUT_SECONDS
                next_progress = started + 5
                process = subprocess.Popen(
                    ["/usr/local/bin/pycdc", str(source_path), "-o", str(output_path)],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=log,
                    cwd=staging_directory,
                    env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp"},
                    start_new_session=True,
                )
                try:
                    while process.poll() is None:
                        if cancel_check():
                            terminate(process)
                            raise AnalysisError("Python bytecode analysis was cancelled")
                        now = time.monotonic()
                        try:
                            generated_size = output_path.stat().st_size
                        except OSError:
                            generated_size = 0
                        if generated_size > MAX_OUTPUT_BYTES:
                            terminate(process)
                            raise AnalysisError("Decompiled Python source exceeded the configured output limit")
                        if now >= deadline:
                            terminate(process)
                            raise AnalysisError(f"pycdc exceeded the {TIMEOUT_SECONDS} second time limit")
                        if now >= next_progress:
                            report_progress(
                                "pycdc decompilation still running "
                                f"({now - started:.0f}s elapsed; {generated_size / (1024 * 1024):.1f} MiB generated)"
                            )
                            next_progress = now + 5
                        try:
                            process.wait(timeout=0.25)
                        except subprocess.TimeoutExpired:
                            pass
                except BaseException:
                    terminate(process)
                    raise
                returncode = process.returncode
            if not output_path.is_file():
                detail = log_path.read_bytes()[-4096:].decode("utf-8", errors="replace").strip()
                raise AnalysisError(detail or f"pycdc could not decompile this file (exit {returncode})")
            output_size = output_path.stat().st_size
            if output_size <= 0 or output_size > MAX_OUTPUT_BYTES:
                raise AnalysisError("Decompiled Python source exceeded the configured output limit")
            with output_path.open("rb") as source:
                prefix = source.read(256)
            if b"\x00" in prefix:
                raise AnalysisError("pycdc produced an invalid source file")
            destination = output_directory / output_name
            warnings = log_path.read_bytes()[-4096:].decode("utf-8", errors="replace").strip()
            if returncode != 0:
                warning = f"pycdc exited with status {returncode}; inspect the output before using it."
                warnings = f"{warnings}\n{warning}".strip()
            disassembly_log_path = staging_directory / "pycdc-dis.log"
            disassembly_warning = disassemble(source_path, disassembly_path, disassembly_log_path, report_progress, cancel_check)
            disassembly_artifact = None
            if disassembly_warning:
                warnings = f"{warnings}\nBytecode evidence unavailable: {disassembly_warning}".strip()
            elif disassembly_path.is_file():
                disassembly_destination = output_directory / disassembly_name
                os.replace(disassembly_path, disassembly_destination)
                disassembly_bytes = disassembly_destination.read_bytes()
                disassembly_artifact = {
                    "artifactId": disassembly_destination.relative_to(DERIVED_ROOT).as_posix(),
                    "sizeBytes": len(disassembly_bytes),
                    "sha256": hashlib.sha256(disassembly_bytes).hexdigest(),
                }
            os.replace(output_path, destination)
            relative_output = destination.relative_to(DERIVED_ROOT).as_posix()
            with destination.open("rb") as source:
                output_sha256 = hashlib.file_digest(source, "sha256").hexdigest()
            with source_path.open("rb") as source:
                bytecode_magic_hex = source.read(4).hex()
            return {
                "status": "completed",
                "toolVersion": "0.6.0",
                "unit": {
                    "name": source_stem[:500] or "module",
                    "relativePath": source_relative_path,
                    "codeArtifactId": relative_output[:2000],
                    "sizeBytes": output_size,
                    "outputSha256": output_sha256,
                    **({
                        "disassemblyArtifactId": disassembly_artifact["artifactId"],
                        "disassemblySizeBytes": disassembly_artifact["sizeBytes"],
                        "disassemblySha256": disassembly_artifact["sha256"],
                    } if disassembly_artifact else {}),
                    "bytecodeMagicHex": bytecode_magic_hex,
                },
                "codeBytes": output_size,
                "truncated": False,
                "warnings": warnings[:4000],
            }
        except subprocess.TimeoutExpired as error:
            raise AnalysisError(f"pycdc exceeded the {TIMEOUT_SECONDS} second time limit") from error
        finally:
            shutil.rmtree(staging_directory, ignore_errors=True)
    finally:
        SLOTS.release()

class Handler(BaseHTTPRequestHandler):
    def send_json(self, status: int, value: dict[str, object]) -> None:
        encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def send_event(self, event: dict[str, object]) -> None:
        self.wfile.write((json.dumps(event, separators=(",", ":")) + "\n").encode("utf-8"))
        self.wfile.flush()

    def client_disconnected(self) -> bool:
        readable, _, _ = select.select([self.connection], [], [], 0)
        if not readable:
            return False
        try:
            return self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
        except BlockingIOError:
            return False
        except OSError:
            return True

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_json(404, {"error": "Not found"})
            return
        self.send_json(200, {"status": "ok", "toolVersion": "0.6.0"})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self.send_json(404, {"error": "Not found"})
            return
        headers_sent = False
        streaming = False
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 32 * 1024:
                raise AnalysisError("Request body size is invalid")
            body = json.loads(self.rfile.read(length))
            streaming = "application/x-ndjson" in self.headers.get("Accept", "")
            if not streaming:
                self.send_json(200, analyze(body))
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            headers_sent = True
            try:
                result = analyze(
                    body,
                    report_progress=lambda message: self.send_event({"type": "progress", "message": str(message)[:500]}),
                    cancel_check=self.client_disconnected,
                )
                self.send_event({"type": "result", "data": result})
            except AnalysisError as error:
                self.send_event({"type": "error", "error": str(error)[:1_000]})
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
        except AnalysisError as error:
            self.send_json(422, {"error": str(error)[:1000]})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.log_error("Unexpected Python bytecode analysis failure")
            if headers_sent and streaming:
                try:
                    self.send_event({"type": "error", "error": "Python bytecode analysis failed unexpectedly"})
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                self.send_json(500, {"error": "Python bytecode analysis failed unexpectedly"})

    def log_message(self, format_string: str, *args: object) -> None:
        print("pycdc-analyzer: " + format_string % args, flush=True)

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
