#!/usr/bin/env python3
"""Secret-free JADX adapter isolated from REAmon's database and network."""
from __future__ import annotations
import hashlib, json, os, re, select, shutil, signal, socket, subprocess, tempfile, threading, time, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from uuid import uuid4

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8010"))
TIMEOUT_SECONDS = min(1200, max(60, int(os.environ.get("JADX_TIMEOUT_SECONDS", "900"))))
MAX_OUTPUT_BYTES = min(1024**3, max(1024**2, int(os.environ.get("JADX_MAX_OUTPUT_BYTES", str(512 * 1024**2)))))
MAX_SOURCE_FILES = min(50000, max(1, int(os.environ.get("JADX_MAX_SOURCE_FILES", "20000"))))
MAX_RETURNED_UNITS = min(20000, max(1, int(os.environ.get("JADX_MAX_RETURNED_UNITS", "20000"))))
MAX_VIEWABLE_BYTES = 2 * 1024 * 1024
STREAM_RESULT_CHUNK_SIZE = 100
STREAM_RESULT_CHUNK_BYTES = 1024 * 1024
MAX_CLASS_REFERENCES = 100
MAX_CLASS_REFERENCE_BYTES = 3500
MAX_CALL_EDGES = 400
MAX_CALL_EDGE_BYTES = 512 * 1024
MAX_METHOD_FEATURES = 8_000
MAX_METHOD_FEATURE_BYTES = 8 * 1024 * 1024
MAX_METHOD_FEATURES_PER_CLASS = 256
MAX_METHOD_FEATURE_BYTES_PER_CLASS = 256 * 1024
MAX_METHOD_SIGNATURE_INSTRUCTIONS = 128
MAX_REBUILD_REQUEST_BYTES = 20 * 1024 * 1024
MAX_REBUILD_SOURCE_FILES = 2000
MAX_REBUILD_SOURCE_BYTES = 16 * 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
PACKAGE_PATTERN = re.compile(r"^\s*package\s+([A-Za-z0-9_.$]+)\s*;", re.MULTILINE)
TYPE_PATTERN = re.compile(r"\b(?:class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)")
SMALI_CLASS_DESCRIPTOR = re.compile(r"L([A-Za-z0-9_$/]+);")
SMALI_METHOD_DECLARATION = re.compile(r"^\s*\.method\b.*?\s([^\s(]+\([^)]*\)\S+)\s*$")
SMALI_METHOD_INVOKE = re.compile(r"^\s*invoke-(?!custom\b)\S*\s+\{[^}]*\},\s*(L[^;]+;->[^\s,]+)")
SLOTS = threading.BoundedSemaphore(2)

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
        raise AnalysisError("JADX result metadata exceeded the streaming limit")
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
                    raise AnalysisError("A JADX result item exceeded the streaming limit")
                yield chunk_event
                chunk = []
                chunk_event = {"type": "result_chunk", "field": field, "items": chunk}
                chunk_bytes = len(json.dumps(chunk_event, separators=(",", ":")).encode("utf-8"))
                item_cost = item_bytes
                if item_cost + chunk_bytes > STREAM_RESULT_CHUNK_BYTES:
                    raise AnalysisError("A JADX result item exceeded the streaming limit")
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

def android_resource_files(root, existing_bytes=0):
    allowed_suffixes = {".xml", ".json", ".txt", ".properties", ".html", ".htm", ".css", ".js", ".yml", ".yaml"}
    found, total, truncated = [], 0, False
    for directory, dirs, filenames in os.walk(root, followlinks=False):
        dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
        for filename in sorted(filenames):
            path = Path(directory) / filename
            if path.is_symlink() or path.suffix.lower() not in allowed_suffixes:
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size <= 0 or size > MAX_VIEWABLE_BYTES:
                truncated = True
                continue
            total += size
            if existing_bytes + total > MAX_OUTPUT_BYTES:
                raise AnalysisError("JADX source and Android resources exceeded the configured storage limit")
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

