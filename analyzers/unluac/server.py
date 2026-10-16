#!/usr/bin/env python3
"""Isolated unluac adapter for standard Lua bytecode."""
from __future__ import annotations
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8017"))
TIMEOUT_SECONDS = min(600, max(10, int(os.environ.get("UNLUAC_TIMEOUT_SECONDS", "180"))))
MAX_INPUT_BYTES = min(128 * 1024 * 1024, max(1024, int(os.environ.get("UNLUAC_MAX_INPUT_BYTES", str(16 * 1024 * 1024)))))
MAX_OUTPUT_BYTES = min(64 * 1024 * 1024, max(1024, int(os.environ.get("UNLUAC_MAX_OUTPUT_BYTES", str(32 * 1024 * 1024)))))
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
TOOL_VERSION = "1.2.3.569+744c8149"
SUPPORTED_VERSIONS = {0x50, 0x51, 0x52, 0x53, 0x54}
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    pass


def safe_id(value: object) -> str:
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise AnalysisError("Invalid analysis identifier")
    return value


def resolve_input(value: object) -> tuple[Path, str]:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise AnalysisError("Invalid Lua bytecode path")
    try:
        candidate = Path(value).resolve(strict=True)
        candidate.relative_to(ARTIFACT_ROOT)
    except (OSError, RuntimeError, ValueError) as error:
        raise AnalysisError("Input is outside the read-only artifact volume") from error
    if not candidate.is_file():
        raise AnalysisError("Input must be a regular Lua bytecode artifact")
    size = candidate.stat().st_size
    if size < 5 or size > MAX_INPUT_BYTES:
        raise AnalysisError("Lua bytecode size is outside the configured limit")
    digest = hashlib.sha256()
    with candidate.open("rb") as stream:
        header = stream.read(5)
        digest.update(header)
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if header[:4] != b"\x1bLua" or header[4] not in SUPPORTED_VERSIONS:
        raise AnalysisError("Input does not have a supported Lua 5.0–5.4 bytecode signature")
    return candidate, digest.hexdigest()


def analyze(body: object) -> dict[str, object]:
    if not isinstance(body, dict):
        raise AnalysisError("Request must be an object")
    project_id = safe_id(body.get("projectId"))
    artifact_id = safe_id(body.get("artifactId"))
    task_id = safe_id(body.get("taskId"))
    run_id = safe_id(body.get("runId"))
    source_path, input_digest = resolve_input(body.get("artifactPath"))
    source_relative_path = body.get("artifactRelativePath")
    if not isinstance(source_relative_path, str) or not source_relative_path or len(source_relative_path) > 1000:
        raise AnalysisError("Lua bytecode logical path is invalid")
    source_relative_path = source_relative_path.replace("\\", "/")
    if not SLOTS.acquire(blocking=False):
        raise AnalysisError("The Lua bytecode decompiler is busy")
    try:
        digest = hashlib.sha256(source_relative_path.encode("utf-8")).hexdigest()[:12]
        stem = re.sub(r"[^A-Za-z0-9_.-]", "_", PurePosixPath(source_relative_path).stem).strip(".-")[:120] or "module"
        output_name = f"{digest}-{stem}.lua"
        output_directory = DERIVED_ROOT / project_id / artifact_id / task_id / run_id / "unluac"
        output_directory.mkdir(parents=True, exist_ok=True)
        try:
            output_directory.resolve(strict=True).relative_to(DERIVED_ROOT)
        except (OSError, RuntimeError, ValueError) as error:
            raise AnalysisError("Output directory is outside the derived-data volume") from error

        with tempfile.TemporaryDirectory(prefix="unluac-", dir="/tmp") as staging_directory:
            output_path = Path(staging_directory) / "decompiled.lua"
            log_path = Path(staging_directory) / "unluac.log"
            try:
                with log_path.open("wb") as log_file:
                    result = subprocess.run(
                        ["java", "-Xms32m", "-Xmx384m", "-jar", "/opt/unluac.jar", "--output", str(output_path), str(source_path)],
                        stdin=subprocess.DEVNULL,
                        stdout=log_file,
                        stderr=subprocess.STDOUT,
                        timeout=TIMEOUT_SECONDS,
                        check=False,
                        cwd=staging_directory,
                        env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"},
                    )
            except subprocess.TimeoutExpired as error:
                raise AnalysisError(f"Lua decompilation exceeded the {TIMEOUT_SECONDS} second time limit") from error
            if result.returncode != 0 or not output_path.is_file() or output_path.is_symlink():
                detail = log_path.read_bytes()[-4096:].decode("utf-8", errors="replace").strip()
                raise AnalysisError(detail or "Lua bytecode could not be decompiled")
            output_size = output_path.stat().st_size
            if output_size <= 0 or output_size > MAX_OUTPUT_BYTES:
                raise AnalysisError("Decompiled Lua source exceeded the configured output limit")
            with output_path.open("rb") as source:
                prefix = source.read(256)
            if b"\x00" in prefix:
                raise AnalysisError("unluac produced an invalid source file")

            destination = output_directory / output_name
            temporary_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(prefix=".unluac-", dir=output_directory, delete=False) as temporary:
                    temporary_path = Path(temporary.name)
                    with output_path.open("rb") as source:
                        shutil.copyfileobj(source, temporary)
                    os.fchmod(temporary.fileno(), 0o644)
                os.replace(temporary_path, destination)
            finally:
                if temporary_path and temporary_path.exists():
                    temporary_path.unlink()

        relative_output = destination.relative_to(DERIVED_ROOT).as_posix()
        logical_name = PurePosixPath(source_relative_path).stem
        if not logical_name:
            logical_name = "module"
        return {
            "status": "completed",
            "toolVersion": TOOL_VERSION,
            "input": {"relativePath": source_relative_path, "sha256": input_digest},
            "unit": {
                "name": f"{logical_name[:495]}.lua",
                "relativePath": source_relative_path,
                "codeArtifactId": relative_output[:2000],
                "sizeBytes": output_size,
            },
            "codeBytes": output_size,
            "warnings": "Stripped chunks may not retain original local names. Reconstructed source is not guaranteed to match the original.",
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
        self.send_json(200, {"status": "ok", "toolVersion": TOOL_VERSION})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 32 * 1024:
                raise AnalysisError("Request body size is invalid")
            body = json.loads(self.rfile.read(length))
            self.send_json(200, analyze(body))
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
        except AnalysisError as error:
            self.send_json(422, {"error": str(error)[:1000]})
        except BrokenPipeError:
            pass
        except Exception:
            self.log_error("Unexpected Lua bytecode analysis failure")
            self.send_json(500, {"error": "Lua bytecode decompilation failed unexpectedly"})

    def log_message(self, format_string: str, *args: object) -> None:
        print("unluac-analyzer: " + format_string % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
