#!/usr/bin/env python3
"""Secret-free, network-isolated Ghidra headless adapter."""
from __future__ import annotations
import base64, hashlib, json, os, re, select, shutil, signal, socket, subprocess, tempfile, threading, time
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
MAX_UNSTRIP_OUTPUT_BYTES = min(67108864, max(1048576, int(os.environ.get("UNSTRIP_MAX_OUTPUT_BYTES", "33554432"))))
UNSTRIP_TIMEOUT_SECONDS = min(300, max(15, int(os.environ.get("UNSTRIP_TIMEOUT_SECONDS", "120"))))
REIPA_COMMIT = "b0d4759451ed20796892a059fa53d9dbb130af61"
REIPA_TIMEOUT_SECONDS = min(180, max(15, int(os.environ.get("REIPA_TIMEOUT_SECONDS", "60"))))
MAX_REIPA_SYMBOL_BYTES = min(67108864, max(1048576, int(os.environ.get("REIPA_MAX_SYMBOL_BYTES", "33554432"))))
MAX_REIPA_TYPE_BYTES = min(8388608, max(262144, int(os.environ.get("REIPA_MAX_TYPE_BYTES", "2097152"))))
MAX_REIPA_OBJC_BYTES = min(33554432, max(262144, int(os.environ.get("REIPA_MAX_OBJC_BYTES", "8388608"))))
REIPA_DECOMPILE_TIMEOUT_SECONDS = min(180, max(15, int(os.environ.get("REIPA_DECOMPILE_TIMEOUT_SECONDS", "60"))))
MAX_REIPA_ALTERNATE_BYTES = min(67108864, max(1048576, int(os.environ.get("REIPA_MAX_ALTERNATE_BYTES", "33554432"))))
MAX_REIPA_ALTERNATE_UNIT_BYTES = 131072
MAX_REIPA_ALTERNATES = 64
MAX_REIPA_TYPES = 1000
FLOSS_VERSION = "3.1.1"
MAX_FLOSS_OUTPUT_BYTES = min(67108864, max(1048576, int(os.environ.get("FLOSS_MAX_OUTPUT_BYTES", "16777216"))))
FLOSS_TIMEOUT_SECONDS = min(300, max(15, int(os.environ.get("FLOSS_TIMEOUT_SECONDS", "120"))))
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

def run_ghidra(arguments, log_file, cancel_check, home, timeout_seconds=TIMEOUT_SECONDS, stdout_file=None,
               max_stdout_bytes=None, extra_env=None):
    environment = {
        **os.environ,
        "HOME": str(home),
        "GHIDRA_MAXMEM": os.environ.get("GHIDRA_JAVA_MAXMEM", "3G"),
        "GHIDRA_HEADLESS_MAXMEM": os.environ.get("GHIDRA_JAVA_MAXMEM", "3G"),
        "JAVA_TOOL_OPTIONS": f"-Duser.home={home}",
        "JAVA_HOME": os.environ.get("JAVA_HOME", "/usr/lib/jvm/java-21-openjdk-amd64"),
        "TMPDIR": str(home / "tmp"),
    }
    if extra_env:
        environment.update(extra_env)
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=stdout_file or log_file,
                               stderr=log_file if stdout_file else subprocess.STDOUT,
                               start_new_session=True, env=environment)
    deadline = time.monotonic() + timeout_seconds
    try:
        while process.poll() is None:
            if cancel_check():
                raise AnalysisError("Ghidra analysis was cancelled")
            if stdout_file is not None and max_stdout_bytes is not None \
                    and os.fstat(stdout_file.fileno()).st_size > max_stdout_bytes:
                raise AnalysisError("Analyzer exceeded its configured output limit")
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

def native_format_supported_by_floss(path):
    try:
        with path.open("rb") as source:
            magic = source.read(4)
    except OSError:
        return False
    return magic == b"\x7fELF" or magic[:2] == b"MZ" or magic in {
        b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
    }

def is_macho_input(path):
    try:
        with path.open("rb") as source:
            magic = source.read(4)
    except OSError:
        return False
    return magic in {
        b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
    }

