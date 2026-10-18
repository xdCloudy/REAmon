#!/usr/bin/env python3
"""Isolated Vineflower JVM decompiler adapter."""
from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
PORT = int(os.environ.get("PORT", "8021"))
TIMEOUT_SECONDS = min(1800, max(60, int(os.environ.get("VINEFLOWER_TIMEOUT_SECONDS", "900"))))
MAX_OUTPUT_BYTES = min(1024**3, max(1024**2, int(os.environ.get("VINEFLOWER_MAX_OUTPUT_BYTES", str(512 * 1024**2)))))
MAX_SOURCE_FILES = min(50000, max(1, int(os.environ.get("VINEFLOWER_MAX_SOURCE_FILES", "20000"))))
MAX_REQUEST_BYTES = 64 * 1024
MAX_LOG_BYTES = 128 * 1024
JAVA_DEOBFUSCATOR_REVISION = "bdde461b5aaf762f3b35d410ac76d850da5dd7a1"
JAVA_DEOBFUSCATOR_SHA256 = "23ba5d13ee632bc941c68f4dff24d7313881ae8754a10270a3d0c1dfde2be283"
STATIC_FLOW_TRANSFORMER = "allatori.FlowObfuscationTransformer"
STATIC_FLOW_TIMEOUT_SECONDS = min(300, max(30, int(os.environ.get("VINEFLOWER_STATIC_FLOW_TIMEOUT_SECONDS", "180"))))
STATIC_FLOW_MAX_INPUT_BYTES = min(128 * 1024 * 1024, max(1, int(os.environ.get("VINEFLOWER_STATIC_FLOW_MAX_INPUT_BYTES", str(64 * 1024 * 1024)))))
STATIC_FLOW_MAX_ENTRIES = min(50_000, max(1, int(os.environ.get("VINEFLOWER_STATIC_FLOW_MAX_ENTRIES", "20000"))))
STATIC_FLOW_MAX_EXPANDED_BYTES = min(1024**3, max(1024**2, int(os.environ.get("VINEFLOWER_STATIC_FLOW_MAX_EXPANDED_BYTES", str(512 * 1024 * 1024)))))
STATIC_FLOW_MAX_OUTPUT_BYTES = min(512 * 1024 * 1024, max(1024**2, int(os.environ.get("VINEFLOWER_STATIC_FLOW_MAX_OUTPUT_BYTES", str(256 * 1024 * 1024)))))
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
    if not path.is_file() or path.suffix.lower() not in {".class", ".jar"}:
        raise AnalysisError("Vineflower accepts JVM .class and .jar artifacts only")
    return path


def output_bytes(root: Path) -> int:
    total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
        for name in files:
            path = Path(directory) / name
            if path.is_symlink():
                continue
            try:
                total += path.stat().st_size
            except OSError:
                continue
    return total


def run_vineflower(binary: Path, output: Path, timeout_seconds: int = TIMEOUT_SECONDS) -> tuple[str, bool]:
    log_path = output.parent / "vineflower.log"
    command = [
        "java", f"-Xmx{os.environ.get('VINEFLOWER_JAVA_HEAP', '2g')}",
        "-jar", "/opt/vineflower/vineflower.jar", "--log-level=warn", "--folder", str(binary), str(output),
    ]
    started = time.monotonic()
    with log_path.open("wb") as log_file:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT,
            cwd=output.parent, env={**os.environ, "HOME": str(output.parent / "home"), "TMPDIR": str(output.parent / "tmp")},
            start_new_session=True,
        )
        try:
            next_size_check = started
            while process.poll() is None:
                if time.monotonic() - started > timeout_seconds:
                    process.kill()
                    process.wait()
                    raise AnalysisError(f"Vineflower exceeded {timeout_seconds} seconds")
                if log_path.stat().st_size > MAX_LOG_BYTES:
                    process.kill()
                    process.wait()
                    raise AnalysisError("Vineflower diagnostics exceeded the configured limit")
                if time.monotonic() >= next_size_check:
                    if output.exists() and output_bytes(output) > MAX_OUTPUT_BYTES:
                        process.kill()
                        process.wait()
                        raise AnalysisError("Vineflower output exceeded the configured storage limit")
                    next_size_check = time.monotonic() + 1
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    detail = log_path.read_text(encoding="utf-8", errors="replace")[-MAX_LOG_BYTES:].strip()
    if process.returncode != 0:
        raise AnalysisError(detail or f"Vineflower exited with code {process.returncode}")
    return detail, False


