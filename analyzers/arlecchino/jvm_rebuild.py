"""Compile one reviewed Java class and replace it in a derived JAR."""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

ARTIFACT_ROOT = Path(os.environ.get("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts")).resolve()
DERIVED_ROOT = Path(os.environ.get("REAMON_DERIVED_PATH", "/data/reamon-derived")).resolve()
MAX_INPUT_BYTES = min(1024**3, max(1024**2, int(os.environ.get("ARLECCHINO_MAX_BINARY_BYTES", str(512 * 1024**2)))))
MAX_JAR_UNPACKED_BYTES = 1024**3
MAX_SOURCE_BYTES = 2 * 1024**2
MAX_CLASS_BYTES = 16 * 1024**2
MAX_COMPILED_BYTES = 64 * 1024**2
MAX_ENTRIES = 100_000
COMPILE_TIMEOUT_SECONDS = min(300, max(10, int(os.environ.get("ARLECCHINO_COMPILE_TIMEOUT_SECONDS", "120"))))
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
SAFE_SOURCE_PATH = re.compile(r"^(?!/)(?!.*(?:^|/)\.\.(?:/|$))[^\\\x00:]{1,1000}\.java$")
SIGNATURE_SUFFIXES = (".SF", ".RSA", ".DSA", ".EC")


class RebuildError(Exception):
    pass


class CompileDiagnostics(RebuildError):
    pass


def _identifier(value: object, field: str) -> str:
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise RebuildError(f"Invalid {field}")
    return value


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _input_jar(value: object) -> Path:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise RebuildError("Invalid artifact path")
    candidate = Path(value)
    if candidate.is_symlink():
        raise RebuildError("Artifact input must not be a symbolic link")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(ARTIFACT_ROOT)
    except (OSError, RuntimeError, ValueError) as error:
        raise RebuildError("Input must resolve to a file inside the read-only artifact volume") from error
    if not resolved.is_file() or resolved.suffix.lower() != ".jar":
        raise RebuildError("Source rebuild accepts JVM .jar artifacts only")
    if resolved.stat().st_size <= 0 or resolved.stat().st_size > MAX_INPUT_BYTES:
        raise RebuildError("Input JAR is empty or exceeds the configured size limit")
    return resolved


def _checked_output_path(project_id: str, artifact_id: str, task_id: str, build_id: str) -> tuple[Path, str]:
    relative = f"{project_id}/{artifact_id}/{task_id}/builds/{build_id}.jar"
    destination = DERIVED_ROOT / relative
    try:
        destination.resolve(strict=False).relative_to(DERIVED_ROOT)
        current = destination.parent
        while current != DERIVED_ROOT:
            if current.is_symlink():
                raise RebuildError("Derived output path must not contain symbolic links")
            current = current.parent
    except (OSError, RuntimeError, ValueError) as error:
        raise RebuildError("Derived output path is invalid") from error
    if destination.exists() or destination.is_symlink():
        raise RebuildError("JAR build identifier already exists")
    return destination, relative


def _strip_manifest_digests(data: bytes) -> bytes:
    """Remove signature digest attributes while preserving other manifest metadata."""
    text = data.decode("utf-8", errors="replace")
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    retained: list[str] = []
    drop_continuation = False
    for line in lines:
        if line.startswith(" "):
            if not drop_continuation:
                retained.append(line)
            continue
        drop_continuation = bool(re.match(r"^[A-Za-z0-9_-]*Digest(?:-[A-Za-z0-9_-]+)*\s*:", line, re.IGNORECASE))
        if not drop_continuation:
            retained.append(line)
    return ("\r\n".join(retained).rstrip("\r\n") + "\r\n").encode("utf-8")