def persist_apktool_project(source, run_root):
    """Keep the complete decoded tree so later Smali/resource edits can be rebuilt."""
    source = Path(source)
    if not source.is_dir():
        raise AnalysisError("Apktool did not produce a decoded project directory")
    staging = Path(tempfile.mkdtemp(prefix=".apktool-project-", dir=run_root))
    total = 0
    try:
        for directory, dirs, filenames in os.walk(source, followlinks=False):
            current = Path(directory)
            dirs[:] = sorted(name for name in dirs if not (current / name).is_symlink())
            relative_directory = current.relative_to(source)
            destination_directory = staging / relative_directory
            destination_directory.mkdir(parents=True, exist_ok=True)
            for filename in sorted(filenames):
                original = current / filename
                if original.is_symlink():
                    continue
                relative = original.relative_to(source)
                if relative.is_absolute() or ".." in relative.parts:
                    raise AnalysisError("Apktool produced a path outside its decoded project")
                size = original.stat().st_size
                if size < 0 or total + size > MAX_OUTPUT_BYTES:
                    raise AnalysisError(f"Decoded Apktool project exceeds the {MAX_OUTPUT_BYTES} byte storage limit")
                target = staging / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(original, target)
                total += size
        destination = run_root / "apktool-project"
        staging.replace(destination)
        return destination.relative_to(DERIVED_ROOT).as_posix(), total
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

