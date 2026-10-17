#!/usr/bin/env python3
"""Isolated HTTP adapter for the pinned Arlecchino JVM meta-decompiler."""
from __future__ import annotations

import hashlib
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
from jvm_rebuild import CompileDiagnostics, RebuildError, rebuild as rebuild_jvm_source

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8028"))
VERSION = "1.0.0"
REVISION = "de3e7b0bbc4c99d45a5baa63f8f8f05532b80363"
BIN = os.environ.get("ARLECCHINO_BIN", "/opt/arlecchino/bin/arlecchino")
CONFIG = os.environ.get("ARLECCHINO_CONFIG", "/opt/arlecchino/engines.toml")
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("ARLECCHINO_TIMEOUT_SECONDS", "900"))))
MAX_BINARY_BYTES = min(1024**3, max(1024**2, int(os.environ.get("ARLECCHINO_MAX_BINARY_BYTES", str(512 * 1024**2)))))
MAX_OUTPUT_BYTES = min(1024**3, max(1024**2, int(os.environ.get("ARLECCHINO_MAX_OUTPUT_BYTES", str(512 * 1024**2)))))
MAX_SOURCE_FILES = min(50000, max(1, int(os.environ.get("ARLECCHINO_MAX_SOURCE_FILES", "20000"))))
MAX_REQUEST_BYTES = 64 * 1024
MAX_REBUILD_REQUEST_BYTES = 5 * 1024 * 1024
MAX_LOG_BYTES = 1024 * 1024
MAX_REPORT_BYTES = 16 * 1024 * 1024
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
    if not path.is_file() or path.suffix.lower() != ".jar":
        raise AnalysisError("Arlecchino accepts JVM .jar artifacts only")
    if path.stat().st_size <= 0 or path.stat().st_size > MAX_BINARY_BYTES:
        raise AnalysisError("Input JAR is empty or exceeds the configured size limit")
    return path


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def kill_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=3)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def run_decompiler(binary: Path, output: Path, log_path: Path, home: Path) -> str:
    command = [BIN, "decompile", str(binary), "--out", str(output), "--config", CONFIG,
               "--jobs", "2", "--no-autofix", "--no-metrics", "--no-midp-stub"]
    started = time.monotonic()
    with log_path.open("wb") as log:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                   cwd=output.parent, env={**os.environ, "HOME": str(home),
                                   "XDG_CACHE_HOME": str(home / ".cache")}, start_new_session=True)
        try:
            while process.poll() is None:
                if time.monotonic() - started > TIMEOUT_SECONDS:
                    raise AnalysisError(f"Arlecchino exceeded {TIMEOUT_SECONDS} seconds")
                if log_path.stat().st_size > MAX_LOG_BYTES:
                    raise AnalysisError("Arlecchino diagnostics exceeded the configured limit")
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
        except BaseException:
            kill_group(process)
            raise
    detail = log_path.read_text(encoding="utf-8", errors="replace")[-MAX_LOG_BYTES:].strip()
    if process.returncode != 0:
        raise AnalysisError(detail or f"Arlecchino exited with code {process.returncode}")
    return detail


def normalized_roundtrip(report: dict[str, object]) -> dict[str, object] | None:
    raw = report.get("roundtrip")
    if not isinstance(raw, dict):
        return None
    total = raw.get("total_original")
    present = raw.get("present")
    coverage = raw.get("coverage_pct")
    if not isinstance(total, int) or isinstance(total, bool) or total < 0:
        return None
    if not isinstance(present, int) or isinstance(present, bool) or present < 0 or present > total:
        return None
    if not isinstance(coverage, (int, float)) or isinstance(coverage, bool) or not 0 <= coverage <= 100:
        return None
    mismatches = raw.get("structural_mismatch")
    missing = raw.get("missing")
    return {
        "present": present,
        "totalOriginal": total,
        "coveragePercent": round(float(coverage), 1),
        "missingClassCount": len(missing) if isinstance(missing, list) else 0,
        "structuralMismatchCount": len(mismatches) if isinstance(mismatches, list) else 0,
    }


