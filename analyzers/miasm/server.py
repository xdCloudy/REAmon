#!/usr/bin/env python3
"""Isolated, bounded Miasm native IR and simplification evidence adapter."""
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

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8034"))
VERSION = os.environ.get("MIASM_VERSION", "unknown")
REVISION = os.environ.get("MIASM_PROVIDER_REVISION", "")
TIMEOUT_SECONDS = min(1800, max(30, int(os.environ.get("MIASM_TIMEOUT_SECONDS", "300"))))
MAX_BINARY_BYTES = min(512 * 1024 * 1024, max(1024 * 1024, int(os.environ.get("MIASM_MAX_BINARY_BYTES", str(256 * 1024 * 1024)))))
MAX_FUNCTIONS = min(200, max(1, int(os.environ.get("MIASM_MAX_FUNCTIONS", "80"))))
MAX_BLOCKS_PER_FUNCTION = min(128, max(1, int(os.environ.get("MIASM_MAX_BLOCKS_PER_FUNCTION", "32"))))
MAX_INSTRUCTIONS_PER_BLOCK = min(512, max(8, int(os.environ.get("MIASM_MAX_INSTRUCTIONS_PER_BLOCK", "128"))))
MAX_UNIT_BYTES = min(512 * 1024, max(4096, int(os.environ.get("MIASM_MAX_UNIT_BYTES", str(128 * 1024)))))
MAX_OUTPUT_BYTES = min(64 * 1024 * 1024, max(MAX_UNIT_BYTES, int(os.environ.get("MIASM_MAX_OUTPUT_BYTES", str(16 * 1024 * 1024)))))
MAX_REQUEST_BYTES = 64 * 1024
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
    if not path.is_file() or path.stat().st_size <= 0 or path.stat().st_size > MAX_BINARY_BYTES:
        raise AnalysisError("Input binary is empty or exceeds the configured size limit")
    return path


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def executable_ranges(container) -> tuple[list[tuple[int, int]], bool]:
    executable = container.executable
    program_headers = getattr(getattr(executable, "ph", None), "phlist", None)
    if program_headers is not None:
        ranges = []
        for program in program_headers:
            header = getattr(getattr(program, "ph", None), "cstr", None)
            if header is not None and header.type == 1 and header.flags & 1 and header.memsz > 0:
                ranges.append((int(header.vaddr), int(header.vaddr + header.memsz)))
        return ranges, True

    section_headers = getattr(getattr(executable, "SHList", None), "shlist", None)
    if section_headers is not None:
        ranges = []
        for section in section_headers:
            if section.flags & 0x20000000:
                start = int(executable.rva2virt(section.addr))
                end = start + max(int(section.size), int(section.rawsize))
                if end > start:
                    ranges.append((start, end))
        return ranges, False
    return [], False


def function_candidates(container, loc_db) -> list[tuple[int, str]]:
    ranges, is_elf = executable_ranges(container)
    if not ranges:
        return []

    def is_executable(address: int) -> bool:
        return any(start <= address < end for start, end in ranges)

    candidates: dict[int, set[str]] = {}
    if is_elf:
        for section in getattr(container.executable.sh, "shlist", []):
            symbols = getattr(section, "symtab", None)
            if symbols is None:
                continue
            for symbol in symbols:
                if (int(symbol.info) & 0xF) not in (2, 10) or symbol.shndx == 0:
                    continue
                address = int(symbol.value)
                if address > 0 and is_executable(address):
                    raw_name = symbol.name or ""
                    name = (raw_name.decode("utf-8", errors="replace") if isinstance(raw_name, bytes)
                            else str(raw_name))[:500]
                    candidates.setdefault(address, set()).add(name or f"sub_{address:x}")
    else:
        for address in loc_db.offsets:
            if not isinstance(address, int) or address <= 0 or not is_executable(address):
                continue
            location = loc_db.get_offset_location(address)
            if location is None:
                continue
            names = {name[:500] for name in loc_db.get_location_names(location) if name and not name.startswith("loc_")}
            if names:
                candidates.setdefault(address, set()).update(names)
    if container.entry_point is not None and is_executable(int(container.entry_point)):
        candidates.setdefault(int(container.entry_point), set()).add("entry_point")
    ordered = sorted(candidates.items(), key=lambda item: item[0])
    return [(address, ", ".join(sorted(names))[:500]) for address, names in ordered[:MAX_FUNCTIONS]]


