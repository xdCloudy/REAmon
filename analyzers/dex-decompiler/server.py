#!/usr/bin/env python3
"""Secret-free DEX-to-Java adapter; REAmon owns persistence and review state."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from uuid import uuid4

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8019"))
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("DEX_DECOMPILER_TIMEOUT_SECONDS", "900"))))
MAX_OUTPUT_BYTES = min(1024**3, max(1024**2, int(os.environ.get("DEX_DECOMPILER_MAX_OUTPUT_BYTES", str(512 * 1024**2)))))
MAX_RETURNED_UNITS = min(500, max(1, int(os.environ.get("DEX_DECOMPILER_MAX_RETURNED_UNITS", "500"))))
MAX_SOURCE_FILES = 50_000
MAX_SOURCE_BYTES = 4 * 1024 * 1024
MAX_STRUCTURED_METHODS = 10_000
MAX_STRUCTURED_CALLS = 4_000
MAX_STRUCTURED_REFERENCES = 4_000
MAX_STRUCTURED_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_REQUEST_BYTES = 64 * 1024
TOOL_VERSION = "d458efd15d74351e83f4e8968c75ef17c71f3c65"
SAFE_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    pass


def safe_id(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 128 \
            or value[0] not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" \
            or any(char not in SAFE_ID_CHARS for char in value):
        raise AnalysisError("Invalid analysis identifier")
    return value


def resolve_input(value: object) -> Path:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise AnalysisError("Invalid artifact path")
    try:
        candidate = Path(value).resolve(strict=True)
        candidate.relative_to(ARTIFACT_ROOT)
    except (OSError, RuntimeError, ValueError) as error:
        raise AnalysisError("Input must resolve to a file inside the read-only artifact volume") from error
    if candidate.is_symlink() or not candidate.is_file():
        raise AnalysisError("Artifact input is not a regular file")
    if candidate.suffix.lower() not in {".apk", ".dex"}:
        raise AnalysisError("This engine accepts APK and DEX inputs")
    return candidate


def collect_sources(root: Path) -> tuple[list[tuple[Path, PurePosixPath, int]], int, bool]:
    sources: list[tuple[Path, PurePosixPath, int]] = []
    total_bytes = 0
    truncated = False
    for directory, dirs, filenames in os.walk(root, followlinks=False):
        current = Path(directory)
        dirs[:] = sorted(name for name in dirs if not (current / name).is_symlink())
        for filename in sorted(filenames):
            source = current / filename
            if source.is_symlink() or source.suffix.lower() != ".java":
                continue
            try:
                resolved = source.resolve(strict=True)
                relative = PurePosixPath(resolved.relative_to(root.resolve()).as_posix())
                size = resolved.stat().st_size
            except (OSError, RuntimeError, ValueError):
                continue
            if relative.is_absolute() or ".." in relative.parts:
                continue
            if size <= 0:
                continue
            total_bytes += size
            if total_bytes > MAX_OUTPUT_BYTES:
                raise AnalysisError("DEX-to-Java output exceeded the configured storage limit")
            if size > MAX_SOURCE_BYTES:
                truncated = True
                continue
            sources.append((resolved, relative, size))
            if len(sources) >= MAX_SOURCE_FILES:
                truncated = True
                return sources, total_bytes, truncated
    return sources, total_bytes, truncated


def analyse(body: dict[str, object]) -> dict[str, object]:
    project_id = safe_id(body.get("projectId"))
    artifact_id = safe_id(body.get("artifactId"))
    task_id = safe_id(body.get("taskId"))
    run_id = safe_id(body.get("runId"))
    source = resolve_input(body.get("artifactPath"))
    artifact_hash = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            artifact_hash.update(chunk)

    with tempfile.TemporaryDirectory(prefix="reamon-dex-decompiler-") as temporary:
        temporary_root = Path(temporary)
        output_root = temporary_root / "java"
        output_root.mkdir()
        command = [
            "/usr/local/bin/dex-decompile", "-i", str(source), "-d", str(output_root),
            "--deobf", "--show-bytecode",
        ]
        try:
            result = subprocess.run(
                command,
                cwd=temporary_root,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=TIMEOUT_SECONDS,
                check=False,
                start_new_session=True,
            )
        except subprocess.TimeoutExpired as error:
            raise AnalysisError(f"DEX-to-Java decompilation exceeded {TIMEOUT_SECONDS} seconds") from error
        except OSError as error:
            raise AnalysisError(f"Could not start the DEX decompiler: {error}") from error

        stdout = result.stdout[-4000:].decode("utf-8", errors="replace").strip()
        stderr = result.stderr[-4000:].decode("utf-8", errors="replace").strip()
        if result.returncode != 0:
            detail = stderr or stdout or f"DEX decompiler exited with code {result.returncode}"
            raise AnalysisError(detail[:2000])
        sources, total_source_bytes, source_truncated = collect_sources(output_root)
        if not sources:
            detail = stderr or stdout
            raise AnalysisError(("DEX decompiler produced no Java source" + (f": {detail[:1000]}" if detail else "")))

        method_result: dict[str, object] = {"methods": [], "discoveredMethodCount": 0, "truncated": False}
        method_warning = ""
        method_evidence_root = temporary_root / "method-evidence"
        try:
            structured = subprocess.run(
                ["/usr/local/bin/reamon-dex-structure", str(source), str(method_evidence_root)],
                cwd=temporary_root,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=TIMEOUT_SECONDS,
                check=False,
                start_new_session=True,
            )
            if structured.returncode != 0:
                raise AnalysisError((structured.stderr[-2000:].decode("utf-8", errors="replace").strip()
                                     or f"Structured DEX analysis exited with code {structured.returncode}"))
            if len(structured.stdout) > MAX_STRUCTURED_OUTPUT_BYTES:
                raise AnalysisError("Structured method output exceeded the configured limit")
            parsed_methods = json.loads(structured.stdout)
            if not isinstance(parsed_methods, dict) or not isinstance(parsed_methods.get("methods"), list):
                raise AnalysisError("Structured DEX analysis returned an invalid method list")
            method_result = parsed_methods
        except (AnalysisError, OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
            method_warning = f"Structured DEX method and CFG analysis was unavailable: {str(error)[:1000]}"

        run_root = (DERIVED_ROOT / project_id / artifact_id / task_id / run_id).resolve()
        try:
            run_root.relative_to(DERIVED_ROOT)
        except ValueError as error:
            raise AnalysisError("Derived analysis path is invalid") from error
        run_root.mkdir(parents=True, exist_ok=True)
        destination = run_root / "dex-decompiler"
        if destination.exists() or destination.is_symlink():
            raise AnalysisError("Output for this analysis run already exists")
        staging = run_root / f".dex-decompiler-{uuid4().hex}"
        staging.mkdir()
        units: list[dict[str, object]] = []
        returned_bytes = 0
        try:
            for source_path, relative, size in sources[:MAX_RETURNED_UNITS]:
                target = staging.joinpath(*relative.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source_path, target)
                artifact_path = destination.joinpath(*relative.parts)
                code_artifact_id = artifact_path.relative_to(DERIVED_ROOT).as_posix()
                name = ".".join(relative.with_suffix("").parts)
                units.append({
                    "name": name[:500],
                    "relativePath": relative.as_posix()[:1000],
                    "codeArtifactId": code_artifact_id[:2000],
                    "sizeBytes": size,
                })
                returned_bytes += size
            method_rows = method_result.get("methods", [])
            if isinstance(method_rows, list):
                for method in method_rows[:MAX_STRUCTURED_METHODS]:
                    if not isinstance(method, dict):
                        continue
                    relative_evidence = method.get("bytecodeArtifactPath")
                    if not isinstance(relative_evidence, str) or not relative_evidence:
                        continue
                    relative = PurePosixPath(relative_evidence)
                    if relative.is_absolute() or ".." in relative.parts or "\\" in relative_evidence:
                        continue
                    try:
                        evidence_source = (method_evidence_root.joinpath(*relative.parts)).resolve(strict=True)
                        evidence_source.relative_to(method_evidence_root.resolve())
                        evidence_size = evidence_source.stat().st_size
                    except (OSError, RuntimeError, ValueError):
                        continue
                    if not evidence_source.is_file() or evidence_size <= 0 or evidence_size > 1024 * 1024:
                        continue
                    target_relative = PurePosixPath("method-evidence") / relative
                    target = staging.joinpath(*target_relative.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(evidence_source, target)
                    method["bytecodeArtifactId"] = destination.joinpath(*target_relative.parts).relative_to(DERIVED_ROOT).as_posix()
                    method["bytecodeArtifactSizeBytes"] = evidence_size
            staging.replace(destination)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    method_rows = method_result.get("methods", [])
    methods = [row for row in method_rows[:MAX_STRUCTURED_METHODS] if isinstance(row, dict)] if isinstance(method_rows, list) else []
    discovered_methods = method_result.get("discoveredMethodCount", len(method_rows) if isinstance(method_rows, list) else 0)
    method_truncated = method_result.get("truncated") is True or (isinstance(discovered_methods, int) and discovered_methods > len(methods))
    call_rows = method_result.get("calls", [])
    calls = [row for row in call_rows[:MAX_STRUCTURED_CALLS] if isinstance(row, dict)] if isinstance(call_rows, list) else []
    call_graph_truncated = method_result.get("callGraphTruncated") is True or (isinstance(call_rows, list) and len(call_rows) > len(calls))
    reference_rows = method_result.get("references", [])
    references = [row for row in reference_rows[:MAX_STRUCTURED_REFERENCES] if isinstance(row, dict)] if isinstance(reference_rows, list) else []
    references_truncated = method_result.get("referencesTruncated") is True or (isinstance(reference_rows, list) and len(reference_rows) > len(references))

    return {
        "status": "completed",
        "toolVersion": TOOL_VERSION,
        "input": {"sha256": artifact_hash.hexdigest(), "relativePath": source.relative_to(ARTIFACT_ROOT).as_posix()},
        "discoveredClassCount": len(sources),
        "returnedClassCount": len(units),
        "discoveredMethodCount": discovered_methods if isinstance(discovered_methods, int) and discovered_methods >= 0 else len(methods),
        "returnedMethodCount": len(methods),
        "methodsTruncated": method_truncated,
        "methods": methods,
        "calls": calls,
        "callGraphTruncated": call_graph_truncated,
        "references": references,
        "referencesTruncated": references_truncated,
        "codeBytes": returned_bytes,
        "truncated": source_truncated or len(sources) > len(units),
        "units": units,
        "warnings": "\n".join(filter(None, [
            "This is an alternate DEX-to-Java reconstruction; review it against JADX and bytecode evidence.",
            method_warning,
            stderr[:2000],
        ]))[:4000],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "REAmonDexDecompiler/1.0"

    def log_message(self, format: str, *args: object) -> None:
        print("dex-decompiler-analyzer: " + format % args, flush=True)

    def _send(self, status: int, body: dict[str, object]) -> None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"error": "Not found"})
            return
        self._send(200, {"status": "ready", "provider": "dex-decompiler", "version": TOOL_VERSION})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self._send(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("content-length", "-1"))
            if length < 0 or length > MAX_REQUEST_BYTES:
                raise AnalysisError("Request body exceeds the configured limit")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise AnalysisError("Request body must be a JSON object")
            if not SLOTS.acquire(timeout=1):
                self._send(429, {"error": "DEX decompiler is busy; retry this analysis later"})
                return
            try:
                result = analyse(body)
            finally:
                SLOTS.release()
            self._send(200, result)
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"error": "Request body must be valid JSON"})
        except AnalysisError as error:
            self._send(422, {"error": str(error)[:2000]})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            self.log_error("analysis failed: %s", error)
            self._send(500, {"error": "DEX decompiler analysis failed"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