def preflight_jar(binary: Path, max_archive_bytes: int = STATIC_FLOW_MAX_INPUT_BYTES) -> tuple[int, int]:
    if binary.stat().st_size > max_archive_bytes:
        raise AnalysisError("JAR exceeds the optional Java flow-cleanup archive limit")
    try:
        with zipfile.ZipFile(binary) as archive:
            entries = archive.infolist()
            if not entries or len(entries) > STATIC_FLOW_MAX_ENTRIES:
                raise AnalysisError("JAR entry count is outside the optional Java flow-cleanup limit")
            expanded_bytes = sum(entry.file_size for entry in entries)
            class_count = sum(entry.filename.endswith(".class") for entry in entries)
            if expanded_bytes > STATIC_FLOW_MAX_EXPANDED_BYTES or class_count > STATIC_FLOW_MAX_ENTRIES:
                raise AnalysisError("JAR expanded size is outside the optional Java flow-cleanup limit")
            return len(entries), class_count
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise AnalysisError("Input is not a readable JAR archive") from error


def run_static_flow_cleanup(binary: Path, work: Path) -> tuple[Path | None, int, str]:
    if binary.suffix.lower() != ".jar":
        return None, 0, "Static Allatori flow cleanup applies to JAR inputs only."
    try:
        preflight_jar(binary)
    except AnalysisError as error:
        return None, 0, str(error)

    shutil.copyfile(binary, work / "input.jar")
    (work / "deobfuscator.yml").write_text(
        "input: input.jar\noutput: allatori-flow.jar\ntransformers:\n  - allatori.FlowObfuscationTransformer\n",
        encoding="utf-8",
    )
    log_path = work / "java-deobfuscator.log"
    command = [
        "java", "-Xmx1g", "-jar", "/opt/java-deobfuscator/deobfuscator.jar",
        "--config", "deobfuscator.yml",
    ]
    started = time.monotonic()
    with log_path.open("wb") as log_file:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT,
            cwd=work, env={**os.environ, "HOME": str(work / "home"), "TMPDIR": str(work / "tmp")},
            start_new_session=True,
        )
        try:
            while process.poll() is None:
                if time.monotonic() - started > STATIC_FLOW_TIMEOUT_SECONDS:
                    process.kill()
                    process.wait()
                    raise AnalysisError(f"Java static flow cleanup exceeded {STATIC_FLOW_TIMEOUT_SECONDS} seconds")
                if log_path.stat().st_size > MAX_LOG_BYTES:
                    process.kill()
                    process.wait()
                    raise AnalysisError("Java static flow cleanup diagnostics exceeded the configured limit")
                output_path = work / "allatori-flow.jar"
                if output_path.exists() and output_path.stat().st_size > STATIC_FLOW_MAX_OUTPUT_BYTES:
                    process.kill()
                    process.wait()
                    raise AnalysisError("Java static flow cleanup output exceeded the configured limit")
                try:
                    process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    detail = log_path.read_text(encoding="utf-8", errors="replace")[-MAX_LOG_BYTES:].strip()
    if process.returncode != 0:
        return None, 0, (detail or f"Java deobfuscator exited with code {process.returncode}")[:4000]
    match = re.search(r"\[Allatori\] \[FlowObfuscationTransformer\] Fixed (\d+) instructions", detail)
    fixed_count = int(match.group(1)) if match else 0
    output_path = work / "allatori-flow.jar"
    if not output_path.is_file():
        return None, 0, "Java deobfuscator did not produce its expected JAR output."
    if not fixed_count:
        return None, 0, "Allatori flow cleanup found no supported instruction patterns."
    try:
        preflight_jar(output_path, STATIC_FLOW_MAX_OUTPUT_BYTES)
    except AnalysisError as error:
        return None, 0, f"Transformed JAR did not pass archive bounds: {error}"
    if output_path.stat().st_size > STATIC_FLOW_MAX_OUTPUT_BYTES:
        return None, 0, "Java static flow cleanup output exceeded the configured limit."
    return output_path, fixed_count, detail[:4000]


