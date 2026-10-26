#!/usr/bin/env python3
"""Secret-free DEX-to-Java adapter; REAmon owns persistence and review state."""
from __future__ import annotations

import hashlib
import json
import os
import signal
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Callable
from uuid import uuid4

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
SCRATCH_ROOT = Path(os.environ.get("REAMON_SCRATCH_PATH", "/tmp")).resolve()
PORT = int(os.environ.get("PORT", "8019"))
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("DEX_DECOMPILER_TIMEOUT_SECONDS", "900"))))
MAX_OUTPUT_BYTES = min(1024**3, max(1024**2, int(os.environ.get("DEX_DECOMPILER_MAX_OUTPUT_BYTES", str(512 * 1024**2)))))
MAX_RETURNED_UNITS = min(80_000, max(1, int(os.environ.get("DEX_DECOMPILER_MAX_RETURNED_UNITS", "80_000"))))
MAX_SOURCE_FILES = 80_000
MAX_SOURCE_BYTES = 4 * 1024 * 1024
MAX_STRUCTURED_METHODS = 10_000
MAX_STRUCTURED_CALLS = 4_000
MAX_STRUCTURED_REFERENCES = 4_000
MAX_STRUCTURED_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_DEX_ENTRIES = 64
MAX_TOTAL_DEX_BYTES = 512 * 1024 * 1024
PROGRESS_CLASS_INTERVAL = 64


def clamp_class_batch_size(value: int) -> int:
    return min(256, max(1, value))


def should_report_class_batch(start: int, limit: int, discovered: int | None) -> bool:
    return limit > 1 or start % PROGRESS_CLASS_INTERVAL == 0 or (
        discovered is not None and start + limit >= discovered
    )


# Isolate class decompilation: the Rust process can retain substantial memory
# across classes, while its single-class retries recover panics and OOMs.
CLASS_BATCH_SIZE = clamp_class_batch_size(int(os.environ.get("DEX_DECOMPILER_CLASS_BATCH_SIZE", "1")))
CLASS_BATCH_TIMEOUT_SECONDS = min(
    600,
    max(30, int(os.environ.get("DEX_DECOMPILER_CLASS_BATCH_TIMEOUT_SECONDS", "60"))),
)
MAX_REQUEST_BYTES = 64 * 1024
TOOL_VERSION = "d458efd15d74351e83f4e8968c75ef17c71f3c65"
SAFE_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
SLOTS = threading.BoundedSemaphore(1)


class AnalysisError(Exception):
    pass


def is_dex_entry(name: str) -> bool:
    basename = PurePosixPath(name).name.lower()
    if basename == "classes.dex":
        return True
    return basename.startswith("classes") and basename.endswith(".dex") \
        and basename[7:-4].isdigit() and int(basename[7:-4]) >= 2


def extract_dex_inputs(source: Path, input_suffix: str, output_root: Path) -> list[tuple[Path, str]]:
    """Extract APK DEX entries so each one is decompiled in its own process."""
    if input_suffix != ".apk":
        return [(source, source.name)]

    try:
        with zipfile.ZipFile(source) as archive:
            entries = [info for info in archive.infolist() if not info.is_dir() and is_dex_entry(info.filename)]
            entries.sort(key=lambda info: (0 if PurePosixPath(info.filename).name.lower() == "classes.dex"
                                            else int(PurePosixPath(info.filename).name[7:-4])))
            if not entries:
                raise AnalysisError("APK contains no classes*.dex entries")
            if len(entries) > MAX_DEX_ENTRIES:
                raise AnalysisError(f"APK contains more than the {MAX_DEX_ENTRIES}-DEX analyzer limit")
            if sum(info.file_size for info in entries) > MAX_TOTAL_DEX_BYTES:
                raise AnalysisError("Uncompressed DEX inputs exceed the 512 MiB analyzer limit")

            output_root.mkdir(parents=True, exist_ok=True)
            extracted: list[tuple[Path, str]] = []
            total_bytes = 0
            for index, info in enumerate(entries):
                target = output_root / f"input-{index + 1:02}.dex"
                copied = 0
                with archive.open(info, "r") as input_stream, target.open("wb") as output_stream:
                    while chunk := input_stream.read(1024 * 1024):
                        copied += len(chunk)
                        total_bytes += len(chunk)
                        if copied > info.file_size or total_bytes > MAX_TOTAL_DEX_BYTES:
                            raise AnalysisError("APK DEX data exceeded its declared or configured size limit")
                        output_stream.write(chunk)
                if copied != info.file_size:
                    raise AnalysisError(f"APK DEX entry {info.filename} did not match its declared size")
                extracted.append((target, info.filename[:500]))
            return extracted
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise AnalysisError("Could not safely extract DEX entries from the APK") from error


