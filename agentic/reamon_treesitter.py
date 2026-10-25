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
        cache_path = Path(cache_dir)
        cache_path.mkdir(parents=True, exist_ok=True)
        # tree-sitter-language-pack rejects a cache directory that other users
        # can modify. The default lives under the shared logs mount, which may
        # be mode 0777; make the cache and existing version directories private
        # before the package inspects them.
        try:
            os.chmod(cache_path, 0o700)
            for root, directories, _files in os.walk(cache_path, followlinks=False):
                root_path = Path(root)
                for name in directories:
                    child = root_path / name
                    if not child.is_symlink():
                        os.chmod(child, 0o700)
        except OSError as exc:
            raise RuntimeError("The Tree-sitter language cache must be private") from exc
        configure(pack_config(cache_dir=cache_dir))
        _configured = True


def get_reamon_parser_with_language(language: str):
    """Build a parser and return the grammar identifier selected for it."""
    normalized = language.strip().lower()
    if not normalized or normalized == "unknown":
        return None, None
    try:
        from tree_sitter import Parser
        from tree_sitter_language_pack import PackConfig, configure, get_language

        _configure_language_cache(configure, PackConfig)
        candidates = list(_LANGUAGE_ALIASES.get(normalized, ()))
        candidates.extend((normalized, re.sub(r"[^a-z0-9_]+", "_", normalized).strip("_")))
        for candidate in dict.fromkeys(item for item in candidates if item):
            try:
                grammar = get_language(candidate)
                return Parser(grammar), candidate
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        return None, None
    return None, None


def get_reamon_parser(language: str):
    """Build a standard tree-sitter parser for a display or grammar name."""
    parser, _ = get_reamon_parser_with_language(language)
    return parser