def rebuild_apktool_project(body):
    project_id, artifact_id = safe_id(body.get("projectId")), safe_id(body.get("artifactId"))
    task_id, run_id = safe_id(body.get("taskId")), safe_id(body.get("runId"))
    changes = body.get("changes", [])
    if not isinstance(changes, list) or len(changes) > MAX_REBUILD_SOURCE_FILES:
        raise AnalysisError("APK rebuild changes must be a list of at most 2,000 files")
    run_root = (DERIVED_ROOT / project_id / artifact_id / task_id / run_id).resolve()
    try:
        run_root.relative_to(DERIVED_ROOT)
    except ValueError as error:
        raise AnalysisError("Derived APK project path is invalid") from error
    project_root = run_root / "apktool-project"
    try:
        project_real = project_root.resolve(strict=True)
        project_real.relative_to(DERIVED_ROOT)
    except (OSError, RuntimeError, ValueError) as error:
        raise AnalysisError("This analysis run has no saved Apktool project") from error
    if not project_real.is_dir():
        raise AnalysisError("This analysis run has no saved Apktool project")

    normalized_changes = []
    seen_paths = set()
    changed_bytes = 0
    smali_path_index = None
    for item in changes:
        if not isinstance(item, dict) or not isinstance(item.get("sourceCode"), str):
            raise AnalysisError("Each APK rebuild change needs text source")
        if isinstance(item.get("classDescriptor"), str):
            descriptor = item["classDescriptor"]
            if not re.fullmatch(r"L[^\s;]+;", descriptor):
                raise AnalysisError("APK rebuild Smali changes need a valid class descriptor")
            if smali_path_index is None:
                smali_path_index = {}
                class_pattern = re.compile(r"^\s*\.class\s+(?:(?:public|private|protected|static|final|abstract|interface|enum|synthetic|annotation|constructor|declared-synchronized)\s+)*(L[^\s;]+;)\s*$", re.MULTILINE)
                for smali_root in sorted(project_real.glob("smali*")):
                    if not smali_root.is_dir() or smali_root.is_symlink():
                        continue
                    for candidate in smali_root.rglob("*.smali"):
                        if candidate.is_symlink() or not candidate.is_file():
                            continue
                        try:
                            candidate_real = candidate.resolve(strict=True)
                            candidate_real.relative_to(project_real)
                            match = class_pattern.search(candidate.read_text(encoding="utf-8", errors="replace"))
                            if match:
                                smali_path_index.setdefault(match.group(1), []).append(candidate_real.relative_to(project_real).as_posix())
                        except (OSError, RuntimeError, ValueError):
                            continue
            candidates = smali_path_index.get(descriptor, [])
            if len(candidates) != 1:
                raise AnalysisError("Smali class descriptor must resolve to exactly one file in the decoded project")
            path_text = candidates[0]
        elif isinstance(item.get("relativePath"), str):
            path_text = item["relativePath"].replace("\\", "/")
        else:
            raise AnalysisError("Each APK rebuild change needs a relative path or Smali class descriptor")
        relative = PurePosixPath(path_text)
        if not path_text or relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts) or ":" in path_text:
            raise AnalysisError("APK rebuild file paths must stay inside the decoded project")
        canonical = relative.as_posix()
        if canonical in seen_paths:
            raise AnalysisError("APK rebuild changes contain a duplicate file path")
        seen_paths.add(canonical)
        target = project_real.joinpath(*relative.parts)
        try:
            target_real = target.resolve(strict=True)
            target_real.relative_to(project_real)
        except (OSError, RuntimeError, ValueError) as error:
            raise AnalysisError("An APK rebuild change does not match a file in the decoded project") from error
        if not target_real.is_file() or target.is_symlink():
            raise AnalysisError("APK rebuild changes must target regular project files")
        encoded = item["sourceCode"].encode("utf-8")
        if not encoded or changed_bytes + len(encoded) > MAX_REBUILD_SOURCE_BYTES:
            raise AnalysisError("APK rebuild text changes exceed the 16 MiB limit")
        changed_bytes += len(encoded)
        normalized_changes.append((relative, encoded))

    build_id = uuid4().hex
    build_root = run_root / "builds"
    build_root.mkdir(parents=True, exist_ok=True)
    apk_path = build_root / f"{build_id}.apk"
    with SLOTS:
        with tempfile.TemporaryDirectory(prefix="reamon-apk-build-") as temporary:
            temporary_root = Path(temporary)
            working_project = temporary_root / "project"
            shutil.copytree(project_real, working_project, symlinks=False)
            for relative, encoded in normalized_changes:
                destination = working_project.joinpath(*relative.parts)
                if destination.is_symlink() or not destination.is_file():
                    raise AnalysisError("An APK rebuild change no longer points to a regular project file")
                destination.write_bytes(encoded)
            staged_apk = temporary_root / "rebuilt-unsigned.apk"
            stderr_path = temporary_root / "apktool-build.stderr"
            deadline = time.monotonic() + TIMEOUT_SECONDS
            try:
                with stderr_path.open("wb") as stderr_file:
                    return_code = run_analysis_tool([
                        "java", "-jar", os.environ.get("APKTOOL_JAR", "/opt/apktool/apktool.jar"),
                        "build", str(working_project), "--force", "--output", str(staged_apk),
                    ], stderr_file, lambda: False, "Apktool build", deadline)
            except OSError as error:
                raise AnalysisError("Apktool build could not be started") from error
            log_text = analysis_log(stderr_path.read_bytes()[-4000:])
            if return_code != 0 or not staged_apk.is_file():
                raise AnalysisError((log_text or f"Apktool exited with code {return_code}.")[:3000])
            size = staged_apk.stat().st_size
            if size <= 0 or size > MAX_OUTPUT_BYTES:
                raise AnalysisError("Rebuilt APK is empty or exceeds the configured storage limit")
            digest = hashlib.sha256()
            with staged_apk.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            staged_apk.replace(apk_path)
    return {
        "status": "completed",
        "buildId": build_id,
        "outputPath": apk_path.relative_to(DERIVED_ROOT).as_posix(),
        "fileName": "rebuilt-app.unsigned.apk",
        "sizeBytes": size,
        "sha256": digest.hexdigest(),
        "changedFileCount": len(normalized_changes),
        "apktoolVersion": "3.0.3",
        "signed": False,
        "warnings": log_text[:3000],
    }

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


