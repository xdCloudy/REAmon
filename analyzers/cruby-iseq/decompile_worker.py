#!/usr/bin/env python3
"""Run the audited Ruby 2.7-focused YARV source reconstruction core."""

import json
import os
import resource
import sys

MAX_INPUT_BYTES = 512 * 1024
MAX_SOURCE_BYTES = 512 * 1024
MAX_ISEQS = 96
UPSTREAM_REVISION = "8296afafb099110f944135f32f59e789567dd1a4"
UPSTREAM_ROOT = os.path.join(os.path.dirname(__file__), "upstream", "ruby-sketchup-decompiler")


def emit(value: dict, status: int = 0) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(status)


def main() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (18, 18))
    if hasattr(resource, "RLIMIT_AS"):
        resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024, 384 * 1024 * 1024))
    source_path = sys.argv[1]
    if not os.path.isfile(source_path) or os.path.getsize(source_path) > MAX_INPUT_BYTES:
        emit({"error": "YARV disassembly is outside the reconstruction input limit"}, 2)

    sys.path.insert(0, UPSTREAM_ROOT)
    from decompiler.parser import parse_dump
    from decompiler.translator import translate_iseq

    try:
        iseqs, iseq_by_name = parse_dump(source_path)
        if not iseqs or len(iseqs) > MAX_ISEQS:
            emit({"error": "YARV disassembly has no supported root sequence or exceeds the sequence limit"}, 2)
        roots = [iseq for iseq in iseqs if iseq.name in ("<top (required)>", "<encoded>")]
        if not roots:
            roots = iseqs[:1]
        source = "\n\n".join(translate_iseq(iseq, iseq_by_name) for iseq in roots)
        encoded = source.encode("utf-8")
        if not encoded or len(encoded) > MAX_SOURCE_BYTES:
            emit({"error": "Reconstructed Ruby candidate is empty or exceeds the output limit"}, 2)
        emit({
            "status": "completed",
            "upstream": "DECOMPILER-RUBY-FOR-SKETCHUP-RUBY-2.7",
            "upstreamRevision": UPSTREAM_REVISION,
            "upstreamScope": "Ruby 2.7 YARV, reported by upstream for SketchUp RubyEncoder plugins; not applicable to .rbe files",
            "iseqCount": len(iseqs),
            "rootCount": len(roots),
            "sourceBytes": len(encoded),
            "source": source,
            "warnings": "Experimental pattern-based Ruby reconstruction adapted from a Ruby 2.7-focused upstream. Syntax validation does not prove behavior, and unsupported instructions may be omitted or approximated.",
        })
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        emit({"error": f"Ruby source reconstruction failed: {type(error).__name__}: {str(error)[:300]}"}, 2)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        emit({"error": f"Ruby source reconstruction failed: {type(error).__name__}: {str(error)[:300]}"}, 2)
