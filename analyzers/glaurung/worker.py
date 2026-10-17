#!/usr/bin/env python3
"""Run pinned Glaurung discovery and pseudocode for one native binary."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

MAX_FUNCTIONS = 500
MAX_FUNCTION_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_FAILURES = 200


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("usage: worker.py <binary> <output-dir> <function-limit>")
    binary = Path(sys.argv[1]).resolve(strict=True)
    output_root = Path(sys.argv[2]).resolve(strict=True)
    limit = max(1, min(MAX_FUNCTIONS, int(sys.argv[3])))

    import glaurung as g

    functions, _call_graph = g.analysis.analyze_functions_path(
        str(binary), max_file_size=512 * 1024 * 1024, max_read_bytes=512 * 1024 * 1024,
        max_functions=limit + 1, max_blocks=4096, max_instructions=200_000,
        timeout_ms=5000, total_timeout_ms=600_000,
    )
    selected = []
    seen: set[int] = set()
    for function in functions:
        try:
            address = int(function.entry_point.value)
            name = str(function.name or f"sub_{address:x}")[:500]
        except (AttributeError, TypeError, ValueError):
            continue
        if address < 0 or address in seen:
            continue
        seen.add(address)
        selected.append((address, name))
        if len(selected) >= limit:
            break
    if not selected:
        raise RuntimeError("Glaurung discovered no addressable native functions")

    vas = [address for address, _ in selected]
    results = g.ir.decompile_many(
        str(binary), vas, max_blocks=4096, max_instructions=200_000,
        timeout_ms=5000, types=True, style="c", max_functions=len(vas),
    )
    name_by_address = dict(selected)
    functions_root = output_root / "functions"
    functions_root.mkdir(parents=True, exist_ok=True)
    units: list[dict[str, object]] = []
    failures: list[str] = []
    output_bytes = 0
    for record in results:
        if not isinstance(record, (tuple, list)) or len(record) < 3:
            continue
        try:
            name = str(record[0] or "")[:500]
            address = int(record[1])
            source = record[2]
        except (TypeError, ValueError):
            continue
        if not isinstance(source, str) or not source.strip() or address not in name_by_address:
            continue
        encoded = source.encode("utf-8")
        if len(encoded) > MAX_FUNCTION_BYTES or output_bytes + len(encoded) > MAX_TOTAL_BYTES:
            failures.append(f"0x{address:x}: pseudocode exceeded the output limit")
            continue
        relative_path = f"functions/{address:x}.c"
        (functions_root / f"{address:x}.c").write_bytes(encoded)
        output_bytes += len(encoded)
        units.append({
            "name": name or name_by_address[address],
            "address": f"0x{address:x}",
            "relativePath": relative_path,
            "sizeBytes": len(encoded),
            "outputSha256": hashlib.sha256(encoded).hexdigest(),
        })
    if not units:
        raise RuntimeError("Glaurung produced no viewable pseudocode for discovered functions")

    manifest = {
        "status": "completed",
        "toolVersion": str(getattr(g, "__version__", None) or "unknown")[:128],
        "functionCount": len(functions),
        "returnedUnits": len(units),
        "failedFunctionCount": len(failures),
        "truncated": len(functions) > len(selected) or bool(failures),
        "outputBytes": output_bytes,
        "units": units,
        "warnings": "\n".join(failures)[:12_000],
    }
    (output_root / "result.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Glaurung analysis failed: {type(error).__name__}: {str(error)[:1500]}", file=sys.stderr)
        raise SystemExit(1)
