"""Offline, hash-bound compilation for reviewer-accepted Go project files."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path, PurePosixPath
from typing import Any

MAX_FILES = 64
MAX_FILE_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_PACKAGES = 64
MAX_DIAGNOSTICS = 20


class GoProjectBuildError(ValueError):
    """The Go project input is incomplete or unsafe to compile."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_go_path(value: str) -> str:
    if (not value or len(value) > 200 or "\\" in value or value.startswith("/")
            or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}", value)
            or any(part in {"", ".", ".."} for part in value.split("/"))
            or not value.endswith(".go")):
        raise GoProjectBuildError("Go project paths must be safe relative .go paths")
    return value


def _write_file(root: Path, relative_path: str, content: bytes) -> None:
    destination = root.joinpath(*PurePosixPath(relative_path).parts)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)


def _diagnostics(data: bytes) -> str:
    return re.sub(r"[\r\n\t ]+", " ", data.decode("utf-8", errors="replace").replace("\x00", " ")).strip()[:1800]


def _dependency_receipts(go_mod: str, go_sum: str) -> list[dict[str, str]]:
    return [
        entry for entry in (
            {"path": "go.mod", "source_sha256": _sha256(go_mod.encode("utf-8"))} if go_mod else None,
            {"path": "go.sum", "source_sha256": _sha256(go_sum.encode("utf-8"))} if go_sum else None,
        ) if entry is not None
    ]


def _dependency_set_hash(dependencies: list[dict[str, str]]) -> str:
    ordered = sorted(dependencies, key=lambda item: item["path"])
    data = b"".join(item["path"].encode() + b"\0" + item["source_sha256"].encode("ascii") + b"\n" for item in ordered)
    return _sha256(data)