def emit_function_ir(binary_path: Path, output_root: Path) -> dict[str, object]:
    from miasm.analysis.binary import Container
    from miasm.analysis.machine import Machine
    from miasm.analysis.simplifier import IRCFGSimplifierCommon
    from miasm.core.locationdb import LocationDB

    source_hash = hash_file(binary_path)
    loc_db = LocationDB()
    with binary_path.open("rb") as stream:
        container = Container.from_stream(stream, loc_db)
    if not container.arch or not container.entry_point:
        raise AnalysisError("Miasm could not identify an executable format, architecture, or entry point")
    machine = Machine(container.arch)
    disassembler = machine.dis_engine(container.bin_stream, loc_db=loc_db)
    disassembler.blocs_wd = MAX_BLOCKS_PER_FUNCTION
    disassembler.lines_wd = MAX_INSTRUCTIONS_PER_BLOCK
    candidates = function_candidates(container, loc_db)
    if not candidates:
        raise AnalysisError("Miasm did not find any symbol or entry-point candidates")

    output_root.mkdir(parents=True, exist_ok=True)
    units: list[dict[str, object]] = []
    warnings: list[str] = []
    total_bytes = 0
    failed = 0
    for address, name in candidates:
        try:
            asmcfg = disassembler.dis_multiblock(address)
            instruction_count = sum(len(block.lines) for block in asmcfg.blocks)
            if not asmcfg.blocks or instruction_count <= 0:
                failed += 1
                continue
            lifter = machine.lifter_model_call(loc_db)
            ircfg = lifter.new_ircfg_from_asmcfg(asmcfg)
            head = loc_db.get_offset_location(address)
            if head not in ircfg.blocks:
                head = next(iter(ircfg.blocks))
            blocks_before = len(ircfg.blocks)
            simplifier = IRCFGSimplifierCommon(lifter)
            simplifier.simplify(ircfg, head)
            rendered = "\n\n".join(str(block) for _, block in sorted(
                ircfg.blocks.items(), key=lambda item: loc_db.get_location_offset(item[0]) or 0))
            raw = rendered.encode("utf-8", errors="replace")
            truncated = len(raw) > MAX_UNIT_BYTES
            if truncated:
                marker = "\n... [per-function IR output truncated]"
                rendered = raw[:MAX_UNIT_BYTES - len(marker.encode("utf-8"))].decode("utf-8", errors="ignore") + marker
                raw = rendered.encode("utf-8")
            if not raw.strip() or total_bytes + len(raw) > MAX_OUTPUT_BYTES:
                warnings.append(f"Stopped at {address:#x}: output limit reached")
                break
            relative_path = f"functions/{address:x}.ir"
            output_path = output_root / relative_path
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(raw)
            units.append({
                "name": name,
                "address": f"0x{address:x}",
                "relativePath": relative_path,
                "sizeBytes": len(raw),
                "outputSha256": hashlib.sha256(raw).hexdigest(),
                "blockCountBeforeSimplification": blocks_before,
                "blockCountAfterSimplification": len(ircfg.blocks),
                "instructionCount": instruction_count,
                "truncated": truncated,
            })
            total_bytes += len(raw)
        except Exception as error:  # A malformed or unsupported function must not discard sibling evidence.
            failed += 1
            if len(warnings) < 40:
                warnings.append(f"{address:#x}: {str(error)[:400]}")

    if not units:
        raise AnalysisError("Miasm did not produce viewable intermediate-representation evidence")
    return {
        "status": "completed",
        "toolVersion": VERSION,
        "providerRevision": REVISION,
        "sourceSha256": source_hash,
        "architecture": container.arch,
        "functionCount": len(candidates),
        "returnedUnits": len(units),
        "failedFunctionCount": failed,
        "truncated": len(candidates) > len(units) or any(unit["truncated"] for unit in units),
        "outputBytes": total_bytes,
        "units": units,
        "warnings": "\n".join(warnings)[:12000],
        "semantics": "Simplified Miasm intermediate representation is provisional structural analysis evidence. It is not recovered original-language source or proof of behavior.",
    }


def worker_main(request_path: Path) -> int:
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        binary_path = resolve_input(request.get("artifactPath"))
        result = emit_function_ir(binary_path, request_path.parent / "output")
        (request_path.parent / "result.json").write_text(json.dumps(result), encoding="utf-8")
        return 0
    except Exception as error:
        (request_path.parent / "error.txt").write_text(str(error)[:2000], encoding="utf-8")
        return 1


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


