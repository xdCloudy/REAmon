#!/usr/bin/env python3
"""Secret-free JADX adapter isolated from REAmon's database and network."""
from __future__ import annotations
import json, os, re, select, shutil, signal, socket, subprocess, tempfile, threading, time, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8010"))
TIMEOUT_SECONDS = min(1200, max(60, int(os.environ.get("JADX_TIMEOUT_SECONDS", "900"))))
MAX_OUTPUT_BYTES = min(1024**3, max(1024**2, int(os.environ.get("JADX_MAX_OUTPUT_BYTES", str(512 * 1024**2)))))
MAX_SOURCE_FILES = min(50000, max(1, int(os.environ.get("JADX_MAX_SOURCE_FILES", "20000"))))
MAX_RETURNED_UNITS = min(20000, max(1, int(os.environ.get("JADX_MAX_RETURNED_UNITS", "20000"))))
MAX_VIEWABLE_BYTES = 2 * 1024 * 1024
STREAM_RESULT_CHUNK_SIZE = 100
MAX_CLASS_REFERENCES = 100
MAX_CLASS_REFERENCE_BYTES = 3500
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
PACKAGE_PATTERN = re.compile(r"^\s*package\s+([A-Za-z0-9_.$]+)\s*;", re.MULTILINE)
TYPE_PATTERN = re.compile(r"\b(?:class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)")
SMALI_CLASS_DESCRIPTOR = re.compile(r"L([A-Za-z0-9_$/]+);")
SLOTS = threading.BoundedSemaphore(2)

class AnalysisError(Exception):
    pass

def stream_result_events(result):
    arrays = {key: value for key, value in result.items() if isinstance(value, list)}
    if sum(len(value) for value in arrays.values()) <= STREAM_RESULT_CHUNK_SIZE:
        yield {"type": "result", "data": result}
        return
    metadata = {key: value for key, value in result.items() if not isinstance(value, list)}
    yield {"type": "result_start", "data": metadata, "arrayFields": list(arrays)}
    for field, values in arrays.items():
        for start in range(0, len(values), STREAM_RESULT_CHUNK_SIZE):
            yield {"type": "result_chunk", "field": field, "items": values[start:start + STREAM_RESULT_CHUNK_SIZE]}
    yield {"type": "result_end"}

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
    found, total, truncated = [], 0, False
    for directory, dirs, filenames in os.walk(root, followlinks=False):
        dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
        for filename in sorted(filenames):
            path = Path(directory) / filename
            if path.is_symlink() or path.suffix.lower() != ".java":
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            total += size
            if size > MAX_OUTPUT_BYTES or total > MAX_OUTPUT_BYTES:
                raise AnalysisError("JADX source output exceeded the configured storage limit")
            found.append(path)
            if len(found) > MAX_SOURCE_FILES:
                found.pop()
                truncated = True
                return found, total, truncated
    return found, total, truncated

def smali_files(root, existing_bytes=0):
    found, total, truncated, oversized = [], 0, False, 0
    for directory, dirs, filenames in os.walk(root, followlinks=False):
        dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
        for filename in sorted(filenames):
            path = Path(directory) / filename
            if path.is_symlink() or path.suffix.lower() != ".smali":
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            total += size
            if size > MAX_OUTPUT_BYTES or existing_bytes + total > MAX_OUTPUT_BYTES:
                raise AnalysisError("JADX source and DEX disassembly exceeded the configured storage limit")
            if size > MAX_VIEWABLE_BYTES:
                oversized += 1
                truncated = True
                continue
            found.append(path)
            if len(found) > MAX_SOURCE_FILES:
                found.pop()
                truncated = True
                return found, total, truncated, oversized
    return found, total, truncated, oversized

def class_references(smali_text, current_path, known_paths):
    """Return bounded references to classes included in this DEX analysis."""
    current = current_path.with_suffix("").as_posix()
    references = set()
    for match in SMALI_CLASS_DESCRIPTOR.finditer(smali_text):
        path = match.group(1)
        if path == current or path not in known_paths:
            continue
        references.add(path.replace("/", "."))
    bounded, size = [], 2
    for reference in sorted(references, key=str.casefold):
        encoded_size = len(json.dumps(reference, ensure_ascii=False).encode("utf-8")) + (1 if bounded else 0)
        if len(bounded) >= MAX_CLASS_REFERENCES or size + encoded_size > MAX_CLASS_REFERENCE_BYTES:
            break
        bounded.append(reference)
        size += encoded_size
    return bounded


def dex_inputs(path):
    try:
        with path.open("rb") as artifact:
            magic = artifact.read(4)
    except OSError:
        return []
    if magic.startswith(b"dex\n") or path.suffix.lower() == ".dex":
        return [str(path)]
    try:
        with zipfile.ZipFile(path) as archive:
            entries = sorted({name for name in archive.namelist()
                       if "/" not in name and re.fullmatch(r"classes(?:(?:[2-9]|[1-9][0-9]+))?\.dex", name)})
    except (OSError, zipfile.BadZipFile):
        return []
    return [f"{path}/{entry}" for entry in sorted(entries, key=lambda name: (name != "classes.dex", len(name), name))]


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