def build_decompile_command(
    input_path: Path, mapping_path: Path | str, output_path: Path, start_index: int, class_limit: int,
    mode: str = "restructure",
) -> list[str]:
    """Use upstream's single-class slicer in a bounded process batch."""
    return [
        "/usr/local/bin/reamon-dex-batch", str(input_path), str(mapping_path), str(output_path),
        str(start_index), str(class_limit), mode,
    ]


def build_mapping_command(input_path: Path, mapping_path: Path) -> list[str]:
    """Accumulate a project map from one DEX at a time to bound parser memory."""
    return ["/usr/local/bin/reamon-dex-map", str(input_path), str(mapping_path)]


def parse_dex_inventory(stdout: bytes) -> int | None:
    """Read the class count emitted before map generation starts."""
    try:
        summary = json.loads(stdout.decode("utf-8", errors="strict").strip())
        count = summary.get("discoveredClassCount")
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        return None
    return count if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else None


def reconcile_dex_inventory(inventory_count: int | None, batch_count: int | None, dex_entry: str) -> int | None:
    """Keep independent parser inventory when a decompilation retry has no summary."""
    if batch_count is None:
        return inventory_count
    if inventory_count is not None and inventory_count != batch_count:
        raise AnalysisError(f"DEX class count changed between inventory and decompilation for {dex_entry}")
    return batch_count


def validate_failed_class_indices(summary: dict[str, object], failed: int, start: int, limit: int) -> list[int] | None:
    """Require an exact, in-range index for every class-level failure."""
    indices = summary.get("failedClassIndices")
    if not isinstance(indices, list) or len(indices) != failed:
        return None
    if any(not isinstance(index, int) or isinstance(index, bool) for index in indices):
        return None
    if len(set(indices)) != len(indices) or any(index < start or index >= start + limit for index in indices):
        return None
    return indices


def reconcile_class_retries(returned: int, failed: int, retry_results: list[tuple[int, int]]) -> tuple[int, int]:
    """Count successful retries once; an unrecovered class stays failed once."""
    for retry_returned, retry_failed in retry_results:
        if retry_returned > 0 and retry_failed == 0:
            returned += retry_returned
            failed -= 1
    return returned, failed


def recover_batch_class_failures(
    summary: dict[str, object],
    start: int,
    limit: int,
    retry_class: Callable[[int], tuple[int | None, int, int]],
) -> tuple[int, int, list[tuple[int | None, int, int]] | None]:
    """Retry indexed class-level failures and reconcile batch totals."""
    returned = summary["returnedClassCount"]
    failed = summary["failedClassCount"]
    if not isinstance(returned, int) or not isinstance(failed, int):
        return 0, 0, None
    failed_indices = validate_failed_class_indices(summary, failed, start, limit)
    if failed > 0 and failed_indices is None:
        return returned, failed, None
    retries = [retry_class(index) for index in failed_indices or []]
    totals = reconcile_class_retries(returned, failed, [(result[1], result[2]) for result in retries])
    return totals[0], totals[1], retries


