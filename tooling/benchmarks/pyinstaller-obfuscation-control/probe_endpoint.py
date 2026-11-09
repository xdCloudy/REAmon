"""Measure clean and obfuscated bytecode extraction from the live provider."""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import marshal
import re
import shutil
import types
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

MODULE_COUNT = 70
MAX_PAGES = 100
ORIGINAL_STRINGS = {"below", "at-or-above"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def request_json(url: str, payload: dict[str, object] | None = None) -> tuple[int, dict[str, object]]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"} if body is not None else {},
        method="GET" if body is None else "POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.loads(response.read(20 * 1024 * 1024))
            status = response.status
    except urllib.error.HTTPError as response:
        result = json.loads(response.read(20 * 1024 * 1024))
        status = response.code
    if not isinstance(result, dict):
        raise ValueError("PyInstaller service returned a non-object JSON response")
    return status, result


def walk_code(code: types.CodeType):
    yield code
    for value in code.co_consts:
        if isinstance(value, types.CodeType):
            yield from walk_code(value)


def inspect_target_module(module: dict[str, object], expected_filename: str) -> dict[str, object] | None:
    archive_path = str(module.get("archivePath", "")).replace("\\", "/")
    if PurePosixPath(archive_path).name != f"{expected_filename}.pyc":
        return None
    raw = base64.b64decode(str(module["dataBase64"]), validate=True)
    if raw[:4] != importlib.util.MAGIC_NUMBER or raw[2:4] != b"\r\n" or len(raw) < 16:
        raise ValueError(f"unexpected .pyc header for {archive_path}")
    top_level = marshal.loads(raw[16:])
    if not isinstance(top_level, types.CodeType):
        raise ValueError(f".pyc payload is not a code object: {archive_path}")
    code_objects = list(walk_code(top_level))
    names = {name for code in code_objects for name in (*code.co_names, code.co_name)}
    strings = {
        value
        for code in code_objects
        for value in code.co_consts
        if isinstance(value, str)
    }
    return {
        "archivePath": archive_path,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "symbols": names,
        "containsOriginalStrings": bool(strings & ORIGINAL_STRINGS),
    }


def inventory(
    *,
    base_url: str,
    artifact_path: str,
    artifact_sha256: str,
    fixture_label: str,
    package_prefix: str,
    expected_function: str,
) -> dict[str, object]:
    offset = 0
    module_count: int | None = None
    next_offset = 0
    total_bytes = 0
    elapsed_ms = 0
    all_paths: set[str] = set()
    target_modules: dict[str, dict[str, object]] = {}
    pages: list[dict[str, object]] = []
    for page_index in range(MAX_PAGES):
        payload = {
            "projectId": "obfuscation-control",
            "artifactId": fixture_label,
            "taskId": f"{fixture_label}-page-{page_index}",
            "runId": f"{fixture_label}-run",
            "artifactPath": artifact_path,
            "offset": offset,
        }
        status, body = request_json(f"{base_url}/extract", payload)
        if status != 200 or body.get("status") != "completed":
            raise ValueError(f"{fixture_label} provider request failed: HTTP {status} {body!r}")
        page_offset = body.get("offset")
        page_next = body.get("nextOffset")
        page_count = body.get("moduleCount")
        modules = body.get("modules")
        if (
            page_offset != offset
            or not isinstance(page_next, int)
            or not isinstance(page_count, int)
            or not isinstance(modules, list)
            or page_next <= offset
            or page_next - offset != len(modules)
        ):
            raise ValueError(f"{fixture_label} provider returned an invalid page boundary")
        if module_count is not None and page_count != module_count:
            raise ValueError(f"{fixture_label} module denominator changed between pages")
        module_count = page_count
        page_target_names: list[str] = []
        for item in modules:
            if not isinstance(item, dict):
                raise ValueError(f"{fixture_label} provider returned a non-object module")
            path = str(item.get("archivePath", "")).replace("\\", "/")
            if not path or path in all_paths:
                raise ValueError(f"{fixture_label} provider returned an empty or duplicate module path")
            all_paths.add(path)
            basename = PurePosixPath(path).stem
            match = re.fullmatch(r"(?:module_|m)(\d{3})", basename)
            if match and (package_prefix in path or path.startswith(basename)):
                target = inspect_target_module(item, basename)
                if target is not None:
                    target_modules[basename] = {
                        "archivePath": target["archivePath"],
                        "sha256": target["sha256"],
                        "expectedFunctionSymbolPresent": expected_function in target["symbols"],
                        "cleanFunctionSymbolPresent": "classify" in target["symbols"],
                        "containsOriginalStrings": target["containsOriginalStrings"],
                    }
                    page_target_names.append(basename)
        pages.append({
            "offset": offset,
            "pageSize": len(modules),
            "nextOffset": page_next,
            "truncated": bool(body.get("truncated")),
            "outputBytes": body.get("outputBytes"),
            "targetModules": page_target_names,
        })
        total_bytes += int(body.get("outputBytes", 0))
        elapsed_ms += int(body.get("elapsedMs", 0))
        next_offset = page_next
        if not body.get("truncated"):
            break
        offset = page_next
    else:
        raise ValueError(f"{fixture_label} exceeded the {MAX_PAGES}-page safety limit")

    if module_count is None or next_offset != module_count or len(all_paths) != module_count:
        raise ValueError(f"{fixture_label} returned an incomplete module inventory")
    if len(target_modules) != MODULE_COUNT:
        raise ValueError(
            f"{fixture_label} recovered {len(target_modules)}/{MODULE_COUNT} target modules"
        )

    original_name_count = sum(
        bool(module["cleanFunctionSymbolPresent"]) for module in target_modules.values()
    )
    expected_name_count = sum(
        bool(module["expectedFunctionSymbolPresent"])
        for module in target_modules.values()
    )
    original_literal_count = sum(
        bool(module["containsOriginalStrings"]) for module in target_modules.values()
    )
    return {
        "artifact": {"path": artifact_path, "sha256": artifact_sha256},
        "httpStatus": 200,
        "status": "completed",
        "moduleCount": module_count,
        "returnedModuleCount": len(all_paths),
        "targetModuleDenominator": MODULE_COUNT,
        "targetModulesRecovered": len(target_modules),
        "expectedFunctionSymbolCount": expected_name_count,
        "cleanFunctionSymbolCount": original_name_count,
        "targetModulesWithOriginalStringLiterals": original_literal_count,
        "totalBytecodeBytes": total_bytes,
        "providerElapsedMs": elapsed_ms,
        "pages": pages,
        "targetModules": target_modules,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clean-artifact", type=Path, required=True)
    parser.add_argument("--obfuscated-artifact", type=Path, required=True)
    parser.add_argument("--build-receipt", type=Path, required=True)
    parser.add_argument("--artifact-root", type=Path, default=Path("/data/reamon-artifacts"))
    parser.add_argument("--base-url", default="http://127.0.0.1:8029")
    parser.add_argument("--service-image-id", required=True)
    parser.add_argument("--stage-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.stage_id):
        raise ValueError("stage id contains unsupported characters")
    if args.output.exists():
        raise FileExistsError(f"refusing to overwrite receipt: {args.output}")

    receipt: dict[str, object] = {
        "schemaVersion": 1,
        "fixtureId": "pyinstaller-source-obfuscation-pair-linux-amd64",
        "recordedAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "service": {
            "baseUrl": args.base_url,
            "imageId": args.service_image_id,
        },
        "controls": {},
        "comparison": {},
        "staging": {},
        "controlResult": "FAIL",
        "scope": (
            "One paired Python/PyInstaller fixture tests short identifier names and XOR-encoded "
            "string constants at the isolated bytecode-extraction provider. It does not test "
            "source deobfuscation or behavioral equivalence of reconstructed source."
        ),
    }
    staged_root: Path | None = None
    staged: list[tuple[Path, str]] = []
    staged_hashes_verified = False
    try:
        source_hashes = {
            "clean": sha256_file(args.clean_artifact),
            "obfuscated": sha256_file(args.obfuscated_artifact),
        }
        build_receipt = json.loads(args.build_receipt.read_text(encoding="utf-8-sig"))
        receipt_artifacts = build_receipt.get("artifacts", {})
        for label, filename in (
            ("clean", "pyinstaller-obfuscation-clean"),
            ("obfuscated", "pyinstaller-obfuscation-obfuscated"),
        ):
            expected = receipt_artifacts.get(filename, {}).get("sha256")
            if expected != source_hashes[label]:
                raise ValueError(f"{label} artifact hash does not match the build receipt")
        receipt["buildReceipt"] = {
            "sha256": sha256_file(args.build_receipt),
            "fixtureId": build_receipt.get("fixtureId"),
            "builderImageId": build_receipt.get("builderImageId"),
        }
        health_status, health = request_json(f"{args.base_url}/health")
        receipt["service"] = {
            **receipt["service"],
            "healthStatus": health_status,
            "extractorRevision": health.get("extractorRevision"),
        }
        if health_status != 200 or health.get("status") != "ok":
            raise ValueError("PyInstaller provider health check failed")

        staged_root = args.artifact_root / "qa" / f"pyinstaller-obfuscation-control-{args.stage_id}"
        staged_root.mkdir(parents=True, exist_ok=False)
        clean_path = staged_root / "clean-fixture"
        obfuscated_path = staged_root / "obfuscated-fixture"
        shutil.copyfile(args.clean_artifact, clean_path)
        shutil.copyfile(args.obfuscated_artifact, obfuscated_path)
        staged = [(clean_path, source_hashes["clean"]), (obfuscated_path, source_hashes["obfuscated"])]
        for path, expected_hash in staged:
            if sha256_file(path) != expected_hash:
                raise ValueError("staged artifact hash does not match its build receipt")
        staged_hashes_verified = True

        prefix = str(staged_root)
        clean_result = inventory(
            base_url=args.base_url,
            artifact_path=f"{prefix}/clean-fixture",
            artifact_sha256=source_hashes["clean"],
            fixture_label="clean",
            package_prefix="clean_fixture",
            expected_function="classify",
        )
        obfuscated_result = inventory(
            base_url=args.base_url,
            artifact_path=f"{prefix}/obfuscated-fixture",
            artifact_sha256=source_hashes["obfuscated"],
            fixture_label="obfuscated",
            package_prefix="obfuscated_fixture",
            expected_function="_1",
        )
        clean_symbols_match = (
            clean_result["expectedFunctionSymbolCount"] == MODULE_COUNT
            and clean_result["targetModulesWithOriginalStringLiterals"] == MODULE_COUNT
        )
        obfuscated_symbols_match = (
            obfuscated_result["expectedFunctionSymbolCount"] == MODULE_COUNT
            and obfuscated_result["cleanFunctionSymbolCount"] == 0
            and obfuscated_result["targetModulesWithOriginalStringLiterals"] == 0
        )
        same_inventory = (
            clean_result["moduleCount"] == obfuscated_result["moduleCount"]
            and clean_result["returnedModuleCount"] == obfuscated_result["returnedModuleCount"]
            and clean_result["targetModulesRecovered"] == obfuscated_result["targetModulesRecovered"]
        )
        receipt["controls"] = {"clean": clean_result, "obfuscated": obfuscated_result}
        receipt["comparison"] = {
            "sameCompleteModuleInventory": same_inventory,
            "cleanSymbolsAndStringsObserved": clean_symbols_match,
            "obfuscatedSymbolsAndStringsObserved": obfuscated_symbols_match,
            "runtimeOracle": "both built fixtures passed the same stdout and branch assertions inside Docker",
            "deobfuscationOutcome": "UNAVAILABLE; provider returns bytecode, not reconstructed source",
        }
        receipt["controlResult"] = (
            "PASS" if same_inventory and clean_symbols_match and obfuscated_symbols_match else "FAIL"
        )
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
    finally:
        cleanup_ok = True
        for path, expected_hash in staged:
            try:
                if path.exists():
                    if sha256_file(path) != expected_hash:
                        cleanup_ok = False
                        continue
                    path.unlink()
            except OSError:
                cleanup_ok = False
        if staged_root is not None and staged_root.exists():
            try:
                staged_root.rmdir()
            except OSError:
                cleanup_ok = False
        receipt["staging"] = {
            "artifactRoot": str(staged_root) if staged_root is not None else None,
            "artifactHashesVerifiedBeforeRequest": staged_hashes_verified,
            "stagedFilesRemovedAfterHashCheck": cleanup_ok and not (staged_root and staged_root.exists()),
        }
        if not receipt["staging"]["stagedFilesRemovedAfterHashCheck"]:
            receipt["controlResult"] = "FAIL"

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
    if receipt["controlResult"] != "PASS":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
