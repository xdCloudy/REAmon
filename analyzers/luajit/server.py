#!/usr/bin/env python3
"""Isolated LuaJIT bytecode decompiler adapter."""
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
PORT = int(os.environ.get("PORT", "8016"))
TIMEOUT_SECONDS = min(600, max(10, int(os.environ.get("LUAJIT_TIMEOUT_SECONDS", "180"))))
MAX_INPUT_BYTES = min(512 * 1024 * 1024, max(1024, int(os.environ.get("LUAJIT_MAX_INPUT_BYTES", str(128 * 1024 * 1024)))))
MAX_OUTPUT_BYTES = min(128 * 1024 * 1024, max(1024, int(os.environ.get("LUAJIT_MAX_OUTPUT_BYTES", str(32 * 1024 * 1024)))))
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
TOOL_VERSION = "2.0.0+0ec63c05"
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    pass


def safe_id(value: object) -> str:
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise AnalysisError("Invalid analysis identifier")
    return value


def resolve_input(value: object) -> tuple[Path, bytes]:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise AnalysisError("Invalid LuaJIT bytecode path")
    try:
        candidate = Path(value).resolve(strict=True)
        candidate.relative_to(ARTIFACT_ROOT)
    except (OSError, RuntimeError, ValueError) as error:
        raise AnalysisError("Input is outside the read-only artifact volume") from error
    if not candidate.is_file():
        raise AnalysisError("Input must be a regular LuaJIT bytecode artifact")
    size = candidate.stat().st_size
    if size < 4 or size > MAX_INPUT_BYTES:
        raise AnalysisError("LuaJIT bytecode size is outside the configured limit")
    input_hash = hashlib.sha256()
    with candidate.open("rb") as stream:
        header = stream.read(4)
        input_hash.update(header)
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            input_hash.update(chunk)
    if len(header) != 4 or header[:3] != b"\x1bLJ":
        raise AnalysisError("Input does not have a LuaJIT bytecode signature")
    return candidate, input_hash.digest()


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
        raise AnalysisError("LuaJIT bytecode logical path is invalid")
    source_relative_path = source_relative_path.replace("\\", "/")
    if not SLOTS.acquire(blocking=False):
        raise AnalysisError("The LuaJIT decompiler is busy")
    try:
        digest = hashlib.sha256(source_relative_path.encode("utf-8")).hexdigest()[:12]
        stem = re.sub(r"[^A-Za-z0-9_.-]", "_", PurePosixPath(source_relative_path).stem).strip(".-")[:120] or "module"
        output_name = f"{digest}-{stem}.lua"
        output_directory = DERIVED_ROOT / project_id / artifact_id / task_id / run_id / "luajit"
        output_directory.mkdir(parents=True, exist_ok=True)
        try:
            output_directory.resolve(strict=True).relative_to(DERIVED_ROOT)
        except (OSError, RuntimeError, ValueError) as error:
            raise AnalysisError("Output directory is outside the derived-data volume") from error
        staging_directory = Path(tempfile.mkdtemp(prefix=".luajit-", dir=output_directory))
        try:
            log_path = staging_directory / "luajit.log"
            with log_path.open("wb") as log_file:
                result = subprocess.run(
                    ["/usr/local/bin/luajit-decompiler", str(source_path), "--output", str(staging_directory),
                     "--force_overwrite", "--jobs", "1"],
                    stdin=subprocess.DEVNULL,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    timeout=TIMEOUT_SECONDS,
                    check=False,
                    cwd=staging_directory,
                    env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"},
                )
            produced = list(staging_directory.rglob("*.lua"))
            if result.returncode != 0 or len(produced) != 1 or produced[0].is_symlink():
                detail = log_path.read_bytes()[-4096:].decode("utf-8", errors="replace").strip()
                raise AnalysisError(detail or "LuaJIT bytecode could not be decompiled")
            output_path = produced[0]
            output_size = output_path.stat().st_size
            if output_size <= 0 or output_size > MAX_OUTPUT_BYTES:
                raise AnalysisError("Decompiled Lua source exceeded the configured output limit")
            with output_path.open("rb") as source:
                prefix = source.read(256)
            if b"\x00" in prefix:
                raise AnalysisError("LuaJIT decompiler produced an invalid source file")
            destination = output_directory / output_name
            os.replace(output_path, destination)
            relative_output = destination.relative_to(DERIVED_ROOT).as_posix()
            logical_name = PurePosixPath(source_relative_path).name
            if logical_name.endswith(".bytes"):
                logical_name = logical_name[:-6]
            elif logical_name.endswith(".lj"):
                logical_name = logical_name[:-3]
            if not logical_name.endswith(".lua"):
                logical_name += ".lua"
            return {
                "status": "completed",
                "toolVersion": TOOL_VERSION,
                "input": {"relativePath": source_relative_path, "sha256": input_digest.hex()},
                "unit": {
                    "name": logical_name[:500],
                    "relativePath": source_relative_path,
                    "codeArtifactId": relative_output[:2000],
                    "sizeBytes": output_size,
                },
                "codeBytes": output_size,
                "warnings": "LuaJIT bytecode cannot restore stripped local names. Review reconstructed Lua before editing.",
            }
        except subprocess.TimeoutExpired as error:
            raise AnalysisError(f"LuaJIT decompilation exceeded the {TIMEOUT_SECONDS} second time limit") from error
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
            self.log_error("Unexpected LuaJIT analysis failure")
            self.send_json(500, {"error": "LuaJIT decompilation failed unexpectedly"})

    def log_message(self, format_string: str, *args: object) -> None:
        print("luajit-analyzer: " + format_string % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