def run_analysis_tool(arguments, stderr_file, cancel_check, tool_name, deadline=None):
    if deadline is None:
        deadline = time.monotonic() + TIMEOUT_SECONDS
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=stderr_file, start_new_session=True,
                               env={**os.environ, "JAVA_TOOL_OPTIONS": os.environ.get("JADX_JAVA_TOOL_OPTIONS", "-Xmx1536m")})
    try:
        while process.poll() is None:
            if cancel_check():
                raise AnalysisError(f"{tool_name} analysis was cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AnalysisError(f"Android analysis exceeded {TIMEOUT_SECONDS} seconds")
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
    analysis_deadline = time.monotonic() + TIMEOUT_SECONDS
    report_progress("Waiting for a JADX analyzer slot")
    with SLOTS:
        try:
            with tempfile.TemporaryDirectory(prefix="reamon-jadx-") as temporary:
                output, stderr_path = Path(temporary) / "out", Path(temporary) / "jadx.stderr"
                with stderr_path.open("wb") as stderr_file:
                    try:
                        report_progress("Decompiling Android bytecode with JADX")
                        return_code = run_analysis_tool([
                            str(Path(os.environ.get("JADX_HOME", "/opt/jadx")) / "bin" / "jadx"),
                            "--no-res", "--output-format", "java", "--threads-count", "2",
                            "--log-level", "ERROR", "-d", str(output), str(input_path)
                        ], stderr_file, cancel_check, "JADX", analysis_deadline)
                    except OSError as error:
                        raise AnalysisError("JADX could not be started") from error
                    stderr_file.flush()
                jadx_return_code = return_code
                log_text = stderr_path.read_bytes()[-4096:].decode("utf-8", errors="replace").strip()
                raw_sources, total_source_bytes, source_scan_truncated = source_files(output) if output.exists() else ([], 0, False)
                if not raw_sources:
                    raise AnalysisError(log_text or "JADX produced no Java source files")
                report_progress(f"JADX finished; indexing {len(raw_sources)} Java source files")
                sources_root = run_root / "sources"
                sources_root.mkdir(parents=True, exist_ok=True)
                units, total_files = [], len(raw_sources)
                progress_stride = max(1, total_files // 25)
                for source_index, source in enumerate(raw_sources, start=1):
                    if source_index == 1 or source_index % progress_stride == 0 or source_index == total_files:
                        report_progress(f"Indexing Java source {source_index} of {total_files}")
                    relative = source.relative_to(output)
                    if relative.is_absolute() or ".." in relative.parts:
                        continue
                    if relative.parts and relative.parts[0].lower() == "sources":
                        relative = Path(*relative.parts[1:])
                    raw = source.read_bytes()
                    if not raw:
                        continue
                    text = raw.decode("utf-8", errors="replace")
                    package, type_match = PACKAGE_PATTERN.search(text), TYPE_PATTERN.search(text)
                    fallback = relative.stem
                    name = f"{package.group(1)}.{type_match.group(1)}" if package and type_match else (f"{package.group(1)}.{fallback}" if package else fallback)
                    destination = sources_root / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(raw)
                    units.append({"name": name[:500], "relativePath": relative.as_posix()[:1000],
                                  "codeArtifactId": destination.relative_to(DERIVED_ROOT).as_posix(), "sizeBytes": len(raw),
                                  "unitType": "class", "language": "Java"})
                units.sort(key=lambda unit: str(unit["relativePath"]).casefold())
                warnings = []
                dex_file_paths = dex_inputs(input_path)
                smali_total_bytes = 0
                disassembled_class_count = 0
                if dex_file_paths:
                    report_progress(f"Disassembling {len(dex_file_paths)} DEX file(s) with Baksmali")
                    disassembly_output = Path(temporary) / "smali"
                    disassembly_success = False
                    for dex_index, dex_path in enumerate(dex_file_paths, start=1):
                        report_progress(f"Disassembling DEX file {dex_index} of {len(dex_file_paths)}")
                        disassembly_stderr = Path(temporary) / "baksmali.stderr"
                        with disassembly_stderr.open("wb") as stderr_file:
                            try:
                                disassembly_code = run_analysis_tool([
                                    "java", "-jar", os.environ.get("BAKSMALI_JAR", "/opt/baksmali/baksmali.jar"),
                                    "disassemble", "--use-locals", "--code-offsets", "--jobs", "2",
                                    dex_path, "-o", str(disassembly_output),
                                ], stderr_file, cancel_check, "Baksmali", analysis_deadline)
                            except AnalysisError as error:
                                if any(word in str(error).lower() for word in ("cancelled", "exceeded")):
                                    raise
                                warnings.append(f"DEX disassembly was unavailable for {Path(dex_path).name}: {str(error)[:500]}")
                                continue
                            except OSError as error:
                                warnings.append(f"DEX disassembly was unavailable for {Path(dex_path).name}: {str(error)[:500]}")
                                continue
                            stderr_file.flush()
                        baksmali_log = disassembly_stderr.read_bytes()[-2000:].decode("utf-8", errors="replace").strip()
                        if disassembly_code != 0:
                            warnings.append(baksmali_log[:1000] or f"Baksmali could not disassemble {Path(dex_path).name}.")
                            continue
                        disassembly_success = True
                    if disassembly_success:
                        try:
                            raw_smali, smali_total_bytes, smali_truncated, oversized_smali = smali_files(disassembly_output, total_source_bytes)
                        except AnalysisError as error:
                            raw_smali, smali_total_bytes, smali_truncated, oversized_smali = [], 0, True, 0
                            warnings.append(str(error))
                        disassembly_root = run_root / "disassembly"
                        source_by_smali = {Path(unit["relativePath"]).with_suffix(".smali").as_posix(): unit for unit in units}
                        known_smali_paths = {smali.relative_to(disassembly_output).with_suffix("").as_posix() for smali in raw_smali}
                        for smali in raw_smali:
                            relative = smali.relative_to(disassembly_output)
                            if relative.is_absolute() or ".." in relative.parts:
                                continue
                            raw = smali.read_bytes()
                            if not raw:
                                continue
                            references = class_references(raw.decode("utf-8", errors="replace"), relative, known_smali_paths)
                            destination = disassembly_root / relative
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            destination.write_bytes(raw)
                            disassembly_id = destination.relative_to(DERIVED_ROOT).as_posix()
                            paired = source_by_smali.get(relative.as_posix())
                            if paired is not None:
                                paired["disassemblyArtifactId"] = disassembly_id
                                paired["disassemblyLanguage"] = "Smali"
                                paired["disassemblyBytes"] = len(raw)
                                paired["classReferences"] = references
                            else:
                                dotted_name = relative.with_suffix("").as_posix().replace("/", ".")
                                units.append({"name": dotted_name[:500], "relativePath": relative.as_posix()[:1000],
                                              "codeArtifactId": disassembly_id, "sizeBytes": len(raw),
                                              "language": "Smali", "unitType": "class", "classReferences": references})
                            disassembled_class_count += 1
                        if not raw_smali:
                            warnings.append("Baksmali did not produce any viewable DEX listings.")
                        if smali_truncated:
                            warnings.append(f"Baksmali output was limited to {len(raw_smali)} viewable class listings.")
                        if oversized_smali:
                            warnings.append(f"{oversized_smali} Smali class listings exceeded the 2 MiB viewer limit and were not linked.")
                units.sort(key=lambda unit: str(unit["relativePath"]).casefold())
                report_progress("Saving decompiled sources and preparing results")
                returned = units[:MAX_RETURNED_UNITS]
                if source_scan_truncated:
                    warnings.append(f"JADX produced more than {len(raw_sources)} Java source files; this run indexed the first {len(raw_sources)} in sorted path order.")
                if len(units) > len(returned):
                    warnings.append(f"Only the first {len(returned)} of {len(units)} discovered code units are available in the visualizer.")
                if log_text:
                    warnings.append(log_text[:4000])
                elif jadx_return_code:
                    warnings.append(f"JADX exited with code {jadx_return_code}.")
                return {"status": "completed", "toolVersion": "1.5.6", "classCount": None if source_scan_truncated else len(units),
                        "javaClassCount": None if source_scan_truncated else total_files, "disassembledClassCount": disassembled_class_count,
                        "codeBytes": total_source_bytes + smali_total_bytes,
                        "returnedUnits": len(returned), "truncated": source_scan_truncated or total_files > len(returned) or len(units) > len(returned),
                        "units": returned, "warnings": " ".join(warnings)}
        except AnalysisError:
            if run_root.exists():
                shutil.rmtree(run_root, ignore_errors=True)
            raise
        except Exception as error:
            if run_root.exists():
                shutil.rmtree(run_root, ignore_errors=True)
            raise AnalysisError("JADX analysis failed unexpectedly") from error

class Handler(BaseHTTPRequestHandler):
    server_version = "REAmon-JADX/1.0"
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
        self._send(200, {"status": "ready", "provider": "jadx", "version": "1.5.6"})
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
                for event in stream_result_events(result):
                    self._send_stream_event(event)
                self._finish_stream()
                return
            self._send(200, analyse(body, lambda: client_disconnected(self.connection)))
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
        print("jadx-analyzer: " + format % args, flush=True)

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