def rebuild(body: dict[str, object]) -> dict[str, object]:
    project_id = _identifier(body.get("projectId"), "project identifier")
    artifact_id = _identifier(body.get("artifactId"), "artifact identifier")
    task_id = _identifier(body.get("taskId"), "task identifier")
    build_id = _identifier(body.get("buildId"), "build identifier")
    binary = _input_jar(body.get("artifactPath"))
    expected_hash = body.get("artifactSha256")
    if not isinstance(expected_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_hash.lower()):
        raise RebuildError("Input artifact hash is invalid")
    input_hash = _hash_file(binary)
    if input_hash != expected_hash.lower():
        raise RebuildError("Input JAR changed since its analysis run")

    relative_source = body.get("relativePath")
    source_code = body.get("sourceCode")
    if not isinstance(relative_source, str) or not SAFE_SOURCE_PATH.fullmatch(relative_source):
        raise RebuildError("Reviewed source path is invalid")
    if not isinstance(source_code, str) or not source_code.strip() or "\x00" in source_code:
        raise RebuildError("Reviewed Java source is empty or invalid")
    source_bytes = source_code.encode("utf-8")
    if len(source_bytes) > MAX_SOURCE_BYTES:
        raise RebuildError("Reviewed Java source exceeds the configured size limit")
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    expected_source_hash = body.get("sourceSha256")
    if not isinstance(expected_source_hash, str) or source_hash != expected_source_hash.lower():
        raise RebuildError("Reviewed source hash did not match the accepted review receipt")

    class_entry = relative_source[:-5] + ".class"
    if class_entry.endswith("/module-info.class") or class_entry.endswith("/package-info.class"):
        raise RebuildError("Module and package descriptor classes cannot be rebuilt as a single code unit")
    destination, output_relative = _checked_output_path(project_id, artifact_id, task_id, build_id)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_jar: Path | None = None

    try:
        with zipfile.ZipFile(binary, "r") as source_jar:
            infos = source_jar.infolist()
            if len(infos) > MAX_ENTRIES or len({info.filename for info in infos}) != len(infos):
                raise RebuildError("Input JAR has too many entries or duplicate entry names")
            total_unpacked = 0
            class_info = None
            signed = False
            for info in infos:
                if info.is_dir():
                    continue
                total_unpacked += info.file_size
                if info.file_size < 0 or info.file_size > MAX_JAR_UNPACKED_BYTES or total_unpacked > MAX_JAR_UNPACKED_BYTES:
                    raise RebuildError("Input JAR exceeds the configured unpacked-size limit")
                upper = info.filename.upper()
                leaf = upper.rsplit("/", 1)[-1]
                if upper.startswith("META-INF/") and (leaf.endswith(SIGNATURE_SUFFIXES) or leaf.startswith("SIG-")):
                    signed = True
                if upper.startswith("META-INF/VERSIONS/"):
                    raise RebuildError("Multi-release JARs are not supported by the single-class rebuild path")
                if info.filename == class_entry:
                    class_info = info
            if class_info is None:
                raise RebuildError(f"Input JAR does not contain {class_entry}")
            if class_info.file_size > MAX_CLASS_BYTES:
                raise RebuildError("Original class exceeds the configured size limit")
            class_bytes = source_jar.read(class_info)
            if len(class_bytes) < 8 or class_bytes[:4] != b"\xca\xfe\xba\xbe":
                raise RebuildError("Selected JAR entry is not a valid Java class file")
            class_major = int.from_bytes(class_bytes[6:8], "big")
            if class_major < 45:
                raise RebuildError("Selected class has an invalid Java class-file version")
            java_release = min(21, max(8, class_major - 44))
            if class_major > 65:
                raise RebuildError("The selected class targets a Java version newer than the bundled JDK 21 compiler")
            if signed:
                raise RebuildError("Signed JARs cannot be rebuilt yet; signing support is not configured")

            with tempfile.TemporaryDirectory(prefix="reamon-jvm-build-") as temporary:
                temp_root = Path(temporary)
                source_root = temp_root / "source"
                class_root = temp_root / "classes"
                source_path = source_root / relative_source
                source_path.parent.mkdir(parents=True, exist_ok=True)
                class_root.mkdir(parents=True)
                source_path.write_bytes(source_bytes)
                command = ["javac", "--release", str(java_release), "-proc:none", "-implicit:none",
                           "-encoding", "UTF-8", "-classpath", str(binary), "-d", str(class_root), str(source_path)]
                environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(temp_root),
                               "TMPDIR": str(temp_root), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
                try:
                    compile_result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                                    stderr=subprocess.STDOUT, timeout=COMPILE_TIMEOUT_SECONDS,
                                                    env=environment, check=False)
                except subprocess.TimeoutExpired as error:
                    raise CompileDiagnostics(f"javac exceeded {COMPILE_TIMEOUT_SECONDS} seconds") from error
                compiler_output = compile_result.stdout.decode("utf-8", errors="replace")[-32_000:].strip()
                if compile_result.returncode != 0:
                    raise CompileDiagnostics(compiler_output or "javac rejected the reviewed source")

                compiled: list[tuple[Path, str, int]] = []
                total_compiled = 0
                for current, _dirs, files in os.walk(class_root, followlinks=False):
                    for filename in files:
                        path = Path(current) / filename
                        if path.is_symlink() or path.suffix.lower() != ".class":
                            continue
                        archive_name = path.relative_to(class_root).as_posix()
                        class_prefix = class_entry[:-6] + "$"
                        if archive_name != class_entry and not archive_name.startswith(class_prefix):
                            raise RebuildError("Reviewed source generated classes outside the selected top-level class")
                        size = path.stat().st_size
                        total_compiled += size
                        if size <= 0 or size > MAX_CLASS_BYTES or total_compiled > MAX_COMPILED_BYTES:
                            raise RebuildError("Compiled class output exceeded the configured size limit")
                        data = path.read_bytes()
                        if len(data) < 8 or data[:4] != b"\xca\xfe\xba\xbe":
                            raise RebuildError("javac produced an invalid class file")
                        compiled.append((path, archive_name, size))
                if not any(name == class_entry for _path, name, _size in compiled):
                    raise RebuildError(f"javac did not produce the selected class {class_entry}")

                replacement_names = {name for _path, name, _size in compiled}
                temporary_jar = destination.with_suffix(".jar.tmp")
                with zipfile.ZipFile(temporary_jar, "w", allowZip64=True) as rebuilt:
                    rebuilt.comment = source_jar.comment
                    for info in infos:
                        if info.filename in replacement_names:
                            continue
                        if info.filename.upper() == "META-INF/MANIFEST.MF":
                            if info.file_size > 2 * 1024 * 1024:
                                raise RebuildError("Input JAR manifest exceeds the configured limit")
                            with source_jar.open(info, "r") as source_entry:
                                rebuilt.writestr(info, _strip_manifest_digests(source_entry.read()))
                        else:
                            with source_jar.open(info, "r") as source_entry, rebuilt.open(info, "w") as output_entry:
                                shutil.copyfileobj(source_entry, output_entry, length=1024 * 1024)
                    for path, archive_name, _size in sorted(compiled, key=lambda item: item[1]):
                        rebuilt.write(path, archive_name, compress_type=zipfile.ZIP_DEFLATED)
                os.replace(temporary_jar, destination)
    except Exception as error:
        if temporary_jar is not None:
            temporary_jar.unlink(missing_ok=True)
        if isinstance(error, RebuildError):
            raise
        if isinstance(error, (zipfile.BadZipFile, OSError, RuntimeError)):
            raise RebuildError(f"Could not rebuild the source JAR: {type(error).__name__}") from error
        raise

    if hash_file(binary) != input_hash:
        destination.unlink(missing_ok=True)
        raise RebuildError("Input JAR changed during compilation")
    output_hash = _hash_file(destination)
    output_size = destination.stat().st_size
    if output_size <= 0 or output_size > MAX_INPUT_BYTES:
        destination.unlink(missing_ok=True)
        raise RebuildError("Rebuilt JAR exceeds the configured output limit")
    return {
        "status": "completed",
        "buildId": build_id,
        "outputPath": output_relative,
        "sha256": output_hash,
        "sizeBytes": output_size,
        "inputSha256": input_hash,
        "sourceSha256": source_hash,
        "relativePath": relative_source,
        "classEntry": class_entry,
        "changedClassCount": len(compiled),
        "removedClassCount": 0,
        "javaRelease": java_release,
        "compilerVersion": subprocess.run(["javac", "-version"], stdout=subprocess.PIPE,
                                           stderr=subprocess.STDOUT, timeout=5, check=False).stdout.decode(
                                               "utf-8", errors="replace").strip()[:120],
        "warnings": "The derived JAR is unsigned. Newly compiled classes for the selected source replaced matching entries; pre-existing nested class entries absent from this compilation are retained. Compilation proves compatibility with this JAR classpath, not runtime equivalence.",
        "diagnostics": compiler_output[:8000],
    }
