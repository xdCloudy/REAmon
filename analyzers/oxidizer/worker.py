#!/usr/bin/env python3
"""Run the angr Rust recovery pipeline for one binary."""
from __future__ import annotations

import json
import sys
from pathlib import Path

MAX_FUNCTIONS = 500
MAX_FUNCTION_SOURCE_BYTES = 1024 * 1024
MAX_TOTAL_SOURCE_BYTES = 128 * 1024 * 1024
MAX_FAILURES = 200
MAX_CALLS = 4000


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("usage: worker.py <binary> <output-dir> <function-limit>")
    binary = Path(sys.argv[1]).resolve(strict=True)
    output_root = Path(sys.argv[2]).resolve(strict=True)
    limit = max(1, min(MAX_FUNCTIONS, int(sys.argv[3])))

    import angr
    from angr.enums import Flavors

    project = angr.Project(str(binary), auto_load_libs=False)
    project.analyses.CFGFast(normalize=True)
    project.analyses.CompleteCallingConventions(recover_variables=False)
    rust_recovery = project.analyses.RustSymbolRecovery()
    if (project.rustc_version is None or rust_recovery.best_sig_dir is None
            or rust_recovery.matched_count <= 0 or not rust_recovery.rust_symbols):
        raise RuntimeError("angr found no Rust runtime signatures; refusing Rust-specific decompilation")
    project.analyses.TypeDBLoader()

    functions = sorted(
        (function for function in project.kb.functions.values()
         if not function.is_simprocedure and not function.is_syscall),
        key=lambda function: function.addr,
    )
    calls: list[dict[str, str]] = []
    units: list[dict[str, object]] = []
    failures: list[str] = []
    output_bytes = 0
    truncated = len(functions) > limit
    functions_root = output_root / "functions"
    functions_root.mkdir(parents=True, exist_ok=True)

    for function in functions[:limit]:
        address = f"0x{function.addr:x}"
        name = str(function.name or address)[:500]
        try:
            result = project.analyses.Decompiler(function, flavor=Flavors.RUST_FLAVOR)
            code = getattr(getattr(result, "codegen", None), "text", None)
            if not isinstance(code, str) or not code.strip():
                failures.append(f"{address}: no pseudocode produced")
                continue
            encoded = code.encode("utf-8")
            if len(encoded) > MAX_FUNCTION_SOURCE_BYTES or output_bytes + len(encoded) > MAX_TOTAL_SOURCE_BYTES:
                truncated = True
                continue
            relative_path = f"functions/{function.addr:x}.rs"
            destination = functions_root / f"{function.addr:x}.rs"
            destination.write_bytes(encoded)
            output_bytes += len(encoded)
            units.append({
                "name": name,
                "address": address,
                "relativePath": relative_path,
                "sizeBytes": len(encoded),
            })
        except Exception as error:  # a broken function should not discard the other recovered functions
            if len(failures) < MAX_FAILURES:
                failures.append(f"{address}: {type(error).__name__}: {str(error)[:400]}")

        try:
            for target in project.kb.functions.callgraph.successors(function.addr):
                if len(calls) >= MAX_CALLS:
                    truncated = True
                    break
                target_function = project.kb.functions.get(target)
                calls.append({
                    "fromAddress": address,
                    "toAddress": f"0x{target:x}",
                    "fromName": name,
                    "toName": str(target_function.name if target_function else f"sub_{target:x}")[:500],
                })
        except (KeyError, ValueError):
            continue

    if not units:
        raise RuntimeError("Oxidizer did not produce viewable pseudocode for this binary")

    manifest = {
        "status": "completed",
        "toolVersion": getattr(angr, "__version__", "unknown"),
        "rustcVersion": str(project.rustc_version),
        "functionCount": len(functions),
        "returnedUnits": len(units),
        "failedFunctionCount": len(failures),
        "truncated": truncated,
        "outputBytes": output_bytes,
        "units": units,
        "calls": calls,
        "warnings": "\n".join(failures)[:12000],
    }
    (output_root / "result.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Oxidizer analysis failed: {type(error).__name__}: {str(error)[:1500]}", file=sys.stderr)
        raise SystemExit(1)
