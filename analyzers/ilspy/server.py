#!/usr/bin/env python3
"""Secret-free ILSpy adapter isolated from REAmon's database and network."""
from __future__ import annotations

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
PORT = int(os.environ.get("PORT", "8013"))
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("ILSPY_TIMEOUT_SECONDS", "900"))))
MAX_OUTPUT_BYTES = min(1024**3, max(1024**2, int(os.environ.get("ILSPY_MAX_OUTPUT_BYTES", str(512 * 1024**2)))))
MAX_SOURCE_FILES = min(50000, max(1, int(os.environ.get("ILSPY_MAX_SOURCE_FILES", "20000"))))
MAX_RETURNED_UNITS = min(20000, max(1, int(os.environ.get("ILSPY_MAX_RETURNED_UNITS", "20000"))))
MAX_VIEWABLE_BYTES = 2 * 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
NAMESPACE_PATTERN = re.compile(r"^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:;|\{)", re.MULTILINE)
TYPE_PATTERN = re.compile(r"\b(?:class|interface|struct|enum|record|delegate)\s+([A-Za-z_][A-Za-z0-9_]*)")
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    pass


def safe_id(value):
    if not isinstance(value, str) or len(value) > 128 or not SAFE_ID.fullmatch(value):
        raise AnalysisError("Invalid analysis identifier")
    return value