def run_with_progress(command: list[str], timeout: int, message: str, progress=None, cwd: Path | None = None) -> subprocess.CompletedProcess[bytes]:
    """Run one bounded tool process while keeping long analyzer requests alive."""
    process = subprocess.Popen(
        command,
        cwd=cwd or os.getcwd(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    started = time.monotonic()
    try:
        while True:
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout)
            try:
                stdout, stderr = process.communicate(timeout=min(15, remaining))
                return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
            except subprocess.TimeoutExpired:
                elapsed = int(time.monotonic() - started)
                if progress:
                    progress(f"{message} · still working ({elapsed}s)")
    except subprocess.TimeoutExpired as error:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        stdout, stderr = process.communicate()
        raise subprocess.TimeoutExpired(command, timeout, output=stdout, stderr=stderr) from error
    except (BrokenPipeError, ConnectionResetError):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        process.communicate()
        raise


def safe_id(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 128 \
            or value[0] not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" \
            or any(char not in SAFE_ID_CHARS for char in value):
        raise AnalysisError("Invalid analysis identifier")
    return value


def create_analysis_tempdir() -> tempfile.TemporaryDirectory:
    """Create request scratch outside the memory-backed container /tmp when configured."""
    try:
        SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
        # SLOTS serializes requests. Any previous matching directory is therefore
        # an orphan left by a hard stop and safe to reclaim before this request.
        for stale in SCRATCH_ROOT.glob("reamon-dex-decompiler-*"):
            if stale.is_dir() and not stale.is_symlink():
                shutil.rmtree(stale, ignore_errors=True)
        return tempfile.TemporaryDirectory(prefix="reamon-dex-decompiler-", dir=SCRATCH_ROOT)
    except OSError as error:
        raise AnalysisError("DEX analyzer scratch storage is unavailable or full") from error


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
    return candidate


def detect_input_suffix(source: Path) -> str:
    # Artifact storage uses content-addressed filenames without extensions, so
    # identify Android inputs by their bytes and provide the CLI a useful suffix.
    try:
        if zipfile.is_zipfile(source):
            with zipfile.ZipFile(source) as archive:
                def is_dex_entry(name: str) -> bool:
                    basename = PurePosixPath(name).name.lower()
                    if basename == "classes.dex":
                        return True
                    return basename.startswith("classes") and basename.endswith(".dex") \
                        and basename[7:-4].isdigit()

                if any(is_dex_entry(name) for name in archive.namelist()):
                    return ".apk"
    except (OSError, zipfile.BadZipFile):
        pass

    try:
        with source.open("rb") as stream:
            magic = stream.read(8)
    except OSError as error:
        raise AnalysisError("Could not read the DEX input") from error
    if len(magic) == 8 and magic[:4] == b"dex\n" and magic[4:7].isdigit() and magic[7:] == b"\0":
        return ".dex"
    raise AnalysisError("This engine accepts APK and DEX inputs")


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


def analyse(body: dict[str, object], progress=None) -> dict[str, object]:
    project_id = safe_id(body.get("projectId"))
    artifact_id = safe_id(body.get("artifactId"))
    task_id = safe_id(body.get("taskId"))
    run_id = safe_id(body.get("runId"))
    source = resolve_input(body.get("artifactPath"))
    input_suffix = detect_input_suffix(source)
    artifact_hash = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            artifact_hash.update(chunk)

    with create_analysis_tempdir() as temporary:
        temporary_root = Path(temporary)
        compiler_input = temporary_root / f"input{input_suffix}"
        compiler_input.symlink_to(source)
        output_root = temporary_root / "java"
        output_root.mkdir()
        dex_inputs = extract_dex_inputs(
            compiler_input if input_suffix != ".apk" else source,
            input_suffix,
            temporary_root / "dex-inputs",
        )
        diagnostic_lines: list[str] = []
        discovered_classes = 0
        returned_classes = 0
        failed_classes = 0
        mapping_path = temporary_root / "deobfuscation.txt"
        mapping_path.parent.mkdir(parents=True, exist_ok=True)
        for dex_index, (dex_path, dex_entry) in enumerate(dex_inputs, start=1):
            inventory_count: int | None = None
            try:
                description = f"DEX {dex_index} of {len(dex_inputs)}"
                if progress:
                    progress(f"Building shared project names from {description}")
                mapping = run_with_progress(
                    build_mapping_command(dex_path, mapping_path),
                    TIMEOUT_SECONDS,
                    f"Building shared project names from {description}",
                    progress,
                    temporary_root,
                )
                inventory_count = parse_dex_inventory(mapping.stdout)
                if mapping.returncode != 0 or not mapping_path.is_file():
                    detail = mapping.stderr[-2000:].decode("utf-8", errors="replace").strip()
                    diagnostic_lines.append(
                        f"Generated-name mapping for {dex_entry} was unavailable; using names already collected from prior DEX files. "
                        f"{detail or f'exit {mapping.returncode}'}"
                    )
            except subprocess.TimeoutExpired:
                diagnostic_lines.append(
                    f"Generated-name mapping for {dex_entry} exceeded {TIMEOUT_SECONDS} seconds; "
                    "using names already collected from prior DEX files."
                )
            except OSError as error:
                diagnostic_lines.append(
                    f"Could not start the name mapper for {dex_entry}: {error}; "
                    "using names already collected from prior DEX files."
                )

            active_mapping: Path | str = mapping_path if mapping_path.is_file() else "-"
            offset = 0
            dex_discovered = inventory_count
            if dex_discovered is not None:
                discovered_classes += dex_discovered
            while dex_discovered is None or offset < dex_discovered:
                def retry_single_class(start: int, reason: str) -> tuple[int | None, int, int]:
                    for mode in ("simple", "fallback"):
                        description = f"Retrying DEX {dex_index} class {start + 1} with {mode} output"
                        try:
                            result = run_with_progress(
                                build_decompile_command(dex_path, active_mapping, output_root, start, 1, mode),
                                min(TIMEOUT_SECONDS, CLASS_BATCH_TIMEOUT_SECONDS),
                                description,
                                progress,
                                temporary_root,
                            )
                        except subprocess.TimeoutExpired:
                            diagnostic_lines.append(f"{description} exceeded the per-class time limit.")
                            continue
                        except OSError as error:
                            diagnostic_lines.append(f"{description} could not start: {error}.")
                            continue

                        stdout = result.stdout[-2000:].decode("utf-8", errors="replace").strip()
                        stderr = result.stderr[-2000:].decode("utf-8", errors="replace").strip()
                        if result.returncode != 0:
                            diagnostic_lines.append(
                                f"{description} failed with exit {result.returncode}"
                                + (f": {stderr or stdout}" if stderr or stdout else ".")
                            )
                            continue
                        try:
                            summary = json.loads(stdout)
                            discovered = summary.get("discoveredClassCount")
                            returned = summary.get("returnedClassCount")
                            failed = summary.get("failedClassCount")
                            if not all(isinstance(value, int) and value >= 0
                                       for value in (discovered, returned, failed)):
                                raise ValueError("invalid class counts")
                        except (json.JSONDecodeError, AttributeError, ValueError):
                            diagnostic_lines.append(f"{description} returned an invalid class summary.")
                            continue
                        if returned == 1 and failed == 0:
                            diagnostic_lines.append(
                                f"Class index {start} in {dex_entry} used {mode} output after {reason}."
                            )
                            return discovered, 1, 0
                    diagnostic_lines.append(
                        f"Class index {start} in {dex_entry} was skipped after {reason}; all output modes failed."
                    )
                    return None, 0, 1

                def run_range(start: int, limit: int) -> tuple[int | None, int, int]:
                    try:
                        description = f"DEX {dex_index} of {len(dex_inputs)} · classes {start + 1}–{start + limit}"
                        if progress and should_report_class_batch(start, limit, dex_discovered):
                            progress(f"Decompiling {description}")
                        result = run_with_progress(
                            build_decompile_command(dex_path, active_mapping, output_root, start, limit),
                            min(TIMEOUT_SECONDS, CLASS_BATCH_TIMEOUT_SECONDS),
                            f"Decompiling {description}",
                            progress,
                            temporary_root,
                        )
                    except subprocess.TimeoutExpired:
                        if limit == 1:
                            return retry_single_class(start, "structured decompilation exceeded the time limit")
                        left_limit = limit // 2
                        right_start = start + left_limit
                        left = run_range(start, left_limit)
                        right = run_range(right_start, limit - left_limit)
                        discovered = left[0] if left[0] is not None else right[0]
                        return discovered, left[1] + right[1], left[2] + right[2]
                    except OSError as error:
                        raise AnalysisError(f"Could not start the DEX decompiler for {dex_entry}: {error}") from error
                    stdout = result.stdout[-2000:].decode("utf-8", errors="replace").strip()
                    stderr = result.stderr[-2000:].decode("utf-8", errors="replace").strip()
                    if stderr:
                        diagnostic_lines.append(stderr)
                    if result.returncode == -9:
                        if limit == 1:
                            return retry_single_class(start, "structured decompilation exceeded the memory limit")
                        left_limit = limit // 2
                        right_start = start + left_limit
                        left = run_range(start, left_limit)
                        right = run_range(right_start, limit - left_limit)
                        discovered = left[0] if left[0] is not None else right[0]
                        return discovered, left[1] + right[1], left[2] + right[2]
                    if result.returncode != 0:
                        detail = stderr or stdout or f"DEX decompiler exited with code {result.returncode}"
                        if "panicked at" in detail or "thread 'main' panicked" in detail:
                            if limit == 1:
                                return retry_single_class(start, "structured decompilation panicked")
                            left_limit = limit // 2
                            right_start = start + left_limit
                            left = run_range(start, left_limit)
                            right = run_range(right_start, limit - left_limit)
                            discovered = left[0] if left[0] is not None else right[0]
                            return discovered, left[1] + right[1], left[2] + right[2]
                        raise AnalysisError(f"DEX decompilation of {dex_entry} failed: {detail[:1500]}")
                    try:
                        summary = json.loads(stdout)
                        discovered = summary.get("discoveredClassCount")
                        returned = summary.get("returnedClassCount")
                        failed = summary.get("failedClassCount")
                        if not all(isinstance(value, int) and value >= 0 for value in (discovered, returned, failed)):
                            raise ValueError("invalid class counts")
                    except (json.JSONDecodeError, AttributeError, ValueError) as error:
                        raise AnalysisError(f"DEX decompilation of {dex_entry} returned an invalid class summary") from error
                    batch_retries: list[tuple[int | None, int, int]] | None = []
                    if failed > 0:
                        returned, failed, batch_retries = recover_batch_class_failures(
                            summary,
                            start,
                            limit,
                            lambda failed_index: retry_single_class(
                                failed_index,
                                "structured decompilation returned a class-level error",
                            ),
                        )
                    if batch_retries is None:
                        diagnostic_lines.append(
                            f"Class failures in {dex_entry} did not include a complete index list; "
                            "those classes remain marked failed."
                        )
                    else:
                        for retry_discovered, _, _ in batch_retries:
                            if retry_discovered is not None and retry_discovered != discovered:
                                raise AnalysisError(f"DEX class count changed while retrying {dex_entry}")
                    return discovered, returned, failed

                discovered, returned, failed = run_range(offset, CLASS_BATCH_SIZE)
                previous_inventory = dex_discovered
                dex_discovered = reconcile_dex_inventory(dex_discovered, discovered, dex_entry)
                if previous_inventory is None and dex_discovered is not None:
                    discovered_classes += dex_discovered
                returned_classes += returned
                failed_classes += failed
                if dex_discovered is None and discovered is None:
                    raise AnalysisError(f"Could not inventory classes in {dex_entry} after a memory-limited batch")
                offset += CLASS_BATCH_SIZE
                if progress and (offset % PROGRESS_CLASS_INTERVAL == 0 or offset >= (dex_discovered or offset)):
                    progress(f"Decompiled {dex_entry}: {min(offset, dex_discovered or offset)} of {dex_discovered or offset} classes · {returned_classes} reconstructed so far")
        stderr = "\n".join(diagnostic_lines)[-4000:]
        sources, total_source_bytes, source_truncated = collect_sources(output_root)
        if not sources:
            detail = stderr or stdout
            raise AnalysisError(("DEX decompiler produced no Java source" + (f": {detail[:1000]}" if detail else "")))

        method_result: dict[str, object] = {"methods": [], "discoveredMethodCount": 0, "truncated": False}
        method_warning = ""
        method_evidence_root = temporary_root / "method-evidence"
        try:
            if progress:
                progress("Collecting method, call, and data reference evidence")
            structured = run_with_progress(
                ["/usr/local/bin/reamon-dex-structure", str(compiler_input), str(method_evidence_root)],
                TIMEOUT_SECONDS,
                "Collecting method and reference evidence",
                progress,
                temporary_root,
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
                output_sha256 = hashlib.sha256(target.read_bytes()).hexdigest()
                artifact_path = destination.joinpath(*relative.parts)
                code_artifact_id = artifact_path.relative_to(DERIVED_ROOT).as_posix()
                name = ".".join(relative.with_suffix("").parts)
                units.append({
                    "name": name[:500],
                    "relativePath": relative.as_posix()[:1000],
                    "codeArtifactId": code_artifact_id[:2000],
                    "sizeBytes": size,
                    "outputSha256": output_sha256,
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
        "discoveredClassCount": discovered_classes,
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
            f"The alternate output contains {len(units)} of {len(sources)} reconstructed Java files; the per-run result limit is {MAX_RETURNED_UNITS}." if len(sources) > len(units) else "",
            f"The DEX provider could not reconstruct {failed_classes} of {discovered_classes} classes." if failed_classes else "",
            method_warning,
            stderr[:2000],
        ]))[:4000],
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
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

    def _start_stream(self) -> None:
        self.send_response(200)
        self.send_header("content-type", "application/x-ndjson; charset=utf-8")
        self.send_header("transfer-encoding", "chunked")
        self.send_header("cache-control", "no-store")
        self.end_headers()

    def _stream_line(self, event: dict[str, object]) -> None:
        encoded = json.dumps(event, separators=(",", ":")).encode("utf-8") + b"\n"
        self.wfile.write(f"{len(encoded):X}\r\n".encode("ascii"))
        self.wfile.write(encoded)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def _stream_progress(self, message: str) -> None:
        self._stream_line({"type": "progress", "message": message[:500]})

    def _stream_result(self, result: dict[str, object]) -> None:
        array_fields = [field for field in ("units", "methods", "calls", "references") if isinstance(result.get(field), list)]
        metadata = {key: value for key, value in result.items() if key not in array_fields}
        self._stream_line({"type": "result_start", "data": metadata, "arrayFields": array_fields})
        for field in array_fields:
            items = result[field]
            assert isinstance(items, list)
            for start in range(0, len(items), 10):
                self._stream_line({"type": "result_chunk", "field": field, "items": items[start:start + 10]})
        self._stream_line({"type": "result_end"})

    def _finish_stream(self) -> None:
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

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
            self._start_stream()
            try:
                try:
                    result = analyse(body, self._stream_progress)
                    self._stream_result(result)
                except AnalysisError as error:
                    self._stream_line({"type": "error", "error": str(error)[:2000]})
                except (BrokenPipeError, ConnectionResetError):
                    return
                except Exception as error:
                    self.log_error("analysis failed: %s", error)
                    self._stream_line({"type": "error", "error": "DEX decompiler analysis failed"})
            except (BrokenPipeError, ConnectionResetError):
                return
            finally:
                try:
                    self._finish_stream()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                SLOTS.release()
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
