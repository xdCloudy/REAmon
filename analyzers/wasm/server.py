"""Isolated WebAssembly-to-WAT analyzer used by REAmon."""
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


ARTIFACT_ROOT = Path(os.getenv("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.getenv("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.getenv("PORT", "8012"))
MAX_MODULE_BYTES = 256 * 1024 * 1024
MAX_WAT_BYTES = 128 * 1024 * 1024
MAX_RETURNED_FUNCTIONS = 2_000
MAX_RETURNED_CALLS = 400
MAX_RESULT_CHUNK_BYTES = 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
SLOT = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    """Expected, user-correctable analyzer failure."""


def _event_bytes(event: dict) -> bytes:
    return (json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def stream_result_events(result: dict):
    """Stream bounded result chunks so a large function map is never one event."""
    arrays = {key: value for key, value in result.items() if isinstance(value, list)}
    single = {"type": "result", "data": result}
    if sum(len(value) for value in arrays.values()) <= 100 and len(_event_bytes(single)) <= MAX_RESULT_CHUNK_BYTES:
        yield single
        return

    metadata = {key: value for key, value in result.items() if not isinstance(value, list)}
    start = {"type": "result_start", "data": metadata, "arrayFields": list(arrays)}
    if len(_event_bytes(start)) > MAX_RESULT_CHUNK_BYTES:
        raise AnalysisError("WebAssembly result metadata exceeded the streaming limit")
    yield start
    for field, values in arrays.items():
        chunk: list[dict] = []
        for item in values:
            candidate = {"type": "result_chunk", "field": field, "items": [*chunk, item]}
            if chunk and (len(chunk) >= 100 or len(_event_bytes(candidate)) > MAX_RESULT_CHUNK_BYTES):
                yield {"type": "result_chunk", "field": field, "items": chunk}
                chunk = []
                candidate = {"type": "result_chunk", "field": field, "items": [item]}
            if len(_event_bytes(candidate)) > MAX_RESULT_CHUNK_BYTES:
                raise AnalysisError("A WebAssembly result item exceeded the streaming limit")
            chunk.append(item)
        if chunk:
            yield {"type": "result_chunk", "field": field, "items": chunk}
    yield {"type": "result_end"}


def safe_id(value: object) -> str:
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise AnalysisError("Invalid analysis identifier")
    return value


def resolve_input(value: object) -> Path:
    if not isinstance(value, str) or not value or len(value) > 4_096:
        raise AnalysisError("Invalid artifact path")
    try:
        candidate = Path(value).resolve(strict=True)
        candidate.relative_to(ARTIFACT_ROOT)
    except (OSError, RuntimeError, ValueError) as error:
        raise AnalysisError("Artifact must be in imported read-only storage") from error
    if not candidate.is_file():
        raise AnalysisError("Artifact input is not a regular file")
    return candidate


def module_items(wat: str) -> list[str]:
    """Read top-level module expressions while skipping WAT comments and strings."""
    found: list[str] = []
    depth = 0
    start: int | None = None
    index = 0
    in_string = False
    escaped = False
    line_comment = False
    block_depth = 0

    while index < len(wat):
        current = wat[index]
        next_char = wat[index + 1] if index + 1 < len(wat) else ""
        if line_comment:
            if current == "\n":
                line_comment = False
            index += 1
            continue
        if block_depth:
            if current == "(" and next_char == ";":
                block_depth += 1
                index += 2
                continue
            if current == ";" and next_char == ")":
                block_depth -= 1
                index += 2
                continue
            index += 1
            continue
        if in_string:
            if escaped:
                escaped = False
            elif current == "\\":
                escaped = True
            elif current == '"':
                in_string = False
            index += 1
            continue
        if current == ";" and next_char == ";":
            line_comment = True
            index += 2
            continue
        if current == "(" and next_char == ";":
            block_depth = 1
            index += 2
            continue
        if current == '"':
            in_string = True
            index += 1
            continue
        if current == "(":
            if depth == 1 and start is None:
                start = index
            depth += 1
        elif current == ")":
            depth -= 1
            if depth == 1 and start is not None:
                declaration = wat[start:index + 1]
                found.append(declaration)
                start = None
        index += 1
    return found


def funcs(wat: str) -> list[str]:
    """Find defined top-level functions, excluding imported function declarations."""
    return [item for item in module_items(wat) if re.match(r"\(func(?:\s|\$|\))", item) and "(import" not in item]


WAT_INSTRUCTION = re.compile(
    r"^\s*((?:[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_.]*|"
    r"br|br_if|br_table|call|call_indirect|call_ref|return|return_call|"
    r"drop|select|nop|unreachable|block|loop|if|else|end))\b"
)


def instruction_mnemonics(function: str, limit: int = 800) -> list[str]:
    """Collect a bounded, operand-free instruction sequence from flat WAT."""
    mnemonics = []
    for line in function.splitlines():
        match = WAT_INSTRUCTION.match(line)
        if match:
            mnemonics.append(match.group(1).lower())
            if len(mnemonics) >= limit:
                break
    return mnemonics


def function_imports(wat: str) -> list[str]:
    """Find imported function names in module index order."""
    imported: list[str] = []
    for item in module_items(wat):
        if not item.startswith("(import"):
            continue
        match = re.search(r"\(func(?:\s+(\$[^\s()]+))?", item)
        if match:
            imported.append(match.group(1) or f"import_{len(imported)}")
    return imported


def direct_calls(function: str) -> list[int]:
    """Return numeric direct-call targets, ignoring WAT comments and strings."""
    visible: list[str] = []
    index = 0
    in_string = False
    escaped = False
    line_comment = False
    block_depth = 0
    while index < len(function):
        current = function[index]
        next_char = function[index + 1] if index + 1 < len(function) else ""
        if line_comment:
            if current == "\n":
                line_comment = False
                visible.append("\n")
            index += 1
            continue
        if block_depth:
            if current == "(" and next_char == ";":
                block_depth += 1
                index += 2
                continue
            if current == ";" and next_char == ")":
                block_depth -= 1
                index += 2
                continue
            index += 1
            continue
        if in_string:
            if escaped:
                escaped = False
            elif current == "\\":
                escaped = True
            elif current == '"':
                in_string = False
            visible.append(" ")
            index += 1
            continue
        if current == ";" and next_char == ";":
            line_comment = True
            index += 2
            continue
        if current == "(" and next_char == ";":
            block_depth = 1
            index += 2
            continue
        if current == '"':
            in_string = True
            visible.append(" ")
        else:
            visible.append(current)
        index += 1
    return [int(match.group(1)) for match in re.finditer(r"\bcall\s+(\d+)\b", "".join(visible))]


def _terminate(process: subprocess.Popen) -> None:
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


def go(body: object, report_progress=lambda _message: None, cancel_check=lambda: False) -> dict:
    if not isinstance(body, dict):
        raise AnalysisError("Invalid request")
    project_id, artifact_id, task_id, run_id = [
        safe_id(body.get(key)) for key in ("projectId", "artifactId", "taskId", "runId")
    ]
    artifact = resolve_input(body.get("artifactPath"))
    if artifact.stat().st_size > MAX_MODULE_BYTES:
        raise AnalysisError("WebAssembly module exceeds the 256 MiB input limit")
    with artifact.open("rb") as stream:
        if stream.read(8) != b"\0asm\1\0\0\0":
            raise AnalysisError("Unsupported WebAssembly module version")

    run_root = (DERIVED_ROOT / project_id / artifact_id / task_id / run_id).resolve()
    try:
        run_root.relative_to(DERIVED_ROOT)
    except ValueError as error:
        raise AnalysisError("Derived output path is invalid") from error

    report_progress("Validated WebAssembly module; waiting for an analyzer slot")
    with SLOT, tempfile.TemporaryDirectory(prefix="reamon-wabt-") as temporary:
        if cancel_check():
            raise AnalysisError("WebAssembly analysis was cancelled")
        if run_root.exists():
            shutil.rmtree(run_root)
        temporary_path = Path(temporary)
        output = temporary_path / "module.wat"
        error_log = temporary_path / "wabt.stderr"
        report_progress("Converting the module to WebAssembly Text with WABT")
        deadline = time.monotonic() + 180
        with error_log.open("wb") as log:
            try:
                process = subprocess.Popen(
                    ["/opt/wabt/bin/wasm2wat", "--no-debug-names", str(artifact), "-o", str(output)],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=log,
                    start_new_session=True,
                    env={"PATH": "/usr/bin:/bin", "HOME": "/tmp"},
                )
            except OSError as error:
                raise AnalysisError("WABT could not be started") from error
            try:
                while process.poll() is None:
                    if cancel_check():
                        raise AnalysisError("WebAssembly analysis was cancelled")
                    if time.monotonic() >= deadline:
                        raise AnalysisError("Wasm disassembly timed out")
                    try:
                        process.wait(timeout=0.25)
                    except subprocess.TimeoutExpired:
                        pass
            except BaseException:
                _terminate(process)
                raise

        detail = error_log.read_bytes()[-3_000:].decode(errors="replace").strip()
        if process.returncode or not output.is_file():
            raise AnalysisError(detail or "WABT could not disassemble the WebAssembly module")
        output_size = output.stat().st_size
        if output_size > MAX_WAT_BYTES:
            raise AnalysisError("WAT output exceeded the 128 MiB storage limit")
        text = output.read_text(errors="replace")
        all_functions = funcs(text)
        imported_functions = function_imports(text)
        selected_functions = all_functions[:MAX_RETURNED_FUNCTIONS]
        report_progress(f"WABT found {len(all_functions):,} functions; indexing {len(selected_functions):,}")

        module_path = run_root / "module" / "module.wat"
        module_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(output, module_path)
        units = []
        stride = max(1, len(selected_functions) // 25)
        function_names = [*imported_functions, *[
            (match.group(1) if (match := re.match(r"\(func\s+(\$[^\s()]+)", function)) else f"function_{index}")
            for index, function in enumerate(all_functions)
        ]]
        calls: list[dict] = []
        for index, function in enumerate(selected_functions):
            number = index + 1
            if number == 1 or number % stride == 0 or number == len(selected_functions):
                report_progress(f"Indexing WebAssembly function {number:,} of {len(selected_functions):,}")
            relative_path = f"functions/f{index:05d}.wat"
            destination = run_root / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(function + "\n", encoding="utf-8")
            name_match = re.match(r"\(func\s+(\$[^\s()]+)", function)
            name = name_match.group(1) if name_match else f"function_{index}"
            function_index = len(imported_functions) + index
            units.append({
                "name": name,
                "address": str(function_index),
                "relativePath": relative_path,
                "codeArtifactId": destination.relative_to(DERIVED_ROOT).as_posix(),
                "sizeBytes": len(function.encode("utf-8")),
                "instructionMnemonics": instruction_mnemonics(function),
            })
            for target_index in direct_calls(function):
                if target_index >= len(function_names):
                    continue
                if len(calls) >= MAX_RETURNED_CALLS:
                    continue
                calls.append({
                    "fromAddress": str(function_index),
                    "toAddress": str(target_index),
                    "fromName": name,
                    "toName": function_names[target_index],
                })

        truncated = len(selected_functions) < len(all_functions)
        warnings = f"Indexed {len(selected_functions)} of {len(all_functions)} functions due to the result limit." if truncated else ""
        call_graph_truncated = sum(len(direct_calls(function)) for function in selected_functions) > len(calls)
        if call_graph_truncated:
            warnings = f"{warnings} Direct call edges were limited to {MAX_RETURNED_CALLS}.".strip()
        if detail:
            warnings = f"{warnings} {detail}".strip()
        return {
            "status": "completed",
            "toolVersion": "1.0.42",
            "functionCount": len(all_functions),
            "returnedUnits": len(units),
            "codeBytes": output_size,
            "truncated": truncated,
            "moduleCodeArtifactId": module_path.relative_to(DERIVED_ROOT).as_posix(),
            "units": units,
            "calls": calls,
            "callCount": len(calls),
            "callGraphTruncated": call_graph_truncated,
            "warnings": warnings,
        }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_event(self, event: dict) -> None:
        self.wfile.write(_event_bytes(event))
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
        self.send_json(200, {"status": "ready", "provider": "wabt", "version": "1.0.42"})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self.send_json(404, {"error": "Not found"})
            return
        streaming = False
        headers_sent = False
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 16_384:
                raise AnalysisError("Invalid request length")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise AnalysisError("Invalid request")

            streaming = "application/x-ndjson" in self.headers.get("Accept", "")
            if not streaming:
                self.send_json(200, go(body))
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            headers_sent = True
            try:
                result = go(
                    body,
                    report_progress=lambda message: self.send_event({"type": "progress", "message": str(message)[:500]}),
                    cancel_check=self.client_disconnected,
                )
                for event in stream_result_events(result):
                    self.send_event(event)
            except AnalysisError as error:
                self.send_event({"type": "error", "error": str(error)[:1_000]})
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
        except AnalysisError as error:
            self.send_json(422, {"error": str(error)[:1_000]})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.log_error("Unexpected WebAssembly analysis failure")
            if headers_sent:
                try:
                    self.send_event({"type": "error", "error": "WebAssembly analysis failed unexpectedly"})
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                self.send_json(500, {"error": "WebAssembly analysis failed unexpectedly"})

    def log_message(self, format_string: str, *args) -> None:
        print("wasm-analyzer: " + format_string % args, flush=True)

    def log_error(self, message: str) -> None:
        print(f"wasm-analyzer: {message}", flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
