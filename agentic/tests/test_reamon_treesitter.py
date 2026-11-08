import os
import tempfile
from pathlib import Path

import pytest

import reamon_treesitter


def test_cache_falls_back_when_shared_mount_cannot_be_made_private(tmp_path, monkeypatch):
    shared_cache = tmp_path / "logs" / "tree-sitter-language-pack"
    monkeypatch.setattr(reamon_treesitter, "__file__", str(tmp_path / "reamon_treesitter.py"))
    monkeypatch.setattr(reamon_treesitter, "_configured", False)
    monkeypatch.delenv("REAMON_TREE_SITTER_CACHE_DIR", raising=False)

    original_chmod = os.chmod

    def chmod(path, mode):
        if Path(path).is_relative_to(shared_cache):
            return
        original_chmod(path, mode)

    monkeypatch.setattr(reamon_treesitter.os, "chmod", chmod)
    configured = {}
    reamon_treesitter._configure_language_cache(
        lambda value: configured.update(value),
        lambda **value: value,
    )

    expected = Path(tempfile.gettempdir()) / f"reamon-tree-sitter-{os.getuid()}"
    assert configured["cache_dir"] == str(expected)
    assert expected.stat().st_mode & 0o077 == 0


def test_explicit_cache_that_cannot_be_made_private_fails_closed(tmp_path, monkeypatch):
    explicit_cache = tmp_path / "shared-cache"
    monkeypatch.setattr(reamon_treesitter, "_configured", False)
    monkeypatch.setenv("REAMON_TREE_SITTER_CACHE_DIR", str(explicit_cache))
    monkeypatch.setattr(reamon_treesitter.os, "chmod", lambda *_args: None)

    with pytest.raises(RuntimeError, match="configured Tree-sitter language cache must be private"):
        reamon_treesitter._configure_language_cache(lambda *_args: None, lambda **value: value)