def method_calls(smali_text, current_path, known_paths):
    """Return concrete caller/target method descriptors from direct Smali invokes."""
    owner = "L" + current_path.with_suffix("").as_posix() + ";"
    current_method = None
    calls = []
    seen = set()
    for line in smali_text.splitlines():
        declaration = SMALI_METHOD_DECLARATION.match(line)
        if declaration:
            current_method = declaration.group(1)
            continue
        if line.lstrip().startswith(".end method"):
            current_method = None
            continue
        if current_method is None:
            continue
        invocation = SMALI_METHOD_INVOKE.match(line)
        if not invocation:
            continue
        target = invocation.group(1)
        identity = (current_method, target)
        if identity in seen:
            continue
        seen.add(identity)
        target_owner, _, target_method = target.partition("->")
        target_path = target_owner[1:-1] + ".smali" if target_owner.startswith("L") and target_owner.endswith(";") else ""
        calls.append({
            "fromSignature": f"{owner}->{current_method}",
            "toSignature": target,
            "toClassPath": target_path if target_path.removesuffix(".smali") in known_paths else "",
        })
    return calls


def method_instruction_features(smali_text, current_path):
    """Extract bounded operand-free opcode sequences from defined DEX methods."""
    owner = "L" + current_path.with_suffix("").as_posix() + ";"
    features = []
    total_bytes = 0
    truncated = False
    current_method = None
    mnemonics = []

    def append_method():
        nonlocal total_bytes, truncated
        if not current_method or len(mnemonics) < 4:
            return
        item = {
            "signature": f"{owner}->{current_method}",
            "instructionMnemonics": mnemonics[:MAX_METHOD_SIGNATURE_INSTRUCTIONS],
        }
        item_bytes = len(json.dumps(item, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
        if len(features) >= MAX_METHOD_FEATURES_PER_CLASS or total_bytes + item_bytes > MAX_METHOD_FEATURE_BYTES_PER_CLASS:
            truncated = True
            return
        features.append(item)
        total_bytes += item_bytes

    for line in smali_text.splitlines():
        declaration = SMALI_METHOD_DECLARATION.match(line)
        if declaration:
            append_method()
            current_method = declaration.group(1)
            mnemonics = []
            continue
        if line.lstrip().startswith(".end method"):
            append_method()
            current_method = None
            mnemonics = []
            continue
        if current_method is None or len(mnemonics) >= MAX_METHOD_SIGNATURE_INSTRUCTIONS:
            continue
        instruction = re.match(r"^\s*([A-Za-z][A-Za-z0-9_/-]*)(?:\s|$)", line)
        if instruction:
            mnemonics.append(instruction.group(1).lower())
    append_method()
    return features, truncated


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

def analysis_log(stderr_bytes):
    lines = stderr_bytes.decode("utf-8", errors="replace").splitlines()
    return "\n".join(line for line in lines if not line.startswith("Picked up JAVA_TOOL_OPTIONS:")).strip()

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
    run_root.mkdir(parents=True, exist_ok=True)
    analysis_deadline = time.monotonic() + TIMEOUT_SECONDS
    apktool_project_path = None
    apktool_project_bytes = 0
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
                            "--deobf", "--log-level", "ERROR", "-d", str(output), str(input_path)
                        ], stderr_file, cancel_check, "JADX", analysis_deadline)
                    except OSError as error:
                        raise AnalysisError("JADX could not be started") from error
                    stderr_file.flush()
                jadx_return_code = return_code
                log_text = analysis_log(stderr_path.read_bytes()[-4096:])
                raw_sources, total_source_bytes, source_scan_truncated = source_files(output) if output.exists() else ([], 0, False)
                warnings, units = [], []
                raw_resources, total_resource_bytes, resource_scan_truncated, indexed_resource_bytes = [], 0, False, 0
                if input_path.suffix.lower() == ".apk":
                    report_progress("Decoding Android manifest and resources with Apktool")
                    apktool_output = Path(temporary) / "apktool"
                    apktool_stderr = Path(temporary) / "apktool.stderr"
                    with apktool_stderr.open("wb") as stderr_file:
                        try:
                            apktool_return_code = run_analysis_tool([
                                "java", "-jar", os.environ.get("APKTOOL_JAR", "/opt/apktool/apktool.jar"),
                                "decode", "--force", "--output", str(apktool_output), str(input_path),
                            ], stderr_file, cancel_check, "Apktool", analysis_deadline)
                        except AnalysisError as error:
                            if any(word in str(error).lower() for word in ("cancelled", "exceeded")):
                                raise
                            warnings.append(f"Apktool resource decoding was unavailable: {str(error)[:500]}")
                            apktool_return_code = -1
                        except OSError as error:
                            warnings.append(f"Apktool could not be started: {str(error)[:500]}")
                            apktool_return_code = -1
                        stderr_file.flush()
                    apktool_log = analysis_log(apktool_stderr.read_bytes()[-3000:])
                    if apktool_return_code == 0 and apktool_output.exists():
                        try:
                            apktool_project_path, apktool_project_bytes = persist_apktool_project(apktool_output, run_root)
                        except AnalysisError as error:
                            warnings.append(f"Rebuildable Apktool project was not saved: {str(error)[:500]}")
                        try:
                            raw_resources, total_resource_bytes, resource_scan_truncated = android_resource_files(
                                apktool_output, total_source_bytes,
                            )
                        except AnalysisError as error:
                            warnings.append(str(error))
                            raw_resources = []
                        resources_root = run_root / "resources"
                        for resource in raw_resources:
                            relative = resource.relative_to(apktool_output)
                            if relative.is_absolute() or ".." in relative.parts:
                                continue
                            raw = resource.read_bytes()
                            try:
                                raw.decode("utf-8", errors="strict")
                            except UnicodeDecodeError:
                                resource_scan_truncated = True
                                continue
                            destination = resources_root / relative
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            destination.write_bytes(raw)
                            indexed_resource_bytes += len(raw)
                            suffix = relative.suffix.lower()
                            resource_language = {
                                ".xml": "XML", ".json": "JSON", ".txt": "Text", ".properties": "Properties",
                                ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".js": "JavaScript",
                                ".yml": "YAML", ".yaml": "YAML",
                            }[suffix]
                            units.append({"name": relative.as_posix()[:1000], "relativePath": relative.as_posix()[:1000],
                                          "codeArtifactId": destination.relative_to(DERIVED_ROOT).as_posix(), "sizeBytes": len(raw),
                                          "unitType": "resource", "language": resource_language})
                    elif apktool_log:
                        warnings.append(f"Apktool resource decoder: {apktool_log[:1500]}")
                    elif apktool_return_code:
                        warnings.append(f"Apktool exited with code {apktool_return_code}.")
                if not raw_sources:
                    warnings.append(log_text or "JADX produced no Java source files.")
                report_progress(f"JADX finished; indexing {len(raw_sources)} Java source files and {len(raw_resources)} Android resources")
                sources_root = run_root / "sources"
                sources_root.mkdir(parents=True, exist_ok=True)
                total_files = len(raw_sources)
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
                dex_file_paths = dex_inputs(input_path)
                smali_total_bytes = 0
                disassembled_class_count = 0
                call_edges = []
                call_edge_bytes = 0
                call_graph_truncated = False
                method_features = []
                method_feature_bytes = 0
                method_features_truncated = False
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
                            raw_smali, smali_total_bytes, smali_truncated, oversized_smali = smali_files(disassembly_output, total_source_bytes + total_resource_bytes)
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
                            calls = method_calls(raw.decode("utf-8", errors="replace"), relative, known_smali_paths)
                            if len(method_features) >= MAX_METHOD_FEATURES:
                                method_features_truncated = True
                                features, features_truncated = [], False
                            else:
                                features, features_truncated = method_instruction_features(raw.decode("utf-8", errors="replace"), relative)
                            method_features_truncated = method_features_truncated or features_truncated
                            destination = disassembly_root / relative
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            destination.write_bytes(raw)
                            disassembly_id = destination.relative_to(DERIVED_ROOT).as_posix()
                            paired = source_by_smali.get(relative.as_posix())
                            from_relative_path = paired["relativePath"] if paired is not None else relative.as_posix()
                            for feature in features:
                                feature["relativePath"] = from_relative_path
                                feature_bytes = len(json.dumps(feature, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
                                if len(method_features) >= MAX_METHOD_FEATURES or method_feature_bytes + feature_bytes > MAX_METHOD_FEATURE_BYTES:
                                    method_features_truncated = True
                                    break
                                method_features.append(feature)
                                method_feature_bytes += feature_bytes
                            for call in calls:
                                edge = {
                                    "fromRelativePath": from_relative_path,
                                    "toRelativePath": (source_by_smali.get(call["toClassPath"]) or {}).get("relativePath", call["toClassPath"]),
                                    **call,
                                }
                                identity = (edge["fromSignature"], edge["toSignature"])
                                if any((prior["fromSignature"], prior["toSignature"]) == identity for prior in call_edges):
                                    continue
                                edge_bytes = len(json.dumps(edge, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
                                if len(call_edges) >= MAX_CALL_EDGES or call_edge_bytes + edge_bytes > MAX_CALL_EDGE_BYTES:
                                    call_graph_truncated = True
                                    continue
                                call_edges.append(edge)
                                call_edge_bytes += edge_bytes
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
                if not units:
                    raise AnalysisError(log_text or "JADX and Apktool produced no viewable code or Android resource units")
                returned = units[:MAX_RETURNED_UNITS]
                if source_scan_truncated:
                    warnings.append(f"JADX produced more than {len(raw_sources)} Java source files; this run indexed the first {len(raw_sources)} in sorted path order.")
                if resource_scan_truncated:
                    warnings.append("Some Android resources were skipped because they were binary, oversized, or beyond the configured file limit.")
                if len(units) > len(returned):
                    warnings.append(f"Only the first {len(returned)} of {len(units)} discovered code units are available in the visualizer.")
                if call_graph_truncated:
                    warnings.append(f"The method call graph was limited to {len(call_edges)} direct call edges.")
                if method_features_truncated:
                    warnings.append(f"The Smali instruction index was limited to {len(method_features)} methods.")
                if log_text:
                    warnings.append(log_text[:4000])
                elif jadx_return_code:
                    warnings.append(f"JADX exited with code {jadx_return_code}.")
                returned_class_count = sum(unit.get("unitType") != "resource" for unit in returned)
                returned_resource_count = len(returned) - returned_class_count
                resource_count = sum(unit.get("unitType") == "resource" for unit in units)
                truncated = source_scan_truncated or resource_scan_truncated or len(units) > len(returned) or call_graph_truncated or method_features_truncated
                class_count = sum(unit.get("unitType") != "resource" for unit in units)
                return {"status": "completed", "toolVersion": "1.5.6", "apktoolVersion": "3.0.3" if input_path.suffix.lower() == ".apk" else None,
                        "apktoolProjectPath": apktool_project_path, "apktoolProjectBytes": apktool_project_bytes,
                        "classCount": None if source_scan_truncated else class_count,
                        "resourceCount": None if resource_scan_truncated else resource_count,
                        "javaClassCount": None if source_scan_truncated else total_files, "disassembledClassCount": disassembled_class_count,
                        "discoveredCodeUnitCount": None if truncated else len(units), "returnedCodeUnitCount": len(returned),
                        "returnedClassCount": returned_class_count, "returnedResourceCount": returned_resource_count,
                        "codeBytes": total_source_bytes + smali_total_bytes + indexed_resource_bytes,
                        "returnedUnits": len(returned), "truncated": truncated,
                        "calls": call_edges, "callCount": len(call_edges), "callGraphTruncated": call_graph_truncated,
                        "methods": method_features, "methodFeatureCount": len(method_features), "methodFeaturesTruncated": method_features_truncated,
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
        self._send(200, {"status": "ready", "provider": "jadx", "version": "1.5.6", "apktoolVersion": "3.0.3"})
    def do_POST(self):
        if self.path not in ("/analyze", "/rebuild"):
            self._send(404, {"error": "Not found"})
            return
        stream_started = False
        try:
            length = int(self.headers.get("Content-Length", "0"))
            limit = MAX_REBUILD_REQUEST_BYTES if self.path == "/rebuild" else 16 * 1024
            if length < 1 or length > limit:
                raise AnalysisError(f"Request body must be between 1 byte and {limit} bytes")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise AnalysisError("Request body must be an object")
            if self.path == "/rebuild":
                self._send(200, rebuild_apktool_project(body))
                return
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
