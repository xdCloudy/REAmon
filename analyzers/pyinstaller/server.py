#!/usr/bin/env python3
"""Bounded PyInstaller archive extraction adapter for REAmon."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
PORT = int(os.environ.get("PORT", "8029"))
EXTRACTOR_REVISION = "2aa0ec9e58317ac717fdeec84a02d5a67de7b96c2-reamon1"
MAX_INPUT_BYTES = 128 * 1024 * 1024
MAX_MODULES = 64
MAX_MODULE_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
TIMEOUT_SECONDS = 90
SAFE_ID_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
SLOTS = threading.BoundedSemaphore(1)


class ExtractionError(Exception):
    pass


def safe_id(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 128 or value[0] not in SAFE_ID_CHARS:
        raise ExtractionError("Invalid extraction identifier")
    if any(char not in SAFE_ID_CHARS for char in value):
        raise ExtractionError("Invalid extraction identifier")
    return value


def resolve_input(value: object) -> Path:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ExtractionError("Invalid PyInstaller input path")
    try:
        candidate = Path(value).resolve(strict=True)
        candidate.relative_to(ARTIFACT_ROOT)
    except (OSError, RuntimeError, ValueError) as error:
        raise ExtractionError("Input is outside the read-only artifact volume") from error
    if not candidate.is_file():
        raise ExtractionError("Input must be a regular executable artifact")
    size = candidate.stat().st_size
    if size < 64 or size > MAX_INPUT_BYTES:
        raise ExtractionError("PyInstaller input size is outside the configured limit")
    if not has_pyinstaller_cookie(candidate, size):
        raise ExtractionError("Input does not contain a valid PyInstaller CArchive cookie")
    return candidate


def has_pyinstaller_cookie(path: Path, file_size: int) -> bool:
    signature = b"MEI\x0c\x0b\x0a\x0b\x0e"
    tail_size = min(file_size, 1024 * 1024)
    with path.open("rb") as stream:
        stream.seek(file_size - tail_size)
        tail = stream.read(tail_size)
    offset = tail.rfind(signature)
    while offset >= 0:
        if offset + 20 <= len(tail):
            package_size, toc_offset, toc_size = struct.unpack_from(">III", tail, offset + 8)
            absolute_offset = file_size - tail_size + offset
            if 0 < package_size <= absolute_offset and 0 < toc_size and toc_offset <= package_size and toc_size <= package_size - toc_offset:
                return True
        offset = tail.rfind(signature, 0, offset)
    return False


def collect_modules(extraction_root: Path) -> tuple[list[dict[str, object]], int]:
    root = extraction_root.resolve(strict=True)
    modules: list[dict[str, object]] = []
    total_bytes = 0
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        base = Path(directory)
        dirnames[:] = [name for name in dirnames if not (base / name).is_symlink()]
        for filename in sorted(filenames):
            if not filename.lower().endswith(".pyc"):
                continue
            path = base / filename
            try:
                info = path.lstat()
                if not path.is_file() or path.is_symlink() or info.st_size < 16 or info.st_size > MAX_MODULE_BYTES:
                    continue
                path.resolve(strict=True).relative_to(root)
                data = path.read_bytes()
            except (OSError, RuntimeError, ValueError):
                continue
            if len(data) != info.st_size or data[2:4] != b"\r\n":
                continue
            if len(modules) >= MAX_MODULES or total_bytes + len(data) > MAX_OUTPUT_BYTES:
                return modules, total_bytes
            relative_path = path.relative_to(root).as_posix()
            total_bytes += len(data)
            modules.append({
                "archivePath": relative_path[:1000],
                "sizeBytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "magicHex": data[:4].hex(),
                "dataBase64": base64.b64encode(data).decode("ascii"),
            })
    return modules, total_bytes


def extract(body: object) -> dict[str, object]:
    if not isinstance(body, dict):
        raise ExtractionError("Request must be a JSON object")
    project_id = safe_id(body.get("projectId"))
    artifact_id = safe_id(body.get("artifactId"))
    safe_id(body.get("taskId"))
    safe_id(body.get("runId"))
    input_path = resolve_input(body.get("artifactPath"))
    if not SLOTS.acquire(blocking=False):
        raise ExtractionError("The PyInstaller extraction worker is busy")
    try:
        with tempfile.TemporaryDirectory(prefix=f"reamon-pyi-{project_id[:10]}-{artifact_id[:10]}-") as temporary:
            workdir = Path(temporary)
            started = time.monotonic()
            try:
                result = subprocess.run(
                    ["/usr/local/bin/pyinstxtractor-go", str(input_path)],
                    cwd=workdir,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp"},
                    timeout=TIMEOUT_SECONDS,
                    check=False,
                )
            except subprocess.TimeoutExpired as error:
                raise ExtractionError("PyInstaller extraction exceeded the 90 second limit") from error
            except OSError as error:
                raise ExtractionError(f"PyInstaller extractor could not start: {type(error).__name__}") from error
            if result.returncode != 0:
                raise ExtractionError("The archive could not be extracted; it may be unsupported or malformed")
            extraction_root = workdir / f"{input_path.name}_extracted"
            if not extraction_root.is_dir() or extraction_root.is_symlink():
                raise ExtractionError("The extractor produced no contained output directory")
            modules, total_bytes = collect_modules(extraction_root)
            if not modules:
                raise ExtractionError("No bounded Python bytecode modules were recovered")
            return {
                "status": "completed",
                "extractorRevision": EXTRACTOR_REVISION,
                "moduleCount": len(modules),
                "outputBytes": total_bytes,
                "truncated": len(modules) >= MAX_MODULES or total_bytes >= MAX_OUTPUT_BYTES,
                "elapsedMs": max(0, int((time.monotonic() - started) * 1000)),
                "modules": modules,
            }
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

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_json(404, {"error": "Not found"})
            return
        self.send_json(200, {"status": "ok", "extractorRevision": EXTRACTOR_REVISION})

    def do_POST(self) -> None:
        if self.path != "/extract":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 64 * 1024:
                raise ExtractionError("Request size is outside the configured limit")
            body = json.loads(self.rfile.read(length))
            self.send_json(200, extract(body))
        except ExtractionError as error:
            self.send_json(400, {"status": "failed", "error": str(error)[:1200]})
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"status": "failed", "error": "Invalid JSON request"})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            self.send_json(500, {"status": "failed", "error": f"Extraction failed: {type(error).__name__}"})

    def log_message(self, format_string: str, *args: object) -> None:
        print("pyinstaller-analyzer: " + format_string % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
