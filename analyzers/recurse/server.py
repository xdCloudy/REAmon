#!/usr/bin/env python3
"""Isolated, bounded adapter for Recurse's pinned stdio MCP analyzer."""
from __future__ import annotations

import hashlib
import json
import os
import re
import selectors
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8026"))
RECURSE = os.environ.get("RECURSE_MCP", "/usr/local/bin/recurse-mcp")
PROVIDER_REVISION = os.environ.get("RECURSE_PROVIDER_REVISION", "")
RECURSE_VERSION = os.environ.get("RECURSE_VERSION", "unknown")
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("RECURSE_TIMEOUT_SECONDS", "900"))))
MAX_BINARY_BYTES = min(2 * 1024 * 1024 * 1024, max(1024 * 1024, int(os.environ.get("RECURSE_MAX_BINARY_BYTES", str(512 * 1024 * 1024)))))
MAX_FUNCTIONS = min(200, max(1, int(os.environ.get("RECURSE_MAX_FUNCTIONS", "100"))))
MAX_LIFT_BYTES = min(256 * 1024, max(1024, int(os.environ.get("RECURSE_MAX_LIFT_BYTES", str(128 * 1024)))))
MAX_TOTAL_BYTES = min(64 * 1024 * 1024, max(MAX_LIFT_BYTES, int(os.environ.get("RECURSE_MAX_OUTPUT_BYTES", str(32 * 1024 * 1024)))))
MAX_REQUEST_BYTES = 64 * 1024
MAX_PROTOCOL_LINE_BYTES = MAX_LIFT_BYTES + 2 * 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
ADDRESS = re.compile(r"^(?:0x)?[0-9a-f]{1,16}$", re.IGNORECASE)
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    pass


class AnalyzerBusy(AnalysisError):
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
    if not path.is_file():
        raise AnalysisError("Input is not a regular artifact file")
    if path.stat().st_size <= 0 or path.stat().st_size > MAX_BINARY_BYTES:
        raise AnalysisError("Input binary is empty or exceeds the configured size limit")
    return path


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


class McpClient:
    def __init__(self, binary: Path, *, cancel_check: Callable[[], bool], deadline: float):
        self.process = subprocess.Popen(
            [RECURSE, str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd="/tmp", env={**os.environ, "HOME": "/tmp", "PYTHONNOUSERSITE": "1"}, start_new_session=True,
        )
        self.cancel_check = cancel_check
        self.deadline = deadline
        self.next_id = 0
        self.buffer = bytearray()
        assert self.process.stdin is not None and self.process.stdout is not None
        os.set_blocking(self.process.stdout.fileno(), False)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def close(self) -> None:
        self.selector.close()
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait()
        if self.process.stdin:
            self.process.stdin.close()
        if self.process.stdout:
            self.process.stdout.close()

    def request(self, method: str, params: dict[str, object], timeout: float = 30) -> dict[str, object]:
        self.next_id += 1
        request_id = self.next_id
        assert self.process.stdin is not None
        try:
            self.process.stdin.write((json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}, separators=(",", ":")) + "\n").encode())
            self.process.stdin.flush()
        except OSError as error:
            raise AnalysisError("Recurse MCP stopped accepting requests") from error

        call_deadline = min(self.deadline, time.monotonic() + timeout)
        while True:
            newline = self.buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self.buffer[:newline])
                del self.buffer[:newline + 1]
                try:
                    message = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise AnalysisError("Recurse MCP returned invalid JSON-RPC") from error
                if not isinstance(message, dict):
                    raise AnalysisError("Recurse MCP returned an invalid response")
                if message.get("id") != request_id:
                    continue
                if isinstance(message.get("error"), dict):
                    detail = message["error"].get("message")
                    raise AnalysisError(str(detail or "Recurse MCP request failed")[:1200])
                result = message.get("result")
                if not isinstance(result, dict):
                    raise AnalysisError("Recurse MCP response did not contain a result")
                return result
            if self.cancel_check():
                raise AnalysisError("Recurse analysis was cancelled")
            if time.monotonic() >= call_deadline:
                raise AnalysisError("Recurse MCP request exceeded its time limit")
            if self.process.poll() is not None:
                raise AnalysisError("Recurse MCP exited before returning a response")
            events = self.selector.select(timeout=min(0.25, max(0.0, call_deadline - time.monotonic())))
            if not events:
                continue
            try:
                chunk = os.read(self.process.stdout.fileno(), 64 * 1024)
            except BlockingIOError:
                continue
            if not chunk:
                raise AnalysisError("Recurse MCP closed its response stream")
            self.buffer.extend(chunk)
            if len(self.buffer) > MAX_PROTOCOL_LINE_BYTES and b"\n" not in self.buffer:
                raise AnalysisError("Recurse MCP response exceeded the configured size limit")

    def notify(self, method: str, params: dict[str, object]) -> None:
        assert self.process.stdin is not None
        try:
            self.process.stdin.write((json.dumps({"jsonrpc": "2.0", "method": method, "params": params}, separators=(",", ":")) + "\n").encode())
            self.process.stdin.flush()
        except OSError as error:
            raise AnalysisError("Recurse MCP stopped accepting notifications") from error

    def analyze(self, arguments: dict[str, object], timeout: float = 30) -> dict[str, object]:
        result = self.request("tools/call", {"name": "analyze", "arguments": arguments}, timeout)
        if result.get("isError") is True:
            content = result.get("content")
            text = content[0].get("text") if isinstance(content, list) and content and isinstance(content[0], dict) else None
            raise AnalysisError(str(text or "Recurse analysis operation failed")[:1200])
        content = result.get("content")
        text = content[0].get("text") if isinstance(content, list) and content and isinstance(content[0], dict) else None
        if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_PROTOCOL_LINE_BYTES:
            raise AnalysisError("Recurse MCP tool output was missing or exceeded its size limit")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as error:
            raise AnalysisError("Recurse MCP tool output was not JSON") from error
        if not isinstance(payload, dict):
            raise AnalysisError("Recurse MCP tool output was not an object")
        return payload