def extract_reipa_metadata(input_path, temporary_root, cancel_check, home):
    if not is_macho_input(input_path):
        return [], {}, [], {}, False, None
    type_path = temporary_root / "reipa-swift-types.txt"
    type_log = temporary_root / "reipa-swift-types.log"
    symbol_path = temporary_root / "reipa-symbols.txt"
    symbol_log = temporary_root / "reipa-symbols.log"
    objc_path = temporary_root / "reipa-objc-classdump.txt"
    objc_log = temporary_root / "reipa-objc-classdump.log"
    verify_path = temporary_root / "reipa-verify.txt"
    verify_log = temporary_root / "reipa-verify.log"
    try:
        with verify_path.open("wb") as output_file, verify_log.open("wb") as log_file:
            verify_code = run_ghidra(
                ["/usr/local/bin/reipa", "verify", str(input_path)], log_file,
                cancel_check, home, REIPA_TIMEOUT_SECONDS, output_file, 4096,
            )
        if verify_code != 0:
            return [], {}, [], {}, False, None
        verification = verify_path.read_text(encoding="utf-8", errors="replace")
        if not re.search(r"^arch:\s+arm64e?$", verification, re.MULTILINE):
            return [], {}, [], {}, False, None
        if re.search(r"^ENCRYPTED:\s+YES", verification, re.MULTILINE):
            return [], {}, [], {}, False, "ReIPA skipped encrypted Mach-O metadata; analyze a decrypted arm64 binary for this evidence."
        with type_path.open("wb") as output_file, type_log.open("wb") as log_file:
            type_code = run_ghidra(
                ["/usr/local/bin/reipa", "swift-types", str(input_path)], log_file,
                cancel_check, home, REIPA_TIMEOUT_SECONDS, output_file, MAX_REIPA_TYPE_BYTES,
            )
        with symbol_path.open("wb") as output_file, symbol_log.open("wb") as log_file:
            symbol_code = run_ghidra(
                ["/usr/local/bin/reipa", "symbols", str(input_path)], log_file,
                cancel_check, home, REIPA_TIMEOUT_SECONDS, output_file, MAX_REIPA_SYMBOL_BYTES,
            )
        with objc_path.open("wb") as output_file, objc_log.open("wb") as log_file:
            objc_code = run_ghidra(
                ["/usr/local/bin/reipa", "classdump", str(input_path)], log_file,
                cancel_check, home, REIPA_TIMEOUT_SECONDS, output_file, MAX_REIPA_OBJC_BYTES,
            )
    except AnalysisError as error:
        if "cancelled" in str(error).lower():
            raise
        return [], {}, [], {}, False, "ReIPA metadata recovery exceeded a limit or was unavailable."
    except OSError:
        return [], {}, [], {}, False, "ReIPA metadata recovery could not start."

    if type_code != 0 or symbol_code != 0 or objc_code != 0:
        return [], {}, [], {}, False, "ReIPA could not read this Mach-O metadata; Ghidra results remain available."
    if (type_path.stat().st_size > MAX_REIPA_TYPE_BYTES or symbol_path.stat().st_size > MAX_REIPA_SYMBOL_BYTES
            or objc_path.stat().st_size > MAX_REIPA_OBJC_BYTES):
        return [], {}, [], {}, True, "ReIPA metadata exceeded its configured output limit."

    type_details = []
    type_names = set()
    truncated = False
    for line in type_path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = re.fullmatch(r"(class|struct|enum|type)\s+(.{1,500})", line.strip())
        if not match:
            continue
        kind, name = match.groups()
        if len(type_details) >= MAX_REIPA_TYPES:
            truncated = True
            break
        name = name.strip()
        if not name:
            continue
        type_names.add(name.rsplit(".", 1)[-1].split("<", 1)[0])
        type_details.append({
            "name": name,
            "kind": kind,
            "reconstructed": "Swift nominal type metadata; member layout was not recovered by this record.",
        })

    swift_symbols = {}
    if type_names:
        for line in symbol_path.read_text(encoding="utf-8", errors="replace").splitlines():
            match = re.match(r"^0x([0-9a-fA-F]{1,16})\s+(.{1,1000})$", line.strip())
            if not match:
                continue
            address, name = match.groups()
            if any(re.search(r"(?<![A-Za-z0-9_])" + re.escape(type_name) + r"(?![A-Za-z0-9_])", name) for type_name in type_names):
                swift_symbols.setdefault(address.lower().lstrip("0") or "0", name[:500])
            if len(swift_symbols) >= MAX_RETURNED_UNITS:
                truncated = True
                break

    objc_type_details = []
    objc_class_names = set()
    objc_symbols = {}
    current_interface = None

    def save_objc_interface():
        nonlocal truncated, current_interface
        if not current_interface:
            return
        header, body = current_interface
        match = re.match(r"@interface\s+([^\s(:]+)(?:\s+\(([^)]+)\))?", header)
        if not match:
            current_interface = None
            return
        class_name, category_name = match.groups()
        name = f"{class_name} ({category_name})" if category_name else class_name
        if len(objc_type_details) >= MAX_REIPA_TYPES:
            truncated = True
            current_interface = None
            return
        objc_class_names.add(class_name)
        objc_type_details.append({
            "name": name[:500],
            "kind": "category" if category_name else "class",
            "reconstructed": "\n".join([header, *body])[:4096],
        })
        current_interface = None

    for line in objc_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("@interface "):
            save_objc_interface()
            current_interface = (line.strip()[:1000], [])
        elif line.strip() == "@end":
            save_objc_interface()
        elif current_interface and len(current_interface[1]) < 64:
            current_interface[1].append(line[:1000])
            header, _ = current_interface
            interface_match = re.match(r"@interface\s+([^\s(:]+)", header)
            method_match = re.match(r"\s*([+-])\s+(.+?)\s*;\s*//\s+0x([0-9a-fA-F]{1,16})\s*$", line)
            if interface_match and method_match:
                class_name = interface_match.group(1)
                sign, declaration, address = method_match.groups()
                declaration = re.sub(r"^\([^)]*\)\s*", "", declaration.strip(), count=1)
                selector_keywords = re.findall(r"([A-Za-z_$][A-Za-z0-9_$]*):", declaration)
                selector = ":".join(selector_keywords) + ":" if selector_keywords else declaration.split(None, 1)[0]
                if selector and len(selector) <= 500 and len(objc_symbols) < MAX_RETURNED_UNITS:
                    objc_symbols.setdefault(address.lower().lstrip("0") or "0", f"{sign}[{class_name} {selector}]"[:500])
                elif len(objc_symbols) >= MAX_RETURNED_UNITS:
                    truncated = True
    save_objc_interface()

    if objc_class_names:
        for line in symbol_path.read_text(encoding="utf-8", errors="replace").splitlines():
            match = re.match(r"^0x([0-9a-fA-F]{1,16})\s+([-+]\[[^]]+\])$", line.strip())
            if not match:
                continue
            address, name = match.groups()
            class_name_match = re.match(r"^[-+]\[([^\s\]]+)", name)
            if class_name_match and class_name_match.group(1) in objc_class_names:
                objc_symbols.setdefault(address.lower().lstrip("0") or "0", name[:500])
            if len(objc_symbols) >= MAX_RETURNED_UNITS:
                truncated = True
                break
    return type_details, swift_symbols, objc_type_details, objc_symbols, truncated, None