def persist_run(output_root: Path, run_root: Path, result: dict[str, object], project_id: str,
                artifact_id: str, task_id: str, run_id: str) -> dict[str, object]:
    run_root.parent.mkdir(parents=True, exist_ok=True)
    if run_root.exists() or run_root.is_symlink():
        if run_root.is_symlink():
            raise AnalysisError("Derived output path must not be a symbolic link")
        shutil.rmtree(run_root)
    run_root.mkdir(parents=True)
    total_bytes = 0
    for unit in result["units"]:
        relative = unit.get("relativePath") if isinstance(unit, dict) else None
        if not isinstance(relative, str) or not re.fullmatch(r"functions/[0-9a-f]+\.ir", relative):
            raise AnalysisError("Miasm returned an invalid artifact path")
        source = (output_root / relative).resolve(strict=True)
        source.relative_to(output_root.resolve())
        if source.is_symlink() or not source.is_file():
            raise AnalysisError("Miasm returned a non-regular output file")
        size = source.stat().st_size
        total_bytes += size
        if size <= 0 or size > MAX_UNIT_BYTES or total_bytes > MAX_OUTPUT_BYTES:
            raise AnalysisError("Miasm output exceeded its configured storage limit")
        destination = run_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        if hash_file(destination) != unit.get("outputSha256"):
            raise AnalysisError("Miasm output changed while it was being stored")
        unit["codeArtifactId"] = f"{project_id}/{artifact_id}/{task_id}/{run_id}/{relative}"
    result["outputBytes"] = total_bytes
    return result


def analyze(body: dict[str, object], connection: socket.socket) -> dict[str, object]:
    if not SLOTS.acquire(blocking=False):
        raise AnalysisError("The Miasm analyzer is busy")
    try:
        project_id = safe_id(body.get("projectId"))
        artifact_id = safe_id(body.get("artifactId"))
        task_id = safe_id(body.get("taskId"))
        run_id = safe_id(body.get("runId"))
        binary_path = resolve_input(body.get("artifactPath"))
        run_root = DERIVED_ROOT / project_id / artifact_id / task_id / run_id
        run_root.resolve().relative_to(DERIVED_ROOT)
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="reamon-miasm-") as temporary:
            temporary_root = Path(temporary)
            request_path = temporary_root / "request.json"
            request_path.write_text(json.dumps({"artifactPath": str(binary_path)}), encoding="utf-8")
            with (temporary_root / "worker.log").open("wb") as log:
                process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker", str(request_path)],
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                           cwd=temporary_root, env={**os.environ, "HOME": str(temporary_root),
                                           "PYTHONDONTWRITEBYTECODE": "1"}, start_new_session=True)
                try:
                    while process.poll() is None:
                        if client_disconnected(connection):
                            raise AnalysisError("Miasm analysis was cancelled")
                        if time.monotonic() - started >= TIMEOUT_SECONDS:
                            raise AnalysisError(f"Miasm exceeded {TIMEOUT_SECONDS} seconds")
                        try:
                            process.wait(timeout=0.25)
                        except subprocess.TimeoutExpired:
                            pass
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
            if process.returncode != 0:
                error_path = temporary_root / "error.txt"
                detail = error_path.read_text(encoding="utf-8", errors="replace")[-2000:].strip() if error_path.exists() else ""
                raise AnalysisError(detail or "Miasm analysis failed")
            result = json.loads((temporary_root / "result.json").read_text(encoding="utf-8"))
            if hash_file(binary_path).lower() != result.get("sourceSha256"):
                raise AnalysisError("Input artifact changed while Miasm was analyzing it")
            output_root = temporary_root / "output"
            return persist_run(output_root, run_root, result, project_id, artifact_id, task_id, run_id)
    finally:
        SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "REAmonMiasm/1"

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
        if self.path != "/health":
            self.send_json(404, {"error": "Not found"})
            return
        self.send_json(200, {"status": "ok", "toolVersion": VERSION, "providerRevision": REVISION})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise AnalysisError("Request size is invalid")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise AnalysisError("Request body was truncated")
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise AnalysisError("Request must be a JSON object")
            self.send_json(200, analyze(body, self.connection))
        except (AnalysisError, ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)[:2000]})
        except Exception:
            self.send_json(500, {"error": "Miasm analysis failed"})


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        raise SystemExit(worker_main(Path(sys.argv[2])))
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