def parse_tool_payload(result: dict[str, object]) -> dict[str, object]:
    client = result["client"]
    assert isinstance(client, McpClient)
    initialized = client.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "reamon", "version": "1"}})
    if initialized.get("protocolVersion") != "2024-11-05":
        raise AnalysisError("Recurse MCP negotiated an unsupported protocol version")
    client.notify("notifications/initialized", {})
    tools = client.request("tools/list", {}).get("tools")
    if not isinstance(tools, list) or not any(isinstance(tool, dict) and tool.get("name") == "analyze" for tool in tools):
        raise AnalysisError("Recurse MCP did not expose its analyze tool")
    functions = client.analyze({"op": "functions", "limit": MAX_FUNCTIONS})
    items = functions.get("items")
    if not isinstance(items, list):
        raise AnalysisError("Recurse function inventory did not include an items list")
    return {"functions": functions, "items": items}


def analyze(body: dict[str, object], cancel_check: Callable[[], bool] = lambda: False) -> dict[str, object]:
    if not SLOTS.acquire(blocking=False):
        raise AnalyzerBusy("The Recurse analyzer is busy")
    client: McpClient | None = None
    try:
        project_id = safe_id(body.get("projectId"))
        artifact_id = safe_id(body.get("artifactId"))
        task_id = safe_id(body.get("taskId"))
        run_id = safe_id(body.get("runId"))
        binary = resolve_input(body.get("artifactPath"))
        run_root = (DERIVED_ROOT / project_id / artifact_id / task_id / run_id).resolve()
        try:
            run_root.relative_to(DERIVED_ROOT)
        except ValueError as error:
            raise AnalysisError("Derived output path is invalid") from error
        if run_root.exists():
            shutil.rmtree(run_root)
        (run_root / "lift").mkdir(parents=True)
        input_sha256 = hash_file(binary)
        deadline = time.monotonic() + TIMEOUT_SECONDS
        client = McpClient(binary, cancel_check=cancel_check, deadline=deadline)
        inventory = parse_tool_payload({"client": client})
        functions = inventory["functions"]
        assert isinstance(functions, dict)
        function_items = inventory["items"]
        assert isinstance(function_items, list)
        units: list[dict[str, object]] = []
        warnings: list[str] = []
        total_bytes = 0
        failures = 0
        seen_addresses: set[str] = set()

        for function in function_items[:MAX_FUNCTIONS]:
            if cancel_check():
                raise AnalysisError("Recurse analysis was cancelled")
            if time.monotonic() >= deadline:
                raise AnalysisError("Recurse analysis exceeded its configured time limit")
            if not isinstance(function, dict):
                failures += 1
                continue
            raw_address = function.get("addr")
            if isinstance(raw_address, bool):
                failures += 1
                continue
            if isinstance(raw_address, int) and 0 <= raw_address < 1 << 64:
                address = raw_address
            elif isinstance(raw_address, str) and ADDRESS.fullmatch(raw_address.strip()):
                address = int(raw_address.strip().removeprefix("0x").removeprefix("0X"), 16)
            else:
                failures += 1
                continue
            address_hex = f"0x{address:x}"
            if address_hex in seen_addresses:
                continue
            seen_addresses.add(address_hex)
            name = str(function.get("name") or address_hex).strip()[:500]
            function_size = function.get("size")
            function_size = function_size if isinstance(function_size, int) and not isinstance(function_size, bool) and 0 <= function_size <= MAX_BINARY_BYTES else 0
            try:
                lifted = client.analyze({"op": "lift", "addr": address_hex}, timeout=45)
                vtil = lifted.get("vtil")
                if not isinstance(vtil, str) or not vtil.strip():
                    raise AnalysisError("Lift result had no intermediate representation")
                encoded = vtil.encode("utf-8")
                if len(encoded) > MAX_LIFT_BYTES:
                    failures += 1
                    warnings.append(f"{address_hex}: Recurse output exceeded the per-function limit")
                    continue
                if total_bytes + len(encoded) > MAX_TOTAL_BYTES:
                    warnings.append("Run output limit reached; remaining functions were omitted")
                    break
                relative_path = f"lift/{address:x}.vtil"
                output_path = (run_root / relative_path).resolve()
                output_path.relative_to(run_root)
                output_path.write_bytes(encoded)
                output_sha256 = hashlib.sha256(encoded).hexdigest()
                optimized = lifted.get("optimized")
                passes = {}
                if isinstance(optimized, dict):
                    for key in ("rounds", "propagated", "folded", "simplified", "dead_stores_removed", "branches_resolved"):
                        value = optimized.get(key)
                        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 1_000_000:
                            passes[key] = value
                units.append({
                    "name": name,
                    "address": address_hex,
                    "functionSizeBytes": function_size,
                    "instructionCount": int(lifted.get("instructions", 0)) if isinstance(lifted.get("instructions"), int) else 0,
                    "relativePath": relative_path,
                    "codeArtifactId": f"{project_id}/{artifact_id}/{task_id}/{run_id}/{relative_path}",
                    "sizeBytes": len(encoded),
                    "outputSha256": output_sha256,
                    "optimized": passes,
                })
                total_bytes += len(encoded)
            except AnalysisError as error:
                failures += 1
                if len(warnings) < 100:
                    warnings.append(f"{address_hex}: {str(error)[:240]}")

        if not units:
            raise AnalysisError("Recurse returned no bounded lift evidence for the discovered functions")
        return {
            "status": "completed",
            "toolVersion": RECURSE_VERSION,
            "providerRevision": PROVIDER_REVISION,
            "sourceSha256": input_sha256,
            "functionCount": int(functions.get("count", len(function_items))) if isinstance(functions.get("count"), int) else len(function_items),
            "returnedUnits": len(units),
            "failedFunctionCount": failures,
            "truncated": len(function_items) > len(units) or len(function_items) >= MAX_FUNCTIONS,
            "outputBytes": total_bytes,
            "units": units,
            "warnings": "\n".join(warnings)[:12_000],
        }
    finally:
        if client:
            client.close()
        SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "REAmonRecurse/1"

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
        if self.path == "/health":
            self.send_json(200, {"status": "ok", "provider": "Recurse", "version": RECURSE_VERSION, "revision": PROVIDER_REVISION})
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid request size"})
            return
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "Request body is empty or too large"})
            return
        try:
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise AnalysisError("Request body must be a JSON object")
            self.send_json(200, analyze(body, lambda: client_disconnected(self.connection)))
        except AnalyzerBusy as error:
            self.send_json(429, {"error": str(error)})
        except (AnalysisError, OSError, ValueError, TypeError) as error:
            self.send_json(400, {"error": str(error)[:2000]})
        except Exception as error:
            self.send_json(500, {"error": f"Recurse analysis failed: {type(error).__name__}"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