def extract_reipa_pseudocode(input_path, run_root, temporary_root, target_addresses, cancel_check, home, output_limit):
    if not target_addresses:
        return {}, False, None
    if output_limit < 1:
        return {}, True, "ReIPA alternate pseudocode had no remaining artifact storage budget."
    targets = set(target_addresses)
    truncated = False
    warning = None
    output_path = temporary_root / "reipa-pseudocode.txt"
    log_path = temporary_root / "reipa-pseudocode.log"
    try:
        with output_path.open("wb") as output_file, log_path.open("wb") as log_file:
            return_code = run_ghidra(
                ["/usr/local/bin/reipa", "decompile", str(input_path), "--all", "--count", "512"],
                log_file, cancel_check, home, REIPA_DECOMPILE_TIMEOUT_SECONDS, output_file, output_limit,
            )
        if return_code != 0:
            truncated = True
            warning = "ReIPA alternate pseudocode exited early; complete functions from its output may still be available."
    except AnalysisError as error:
        if "cancelled" in str(error).lower():
            raise
        truncated = True
        warning = "ReIPA alternate pseudocode reached its time or output limit; complete functions from the partial output may still be available."
    except OSError:
        return {}, False, "ReIPA alternate pseudocode could not start."

    if not output_path.is_file():
        return {}, truncated, warning
    result = {}
    current_address = None
    current_lines = []

    def save_current():
        nonlocal truncated
        if current_address not in targets or len(result) >= MAX_REIPA_ALTERNATES:
            if current_address in targets:
                truncated = True
            return
        code = "\n".join(current_lines).strip() + "\n"
        encoded = code.encode("utf-8")
        if not code.strip() or not code.rstrip().endswith("}") or len(encoded) > MAX_REIPA_ALTERNATE_UNIT_BYTES:
            truncated = True
            return
        destination = run_root / "alternates" / "reipa" / f"{current_address}.c"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(encoded)
        result[current_address] = {
            "path": destination,
            "sizeBytes": len(encoded),
            "sha256": hashlib.sha256(encoded).hexdigest(),
        }

    for line in output_path.read_text(encoding="utf-8", errors="replace").splitlines():
        marker = re.match(r"^// .+?\s+@0x([0-9a-fA-F]{1,16})\s+\(", line)
        if marker:
            save_current()
            current_address = marker.group(1).lower().lstrip("0") or "0"
            current_lines = [line]
        elif current_address is not None:
            current_lines.append(line)
    save_current()
    if len(targets) > MAX_REIPA_ALTERNATES:
        truncated = True
    if not result and not warning:
        warning = "ReIPA did not produce complete pseudocode for the matched Swift or Objective-C functions."
    return result, truncated, warning

