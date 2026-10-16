"""Tree-sitter parser access for REAmon source languages."""

import os
import re
import threading
from pathlib import Path

_configure_lock = threading.Lock()
_configured = False

_LANGUAGE_ALIASES = {
    "c++": ("cpp",),
    "c#": ("csharp", "c_sharp"),
    "csharp": ("csharp", "c_sharp"),
    "c_sharp": ("csharp", "c_sharp"),
    "javascript": ("javascript", "js"),
    "javascript jsx": ("javascript", "jsx"),
    "typescript": ("typescript", "ts"),
    "typescript jsx": ("tsx", "typescript"),
    "tsx": ("tsx", "typescript"),
    "webassembly text (wat)": ("wat", "webassembly", "wasm"),
    "wat": ("wat", "webassembly", "wasm"),
    "webassembly": ("wasm", "wat", "webassembly"),
    "assembly": ("asm", "assembly"),
    "objective-c": ("objc", "objective_c"),
    "objective c": ("objc", "objective_c"),
    "shell script": ("bash", "shell"),
    "shell": ("shell", "bash"),
    "visual basic .net": ("vb", "visual_basic"),
    "vb.net": ("vb", "visual_basic"),
}


def _configure_language_cache(configure, pack_config) -> None:
    global _configured
    if _configured:
        return
    with _configure_lock:
        if _configured:
            return
        cache_dir = os.environ.get("REAMON_TREE_SITTER_CACHE_DIR")
        if not cache_dir:
            cache_dir = str(Path(__file__).resolve().parent / "logs" / "tree-sitter-language-pack")
        Path(cache_dir).mkdir(parents=True, exist_ok=True)
        configure(pack_config(cache_dir=cache_dir))
        _configured = True


def get_reamon_parser(language: str):
    """Build a standard tree-sitter parser for a display or grammar name."""
    normalized = language.strip().lower()
    if not normalized or normalized == "unknown":
        return None
    try:
        from tree_sitter import Parser
        from tree_sitter_language_pack import PackConfig, configure, get_language

        _configure_language_cache(configure, PackConfig)
        candidates = list(_LANGUAGE_ALIASES.get(normalized, ()))
        candidates.extend((normalized, re.sub(r"[^a-z0-9_]+", "_", normalized).strip("_")))
        for candidate in dict.fromkeys(item for item in candidates if item):
            try:
                grammar = get_language(candidate)
                return Parser(grammar)
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        return None
    return None
