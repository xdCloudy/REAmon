#!/usr/bin/env python3
"""Secret-free, network-isolated Ghidra headless adapter."""
from __future__ import annotations
import base64, json, os, re, select, shutil, signal, socket, subprocess, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8011"))
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("GHIDRA_TIMEOUT_SECONDS", "900"))))
MAX_OUTPUT_BYTES = min(536870912, max(1048576, int(os.environ.get("GHIDRA_MAX_OUTPUT_BYTES", "268435456"))))
MAX_FUNCTIONS = min(2000, max(1, int(os.environ.get("GHIDRA_MAX_FUNCTIONS", "2000"))))
MAX_RETURNED_UNITS = min(2000, max(1, int(os.environ.get("GHIDRA_MAX_RETURNED_UNITS", "2000"))))
MAX_CALL_EDGES = min(400, max(0, int(os.environ.get("GHIDRA_MAX_CALL_EDGES", "400"))))
MAX_GORESYM_OUTPUT_BYTES = min(134217728, max(1048576, int(os.environ.get("GORESYM_MAX_OUTPUT_BYTES", "67108864"))))
GORESYM_TIMEOUT_SECONDS = min(300, max(15, int(os.environ.get("GORESYM_TIMEOUT_SECONDS", "120"))))
STREAM_RESULT_CHUNK_SIZE = 100
STREAM_RESULT_CHUNK_BYTES = 1024 * 1024
GHIDRA_HOME = Path(os.environ.get("GHIDRA_HOME", "/opt/ghidra/current")).resolve()
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
SLOTS = threading.BoundedSemaphore(1)

class AnalysisError(Exception):
    pass

def stream_result_events(result):
    arrays = {key: value for key, value in result.items() if isinstance(value, list)}
    single_result = {"type": "result", "data": result}
    if sum(len(value) for value in arrays.values()) <= STREAM_RESULT_CHUNK_SIZE and len(json.dumps(single_result, separators=(",", ":")).encode("utf-8")) <= STREAM_RESULT_CHUNK_BYTES:
        yield single_result
        return
    metadata = {key: value for key, value in result.items() if not isinstance(value, list)}
    start_event = {"type": "result_start", "data": metadata, "arrayFields": list(arrays)}
    if len(json.dumps(start_event, separators=(",", ":")).encode("utf-8")) > STREAM_RESULT_CHUNK_BYTES:
        raise AnalysisError("Ghidra result metadata exceeded the streaming limit")
    yield start_event
    for field, values in arrays.items():
        chunk = []
        chunk_event = {"type": "result_chunk", "field": field, "items": chunk}
        chunk_bytes = len(json.dumps(chunk_event, separators=(",", ":")).encode("utf-8"))
        for item in values:
            item_bytes = len(json.dumps(item, separators=(",", ":")).encode("utf-8"))
            item_cost = item_bytes + (1 if chunk else 0)
            if item_cost + chunk_bytes > STREAM_RESULT_CHUNK_BYTES:
                if not chunk:
                    raise AnalysisError("A Ghidra result item exceeded the streaming limit")
                yield chunk_event
                chunk = []
                chunk_event = {"type": "result_chunk", "field": field, "items": chunk}
                chunk_bytes = len(json.dumps(chunk_event, separators=(",", ":")).encode("utf-8"))
                item_cost = item_bytes
                if item_cost + chunk_bytes > STREAM_RESULT_CHUNK_BYTES:
                    raise AnalysisError("A Ghidra result item exceeded the streaming limit")
            chunk.append(item)
            chunk_bytes += item_cost
            if len(chunk) >= STREAM_RESULT_CHUNK_SIZE:
                yield chunk_event
                chunk = []
                chunk_event = {"type": "result_chunk", "field": field, "items": chunk}
                chunk_bytes = len(json.dumps(chunk_event, separators=(",", ":")).encode("utf-8"))
        if chunk:
            yield chunk_event
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

def within(root, path):
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(root.resolve())
    except ValueError as error:
        raise AnalysisError("Ghidra output escaped its temporary directory") from error
    return resolved