def normalized_address(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        if value < 0 or value > 0xFFFFFFFFFFFFFFFF:
            return None
        value = format(value, "x")
    if not isinstance(value, str):
        return None
    address = value.strip().lower()
    if ":" in address:
        address = address.rsplit(":", 1)[-1]
    address = address.removeprefix("0x").lstrip("0") or "0"
    return address if re.fullmatch(r"[0-9a-f]{1,16}", address) else None

def extract_floss_strings(input_path, output_path, log_path, cancel_check, home):
    if not native_format_supported_by_floss(input_path):
        return {}, {}, None, None
    executable = os.environ.get("FLOSS_BIN", "/usr/local/bin/floss")
    if not Path(executable).is_file():
        return {}, {}, "FLOSS string recovery is unavailable in this analyzer image.", None
    try:
        with output_path.open("wb") as output_file, log_path.open("wb") as log_file:
            return_code = run_ghidra(
                [executable, "--json", "--no-string-type", "static", "--", str(input_path)],
                log_file, cancel_check, home, FLOSS_TIMEOUT_SECONDS, output_file, MAX_FLOSS_OUTPUT_BYTES,
                {
                    "FLOSS_CACHE_ENABLE": "0",
                    "FLOSS_SAVE_WORKSPACE": "0",
                    "FLOSS_CACHE_DIR": str(home / "floss-cache"),
                    "TMPDIR": os.environ.get("FLOSS_TMPDIR", str(home / "tmp")),
                },
            )
        if return_code != 0:
            return {}, {}, f"FLOSS string recovery was unavailable (exit code {return_code}).", None
        if output_path.stat().st_size > MAX_FLOSS_OUTPUT_BYTES:
            return {}, {}, "FLOSS output exceeded its configured storage limit.", None
        document = json.loads(output_path.read_text(encoding="utf-8"))
        metadata = document.get("metadata", {}) if isinstance(document, dict) else {}
        if not isinstance(metadata, dict) or metadata.get("version") != FLOSS_VERSION:
            return {}, {}, "FLOSS returned an unexpected or unversioned results document.", None
        string_groups = document.get("strings", {})
        if not isinstance(string_groups, dict):
            return {}, {}, "FLOSS returned a malformed strings section.", None

        recovered = {}
        truncated = {}
        total = 0
        for source_field, kind, address_field in (
            ("stack_strings", "stack", "function"),
            ("tight_strings", "tight", "function"),
            ("decoded_strings", "decoded", "decoding_routine"),
        ):
            entries = string_groups.get(source_field, [])
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                function_address = normalized_address(entry.get(address_field))
                value = entry.get("string")
                if not function_address or not isinstance(value, str) or not value.strip():
                    continue
                value = value.strip()
                if len(value) > 512:
                    value = value[:512]
                    truncated[function_address] = True
                item = {"kind": kind, "value": value}
                encoding = entry.get("encoding")
                if isinstance(encoding, str) and len(encoding) <= 32:
                    item["encoding"] = encoding
                decoded_at = normalized_address(entry.get("decoded_at"))
                if decoded_at:
                    item["decodedAt"] = decoded_at
                rows = recovered.setdefault(function_address, [])
                if item in rows:
                    continue
                if total >= 5000 or len(rows) >= 32:
                    truncated[function_address] = True
                    continue
                rows.append(item)
                total += 1
        return recovered, truncated, None, FLOSS_VERSION
    except AnalysisError as error:
        if "cancelled" in str(error).lower():
            raise
        return {}, {}, str(error)[:240], None
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return {}, {}, f"FLOSS output could not be read: {type(error).__name__}.", None

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
                floss_path = temporary_root / "floss-results.json"
                floss_log_path = temporary_root / "floss.log"
                report_progress("Recovering obfuscated native strings with FLOSS")
                floss_strings_by_function, floss_truncated_by_function, floss_warning, floss_version = extract_floss_strings(
                    input_path, floss_path, floss_log_path, cancel_check, home,
                )
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
                            MAX_GORESYM_OUTPUT_BYTES,
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
                swift_type_details, reipa_swift_symbols, objc_type_details, reipa_objc_symbols = [], {}, [], {}
                reipa_metadata_truncated = False
                reipa_warning = None
                if is_macho_input(input_path):
                    report_progress("Checking for Swift and Objective-C metadata")
                    (swift_type_details, reipa_swift_symbols, objc_type_details, reipa_objc_symbols,
                     reipa_metadata_truncated, reipa_warning) = extract_reipa_metadata(
                        input_path, temporary_root, cancel_check, home,
                    )
                unstrip_type_details = []
                unstrip_type_details_truncated = False
                unstrip_functions = {}
                unstrip_interfaces_by_function = {}
                unstrip_interfaces_truncated_by_function = set()
                unstrip_interfaces_truncated = False
                if go_metadata:
                    unstrip_functions_path = temporary_root / "unstrip-functions.json"
                    unstrip_log_path = temporary_root / "unstrip-functions.log"
                    report_progress("Recovering Go method signatures and source locations")
                    try:
                        with unstrip_functions_path.open("wb") as output_file, unstrip_log_path.open("wb") as log_file:
                            unstrip_functions_code = run_ghidra(
                                ["/usr/local/bin/unstrip", "--format", "json", str(input_path)],
                                log_file, cancel_check, home, UNSTRIP_TIMEOUT_SECONDS, output_file,
                                MAX_UNSTRIP_OUTPUT_BYTES,
                            )
                        if unstrip_functions_code == 0 and unstrip_functions_path.stat().st_size <= MAX_UNSTRIP_OUTPUT_BYTES:
                            unstrip_function_report = json.loads(unstrip_functions_path.read_text(encoding="utf-8"))
                            records = unstrip_function_report.get("functions", []) if isinstance(unstrip_function_report, dict) else []
                            if isinstance(records, list):
                                for record in records:
                                    if not isinstance(record, dict):
                                        continue
                                    try:
                                        address = format(int(record.get("address")), "x")
                                    except (TypeError, ValueError):
                                        continue
                                    details = {}
                                    signature = record.get("signature")
                                    source_file = record.get("file")
                                    source_line = record.get("start_line")
                                    if isinstance(signature, str) and signature.strip():
                                        details["signature"] = signature.strip()[:1000]
                                    if isinstance(source_file, str) and source_file.strip():
                                        details["sourceFile"] = source_file.strip()[:500]
                                    if isinstance(source_line, int) and not isinstance(source_line, bool) and 0 < source_line <= 10_000_000:
                                        details["sourceLine"] = source_line
                                    if details:
                                        unstrip_functions[address] = details
                    except AnalysisError as error:
                        if "cancelled" in str(error).lower():
                            raise
                        go_warnings.append("unstrip Go method signatures exceeded an output/time limit or could not start.")
                    except (OSError, ValueError, json.JSONDecodeError) as error:
                        go_warnings.append("unstrip Go method signatures could not be parsed.")

                    unstrip_interfaces_path = temporary_root / "unstrip-interfaces.json"
                    unstrip_interfaces_log_path = temporary_root / "unstrip-interfaces.log"
                    report_progress("Recovering Go interface dispatch evidence")
                    try:
                        with unstrip_interfaces_path.open("wb") as output_file, unstrip_interfaces_log_path.open("wb") as log_file:
                            unstrip_interfaces_code = run_ghidra(
                                ["/usr/local/bin/unstrip", "--itabs", "--format", "json", str(input_path)],
                                log_file, cancel_check, home, UNSTRIP_TIMEOUT_SECONDS, output_file,
                                MAX_UNSTRIP_OUTPUT_BYTES,
                            )
                        if unstrip_interfaces_code == 0 and unstrip_interfaces_path.stat().st_size <= MAX_UNSTRIP_OUTPUT_BYTES:
                            unstrip_interfaces = json.loads(unstrip_interfaces_path.read_text(encoding="utf-8"))
                            if isinstance(unstrip_interfaces, list):
                                total_methods = 0
                                for itab in unstrip_interfaces[:10000]:
                                    if not isinstance(itab, dict):
                                        unstrip_interfaces_truncated = True
                                        continue
                                    interface_name = itab.get("interface_name")
                                    concrete_name = itab.get("concrete_name")
                                    methods = itab.get("methods", [])
                                    if not isinstance(interface_name, str) or not interface_name.strip() \
                                            or not isinstance(concrete_name, str) or not concrete_name.strip() \
                                            or not isinstance(methods, list):
                                        unstrip_interfaces_truncated = True
                                        continue
                                    for method in methods:
                                        if total_methods >= 20000:
                                            unstrip_interfaces_truncated = True
                                            break
                                        if not isinstance(method, dict):
                                            unstrip_interfaces_truncated = True
                                            continue
                                        method_name = method.get("interface_method")
                                        try:
                                            concrete_address = format(int(method.get("concrete_fn")), "x")
                                        except (TypeError, ValueError):
                                            continue
                                        if not isinstance(method_name, str) or not method_name.strip() or concrete_address == "0":
                                            continue
                                        rows = unstrip_interfaces_by_function.setdefault(concrete_address, [])
                                        if len(rows) >= 32:
                                            unstrip_interfaces_truncated = True
                                            unstrip_interfaces_truncated_by_function.add(concrete_address)
                                            continue
                                        try:
                                            itab_address = format(int(itab.get("addr", 0)), "x")[:128]
                                        except (TypeError, ValueError, OverflowError):
                                            itab_address = ""
                                        rows.append({
                                            "interfaceName": interface_name.strip()[:500],
                                            "concreteType": concrete_name.strip()[:500],
                                            "method": method_name.strip()[:256],
                                            "itabAddress": itab_address,
                                            "concreteFunctionAddress": concrete_address[:128],
                                            "incomplete": itab.get("incomplete") is True,
                                        })
                                        total_methods += 1
                                if len(unstrip_interfaces) > 10000:
                                    unstrip_interfaces_truncated = True
                            else:
                                unstrip_interfaces_truncated = True
                        elif unstrip_interfaces_path.stat().st_size > MAX_UNSTRIP_OUTPUT_BYTES:
                            unstrip_interfaces_truncated = True
                            go_warnings.append("unstrip Go interface metadata exceeded its configured output limit.")
                        else:
                            go_warnings.append("unstrip Go interface metadata was unavailable for this binary.")
                    except AnalysisError as error:
                        if "cancelled" in str(error).lower():
                            raise
                        unstrip_interfaces_truncated = True
                        go_warnings.append("unstrip Go interface metadata exceeded an output/time limit or could not start.")
                    except (OSError, ValueError, json.JSONDecodeError, OverflowError) as error:
                        unstrip_interfaces_truncated = True
                        go_warnings.append("unstrip Go interface metadata could not be parsed.")

                    unstrip_path = temporary_root / "unstrip-types.json"
                    unstrip_log_path = temporary_root / "unstrip.log"
                    report_progress("Recovering additional Go type evidence")
                    try:
                        with unstrip_path.open("wb") as output_file, unstrip_log_path.open("wb") as log_file:
                            unstrip_code = run_ghidra(
                                ["/usr/local/bin/unstrip", "--types", "--format", "json", str(input_path)],
                                log_file, cancel_check, home, UNSTRIP_TIMEOUT_SECONDS, output_file,
                                MAX_UNSTRIP_OUTPUT_BYTES,
                            )
                        if unstrip_code == 0 and unstrip_path.stat().st_size <= MAX_UNSTRIP_OUTPUT_BYTES:
                            unstrip_rows = json.loads(unstrip_path.read_text(encoding="utf-8"))
                            if isinstance(unstrip_rows, list):
                                unstrip_type_details_truncated = len(unstrip_rows) > 1000
                                for item in unstrip_rows[:1000]:
                                    if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"].strip():
                                        unstrip_type_details_truncated = True
                                        continue
                                    encoded_item = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
                                    if len(item["name"]) > 500 or len(encoded_item) > 4096:
                                        unstrip_type_details_truncated = True
                                    unstrip_type_details.append({
                                        "name": item["name"][:500],
                                        "kind": str(item.get("kind", "unknown"))[:128],
                                        "reconstructed": encoded_item[:4096],
                                        "source": "unstrip",
                                    })
                            else:
                                unstrip_type_details_truncated = True
                        elif unstrip_path.stat().st_size > MAX_UNSTRIP_OUTPUT_BYTES:
                            unstrip_type_details_truncated = True
                            go_warnings.append("unstrip Go type metadata exceeded its configured output limit.")
                        else:
                            go_warnings.append("unstrip Go type metadata was unavailable for this binary.")
                    except AnalysisError as error:
                        if "cancelled" in str(error).lower():
                            raise
                        unstrip_type_details_truncated = True
                        go_warnings.append("unstrip Go type metadata exceeded an output/time limit or could not start.")
                    except (OSError, ValueError, json.JSONDecodeError) as error:
                        unstrip_type_details_truncated = True
                        go_warnings.append("unstrip Go type metadata could not be parsed.")
                def recovered_go_name(value, fallback):
                    normalized = value.lower().removeprefix("0x").lstrip("0") or "0"
                    recovered = go_functions.get(normalized)
                    return recovered["name"] if recovered else fallback
                def recovered_function_name(value, fallback):
                    recovered_go = recovered_go_name(value, fallback)
                    if recovered_go != fallback or not re.fullmatch(r"(?:FUN|thunk|sub|undefined)_[0-9a-fA-F]+", fallback):
                        return recovered_go
                    address_key = normalized_address(value)
                    if address_key:
                        return reipa_swift_symbols.get(address_key) or reipa_objc_symbols.get(address_key) or fallback
                    return fallback
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
                    if len(fields) not in (4, 5, 6, 7, 8, 9, 10, 11, 12):
                        continue
                    encoded_name, address, size_text, relative = fields[:4]
                    assembly_relative = fields[4] if len(fields) >= 5 else ""
                    encoded_references = fields[5] if len(fields) >= 6 else ""
                    encoded_mnemonics = fields[6] if len(fields) >= 7 else ""
                    encoded_source_map = fields[7] if len(fields) >= 8 else ""
                    encoded_prototype = fields[8] if len(fields) == 9 else ""
                    if len(fields) >= 9:
                        encoded_prototype = fields[8]
                    encoded_variables = fields[9] if len(fields) >= 10 else ""
                    variables_truncated = len(fields) >= 11 and fields[10] == "true"
                    encoded_cfg_metrics = fields[11] if len(fields) >= 12 else ""
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
                    swift_symbol_name = reipa_swift_symbols.get(address_key)
                    objc_symbol_name = reipa_objc_symbols.get(address_key)
                    if re.fullmatch(r"(?:FUN|thunk|sub|undefined)_[0-9a-fA-F]+", name):
                        if swift_symbol_name:
                            name = swift_symbol_name
                        elif objc_symbol_name:
                            name = objc_symbol_name
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
                    prototype = ""
                    if encoded_prototype:
                        try:
                            prototype = base64.b64decode(encoded_prototype, validate=True).decode("utf-8", errors="replace").strip()[:2000]
                        except (ValueError, UnicodeDecodeError):
                            pass
                    recovered_variables = []
                    if encoded_variables:
                        try:
                            decoded_variables = base64.b64decode(encoded_variables, validate=True).decode("utf-8", errors="replace")
                            total_metadata_bytes += len(decoded_variables.encode("utf-8"))
                            for encoded_variable in decoded_variables.splitlines()[:100]:
                                variable_fields = encoded_variable.split("\t")
                                if len(variable_fields) not in (6, 8) or variable_fields[0] not in ("parameter", "local"):
                                    continue
                                try:
                                    parameter_index = int(variable_fields[1])
                                    size_bytes = int(variable_fields[2])
                                except ValueError:
                                    continue
                                storage_start_address = variable_fields[3]
                                if len(variable_fields) == 8 and any(value not in ("true", "false") for value in variable_fields[6:8]):
                                    continue
                                if (size_bytes < 0 or size_bytes > 65536
                                        or (storage_start_address and not re.fullmatch(r"[A-Za-z0-9:_-]{1,128}", storage_start_address))
                                        or (variable_fields[0] == "parameter" and not 0 <= parameter_index < 100)
                                        or (variable_fields[0] == "local" and parameter_index != -1)):
                                    continue
                                try:
                                    variable_name = base64.b64decode(variable_fields[4], validate=True).decode("utf-8", errors="replace")[:256]
                                    variable_type = base64.b64decode(variable_fields[5], validate=True).decode("utf-8", errors="replace")[:256]
                                except (ValueError, UnicodeDecodeError):
                                    continue
                                if not variable_name.strip():
                                    continue
                                variable = {
                                    "kind": variable_fields[0],
                                    "name": variable_name,
                                    "dataType": variable_type,
                                    "sizeBytes": size_bytes,
                                }
                                if variable_fields[0] == "parameter":
                                    variable["parameterIndex"] = parameter_index
                                if storage_start_address:
                                    variable["storageStartAddress"] = storage_start_address
                                if len(variable_fields) == 8:
                                    variable["nameLocked"] = variable_fields[6] == "true"
                                    variable["typeLocked"] = variable_fields[7] == "true"
                                recovered_variables.append(variable)
                        except (ValueError, UnicodeDecodeError):
                            pass
                    cfg_metrics = None
                    if encoded_cfg_metrics:
                        try:
                            decoded_cfg_metrics = base64.b64decode(encoded_cfg_metrics, validate=True).decode("utf-8", errors="strict")
                            parsed_cfg_metrics = json.loads(decoded_cfg_metrics)
                            if (isinstance(parsed_cfg_metrics, dict)
                                    and parsed_cfg_metrics.get("version") == "ghidra-basic-blocks-v1"
                                    and all(isinstance(parsed_cfg_metrics.get(key), int) and not isinstance(parsed_cfg_metrics.get(key), bool)
                                            and 0 <= parsed_cfg_metrics[key] <= 1_000_000
                                            for key in ("blockCount", "edgeCount", "entryBlockCount", "exitBlockCount"))
                                    and isinstance(parsed_cfg_metrics.get("truncated"), bool)):
                                cfg_metrics = parsed_cfg_metrics
                        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                            pass
                    if cfg_metrics:
                        total_metadata_bytes += len(json.dumps(cfg_metrics, separators=(",", ":")).encode("utf-8"))
                    if total_bytes + total_assembly_bytes + total_metadata_bytes > MAX_OUTPUT_BYTES:
                        raise AnalysisError("Ghidra sources and evidence exceeded the configured storage limit")
                    rows.append((name[:500], address[:128], size_bytes, relative, source, assembly_relative, assembly, referenced_strings, instruction_mnemonics, source_address_map, prototype, recovered_variables, variables_truncated, cfg_metrics))

                if not rows:
                    raise AnalysisError(log_text[-1200:] or "Ghidra found no functions it could decompile")
                total_metadata_bytes += sum(
                    len(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                    for values in floss_strings_by_function.values()
                )
                if total_bytes + total_assembly_bytes + total_metadata_bytes > MAX_OUTPUT_BYTES:
                    raise AnalysisError("Ghidra sources and FLOSS string evidence exceeded the configured storage limit")
                returned = rows[:MAX_RETURNED_UNITS]
                report_progress(f"Indexing {len(returned)} function results")
                returned_addresses = {row[1] for row in returned}
                reipa_targets = {
                    normalized_address(row[1])
                    for row in returned
                    if normalized_address(row[1]) in reipa_swift_symbols
                    or normalized_address(row[1]) in reipa_objc_symbols
                }
                reipa_alternates = {}
                reipa_alternate_truncated = False
                reipa_alternate_warning = None
                if reipa_targets:
                    report_progress("Generating address-matched ReIPA pseudocode alternatives")
                    reipa_output_budget = max(0, min(
                        MAX_REIPA_ALTERNATE_BYTES,
                        MAX_OUTPUT_BYTES - total_bytes - total_assembly_bytes - total_metadata_bytes,
                    ))
                    (reipa_alternates, reipa_alternate_truncated,
                     reipa_alternate_warning) = extract_reipa_pseudocode(
                        input_path, run_root, temporary_root, reipa_targets, cancel_check, home,
                        reipa_output_budget,
                    )
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
                            "fromName": recovered_function_name(from_address, from_name)[:500],
                            "toName": recovered_function_name(to_address, to_name)[:500],
                        })
                if summary.get("callsTruncated") == "true" and not call_edges_truncated:
                    call_edges_truncated = True
                sources_root = run_root / "sources"
                units = []
                progress_stride = max(1, len(returned) // 25)
                for unit_index, (name, address, size_bytes, relative, source, assembly_relative, assembly, referenced_strings, instruction_mnemonics, source_address_map, prototype, recovered_variables, variables_truncated, cfg_metrics) in enumerate(returned, start=1):
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
                    reipa_alternate = reipa_alternates.get(address_key)
                    if reipa_alternate:
                        unit.update({
                            "reipaAlternateCodeArtifactId": reipa_alternate["path"].relative_to(DERIVED_ROOT).as_posix(),
                            "reipaAlternateOutputSha256": reipa_alternate["sha256"],
                            "reipaAlternateSizeBytes": reipa_alternate["sizeBytes"],
                        })
                    if go_function:
                        unit["sourceLanguage"] = "Go"
                        unit["symbolSource"] = "GoReSym"
                        if go_function["package"]:
                            unit["goPackage"] = go_function["package"]
                        unstrip_function = unstrip_functions.get(address_key)
                        if unstrip_function:
                            unit.update({
                                "goUnstripSignature": unstrip_function.get("signature"),
                                "goUnstripSourceFile": unstrip_function.get("sourceFile"),
                                "goUnstripSourceLine": unstrip_function.get("sourceLine"),
                            })
                        interface_methods = unstrip_interfaces_by_function.get(address_key)
                        if interface_methods:
                            unit["goUnstripInterfaces"] = interface_methods[:32]
                            unit["goUnstripInterfacesTruncated"] = address_key in unstrip_interfaces_truncated_by_function
                    if swift_symbol_name:
                        unit["sourceLanguage"] = "Swift"
                        unit["symbolSource"] = "ReIPA"
                        unit["recoveredNativeSymbolName"] = swift_symbol_name
                    elif objc_symbol_name:
                        unit["sourceLanguage"] = "Objective-C"
                        unit["symbolSource"] = "ReIPA"
                        unit["recoveredNativeSymbolName"] = objc_symbol_name
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
                    if cfg_metrics:
                        unit["cfgMetrics"] = cfg_metrics
                    if source_address_map:
                        unit["sourceAddressMap"] = source_address_map
                    if prototype:
                        unit["prototype"] = prototype
                    if recovered_variables:
                        unit["recoveredVariables"] = recovered_variables
                    if variables_truncated:
                        unit["recoveredVariablesTruncated"] = True
                    floss_key = normalized_address(address)
                    if floss_version and floss_key:
                        recovered_floss_strings = floss_strings_by_function.get(floss_key, [])
                        if recovered_floss_strings:
                            unit["flossRecoveredStrings"] = recovered_floss_strings
                        if floss_truncated_by_function.get(floss_key):
                            unit["flossRecoveredStringsTruncated"] = True
                        unit["flossVersion"] = floss_version
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
                recovered_variables_truncated = summary.get("recoveredVariablesTruncated") == "true"
                if recovered_variables_truncated:
                    warnings.append("Ghidra recovered variable evidence reached its configured analysis limit.")
                if any(row[13] and row[13].get("truncated") is True for row in returned):
                    warnings.append("Ghidra basic-block metrics reached a per-function or per-run limit; affected counts are lower bounds.")
                if floss_warning:
                    warnings.append(floss_warning)
                if reipa_warning:
                    warnings.append(reipa_warning)
                if reipa_metadata_truncated:
                    warnings.append("ReIPA type or symbol metadata was truncated at a configured limit.")
                if reipa_alternate_warning:
                    warnings.append(reipa_alternate_warning)
                if reipa_alternate_truncated:
                    warnings.append("ReIPA alternate pseudocode was truncated at a configured analysis limit.")
                if unstrip_interfaces_truncated:
                    go_warnings.append("unstrip Go interface dispatch evidence was truncated by an analysis limit.")
                go_type_rows = go_metadata.get("Types", []) if go_metadata and isinstance(go_metadata.get("Types"), list) else []
                go_type_details = []
                go_type_details_truncated = len(go_type_rows) > 1000
                for item in go_type_rows[:1000]:
                    if not isinstance(item, dict) or not isinstance(item.get("Str"), str) or not item.get("Str"):
                        go_type_details_truncated = True
                        continue
                    name = item["Str"]
                    kind = item.get("Kind", "")
                    reconstructed = item.get("Reconstructed", "")
                    if not isinstance(kind, str):
                        kind = ""
                        go_type_details_truncated = True
                    if not isinstance(reconstructed, str):
                        reconstructed = ""
                        go_type_details_truncated = True
                    if len(name) > 500 or len(kind) > 128 or len(reconstructed) > 4096:
                        go_type_details_truncated = True
                    go_type_details.append({
                        "name": name[:500],
                        "kind": kind[:128],
                        "reconstructed": reconstructed[:4096],
                    })
                return {
                    "status": "completed",
                    "toolVersion": "12.1.4",
                    "instructionArchitecture": summary.get("instructionArchitecture", "")[:128],
                    "recoveredLanguage": "Go" if go_metadata else None,
                    "goVersion": str(go_metadata.get("Version", ""))[:128] if go_metadata else None,
                    "goArchitecture": str(go_metadata.get("Arch", ""))[:128] if go_metadata else None,
                    "goTypes": [
                        str(item.get("Str", ""))[:500]
                        for item in go_type_rows[:1000]
                        if isinstance(item, dict) and isinstance(item.get("Str"), str) and item.get("Str")
                    ],
                    "goTypeDetails": go_type_details,
                    "goTypeDetailsTruncated": go_type_details_truncated,
                    "goUnstripTypeDetails": unstrip_type_details,
                    "goUnstripTypeDetailsTruncated": unstrip_type_details_truncated,
                    "goUnstripInterfacesTruncated": unstrip_interfaces_truncated,
                    "swiftTypeDetails": swift_type_details,
                    "objcTypeDetails": objc_type_details,
                    "reipaMetadataTruncated": reipa_metadata_truncated,
                    "swiftMetadataVersion": f"ReIPA@{REIPA_COMMIT}",
                    "reipaAlternateTruncated": reipa_alternate_truncated,
                    "reipaAlternateCodeBytes": sum(item["sizeBytes"] for item in reipa_alternates.values()),
                    "functionCount": len(rows),
                    "visitedFunctionCount": int(summary.get("visited", "0")),
                    "failedFunctionCount": failures,
                    "codeBytes": total_bytes,
                    "returnedUnits": len(units),
                    "callCount": len(calls),
                    "callGraphTruncated": call_edges_truncated,
                    "sourceAddressMapTruncated": source_address_map_truncated,
                    "recoveredVariablesTruncated": recovered_variables_truncated,
                    "flossVersion": floss_version,
                    "flossRecoveredStringsTruncated": any(floss_truncated_by_function.values()),
                    "calls": calls,
                    "truncated": summary.get("truncated") == "true" or len(rows) > len(units) or call_edges_truncated or source_address_map_truncated or recovered_variables_truncated or reipa_metadata_truncated or reipa_alternate_truncated or any(floss_truncated_by_function.values()),
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
        self._send(200, {
            "status": "ready",
            "provider": "ghidra",
            "version": "12.1.4",
            "flossVersion": FLOSS_VERSION if Path(os.environ.get("FLOSS_BIN", "/usr/local/bin/floss")).is_file() else None,
        })
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