def analyze(body: dict[str, object]) -> dict[str, object]:
    if not SLOTS.acquire(blocking=False):
        raise AnalysisError("The Arlecchino analyzer is busy")
    try:
        project_id = safe_id(body.get("projectId"))
        artifact_id = safe_id(body.get("artifactId"))
        task_id = safe_id(body.get("taskId"))
        run_id = safe_id(body.get("runId"))
        binary = resolve_input(body.get("artifactPath"))
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
        source_sha256 = hash_file(binary)

        with tempfile.TemporaryDirectory(prefix="reamon-arlecchino-") as temporary:
            temp_root = Path(temporary)
            output = temp_root / "result"
            output.mkdir()
            home = temp_root / "home"
            home.mkdir()
            log_path = temp_root / "arlecchino.log"
            log = run_decompiler(binary, output, log_path, home)
            if hash_file(binary) != source_sha256:
                raise AnalysisError("Input JAR changed while Arlecchino was analyzing it")

            report_path = output / "report.json"
            try:
                if report_path.is_symlink() or report_path.stat().st_size > MAX_REPORT_BYTES:
                    raise AnalysisError("Arlecchino report is invalid or exceeds the configured limit")
                report = json.loads(report_path.read_text(encoding="utf-8"))
            except AnalysisError:
                raise
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                raise AnalysisError("Arlecchino did not return a valid JSON report") from error
            if not isinstance(report, dict) or report.get("version") != VERSION:
                raise AnalysisError("Arlecchino report version did not match the pinned provider")

            merged_root = output / "merged"
            if not merged_root.is_dir() or merged_root.is_symlink():
                raise AnalysisError("Arlecchino did not return a merged Java source tree")
            sources: list[tuple[Path, str, int]] = []
            total_bytes = 0
            truncated = False
            stop = False
            for directory, dirs, filenames in os.walk(merged_root, followlinks=False):
                dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
                for filename in sorted(filenames):
                    candidate = Path(directory) / filename
                    if candidate.is_symlink() or candidate.suffix.lower() != ".java":
                        continue
                    relative = candidate.relative_to(merged_root).as_posix()
                    resolved = candidate.resolve(strict=True)
                    try:
                        resolved.relative_to(merged_root.resolve())
                    except ValueError:
                        raise AnalysisError("Arlecchino output escaped the merged source directory")
                    size = resolved.stat().st_size
                    if size <= 0 or size > 16 * 1024 * 1024:
                        truncated = True
                        continue
                    if total_bytes + size > MAX_OUTPUT_BYTES or len(sources) >= MAX_SOURCE_FILES:
                        truncated = True
                        stop = True
                        break
                    sources.append((resolved, relative, size))
                    total_bytes += size
                if stop:
                    break
            if not sources:
                raise AnalysisError("Arlecchino did not produce any bounded Java source files")

            units: list[dict[str, object]] = []
            for source, relative, size in sources:
                destination_relative = f"merged/{relative}"
                destination = run_root / destination_relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                with source.open("rb") as source_file, destination.open("wb") as output_file:
                    for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                        output_file.write(chunk)
                        digest.update(chunk)
                units.append({
                    "name": Path(relative).stem,
                    "relativePath": relative,
                    "codeArtifactId": f"{project_id}/{artifact_id}/{task_id}/{run_id}/{destination_relative}",
                    "language": "Java",
                    "sizeBytes": size,
                    "outputSha256": digest.hexdigest(),
                })

            member_rename = report.get("member_rename")
            rename_applied = isinstance(member_rename, dict) and member_rename.get("applied") is True
            mapping_artifact = None
            mapping_root = output / "_rename"
            if rename_applied and mapping_root.is_dir() and not mapping_root.is_symlink():
                mappings = [path for path in mapping_root.glob("*.rename-map.txt") if path.is_file() and not path.is_symlink()]
                if len(mappings) == 1 and mappings[0].stat().st_size <= 8 * 1024 * 1024:
                    relative = "mappings/member-renames.txt"
                    destination = run_root / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(mappings[0], destination)
                    mapping_artifact = {
                        "codeArtifactId": f"{project_id}/{artifact_id}/{task_id}/{run_id}/{relative}",
                        "sha256": hash_file(destination),
                        "sizeBytes": destination.stat().st_size,
                    }
            if rename_applied and mapping_artifact is None:
                raise AnalysisError("Arlecchino applied canonical member renames but did not return their mapping")

            ranking = report.get("ranking")
            bounded_ranking = []
            if isinstance(ranking, list):
                for row in ranking[:16]:
                    if not isinstance(row, dict):
                        continue
                    name, classes, errors = row.get("engine"), row.get("classes"), row.get("errors")
                    if isinstance(name, str) and isinstance(classes, int) and isinstance(errors, int):
                        bounded_ranking.append({"engine": name[:80], "classes": max(0, classes), "errors": max(0, errors)})
            merge_errors = report.get("merged_errors")
            if not isinstance(merge_errors, int) or isinstance(merge_errors, bool) or merge_errors < 0:
                merge_errors = None
            best_base = report.get("best_base") if isinstance(report.get("best_base"), str) else None
            roundtrip = normalized_roundtrip(report)
            summary = {
                "providerVersion": VERSION,
                "providerRevision": REVISION,
                "sourceSha256": source_sha256,
                "engineRanking": bounded_ranking,
                "bestBaseEngine": best_base,
                "mergedCompilerErrorCount": merge_errors,
                "memberRenamesApplied": rename_applied,
                "renameMapping": mapping_artifact,
                "roundTrip": roundtrip,
                "sourceFileCount": len(sources),
                "codeBytes": total_bytes,
                "truncated": truncated,
                "semanticsNote": "Compilation and round-trip coverage are structural evidence, not recovered original names or behavioral equivalence.",
            }
            metadata_path = run_root / "analysis.json"
            metadata_path.write_text(json.dumps(summary, separators=(",", ":")), encoding="utf-8")

        return {
            "status": "completed",
            "toolVersion": VERSION,
            "providerRevision": REVISION,
            "inputName": binary.name[:1000],
            "artifactSha256": source_sha256,
            "sourceFileCount": len(units),
            "codeBytes": total_bytes,
            "truncated": truncated,
            "engineRanking": bounded_ranking,
            "bestBaseEngine": best_base,
            "mergedCompilerErrorCount": merge_errors,
            "memberRenamesApplied": rename_applied,
            "renameMapping": mapping_artifact,
            "roundTrip": roundtrip,
            "analysisArtifactId": f"{project_id}/{artifact_id}/{task_id}/{run_id}/analysis.json",
            "warnings": "Canonical member names are generated to make bytecode source-legal. They are not recovered original names. Compiler and round-trip metrics do not prove behavior."[:2000],
            "units": units,
        }
    finally:
        SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "REAmonArlecchino/1"
    sys_version = ""

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.client_address[0]} {format % args}", file=sys.stderr)

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"status": "ok", "provider": "arlecchino", "version": VERSION, "revision": REVISION})
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if self.path not in {"/analyze", "/rebuild"}:
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request_limit = MAX_REBUILD_REQUEST_BYTES if self.path == "/rebuild" else MAX_REQUEST_BYTES
            if length <= 0 or length > request_limit:
                raise AnalysisError("Request body is empty or too large")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise AnalysisError("Request must be a JSON object")
            if self.path == "/analyze":
                self.send_json(200, analyze(body))
                return
            if not SLOTS.acquire(blocking=False):
                raise AnalysisError("The Arlecchino analyzer is busy")
            try:
                self.send_json(200, rebuild_jvm_source(body))
            finally:
                SLOTS.release()
        except CompileDiagnostics as error:
            self.send_json(422, {"error": str(error)[:8000], "validationStatus": "FAILED"})
        except RebuildError as error:
            self.send_json(400, {"error": str(error)[:2000]})
        except AnalysisError as error:
            self.send_json(503 if "busy" in str(error).lower() else 400, {"error": str(error)[:2000]})
        except Exception as error:
            self.send_json(500, {"error": f"Arlecchino analysis failed: {type(error).__name__}"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 4
    allow_reuse_address = True


if __name__ == "__main__":
    Server(("0.0.0.0", PORT), Handler).serve_forever()