def compile_go_project(
    files: list[dict[str, Any]],
    *,
    go_mod: str = "",
    go_mod_sha256: str = "",
    go_sum: str = "",
    go_sum_sha256: str = "",
    timeout_seconds: int = 30,
) -> dict[str, Any]:
    """Compile the accepted files together, without module downloads or execution."""
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise GoProjectBuildError(f"A Go project build must contain between 1 and {MAX_FILES} files")

    seen_paths: set[str] = set()
    source_hashes: list[tuple[str, str]] = []
    normalized_files: list[tuple[str, bytes]] = []
    total_bytes = 0
    for item in files:
        if not isinstance(item, dict):
            raise GoProjectBuildError("Go project file entries must be objects")
        path = _safe_go_path(str(item.get("relative_path", "")))
        key = path.casefold()
        if key in seen_paths:
            raise GoProjectBuildError("Go project file paths must be unique")
        seen_paths.add(key)
        code = item.get("source_code")
        expected = str(item.get("expected_sha256", "")).lower()
        if not isinstance(code, str):
            raise GoProjectBuildError(f"Go project file {path} has no source text")
        encoded = code.encode("utf-8")
        if len(encoded) > MAX_FILE_BYTES:
            raise GoProjectBuildError(f"Go project file {path} exceeds the 512 KiB limit")
        total_bytes += len(encoded)
        if total_bytes > MAX_TOTAL_BYTES:
            raise GoProjectBuildError("The Go project exceeds the 8 MiB combined source limit")
        actual = _sha256(encoded)
        if not re.fullmatch(r"[a-f0-9]{64}", expected) or not hmac.compare_digest(actual, expected):
            raise GoProjectBuildError(f"The source hash does not match project file {path}")
        normalized_files.append((path, encoded))
        source_hashes.append((path, actual))

    if len(go_mod.encode("utf-8")) > MAX_MANIFEST_BYTES or len(go_sum.encode("utf-8")) > MAX_MANIFEST_BYTES:
        raise GoProjectBuildError("Go module manifests must be at most 1 MiB each")
    if go_mod:
        if not re.fullmatch(r"[a-f0-9]{64}", go_mod_sha256.lower()) or _sha256(go_mod.encode("utf-8")) != go_mod_sha256.lower():
            raise GoProjectBuildError("The go.mod hash does not match the imported module manifest")
    elif go_mod_sha256:
        raise GoProjectBuildError("A go.mod hash was provided without a module manifest")
    if go_sum:
        if not go_mod:
            raise GoProjectBuildError("A go.sum manifest requires its matching go.mod")
        if not re.fullmatch(r"[a-f0-9]{64}", go_sum_sha256.lower()) or _sha256(go_sum.encode("utf-8")) != go_sum_sha256.lower():
            raise GoProjectBuildError("The go.sum hash does not match the imported module manifest")
    elif go_sum_sha256:
        raise GoProjectBuildError("A go.sum hash was provided without a checksum manifest")

    ordered_hashes = sorted(source_hashes)
    hash_input = b"".join(path.encode() + b"\0" + digest.encode("ascii") + b"\n" for path, digest in ordered_hashes)
    project_hash = _sha256(hash_input)
    dependencies = _dependency_receipts(go_mod, go_sum)
    dependency_hash = _dependency_set_hash(dependencies)
    go_binary = shutil.which("go")
    if not go_binary:
        return {
            "source_sha256": project_hash,
            "dependency_sha256": dependency_hash,
            "validation_status": "UNAVAILABLE",
            "validation_method": "go-project-build",
            "validation_message": "The Go toolchain is not installed in the analysis service.",
            "compiler_version": "unknown",
            "compiled_sha256": None,
            "package_count": 0,
            "file_count": len(ordered_hashes),
            "files": [{"relative_path": path, "source_sha256": digest} for path, digest in ordered_hashes],
            "dependencies": [],
        }

    deadline = time.monotonic() + timeout_seconds
    with tempfile.TemporaryDirectory(prefix="reamon-go-project-") as temp_dir:
        root = Path(temp_dir)
        for path, content in normalized_files:
            _write_file(root, path, content)
        if go_mod:
            _write_file(root, "go.mod", go_mod.encode("utf-8"))
            if go_sum:
                _write_file(root, "go.sum", go_sum.encode("utf-8"))
        else:
            _write_file(root, "go.mod", b"module reamon.local/maintained\n\ngo 1.24\n")
        default_gopath = os.environ.get("GOPATH", "/root/go").split(os.pathsep)[0]
        module_cache = os.environ.get("REAMON_GO_MODULE_CACHE") or os.path.join(default_gopath, "pkg", "mod")
        Path(module_cache).mkdir(parents=True, exist_ok=True)

        environment = {
            "PATH": os.environ.get("PATH", "/usr/local/go/bin:/usr/bin:/bin"),
            "HOME": str(root / "home"),
            "GOENV": "off",
            "GOWORK": "off",
            "GOTOOLCHAIN": "local",
            "GOPROXY": "off",
            "GOSUMDB": "off",
            "GOVCS": "*:off",
            "CGO_ENABLED": "0",
            "GOFLAGS": "-mod=readonly",
            "GOCACHE": str(root / "cache"),
            "GOMODCACHE": module_cache,
            "GOPATH": str(root / "gopath"),
            "GOTMPDIR": str(root / "tmp"),
        }
        for directory in (environment["HOME"], environment["GOCACHE"], environment["GOPATH"], environment["GOTMPDIR"]):
            Path(directory).mkdir(parents=True, exist_ok=True)

        try:
            version_result = subprocess.run(
                [go_binary, "version"], cwd=root, env=environment,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                timeout=5, check=False,
            )
            version_lines = version_result.stdout.decode("utf-8", errors="replace").splitlines()
            version_match = re.search(r"^go version go(\d+\.\d+(?:\.\d+)?)", version_lines[0] if version_lines else "")
            if version_result.returncode != 0 or not version_match:
                raise GoProjectBuildError("The installed Go compiler version could not be determined")
            compiler_version = version_match.group(1)

            module_result = subprocess.run(
                [go_binary, "mod", "edit", "-json"], cwd=root, env=environment,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=5, check=False,
            )
            if module_result.returncode != 0:
                raise GoProjectBuildError("The Go module manifest is invalid")
            try:
                module = json.loads(module_result.stdout)
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise GoProjectBuildError("The Go module manifest could not be safely parsed") from exc
            module_path = module.get("Module", {}).get("Path") if isinstance(module, dict) else None
            if not isinstance(module_path, str) or not module_path:
                raise GoProjectBuildError("The Go module manifest must declare a module path")
            replacements = module.get("Replace", []) if isinstance(module, dict) else []
            for replacement in replacements or []:
                target = replacement.get("New", {}) if isinstance(replacement, dict) else {}
                target_path = target.get("Path", "") if isinstance(target, dict) else ""
                if target_path.startswith((".", "/")) or re.match(r"^[A-Za-z]:[\\/]", target_path):
                    raise GoProjectBuildError("Local path replacements are not supported in isolated Go project builds")

            packages_result = subprocess.run(
                [go_binary, "list", "-f", "{{.ImportPath}}", "./..."], cwd=root, env=environment,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=max(0.1, deadline - time.monotonic()), check=False,
            )
            if packages_result.returncode != 0:
                message = _diagnostics(packages_result.stderr or packages_result.stdout)
                unavailable = any(marker in message.lower() for marker in (
                    "module lookup disabled", "no required module provides package", "missing go.sum entry",
                    "updates to go.mod needed", "cannot find module providing package",
                ))
                return {
                    "source_sha256": project_hash,
                    "dependency_sha256": dependency_hash,
                    "validation_status": "UNAVAILABLE" if unavailable else "FAILED",
                    "validation_method": f"go-{compiler_version}-project-build",
                    "validation_message": f"Go {compiler_version} could not resolve project packages: {message or 'go list failed without diagnostics'}",
                    "compiler_version": compiler_version,
                    "compiled_sha256": None,
                    "package_count": 0,
                    "file_count": len(ordered_hashes),
                    "files": [{"relative_path": path, "source_sha256": digest} for path, digest in ordered_hashes],
                    "dependencies": dependencies,
                }
            packages = [line for line in packages_result.stdout.decode("utf-8", errors="replace").splitlines() if line]
            if not packages or len(packages) > MAX_PACKAGES:
                raise GoProjectBuildError(f"A Go project build must contain between 1 and {MAX_PACKAGES} packages")

            # Go intentionally ignores test files, hidden/underscore directories,
            # vendor trees, and files excluded by build tags or the current target.
            # Do not issue a receipt that claims those supplied sources were built.
            included_result = subprocess.run(
                [go_binary, "list", "-f", "{{.Dir}}|{{join .GoFiles \",\"}}|{{join .CgoFiles \",\"}}", "./..."],
                cwd=root, env=environment, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=max(0.1, deadline - time.monotonic()), check=False,
            )
            if included_result.returncode != 0:
                message = _diagnostics(included_result.stderr or included_result.stdout)
                raise GoProjectBuildError(f"Go could not verify project source coverage: {message or 'go list failed without diagnostics'}")
            included_paths: set[str] = set()
            for line in included_result.stdout.decode("utf-8", errors="replace").splitlines():
                parts = line.split("|", 2)
                if len(parts) != 3:
                    raise GoProjectBuildError("Go returned incomplete project source coverage")
                package_dir, go_files, cgo_files = parts
                for filename in (go_files + "," + cgo_files).split(","):
                    if filename:
                        included_paths.add(Path(package_dir, filename).relative_to(root).as_posix())
            omitted_paths = sorted(path for path, _ in normalized_files if path not in included_paths)
            if omitted_paths:
                sample = ", ".join(omitted_paths[:5])
                suffix = " and more" if len(omitted_paths) > 5 else ""
                raise GoProjectBuildError(f"Go would omit accepted project source from compilation: {sample}{suffix}")

            output_dir = root / "compiled"
            output_dir.mkdir()
            outputs: list[tuple[str, str]] = []
            for index, package in enumerate(packages):
                output_path = output_dir / f"package-{index}"
                result = subprocess.run(
                    [go_binary, "build", "-trimpath", "-buildvcs=false", "-o", str(output_path), package],
                    cwd=root, env=environment, stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    timeout=max(0.1, deadline - time.monotonic()), check=False,
                )
                if result.returncode != 0:
                    message = _diagnostics(result.stderr or result.stdout)
                    unavailable = any(marker in message.lower() for marker in (
                        "module lookup disabled", "no required module provides package", "missing go.sum entry",
                        "updates to go.mod needed", "cannot find module providing package",
                    ))
                    return {
                        "source_sha256": project_hash,
                        "dependency_sha256": dependency_hash,
                        "validation_status": "UNAVAILABLE" if unavailable else "FAILED",
                        "validation_method": f"go-{compiler_version}-project-build",
                        "validation_message": f"Go {compiler_version} rejected project package {package}: {message or 'go build failed without diagnostics'}",
                        "compiler_version": compiler_version,
                        "compiled_sha256": None,
                        "package_count": len(packages),
                        "file_count": len(ordered_hashes),
                        "files": [{"relative_path": path, "source_sha256": digest} for path, digest in ordered_hashes],
                        "dependencies": dependencies,
                    }
                outputs.append((package, _sha256(output_path.read_bytes())))

            compiled_hash_input = b"".join(package.encode() + b"\0" + digest.encode("ascii") + b"\n" for package, digest in outputs)
            return {
                "source_sha256": project_hash,
                "dependency_sha256": dependency_hash,
                "validation_status": "PASSED",
                "validation_method": f"go-{compiler_version}-project-build",
                "validation_message": f"Go {compiler_version} compiled {len(ordered_hashes)} accepted files across {len(packages)} packages without executing the output. Module downloads and CGO were disabled; dependencies had to be present in the offline module cache.",
                "compiler_version": compiler_version,
                "compiled_sha256": _sha256(compiled_hash_input),
                "package_count": len(packages),
                "file_count": len(ordered_hashes),
                "files": [{"relative_path": path, "source_sha256": digest} for path, digest in ordered_hashes],
                "dependencies": dependencies,
            }
        except subprocess.TimeoutExpired:
            return {
                "source_sha256": project_hash,
                "dependency_sha256": dependency_hash,
                "validation_status": "UNAVAILABLE",
                "validation_method": f"go-{compiler_version if 'compiler_version' in locals() else 'unknown'}-project-build",
                "validation_message": "Go project compilation exceeded its time limit; no build receipt should be recorded.",
                "compiler_version": compiler_version if 'compiler_version' in locals() else "unknown",
                "compiled_sha256": None,
                "package_count": 0,
                "file_count": len(ordered_hashes),
                "files": [{"relative_path": path, "source_sha256": digest} for path, digest in ordered_hashes],
                "dependencies": dependencies,
            }