def analyze(body: dict[str, object]) -> dict[str, object]:
    if not SLOTS.acquire(blocking=False):
        raise AnalysisError("The Vineflower analyzer is busy")
    try:
        project_id = safe_id(body.get("projectId"))
        artifact_id = safe_id(body.get("artifactId"))
        task_id = safe_id(body.get("taskId"))
        run_id = safe_id(body.get("runId"))
        binary = resolve_input(body.get("artifactPath"))
        input_sha256 = hashlib.sha256()
        with binary.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                input_sha256.update(chunk)
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

        with tempfile.TemporaryDirectory(prefix="reamon-vineflower-") as temporary:
            temporary_root = Path(temporary)
            (temporary_root / "home").mkdir()
            (temporary_root / "tmp").mkdir()
            units: list[dict[str, object]] = []
            warnings: list[str] = []
            total_bytes = 0
            discovered_source_file_count = 0
            truncated = False
            transform_relative: str | None = None
            transform_sha256: str | None = None
            transform_fixed_count = 0
            transform_warning = ""

            def collect_sources(generated_root: Path, source_root: str, variant: str) -> None:
                nonlocal total_bytes, discovered_source_file_count, truncated
                stop_scanning = False
                for directory, dirs, filenames in os.walk(generated_root, followlinks=False):
                    dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
                    for filename in sorted(filenames):
                        source = Path(directory) / filename
                        if source.is_symlink() or source.suffix.lower() not in {".java", ".kt"}:
                            continue
                        discovered_source_file_count += 1
                        relative = source.relative_to(generated_root).as_posix()
                        try:
                            size = source.stat().st_size
                        except OSError:
                            continue
                        if size > 16 * 1024 * 1024:
                            truncated = True
                            continue
                        if total_bytes + size > MAX_OUTPUT_BYTES or len(units) >= MAX_SOURCE_FILES:
                            truncated = True
                            stop_scanning = True
                            break
                        destination = run_root / source_root / relative
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.resolve().relative_to(run_root.resolve())
                        output_digest = hashlib.sha256()
                        with source.open("rb") as source_file, destination.open("wb") as output_file:
                            for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                                output_file.write(chunk)
                                output_digest.update(chunk)
                        unit: dict[str, object] = {
                            "name": Path(relative).stem,
                            "relativePath": relative,
                            "sourceRoot": source_root,
                            "sourceVariant": variant,
                            "codeArtifactId": f"{project_id}/{artifact_id}/{task_id}/{run_id}/{source_root}/{relative}",
                            "language": "Kotlin" if relative.lower().endswith(".kt") else "Java",
                            "sizeBytes": size,
                            "outputSha256": output_digest.hexdigest(),
                        }
                        if variant == "allatori-flow" and transform_relative and transform_sha256:
                            unit.update({
                                "preprocessor": "Java Deobfuscator Allatori FlowObfuscationTransformer",
                                "preprocessorRevision": JAVA_DEOBFUSCATOR_REVISION,
                                "preprocessorArtifactId": transform_relative,
                                "preprocessorSha256": transform_sha256,
                                "preprocessorFixedInstructionCount": transform_fixed_count,
                                "preprocessorSemantics": "Static bytecode-pattern cleanup; target application code was not executed.",
                            })
                        units.append(unit)
                        total_bytes += size
                    if stop_scanning:
                        break

            baseline_root = temporary_root / "sources-baseline"
            baseline_root.mkdir()
            baseline_log, _ = run_vineflower(binary, baseline_root)
            if baseline_log:
                warnings.append(baseline_log[:4000])
            collect_sources(baseline_root, "sources", "baseline")
            if not any(unit["sourceVariant"] == "baseline" for unit in units):
                raise AnalysisError("Vineflower did not produce any Java or Kotlin source files")

            try:
                transformed_jar, transform_fixed_count, transform_warning = run_static_flow_cleanup(binary, temporary_root)
                if transformed_jar is not None and transform_fixed_count > 0:
                    alternate_root = temporary_root / "sources-allatori-flow"
                    alternate_root.mkdir()
                    alternate_log, _ = run_vineflower(transformed_jar, alternate_root, min(600, TIMEOUT_SECONDS))
                    if alternate_log:
                        warnings.append(alternate_log[:4000])
                    collect_sources(alternate_root, "sources-allatori-flow", "allatori-flow")
                    if any(unit["sourceVariant"] == "allatori-flow" for unit in units):
                        transform_relative = f"{project_id}/{artifact_id}/{task_id}/{run_id}/transforms/java-deobfuscator/allatori-flow.jar"
                        transform_path = run_root / "transforms" / "java-deobfuscator" / "allatori-flow.jar"
                        transform_path.parent.mkdir(parents=True, exist_ok=True)
                        transform_path.resolve().relative_to(run_root.resolve())
                        shutil.copyfile(transformed_jar, transform_path)
                        digest = hashlib.sha256()
                        with transform_path.open("rb") as transformed_file:
                            for chunk in iter(lambda: transformed_file.read(1024 * 1024), b""):
                                digest.update(chunk)
                        transform_sha256 = digest.hexdigest()
                        for unit in units:
                            if unit["sourceVariant"] == "allatori-flow":
                                unit.update({
                                    "preprocessor": "Java Deobfuscator Allatori FlowObfuscationTransformer",
                                    "preprocessorRevision": JAVA_DEOBFUSCATOR_REVISION,
                                    "preprocessorArtifactId": transform_relative,
                                    "preprocessorSha256": transform_sha256,
                                    "preprocessorFixedInstructionCount": transform_fixed_count,
                                    "preprocessorSemantics": "Static bytecode-pattern cleanup; target application code was not executed.",
                                })
                    else:
                        transform_warning = "Allatori flow cleanup changed bytecode, but no alternate source units fit the configured output limits."
                        warnings.append(transform_warning)
                elif transform_warning:
                    warnings.append(transform_warning[:4000])
            except Exception as error:  # Optional alternate path must not discard baseline source.
                units[:] = [unit for unit in units if unit["sourceVariant"] != "allatori-flow"]
                alternate_dir = run_root / "sources-allatori-flow"
                if alternate_dir.exists():
                    shutil.rmtree(alternate_dir)
                transform_dir = run_root / "transforms" / "java-deobfuscator"
                if transform_dir.exists():
                    shutil.rmtree(transform_dir)
                transform_fixed_count = 0
                transform_relative = None
                transform_sha256 = None
                transform_warning = str(error)[:2000]
                warnings.append(f"Optional Allatori static flow cleanup was unavailable: {transform_warning}")

        return {
            "status": "completed",
            "toolVersion": "1.12.0",
            "inputName": binary.name,
            "artifactSha256": input_sha256.hexdigest(),
            "sourceFileCount": discovered_source_file_count,
            "codeBytes": total_bytes,
            "truncated": truncated,
            "units": units,
            "warnings": "Vineflower output is reconstructed evidence, not proof of original source or behavior. " + " ".join(warnings)[:6000],
            "staticFlowCleanup": {
                "status": "applied" if transform_relative else "not_applied",
                "transformer": STATIC_FLOW_TRANSFORMER,
                "upstream": "opastorello/deobfuscator",
                "upstreamRevision": JAVA_DEOBFUSCATOR_REVISION,
                "upstreamSha256": JAVA_DEOBFUSCATOR_SHA256,
                "artifactId": transform_relative,
                "outputSha256": transform_sha256,
                "outputBytes": (run_root / "transforms" / "java-deobfuscator" / "allatori-flow.jar").stat().st_size if transform_relative else None,
                "fixedInstructionCount": transform_fixed_count,
                "warning": transform_warning[:2000],
                "targetCodeExecuted": False,
            },
        }
    finally:
        SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "reamon-vineflower/1"

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ready","provider":"vineflower","version":"1.12.0"}')

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise AnalysisError("Request body is empty or exceeds the size limit")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise AnalysisError("Request body must be a JSON object")
            response = analyze(body)
            self.send_json(200, response)
        except (AnalysisError, ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)[:2000]})
        except Exception:
            self.send_json(500, {"error": "Vineflower analysis failed"})

    def send_json(self, status: int, body: dict[str, object]) -> None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        print("vineflower-analyzer: " + format % args, flush=True)


if __name__ == "__main__":
    DERIVED_ROOT.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