def parse_summary(path):
    values = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key] = value
    return values

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

def run_ghidra(arguments, log_file, cancel_check, home, timeout_seconds=TIMEOUT_SECONDS, stdout_file=None):
    environment = {
        **os.environ,
        "HOME": str(home),
        "GHIDRA_MAXMEM": os.environ.get("GHIDRA_JAVA_MAXMEM", "3G"),
        "GHIDRA_HEADLESS_MAXMEM": os.environ.get("GHIDRA_JAVA_MAXMEM", "3G"),
        "JAVA_TOOL_OPTIONS": f"-Duser.home={home}",
        "JAVA_HOME": os.environ.get("JAVA_HOME", "/usr/lib/jvm/java-21-openjdk-amd64"),
        "TMPDIR": str(home / "tmp"),
    }
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=stdout_file or log_file,
                               stderr=log_file if stdout_file else subprocess.STDOUT,
                               start_new_session=True, env=environment)
    deadline = time.monotonic() + timeout_seconds
    try:
        while process.poll() is None:
            if cancel_check():
                raise AnalysisError("Ghidra analysis was cancelled")
            if time.monotonic() >= deadline:
                raise AnalysisError(f"Analyzer exceeded {timeout_seconds} seconds")
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
        return process.returncode
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

    report_progress("Waiting for a Ghidra analyzer slot")
    with SLOTS:
        try:
            with tempfile.TemporaryDirectory(prefix="reamon-ghidra-") as temporary:
                temporary_root = Path(temporary)
                home = temporary_root / "home"
                home.mkdir()
                (home / "tmp").mkdir()
                project_dir = temporary_root / "project"
                project_dir.mkdir()
                export_root = temporary_root / "export"
                export_root.mkdir()
                log_path = temporary_root / "ghidra.log"
                command = [
                    str(GHIDRA_HOME / "support" / "analyzeHeadless"),
                    str(project_dir), "reamon-analysis",
                    "-import", str(input_path),
                    "-scriptPath", "/app/scripts",
                    "-postScript", "ReamonExport.java", str(export_root), str(MAX_FUNCTIONS), str(MAX_CALL_EDGES),
                    "-analysisTimeoutPerFile", str(min(600, max(30, int(os.environ.get("GHIDRA_FILE_TIMEOUT_SECONDS", "300"))))),
                    "-max-cpu", "2",
                    "-deleteProject",
                ]
                with log_path.open("wb") as log_file:
                    try:
                        report_progress("Analyzing the binary with Ghidra")
                        return_code = run_ghidra(command, log_file, cancel_check, home)
                    except OSError as error:
                        raise AnalysisError("Ghidra headless analyzer could not be started") from error
                goresym_path = temporary_root / "goresym.json"
                goresym_log_path = temporary_root / "goresym.log"
                go_metadata = None
                go_warnings = []
                report_progress("Checking for recoverable Go symbols")
                try:
                    with goresym_path.open("wb") as output_file, goresym_log_path.open("wb") as log_file:
                        goresym_code = run_ghidra(
                            ["/usr/local/bin/goresym", "-d", "-p", "-t", str(input_path)],
                            log_file, cancel_check, home, GORESYM_TIMEOUT_SECONDS, output_file,
                        )
                    if goresym_code == 0 and goresym_path.stat().st_size <= MAX_GORESYM_OUTPUT_BYTES:
                        go_metadata = json.loads(goresym_path.read_text(encoding="utf-8"))
                    elif goresym_path.stat().st_size > MAX_GORESYM_OUTPUT_BYTES:
                        go_warnings.append("Go symbol metadata exceeded its configured output limit.")
                except AnalysisError as error:
                    if "cancelled" in str(error).lower():
                        raise
                    go_warnings.append("Go symbol recovery exceeded its limit or could not start.")
                except (OSError, ValueError, json.JSONDecodeError) as error:
                    go_warnings.append("Go symbol recovery was unavailable for this binary.")
                if go_metadata is not None and not isinstance(go_metadata, dict):
                    go_metadata = None
                go_functions = {}
                if go_metadata:
                    for category in ("UserFunctions", "StdFunctions"):
                        records = go_metadata.get(category, [])
                        if not isinstance(records, list):
                            continue
                        for record in records:
                            if not isinstance(record, dict):
                                continue
                            try:
                                address = int(record.get("Start"))
                            except (TypeError, ValueError):
                                continue
                            full_name = record.get("FullName")
                            if not isinstance(full_name, str) or not full_name.strip() or len(full_name) > 1000:
                                continue
                            go_functions[format(address, "x")] = {
                                "name": full_name.strip(),
                                "package": str(record.get("PackageName", ""))[:500],
                            }
                    if not go_functions:
                        go_metadata = None
                def recovered_go_name(value, fallback):
                    normalized = value.lower().removeprefix("0x").lstrip("0") or "0"
                    recovered = go_functions.get(normalized)
                    return recovered["name"] if recovered else fallback
                log_text = log_path.read_bytes()[-6000:].decode("utf-8", errors="replace").strip()
                manifest = export_root / "manifest.tsv"
                summary_path = export_root / "summary.txt"
                if return_code != 0 or not manifest.is_file() or not summary_path.is_file():
                    detail = log_text[-1200:] if log_text else f"Ghidra exited with code {return_code}"
                    raise AnalysisError(f"Ghidra could not produce function decompilation: {detail}")
                report_progress("Ghidra analysis finished; indexing decompiled functions")
                summary = parse_summary(summary_path)
                rows = []
                total_bytes = 0
                total_assembly_bytes = 0
                total_metadata_bytes = 0
                for line in manifest.read_text(encoding="utf-8", errors="replace").splitlines():
                    fields = line.split("\t")
                    if len(fields) not in (4, 5, 6, 7, 8):
                        continue
                    encoded_name, address, size_text, relative = fields[:4]
                    assembly_relative = fields[4] if len(fields) >= 5 else ""
                    encoded_references = fields[5] if len(fields) >= 6 else ""
                    encoded_mnemonics = fields[6] if len(fields) >= 7 else ""
                    encoded_source_map = fields[7] if len(fields) == 8 else ""
                    if not re.fullmatch(r"[A-Za-z0-9_./-]{1,500}", relative) or ".." in Path(relative).parts:
                        continue
                    source = within(export_root, export_root / relative)
                    source_size = source.stat().st_size
                    total_bytes += source_size
                    assembly = None
                    if assembly_relative:
                        if not re.fullmatch(r"[A-Za-z0-9_./-]{1,500}", assembly_relative) or ".." in Path(assembly_relative).parts:
                            continue
                        assembly = within(export_root, export_root / assembly_relative)
                        total_assembly_bytes += assembly.stat().st_size
                    if source_size < 1 or total_bytes + total_assembly_bytes > MAX_OUTPUT_BYTES:
                        raise AnalysisError("Ghidra function sources exceeded the configured storage limit")
                    try:
                        name = base64.b64decode(encoded_name, validate=True).decode("utf-8", errors="replace")
                        size_bytes = int(size_text)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if not name or size_bytes < 1:
                        continue
                    address_key = address.lower().removeprefix("0x").lstrip("0") or "0"
                    go_function = go_functions.get(address_key)
                    if go_function and re.fullmatch(r"(?:FUN|thunk|sub|undefined)_[0-9a-fA-F]+", name):
                        name = go_function["name"]
                    referenced_strings = []
                    if encoded_references:
                        try:
                            encoded_values = base64.b64decode(encoded_references, validate=True).decode("ascii").split(",")
                            for encoded_value in encoded_values[:12]:
                                value = base64.b64decode(encoded_value, validate=True).decode("utf-8", errors="replace").strip()
                                if value and value not in referenced_strings:
                                    referenced_strings.append(value[:512])
                        except (ValueError, UnicodeDecodeError):
                            pass
                    instruction_mnemonics = []
                    if encoded_mnemonics:
                        try:
                            decoded = base64.b64decode(encoded_mnemonics, validate=True).decode("utf-8", errors="replace")
                            instruction_mnemonics = [
                                item for item in decoded.splitlines()[:800]
                                if re.fullmatch(r"[A-Za-z][A-Za-z0-9_.]{0,31}", item)
                            ]
                        except (ValueError, UnicodeDecodeError):
                            pass
                    source_address_map = []
                    if encoded_source_map:
                        try:
                            decoded_source_map = base64.b64decode(encoded_source_map, validate=True).decode("utf-8", errors="replace")
                            total_metadata_bytes += len(decoded_source_map.encode("utf-8"))
                            for mapping in decoded_source_map.splitlines()[:5000]:
                                line_number_text, separator, instruction_address = mapping.partition("\t")
                                if not separator or not re.fullmatch(r"[A-Za-z0-9:_-]{1,128}", instruction_address):
                                    continue
                                try:
                                    line_number = int(line_number_text)
                                except ValueError:
                                    continue
                                if line_number < 1 or line_number > 1_000_000:
                                    continue
                                item = {"ghidraLineNumber": line_number, "address": instruction_address}
                                if item not in source_address_map:
                                    source_address_map.append(item)
                        except (ValueError, UnicodeDecodeError):
                            pass
                    if total_bytes + total_assembly_bytes + total_metadata_bytes > MAX_OUTPUT_BYTES:
                        raise AnalysisError("Ghidra sources and evidence exceeded the configured storage limit")
                    rows.append((name[:500], address[:128], size_bytes, relative, source, assembly_relative, assembly, referenced_strings, instruction_mnemonics, source_address_map))

                if not rows:
                    raise AnalysisError(log_text[-1200:] or "Ghidra found no functions it could decompile")
                returned = rows[:MAX_RETURNED_UNITS]
                report_progress(f"Indexing {len(returned)} function results")
                returned_addresses = {row[1] for row in returned}
                calls = []
                call_edges_truncated = summary.get("callsTruncated") == "true"
                calls_path = export_root / "calls.tsv"
                if calls_path.is_file():
                    seen_calls = set()
                    for line in calls_path.read_text(encoding="utf-8", errors="replace").splitlines():
                        fields = line.split("\t")
                        if len(fields) != 4:
                            continue
                        from_address, to_address, encoded_from_name, encoded_to_name = fields
                        if (from_address not in returned_addresses
                                or not re.fullmatch(r"[A-Za-z0-9:_-]{1,128}", from_address)
                                or not re.fullmatch(r"[A-Za-z0-9:_-]{1,128}", to_address)):
                            continue
                        try:
                            from_name = base64.b64decode(encoded_from_name, validate=True).decode("utf-8", errors="replace")
                            to_name = base64.b64decode(encoded_to_name, validate=True).decode("utf-8", errors="replace")
                        except (ValueError, UnicodeDecodeError):
                            continue
                        edge = (from_address, to_address)
                        if edge in seen_calls:
                            continue
                        seen_calls.add(edge)
                        if len(calls) >= MAX_CALL_EDGES:
                            call_edges_truncated = True
                            break
                        calls.append({
                            "fromAddress": from_address,
                            "toAddress": to_address,
                            "fromName": recovered_go_name(from_address, from_name)[:500],
                            "toName": recovered_go_name(to_address, to_name)[:500],
                        })
                if summary.get("callsTruncated") == "true" and not call_edges_truncated:
                    call_edges_truncated = True
                sources_root = run_root / "sources"
                units = []
                progress_stride = max(1, len(returned) // 25)
                for unit_index, (name, address, size_bytes, relative, source, assembly_relative, assembly, referenced_strings, instruction_mnemonics, source_address_map) in enumerate(returned, start=1):
                    if unit_index == 1 or unit_index % progress_stride == 0 or unit_index == len(returned):
                        report_progress(f"Saving function {unit_index} of {len(returned)}")
                    destination = sources_root / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
                    address_key = address.lower().removeprefix("0x").lstrip("0") or "0"
                    go_function = go_functions.get(address_key)
                    unit = {
                        "name": name,
                        "address": address,
                        "relativePath": relative,
                        "codeArtifactId": destination.relative_to(DERIVED_ROOT).as_posix(),
                        "sizeBytes": size_bytes,
                    }
                    if go_function:
                        unit["sourceLanguage"] = "Go"
                        unit["symbolSource"] = "GoReSym"
                        if go_function["package"]:
                            unit["goPackage"] = go_function["package"]
                    if assembly is not None:
                        assembly_destination = run_root / assembly_relative
                        assembly_destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(assembly, assembly_destination)
                        unit["disassemblyArtifactId"] = assembly_destination.relative_to(DERIVED_ROOT).as_posix()
                        unit["disassemblyBytes"] = assembly.stat().st_size
                    if referenced_strings:
                        unit["referencedStrings"] = referenced_strings
                    if len(instruction_mnemonics) >= 4:
                        unit["instructionMnemonics"] = instruction_mnemonics
                    if source_address_map:
                        unit["sourceAddressMap"] = source_address_map
                    units.append(unit)

                warnings = []
                if summary.get("truncated") == "true":
                    warnings.append(f"Ghidra reached the {MAX_FUNCTIONS} function analysis limit; only functions in address order up to that limit were considered.")
                failures = int(summary.get("failed", "0"))
                if failures:
                    warnings.append(f"Ghidra could not decompile {failures} of {summary.get('visited', 'unknown')} considered functions.")
                if len(rows) > len(returned):
                    warnings.append(f"Only the first {len(returned)} of {len(rows)} decompiled functions are available as code units.")
                if call_edges_truncated:
                    warnings.append(f"Ghidra call graph output was limited to {MAX_CALL_EDGES} edges.")
                source_address_map_truncated = summary.get("sourceAddressMapTruncated") == "true"
                if source_address_map_truncated:
                    warnings.append("Ghidra source-to-address mappings reached the 5000-entry analysis limit.")
                return {
                    "status": "completed",
                    "toolVersion": "12.1.4",
                    "instructionArchitecture": summary.get("instructionArchitecture", "")[:128],
                    "recoveredLanguage": "Go" if go_metadata else None,
                    "goVersion": str(go_metadata.get("Version", ""))[:128] if go_metadata else None,
                    "goArchitecture": str(go_metadata.get("Arch", ""))[:128] if go_metadata else None,
                    "goTypes": [
                        str(item.get("Str", ""))[:500]
                        for item in (go_metadata.get("Types", [])[:1000] if go_metadata and isinstance(go_metadata.get("Types"), list) else [])
                        if isinstance(item, dict) and isinstance(item.get("Str"), str) and item.get("Str")
                    ],
                    "functionCount": len(rows),
                    "visitedFunctionCount": int(summary.get("visited", "0")),
                    "failedFunctionCount": failures,
                    "codeBytes": total_bytes,
                    "returnedUnits": len(units),
                    "callCount": len(calls),
                    "callGraphTruncated": call_edges_truncated,
                    "sourceAddressMapTruncated": source_address_map_truncated,
                    "calls": calls,
                    "truncated": summary.get("truncated") == "true" or len(rows) > len(units) or call_edges_truncated or source_address_map_truncated,
                    "units": units,
                    "warnings": " ".join(warnings + go_warnings),
                }
        except AnalysisError:
            if run_root.exists():
                shutil.rmtree(run_root, ignore_errors=True)
            raise
        except Exception as error:
            if run_root.exists():
                shutil.rmtree(run_root, ignore_errors=True)
            raise AnalysisError("Ghidra analysis failed unexpectedly") from error

class Handler(BaseHTTPRequestHandler):
    server_version = "REAmon-Ghidra/1.0"
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
        self._send(200, {"status": "ready", "provider": "ghidra", "version": "12.1.4"})
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
                    self._send_stream_event({"type": "error", "error": str(error)[:1200]})
                    self._finish_stream()
                except (BrokenPipeError, ConnectionResetError):
                    return
            else:
                self._send(422, {"error": str(error)[:1200]})
        except (BrokenPipeError, ConnectionResetError):
            return
    def log_message(self, format, *args):
        print("ghidra-analyzer: " + format % args, flush=True)

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