def resolve_input(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise AnalysisError("Invalid artifact path")
    try:
        candidate = Path(value).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise AnalysisError("Artifact input does not exist or cannot be resolved") from error
    try:
        candidate.relative_to(ARTIFACT_ROOT)
    except ValueError as error:
        raise AnalysisError("Input is outside the read-only artifact volume") from error
    if not candidate.is_file():
        raise AnalysisError("Artifact input is not a regular file")
    return candidate


def source_files(root):
    found, total_bytes, scan_truncated = [], 0, False
    for directory, dirs, filenames in os.walk(root, followlinks=False):
        dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
        for filename in sorted(filenames):
            path = Path(directory) / filename
            if path.is_symlink() or path.suffix.lower() != ".cs":
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            total_bytes += size
            if size > MAX_OUTPUT_BYTES or total_bytes > MAX_OUTPUT_BYTES:
                raise AnalysisError("ILSpy source output exceeded the configured storage limit")
            found.append(path)
            if len(found) > MAX_SOURCE_FILES:
                found.pop()
                scan_truncated = True
                return found, total_bytes, scan_truncated
    return found, total_bytes, scan_truncated


def client_disconnected(connection):
    readable, _, _ = select.select([connection], [], [], 0)
    if not readable:
        return False
    try:
        return connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
    except BlockingIOError:
        return False
    except OSError:
        return True


def run_analysis_tool(arguments, stderr_file, cancel_check, deadline):
    process = subprocess.Popen(
        arguments,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=stderr_file,
        start_new_session=True,
        env={**os.environ, "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1"},
    )
    try:
        while process.poll() is None:
            if cancel_check():
                raise AnalysisError("ILSpy analysis was cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AnalysisError(f"ILSpy analysis exceeded {TIMEOUT_SECONDS} seconds")
            try:
                process.wait(timeout=min(0.25, remaining))
            except subprocess.TimeoutExpired:
                pass
        return process.returncode
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        raise


def analyse(body, cancel_check=lambda: False, report_progress=lambda message: None):
    project_id, artifact_id = safe_id(body.get("projectId")), safe_id(body.get("artifactId"))
    task_id, run_id = safe_id(body.get("taskId")), safe_id(body.get("runId"))
    input_path = resolve_input(body.get("artifactPath"))
    run_root = (DERIVED_ROOT / project_id / artifact_id / task_id / run_id).resolve()
    try:
        run_root.relative_to(DERIVED_ROOT)
    except ValueError as error:
        raise AnalysisError("Derived output path is invalid") from error
    if run_root.exists():
        shutil.rmtree(run_root)

    deadline = time.monotonic() + TIMEOUT_SECONDS
    report_progress("Waiting for an ILSpy analyzer slot")
    with SLOTS:
        try:
            with tempfile.TemporaryDirectory(prefix="reamon-ilspy-") as temporary:
                output = Path(temporary) / "out"
                stderr_path = Path(temporary) / "ilspy.stderr"
                with stderr_path.open("wb") as stderr_file:
                    try:
                        report_progress("Decompiling managed assembly with ILSpy")
                        return_code = run_analysis_tool([
                            os.environ.get("ILSPYCMD", "/opt/ilspycmd/ilspycmd"),
                            "--nested-directories", "-p", "-o", str(output), str(input_path),
                        ], stderr_file, cancel_check, deadline)
                    except OSError as error:
                        raise AnalysisError("ILSpy could not be started") from error
                    stderr_file.flush()

                log_text = stderr_path.read_bytes()[-4096:].decode("utf-8", errors="replace").strip()
                raw_sources, total_source_bytes, scan_truncated = source_files(output) if output.exists() else ([], 0, False)
                if not raw_sources:
                    raise AnalysisError(log_text or "ILSpy produced no C# source files")

                source_root = run_root / "sources"
                source_root.mkdir(parents=True, exist_ok=True)
                units, oversized = [], 0
                returned_sources = raw_sources[:MAX_RETURNED_UNITS]
                for source_index, source in enumerate(returned_sources, start=1):
                    if source_index == 1 or source_index % max(1, len(returned_sources) // 25) == 0 or source_index == len(returned_sources):
                        report_progress(f"Indexing C# source {source_index} of {len(returned_sources)}")
                    relative = source.relative_to(output)
                    if relative.is_absolute() or ".." in relative.parts:
                        continue
                    raw = source.read_bytes()
                    if not raw:
                        continue
                    if len(raw) > MAX_VIEWABLE_BYTES:
                        oversized += 1
                        continue
                    text = raw.decode("utf-8", errors="replace")
                    namespace = NAMESPACE_PATTERN.search(text)
                    type_match = TYPE_PATTERN.search(text)
                    fallback = relative.stem.replace("+", ".")
                    name = f"{namespace.group(1)}.{type_match.group(1)}" if namespace and type_match else (f"{namespace.group(1)}.{fallback}" if namespace else fallback)
                    destination = source_root / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(raw)
                    units.append({
                        "name": name[:500],
                        "relativePath": relative.as_posix()[:1000],
                        "codeArtifactId": destination.relative_to(DERIVED_ROOT).as_posix(),
                        "sizeBytes": len(raw),
                        "unitType": "type",
                        "language": "C#",
                    })

                units.sort(key=lambda unit: str(unit["relativePath"]).casefold())
                warnings = []
                if scan_truncated:
                    warnings.append(f"ILSpy produced more than {len(raw_sources)} C# source files; the source scan stopped at its configured limit.")
                if len(raw_sources) > MAX_RETURNED_UNITS:
                    warnings.append(f"Only the first {MAX_RETURNED_UNITS} of {len(raw_sources)} discovered C# source files are available as code units.")
                if oversized:
                    warnings.append(f"{oversized} C# source files exceeded the 2 MiB viewer limit and were not linked.")
                if log_text:
                    warnings.append(log_text[:4000])
                elif return_code:
                    warnings.append(f"ILSpy exited with code {return_code}.")
                if not units:
                    raise AnalysisError("ILSpy produced no viewable C# source files")

                report_progress("Saving decompiled sources and preparing results")
                return {
                    "status": "completed",
                    "toolVersion": os.environ.get("ILSPY_VERSION", "unknown"),
                    "classCount": None if scan_truncated else len(raw_sources),
                    "codeBytes": total_source_bytes,
                    "returnedUnits": len(units),
                    "truncated": scan_truncated or len(raw_sources) > len(units),
                    "units": units,
                    "warnings": " ".join(warnings),
                }
        except AnalysisError:
            if run_root.exists():
                shutil.rmtree(run_root, ignore_errors=True)
            raise
        except Exception as error:
            if run_root.exists():
                shutil.rmtree(run_root, ignore_errors=True)
            raise AnalysisError("ILSpy analysis failed unexpectedly") from error


class Handler(BaseHTTPRequestHandler):
    server_version = "REAmon-ILSpy/1.0"
    protocol_version = "HTTP/1.1"

    def _send(self, status, value):
        encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _start_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _send_stream_event(self, value):
        encoded = json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n"
        self.wfile.write(f"{len(encoded):X}\r\n".encode("ascii") + encoded + b"\r\n")
        self.wfile.flush()

    def _finish_stream(self):
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def do_GET(self):
        if self.path != "/health":
            self._send(404, {"error": "Not found"})
            return
        self._send(200, {"status": "ready", "provider": "ilspy", "version": os.environ.get("ILSPY_VERSION", "unknown")})

    def do_POST(self):
        if self.path != "/analyze":
            self._send(404, {"error": "Not found"})
            return
        stream_started = False
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 16 * 1024:
                raise AnalysisError("Request body must be between 1 byte and 16 KB")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise AnalysisError("Request body must be an object")
            if "application/x-ndjson" in self.headers.get("Accept", ""):
                self._start_stream()
                stream_started = True
                result = analyse(body, lambda: client_disconnected(self.connection),
                                 lambda message: self._send_stream_event({"type": "progress", "message": message}))
                self._send_stream_event({"type": "result", "data": result})
                self._finish_stream()
                return
            self._send(200, analyse(body))
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"error": "Request body must be valid JSON"})
        except AnalysisError as error:
            if stream_started:
                try:
                    self._send_stream_event({"type": "error", "error": str(error)[:1000]})
                    self._finish_stream()
                except (BrokenPipeError, ConnectionResetError):
                    return
            else:
                self._send(422, {"error": str(error)[:1000]})
        except (BrokenPipeError, ConnectionResetError):
            return

    def log_message(self, format, *args):
        print("ilspy-analyzer: " + format % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
