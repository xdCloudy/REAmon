#!/usr/bin/env python3
"""Bounded APK metadata adapter for the pinned Il2CppDumper release."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
PORT = int(os.environ.get("PORT", "8035"))
DUMPER_HOME = Path(os.environ.get("IL2CPP_DUMPER_HOME", "/opt/il2cpp-dumper")).resolve()
DUMPER_REVISION = "8a521b9c180cf13499253f0818cbc729dca767cb"
MAX_APK_BYTES = 1024 * 1024 * 1024
MAX_METADATA_BYTES = 256 * 1024 * 1024
MAX_LIBRARY_BYTES = 768 * 1024 * 1024
MAX_SCRIPT_JSON_BYTES = 64 * 1024 * 1024
MAX_MEMBER_COUNT = 100_000
MAX_LIBRARY_PATHS = 4
MAX_METHODS = 25_000
TIMEOUT_SECONDS = 180
SAFE_ID_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    pass


def safe_id(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 128 or value[0] not in SAFE_ID_CHARS:
        raise AnalysisError("Invalid analysis identifier")
    if any(char not in SAFE_ID_CHARS for char in value):
        raise AnalysisError("Invalid analysis identifier")
    return value


def resolve_input(value: object) -> Path:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise AnalysisError("Invalid APK path")
    try:
        candidate = Path(value).resolve(strict=True)
        candidate.relative_to(ARTIFACT_ROOT)
    except (OSError, RuntimeError, ValueError) as error:
        raise AnalysisError("APK is outside the read-only artifact volume") from error
    if not candidate.is_file():
        raise AnalysisError("APK path must be a regular file")
    size = candidate.stat().st_size
    if size < 22 or size > MAX_APK_BYTES:
        raise AnalysisError("APK size is outside the configured limit")
    return candidate


def safe_member_path(value: object, pattern: str) -> str:
    import re

    if not isinstance(value, str) or not value or len(value) > 1000 or "\0" in value or "\\" in value:
        raise AnalysisError("Invalid APK member path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts) or not re.fullmatch(pattern, value, re.IGNORECASE):
        raise AnalysisError("APK member path is not a supported IL2CPP member")
    return value


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_member(archive: zipfile.ZipFile, member_path: str, destination: Path, size_limit: int) -> tuple[int, str]:
    matches = [item for item in archive.infolist() if item.filename == member_path]
    if len(matches) != 1:
        raise AnalysisError("APK member is missing or ambiguous")
    info = matches[0]
    if info.is_dir() or info.flag_bits & 0x1 or info.file_size < 16 or info.file_size > size_limit:
        raise AnalysisError("APK member is encrypted or outside the configured size limit")
    digest = hashlib.sha256()
    copied = 0
    try:
        with archive.open(info, "r") as source, destination.open("xb") as output:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                copied += len(chunk)
                if copied > size_limit or copied > info.file_size:
                    raise AnalysisError("APK member exceeded its declared size")
                digest.update(chunk)
                output.write(chunk)
    except (OSError, RuntimeError, zipfile.BadZipFile, EOFError) as error:
        destination.unlink(missing_ok=True)
        raise AnalysisError("APK member could not be safely read") from error
    if copied != info.file_size:
        destination.unlink(missing_ok=True)
        raise AnalysisError("APK member size did not match the ZIP directory")
    return copied, digest.hexdigest()


def run_dumper(binary: Path, metadata: Path, workdir: Path) -> tuple[list[dict[str, str]], int, bool]:
    tool_dir = workdir / "tool"
    shutil.copytree(DUMPER_HOME, tool_dir, symlinks=False)
    config = {
        "DumpMethod": True,
        "DumpField": True,
        "DumpProperty": True,
        "DumpAttribute": True,
        "DumpFieldOffset": True,
        "DumpMethodOffset": True,
        "DumpTypeDefIndex": True,
        "GenerateDummyDll": False,
        "GenerateStruct": True,
        "DummyDllAddToken": False,
        "RequireAnyKey": False,
        "ForceIl2CppVersion": False,
        "ForceVersion": 16,
        "ForceDump": False,
        "NoRedirectedPointer": False,
    }
    (tool_dir / "config.json").write_text(json.dumps(config), encoding="utf-8")
    output_dir = workdir / "output"
    output_dir.mkdir()
    environment = {"PATH": "/usr/bin:/bin", "HOME": str(workdir), "DOTNET_CLI_TELEMETRY_OPTOUT": "1"}
    try:
        result = subprocess.run(
            ["dotnet", str(tool_dir / "Il2CppDumper.dll"), str(binary), str(metadata), str(output_dir)],
            cwd=workdir,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise AnalysisError("Il2CppDumper exceeded the 600 second limit") from error
    except OSError as error:
        raise AnalysisError("Il2CppDumper could not start") from error
    script_path = output_dir / "script.json"
    if result.returncode != 0 or not script_path.is_file() or script_path.is_symlink():
        raise AnalysisError("Il2CppDumper did not produce its metadata address map")
    script_size = script_path.stat().st_size
    if script_size <= 0 or script_size > MAX_SCRIPT_JSON_BYTES:
        raise AnalysisError("Il2CppDumper metadata output exceeded the configured limit")
    try:
        with script_path.open("r", encoding="utf-8") as stream:
            payload = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise AnalysisError("Il2CppDumper returned invalid script.json") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("ScriptMethod"), list):
        raise AnalysisError("Il2CppDumper script.json has no ScriptMethod list")
    raw_methods = payload["ScriptMethod"]
    methods: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in raw_methods:
        if not isinstance(item, dict):
            continue
        address = item.get("Address")
        name = item.get("Name")
        signature = item.get("Signature")
        type_signature = item.get("TypeSignature")
        if not isinstance(address, int) or isinstance(address, bool) or address < 0 or address >= 2**64:
            continue
        if not isinstance(name, str) or not name.strip() or len(name) > 1000:
            continue
        signature = signature if isinstance(signature, str) else ""
        type_signature = type_signature if isinstance(type_signature, str) else ""
        if len(signature) > 2000 or len(type_signature) > 1000:
            continue
        record = (f"0x{address:x}", name.strip(), signature)
        if record in seen:
            continue
        seen.add(record)
        methods.append({"rva": record[0], "name": record[1], "signature": signature, "typeSignature": type_signature})
        if len(methods) >= MAX_METHODS:
            break
    return methods, len(raw_methods), len(raw_methods) > len(methods)


def analyse(body: object) -> dict[str, object]:
    if not isinstance(body, dict):
        raise AnalysisError("Request must be a JSON object")
    project_id = safe_id(body.get("projectId"))
    artifact_id = safe_id(body.get("artifactId"))
    safe_id(body.get("taskId"))
    safe_id(body.get("runId"))
    input_path = resolve_input(body.get("artifactPath"))
    metadata_path = safe_member_path(body.get("metadataPath"), r"(?:[^/]+/)*global-metadata\.dat")
    library_values = body.get("libraryPaths")
    if not isinstance(library_values, list) or not library_values or len(library_values) > MAX_LIBRARY_PATHS:
        raise AnalysisError("A bounded list of IL2CPP library paths is required")
    library_paths = list(dict.fromkeys(safe_member_path(value, r"lib/[^/]+/libil2cpp\.so") for value in library_values))
    if len(library_paths) != len(library_values):
        raise AnalysisError("Duplicate IL2CPP library paths are not allowed")
    if not SLOTS.acquire(blocking=False):
        raise AnalysisError("The Il2CppDumper worker is busy")
    try:
        started = time.monotonic()
        apk_sha256 = hash_file(input_path)
        libraries: list[dict[str, object]] = []
        all_methods: list[dict[str, str]] = []
        methods_total = 0
        truncated = False
        with zipfile.ZipFile(input_path, "r") as archive:
            if len(archive.infolist()) > MAX_MEMBER_COUNT:
                raise AnalysisError("APK has too many ZIP members for bounded analysis")
            metadata_info = [item for item in archive.infolist() if item.filename == metadata_path]
            if len(metadata_info) != 1:
                raise AnalysisError("Profiled metadata member is missing or ambiguous")
            if metadata_info[0].file_size > MAX_METADATA_BYTES:
                raise AnalysisError("IL2CPP metadata exceeds the configured size limit")
            with tempfile.TemporaryDirectory(prefix=f"reamon-il2cpp-{project_id[:10]}-{artifact_id[:10]}-") as temporary:
                root = Path(temporary)
                metadata_file = root / "global-metadata.dat"
                metadata_size, metadata_sha256 = extract_member(archive, metadata_path, metadata_file, MAX_METADATA_BYTES)
                methods_remaining = MAX_METHODS
                for index, member_path in enumerate(library_paths):
                    binary_file = root / f"libil2cpp-{index}.so"
                    library_size, library_sha256 = extract_member(archive, member_path, binary_file, MAX_LIBRARY_BYTES)
                    run_dir = root / f"run-{index}"
                    run_dir.mkdir()
                    methods, discovered, was_truncated = run_dumper(binary_file, metadata_file, run_dir)
                    available_here = len(methods)
                    methods = methods[:methods_remaining]
                    methods_remaining -= len(methods)
                    methods_total += discovered
                    truncated = truncated or was_truncated or available_here > len(methods)
                    libraries.append({
                        "memberPath": member_path,
                        "sha256": library_sha256,
                        "sizeBytes": library_size,
                        "methodCount": discovered,
                    })
                    all_methods.extend({
                        **method,
                        "libraryPath": member_path,
                        "librarySha256": library_sha256,
                    } for method in methods)
                    if methods_remaining <= 0:
                        truncated = truncated or index < len(library_paths) - 1
                        break
        if not libraries:
            raise AnalysisError("No IL2CPP native libraries were analyzed")
        return {
            "status": "completed",
            "providerRevision": DUMPER_REVISION,
            "apkSha256": apk_sha256,
            "metadata": {"memberPath": metadata_path, "sha256": metadata_sha256, "sizeBytes": metadata_size},
            "libraries": libraries,
            "methods": all_methods,
            "methodCount": methods_total,
            "returnedMethodCount": len(all_methods),
            "truncated": truncated,
            "elapsedMs": max(0, int((time.monotonic() - started) * 1000)),
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
        self.send_json(200, {"status": "ok", "providerRevision": DUMPER_REVISION})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 64 * 1024:
                raise AnalysisError("Request size is outside the configured limit")
            body = json.loads(self.rfile.read(length))
            result = analyse(body)
            methods = result.pop("methods")
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            header = {key: value for key, value in result.items()}
            self.wfile.write(json.dumps({"type": "result_start", "data": header, "arrayFields": ["methods"]}, separators=(",", ":")).encode("utf-8") + b"\n")
            for start in range(0, len(methods), 100):
                self.wfile.write(json.dumps({"type": "result_chunk", "field": "methods", "items": methods[start:start + 100]}, separators=(",", ":")).encode("utf-8") + b"\n")
            self.wfile.write(b'{"type":"result_end"}\n')
            self.wfile.flush()
        except AnalysisError as error:
            self.send_json(400, {"status": "failed", "error": str(error)[:1200]})
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"status": "failed", "error": "Invalid JSON request"})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            self.send_json(500, {"status": "failed", "error": f"Il2CppDumper analysis failed: {type(error).__name__}"})

    def log_message(self, format_string: str, *args: object) -> None:
        print("il2cpp-analyzer: " + format_string % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
