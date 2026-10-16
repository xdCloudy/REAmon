"""
Unit + safety tests for agentic/workspace_fs.py (the 24 fs_* primitives).

Covers:
  - _resolve_safe: traversal, absolute-path, symlink-escape rejection.
  - Each tool's happy path + a representative error path.
  - Atomicity of fs_write (tmp+replace) and fs_multi_edit (all-or-nothing).
  - Undo stack ordering / capping.
  - fs_extract zip-slip / tar-slip rejection.
  - fs_diff(vs_last_read=True) detecting concurrent writes.

Heavy deps (tools.py imports langchain/neo4j) are stubbed so tests can run on
the host without the agent container.

Run with: python3 -m unittest tests/test_workspace_fs.py -v
"""
from __future__ import annotations

import asyncio
import gzip
import io
import os
import shutil
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

_AGENTIC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _AGENTIC_DIR)

# workspace_fs reads project_id from agent_context (a lightweight module with
# no heavy deps), so we can set it directly - no stubbing required.
import agent_context  # noqa: E402
import workspace_fs  # noqa: E402


def _set_pid(pid: str):
    agent_context.current_project_id.set(pid)


class WorkspaceFSTestBase(unittest.IsolatedAsyncioTestCase):
    """Shared scaffolding: per-test WORKSPACE_ROOT + project scope."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="redamon-ws-test-")
        self._orig_root = workspace_fs.WORKSPACE_ROOT
        workspace_fs.WORKSPACE_ROOT = Path(self.tmp)
        # Reset module-level caches so tests don't leak state into each other.
        workspace_fs._edit_stack.clear()
        workspace_fs._last_read_contents.clear()
        workspace_fs._last_read_hashes.clear()
        _set_pid("proj-test")
        self.root = Path(self.tmp) / "proj-test"
        # Pre-create the project dir so tests that write directly to self.root
        # (before any fs_* call triggers auto-creation) don't fail.
        self.root.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        workspace_fs.WORKSPACE_ROOT = self._orig_root
        shutil.rmtree(self.tmp, ignore_errors=True)
        _set_pid("")


# =============================================================================
# Safety: _resolve_safe
# =============================================================================

class TestResolveSafe(WorkspaceFSTestBase):
    async def test_workspace_auto_creates_subdirs(self):
        # Just calling _workspace_root() should create the standard subdirs.
        await workspace_fs.fs_list(".")
        for sub in ("notes", "tool-outputs", "jobs", "uploads"):
            self.assertTrue((self.root / sub).is_dir(), f"missing subdir {sub}")

    async def test_rejects_parent_traversal(self):
        out = await workspace_fs.fs_read("../../etc/passwd")
        self.assertIn("Error:", out)
        # Either "escapes workspace" or "not found" after safe collapse;
        # the critical bit is that it never returned passwd contents.
        self.assertNotIn("root:", out)

    async def test_rejects_traversal_with_segments(self):
        out = await workspace_fs.fs_write("notes/../../escape.txt", "x")
        # The resolution flattens to /tmp/.../escape.txt - escapes "/tmp/.../proj-test"
        self.assertIn("Error:", out)
        self.assertFalse((Path(self.tmp) / "escape.txt").exists())

    async def test_rejects_absolute_path_outside_workspace(self):
        out = await workspace_fs.fs_read("/etc/passwd")
        self.assertIn("Error:", out)

    async def test_allows_absolute_path_inside_workspace(self):
        await workspace_fs.fs_write("hello.txt", "hi")
        abs_path = str(self.root / "hello.txt")
        out = await workspace_fs.fs_read(abs_path)
        self.assertIn("hi", out)

    async def test_no_project_id_raises(self):
        _set_pid("")
        out = await workspace_fs.fs_read("anything")
        # _project_id() raises ValueError; the tool wraps it as Error: ...
        # actually it's raised inside _resolve_safe via _workspace_root,
        # so it propagates - tests catch as exception.
        # Different fs_* funcs handle it differently; for fs_read it's caught
        # only as ValueError from _resolve_safe. _project_id ValueError will
        # bubble up.
        self.assertTrue(
            isinstance(out, str) and "Error" in out
            or out is None,
            f"expected error string, got {out!r}",
        )


# =============================================================================
# READ
# =============================================================================

class TestRead(WorkspaceFSTestBase):
    async def test_fs_write_then_read_roundtrip(self):
        await workspace_fs.fs_write("a.txt", "hello\nworld\n")
        out = await workspace_fs.fs_read("a.txt")
        self.assertIn("hello", out)
        self.assertIn("world", out)
        # Has line numbers
        self.assertRegex(out, r"^\s*1\t")

    async def test_fs_read_missing(self):
        out = await workspace_fs.fs_read("nope.txt")
        self.assertIn("not found", out.lower())

    async def test_fs_read_on_directory(self):
        out = await workspace_fs.fs_read("notes")  # auto-created subdir
        self.assertIn("directory", out.lower())

    async def test_fs_read_binary_returns_base64(self):
        (self.root / "bin.dat").write_bytes(b"\x00\x01\x02ABC")
        out = await workspace_fs.fs_read("bin.dat")
        self.assertIn("binary file", out)
        self.assertIn("base64", out)

    async def test_fs_read_offset_limit(self):
        content = "".join(f"line{i}\n" for i in range(1, 11))
        await workspace_fs.fs_write("big.txt", content)
        out = await workspace_fs.fs_read("big.txt", offset=3, limit=2)
        self.assertIn("line3", out)
        self.assertIn("line4", out)
        self.assertNotIn("line5", out)
        # Truncation header shows partial-view bounds
        self.assertIn("lines 3-4 of 10", out)

    async def test_fs_read_records_snapshot_for_diff(self):
        await workspace_fs.fs_write("watched.txt", "v1")
        await workspace_fs.fs_read("watched.txt")
        key = ("proj-test", "watched.txt")
        self.assertIn(key, workspace_fs._last_read_contents)
        self.assertEqual(workspace_fs._last_read_contents[key], b"v1")

    async def test_fs_read_many_caps_total(self):
        for i in range(5):
            await workspace_fs.fs_write(f"f{i}.txt", "X" * 1000)
        out = await workspace_fs.fs_read_many(
            [f"f{i}.txt" for i in range(5)], max_total_bytes=2200
        )
        # Should hit cap by 3rd file
        self.assertIn("=== f0.txt ===", out)
        self.assertIn("=== f1.txt ===", out)
        self.assertTrue(
            "skipped" in out or "truncated" in out,
            "expected cap-triggered truncation marker",
        )

    async def test_fs_stat_with_hash(self):
        await workspace_fs.fs_write("h.txt", "hello")
        out = await workspace_fs.fs_stat("h.txt", include_hash=True)
        self.assertIn("type: file", out)
        self.assertIn("size: 5", out)
        self.assertIn(
            "sha256: 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            out,
        )


# =============================================================================
# WRITE & MUTATE
# =============================================================================

class TestWriteMutate(WorkspaceFSTestBase):
    async def test_fs_write_create_only_rejects_existing(self):
        await workspace_fs.fs_write("e.txt", "first")
        out = await workspace_fs.fs_write("e.txt", "second", mode="create_only")
        self.assertIn("already exists", out)
        # File unchanged
        self.assertEqual((self.root / "e.txt").read_text(), "first")

    async def test_fs_write_append_mode(self):
        await workspace_fs.fs_write("log.txt", "a\n")
        await workspace_fs.fs_write("log.txt", "b\n", mode="append")
        self.assertEqual((self.root / "log.txt").read_text(), "a\nb\n")

    async def test_fs_write_bad_mode(self):
        out = await workspace_fs.fs_write("x.txt", "v", mode="bogus")
        self.assertIn("invalid mode", out)

    async def test_fs_write_atomic_no_partial_on_replace(self):
        # If a .tmp survives mid-operation, we'd see it; here we just confirm
        # the final file matches and no .tmp remains.
        await workspace_fs.fs_write("atom.txt", "first")
        await workspace_fs.fs_write("atom.txt", "second")
        self.assertEqual((self.root / "atom.txt").read_text(), "second")
        self.assertFalse((self.root / "atom.txt.tmp").exists())

    async def test_fs_edit_uniqueness_check(self):
        await workspace_fs.fs_write("u.txt", "foo bar foo")
        out = await workspace_fs.fs_edit("u.txt", "foo", "baz")
        self.assertIn("found 2 times", out)
        # File unchanged
        self.assertEqual((self.root / "u.txt").read_text(), "foo bar foo")

    async def test_fs_edit_replace_all(self):
        await workspace_fs.fs_write("u.txt", "foo bar foo")
        out = await workspace_fs.fs_edit("u.txt", "foo", "baz", replace_all=True)
        self.assertIn("Replaced 2", out)
        self.assertEqual((self.root / "u.txt").read_text(), "baz bar baz")

    async def test_fs_edit_pushes_undo(self):
        await workspace_fs.fs_write("u.txt", "hello world")
        await workspace_fs.fs_edit("u.txt", "world", "earth")
        out = await workspace_fs.fs_undo_edit("u.txt")
        self.assertIn("Reverted", out)
        self.assertEqual((self.root / "u.txt").read_text(), "hello world")

    async def test_fs_undo_with_empty_stack(self):
        await workspace_fs.fs_write("nope.txt", "x")
        out = await workspace_fs.fs_undo_edit("nope.txt")
        self.assertIn("No undo history", out)

    async def test_fs_multi_edit_all_or_nothing(self):
        await workspace_fs.fs_write("m.txt", "alpha beta gamma")
        out = await workspace_fs.fs_multi_edit("m.txt", [
            {"old_string": "alpha", "new_string": "ALPHA"},
            {"old_string": "missing", "new_string": "X"},  # fails
        ])
        self.assertIn("Error", out)
        # File unchanged
        self.assertEqual((self.root / "m.txt").read_text(), "alpha beta gamma")

    async def test_fs_multi_edit_happy_path(self):
        await workspace_fs.fs_write("m.txt", "a b c")
        out = await workspace_fs.fs_multi_edit("m.txt", [
            {"old_string": "a", "new_string": "A"},
            {"old_string": "b", "new_string": "B"},
        ])
        self.assertIn("Applied 2", out)
        self.assertEqual((self.root / "m.txt").read_text(), "A B c")

    async def test_undo_stack_caps_at_depth(self):
        await workspace_fs.fs_write("c.txt", "0")
        for i in range(1, 25):  # 24 edits > cap of 20
            await workspace_fs.fs_edit("c.txt", str(i - 1), str(i))
        abs_path = str((self.root / "c.txt").resolve())
        self.assertEqual(len(workspace_fs._edit_stack[abs_path]), 20)

    async def test_fs_delete_dir_requires_recursive(self):
        await workspace_fs.fs_mkdir("a/b/c")
        out = await workspace_fs.fs_delete("a")
        self.assertIn("recursive=True", out)
        out = await workspace_fs.fs_delete("a", recursive=True)
        self.assertIn("Removed directory", out)
        self.assertFalse((self.root / "a").exists())

    async def test_fs_mkdir_fresh_returns_created(self):
        out = await workspace_fs.fs_mkdir("fresh")
        self.assertIn("Created directory fresh", out)
        self.assertTrue((self.root / "fresh").is_dir())

    async def test_fs_mkdir_existing_empty_dir_signals_no_change(self):
        # Regression: used to return "Created directory X." even when the
        # dir already existed (default subdirs like uploads/), misleading
        # the agent into thinking it had just created something.
        (self.root / "uploads_existing").mkdir()
        out = await workspace_fs.fs_mkdir("uploads_existing")
        self.assertIn("already exists", out)
        self.assertIn("no change", out)
        self.assertIn("0 entries", out)
        self.assertNotIn("Created directory", out)

    async def test_fs_mkdir_existing_non_empty_dir_reports_entry_count(self):
        (self.root / "pkg").mkdir()
        (self.root / "pkg" / "a.txt").write_text("1")
        (self.root / "pkg" / "b.txt").write_text("2")
        out = await workspace_fs.fs_mkdir("pkg")
        self.assertIn("already exists", out)
        self.assertIn("2 entries", out)

    async def test_fs_mkdir_path_is_file_returns_error(self):
        # Used to crash with FileExistsError because exist_ok=True only
        # suppresses for directories, not files.
        await workspace_fs.fs_write("collide.txt", "data")
        out = await workspace_fs.fs_mkdir("collide.txt")
        self.assertIn("Error", out)
        self.assertIn("not a directory", out)

    async def test_fs_mkdir_missing_parent_without_parents_flag(self):
        # Used to raise FileNotFoundError with no friendly message.
        out = await workspace_fs.fs_mkdir("never/before/seen", parents=False)
        self.assertIn("Error", out)
        self.assertIn("parents=True", out)
        self.assertFalse((self.root / "never").exists())

    async def test_fs_move_creates_parents(self):
        await workspace_fs.fs_write("x.txt", "v")
        out = await workspace_fs.fs_move("x.txt", "sub1/sub2/y.txt")
        self.assertIn("Moved", out)
        self.assertTrue((self.root / "sub1/sub2/y.txt").exists())

    async def test_fs_copy_file_and_dir(self):
        await workspace_fs.fs_write("src.txt", "v")
        await workspace_fs.fs_copy("src.txt", "dst.txt")
        self.assertTrue((self.root / "dst.txt").exists())
        await workspace_fs.fs_mkdir("srcdir/sub")
        await workspace_fs.fs_write("srcdir/sub/in.txt", "yo")
        out = await workspace_fs.fs_copy("srcdir", "dstdir", recursive=True)
        self.assertIn("Copied", out)
        self.assertTrue((self.root / "dstdir/sub/in.txt").exists())

    async def test_fs_chmod_octal_and_symbolic(self):
        await workspace_fs.fs_write("script.sh", "echo hi")
        await workspace_fs.fs_chmod("script.sh", "755")
        self.assertEqual(
            (self.root / "script.sh").stat().st_mode & 0o777, 0o755
        )
        await workspace_fs.fs_chmod("script.sh", "+x")  # idempotent
        self.assertTrue((self.root / "script.sh").stat().st_mode & 0o111)
        await workspace_fs.fs_chmod("script.sh", "-x")
        self.assertFalse((self.root / "script.sh").stat().st_mode & 0o111)

    async def test_fs_symlink_soft(self):
        await workspace_fs.fs_write("target.txt", "value")
        await workspace_fs.fs_symlink_create("target.txt", "link.txt")
        self.assertTrue((self.root / "link.txt").is_symlink())
        out = await workspace_fs.fs_symlink_read("link.txt")
        self.assertIn("->", out)
        self.assertIn("target.txt", out)


# =============================================================================
# SEARCH & NAVIGATE
# =============================================================================

class TestSearchNavigate(WorkspaceFSTestBase):
    async def test_fs_grep_files_with_matches(self):
        await workspace_fs.fs_write("a.txt", "needle here")
        await workspace_fs.fs_write("b.txt", "haystack")
        out = await workspace_fs.fs_grep("needle")
        if "rg) not installed" in out:
            self.skipTest("ripgrep not installed on host")
        self.assertIn("a.txt", out)
        self.assertNotIn("b.txt", out)

    async def test_fs_grep_no_match(self):
        await workspace_fs.fs_write("a.txt", "hi")
        out = await workspace_fs.fs_grep("xyzzyqq")
        if "rg) not installed" in out:
            self.skipTest("ripgrep not installed on host")
        self.assertIn("No matches", out)

    async def test_fs_glob_mtime_sort(self):
        await workspace_fs.fs_write("old.md", "v")
        # Force older mtime
        old_path = self.root / "old.md"
        os.utime(old_path, (1, 1))
        await workspace_fs.fs_write("new.md", "v")
        out = await workspace_fs.fs_glob("*.md")
        # new.md should appear before old.md
        self.assertLess(out.find("new.md"), out.find("old.md"))

    async def test_fs_find_by_name(self):
        await workspace_fs.fs_write("a/b.md", "x")
        await workspace_fs.fs_write("a/c.txt", "y")
        out = await workspace_fs.fs_find(name="*.md")
        self.assertIn("b.md", out)
        self.assertNotIn("c.txt", out)

    async def test_fs_find_by_size(self):
        await workspace_fs.fs_write("big.bin", "X" * 5000)
        await workspace_fs.fs_write("small.bin", "x")
        out = await workspace_fs.fs_find(size=">1K")
        self.assertIn("big.bin", out)
        self.assertNotIn("small.bin", out)

    async def test_fs_list_dirs_first(self):
        await workspace_fs.fs_write("z.txt", "v")
        await workspace_fs.fs_mkdir("aaa")
        out = await workspace_fs.fs_list(".")
        # 'aaa' is a dir; should be listed before z.txt
        self.assertLess(out.find("aaa"), out.find("z.txt"))

    async def test_fs_tree_basic(self):
        await workspace_fs.fs_mkdir("a/b")
        await workspace_fs.fs_write("a/b/c.txt", "v")
        out = await workspace_fs.fs_tree(".", max_depth=5)
        self.assertIn("a/", out)
        self.assertIn("b/", out)
        self.assertIn("c.txt", out)

    # --- Gap-fill #4: fs_find mtime parser ---------------------------------

    async def test_fs_find_mtime_less_than(self):
        # Just-created files match "<1h"; ancient files don't.
        await workspace_fs.fs_write("fresh.txt", "v")
        await workspace_fs.fs_write("ancient.txt", "v")
        os.utime(self.root / "ancient.txt", (1, 1))  # 1970
        out = await workspace_fs.fs_find(name="*.txt", mtime="<1h")
        self.assertIn("fresh.txt", out)
        self.assertNotIn("ancient.txt", out)

    async def test_fs_find_mtime_greater_than(self):
        await workspace_fs.fs_write("fresh.txt", "v")
        await workspace_fs.fs_write("ancient.txt", "v")
        os.utime(self.root / "ancient.txt", (1, 1))
        out = await workspace_fs.fs_find(name="*.txt", mtime=">1d")
        # Ancient is way more than 1 day old; fresh is seconds old.
        self.assertIn("ancient.txt", out)
        self.assertNotIn("fresh.txt", out)

    async def test_fs_find_bad_mtime_spec_is_ignored(self):
        # Bad spec should not crash; filter is just dropped.
        await workspace_fs.fs_write("x.txt", "v")
        out = await workspace_fs.fs_find(name="*.txt", mtime="garbage")
        self.assertIn("x.txt", out)

    # --- Gap-fill #1: fs_symbols (tree-sitter) -----------------------------

    async def test_fs_symbols_python(self):
        try:
            import tree_sitter_language_pack  # noqa: F401
        except ImportError:
            self.skipTest("tree_sitter_language_pack not installed on host")
        src = (
            "def alpha():\n"
            "    pass\n"
            "\n"
            "class Beta:\n"
            "    def gamma(self):\n"
            "        return 1\n"
        )
        await workspace_fs.fs_write("sample.py", src)
        out = await workspace_fs.fs_symbols("sample.py")
        self.assertIn("alpha", out)
        self.assertIn("Beta", out)
        self.assertIn("gamma", out)
        # Line ranges present
        self.assertRegex(out, r"\[\d+-\d+\]")

    async def test_fs_symbols_unsupported_extension(self):
        # Even without tree-sitter installed, the extension check fires first.
        await workspace_fs.fs_write("data.lua", "function f() end")
        out = await workspace_fs.fs_symbols("data.lua")
        self.assertIn("unsupported language", out.lower())

    async def test_fs_symbols_missing_file(self):
        out = await workspace_fs.fs_symbols("nope.py")
        self.assertIn("not found", out.lower())

    async def test_fs_symbols_markdown_atx(self):
        await workspace_fs.fs_write(
            "doc.md",
            "# Top\n\nintro\n\n## Sub A\n\nbody\n\n### Deep\n\n## Sub B\n",
        )
        out = await workspace_fs.fs_symbols("doc.md")
        self.assertIn("4 defs", out)
        self.assertIn("h1 Top", out)
        self.assertIn("h2 Sub A", out)
        self.assertIn("h3 Deep", out)
        self.assertIn("h2 Sub B", out)

    async def test_fs_symbols_markdown_setext(self):
        await workspace_fs.fs_write(
            "doc.md",
            "Title One\n=========\n\npara\n\nSubtitle\n--------\n",
        )
        out = await workspace_fs.fs_symbols("doc.md")
        self.assertIn("h1 Title One", out)
        self.assertIn("h2 Subtitle", out)

    async def test_fs_symbols_markdown_ignores_fenced_code(self):
        # `#` inside a fenced code block must NOT be treated as a header.
        await workspace_fs.fs_write(
            "doc.md",
            "# Real\n\n```\n# not a header\n## still not\n```\n\n## After\n",
        )
        out = await workspace_fs.fs_symbols("doc.md")
        self.assertIn("h1 Real", out)
        self.assertIn("h2 After", out)
        self.assertNotIn("not a header", out)
        self.assertNotIn("still not", out)

    async def test_fs_symbols_markdown_empty(self):
        await workspace_fs.fs_write("empty.md", "just a paragraph with no headers\n")
        out = await workspace_fs.fs_symbols("empty.md")
        self.assertIn("no definitions", out.lower())


# =============================================================================
# INTEGRITY & ARCHIVE
# =============================================================================

class TestIntegrityArchive(WorkspaceFSTestBase):
    async def test_fs_hash_sha256(self):
        await workspace_fs.fs_write("h.txt", "hello")
        out = await workspace_fs.fs_hash("h.txt")
        self.assertIn("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", out)

    async def test_fs_hash_md5(self):
        await workspace_fs.fs_write("h.txt", "hello")
        out = await workspace_fs.fs_hash("h.txt", algo="md5")
        self.assertIn("5d41402abc4b2a76b9719d911017c592", out)

    async def test_fs_diff_two_files(self):
        await workspace_fs.fs_write("a.txt", "hello\n")
        await workspace_fs.fs_write("b.txt", "hello\nworld\n")
        out = await workspace_fs.fs_diff("a.txt", "b.txt")
        self.assertIn("+world", out)

    async def test_fs_diff_vs_last_read_detects_external_write(self):
        await workspace_fs.fs_write("watched.txt", "v1")
        await workspace_fs.fs_read("watched.txt")
        # Mutate externally (bypassing fs_write)
        (self.root / "watched.txt").write_text("v2", encoding="utf-8")
        out = await workspace_fs.fs_diff("watched.txt", vs_last_read=True)
        self.assertIn("-v1", out)
        self.assertIn("+v2", out)

    async def test_fs_diff_vs_last_read_no_snapshot(self):
        await workspace_fs.fs_write("nofresh.txt", "v")
        out = await workspace_fs.fs_diff("nofresh.txt", vs_last_read=True)
        self.assertIn("no fs_read snapshot", out)

    async def test_fs_extract_zip_slip_rejected(self):
        # Build a malicious zip with ../ entry
        zpath = self.root / "evil.zip"
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr("../escape.txt", b"PWNED")
        out = await workspace_fs.fs_extract("evil.zip", "extracted")
        self.assertIn("zip-slip", out)
        # The escape file must NOT exist outside dest
        self.assertFalse((self.root / "escape.txt").exists())
        self.assertFalse((Path(self.tmp) / "escape.txt").exists())

    async def test_fs_extract_tar_slip_rejected(self):
        tpath = self.root / "evil.tar"
        with tarfile.open(tpath, "w") as tf:
            data = b"PWNED"
            info = tarfile.TarInfo(name="../escape.txt")
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        out = await workspace_fs.fs_extract("evil.tar", "extracted")
        self.assertIn("tar-slip", out)
        self.assertFalse((Path(self.tmp) / "escape.txt").exists())

    async def test_fs_extract_zip_happy_path(self):
        zpath = self.root / "ok.zip"
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr("inner.txt", b"contents")
        out = await workspace_fs.fs_extract("ok.zip", "out")
        self.assertIn("Extracted 1", out)
        self.assertTrue((self.root / "out" / "inner.txt").is_file())

    async def test_fs_extract_gz_single_file(self):
        gp = self.root / "blob.txt.gz"
        with gzip.open(gp, "wb") as g:
            g.write(b"hello gz")
        out = await workspace_fs.fs_extract("blob.txt.gz", "g")
        self.assertIn("Extracted 1", out)
        self.assertEqual((self.root / "g" / "blob.txt").read_bytes(), b"hello gz")

    async def test_fs_archive_tar_gz(self):
        await workspace_fs.fs_write("a.txt", "1")
        await workspace_fs.fs_write("b.txt", "2")
        out = await workspace_fs.fs_archive(["a.txt", "b.txt"], "bundle.tar.gz")
        self.assertIn("Archived 2", out)
        self.assertTrue((self.root / "bundle.tar.gz").is_file())
        with tarfile.open(self.root / "bundle.tar.gz", "r:gz") as tf:
            self.assertEqual(sorted(tf.getnames()), ["a.txt", "b.txt"])

    async def test_fs_archive_zip(self):
        await workspace_fs.fs_write("a.txt", "1")
        out = await workspace_fs.fs_archive(["a.txt"], "bundle.zip", format="zip")
        self.assertIn("Archived 1", out)

    async def test_fs_archive_directory_zip_preserves_dir_name(self):
        # Regression: archiving a dir used to embed the full project-root path
        # so an extract reproduced the nesting (`payloads-restored/notes/payloads/...`).
        # Now arcnames are relative to the input's parent: archiving `pkg/` yields
        # entries `pkg/...` so an extract gives `<dest>/pkg/...` (one level).
        await workspace_fs.fs_write("pkg/a.txt", "1")
        await workspace_fs.fs_write("pkg/nested/b.txt", "2")
        out = await workspace_fs.fs_archive(["pkg"], "bundle.zip", format="zip")
        self.assertIn("Archived 1", out)
        with zipfile.ZipFile(self.root / "bundle.zip") as zf:
            names = sorted(zf.namelist())
        self.assertEqual(names, ["pkg/a.txt", "pkg/nested/b.txt"])

    async def test_fs_archive_directory_tar_preserves_dir_name(self):
        await workspace_fs.fs_write("pkg/a.txt", "1")
        await workspace_fs.fs_write("pkg/nested/b.txt", "2")
        out = await workspace_fs.fs_archive(["pkg"], "bundle.tar.gz")
        self.assertIn("Archived 1", out)
        with tarfile.open(self.root / "bundle.tar.gz", "r:gz") as tf:
            names = sorted(tf.getnames())
        # tar.add() recurses by default; the top-level entry is `pkg`, with children below.
        self.assertIn("pkg", names)
        self.assertIn("pkg/a.txt", names)
        self.assertIn("pkg/nested/b.txt", names)

    async def test_fs_archive_zip_skips_symlinks_inside_dir(self):
        # Security parity with archive_dir_for_project: a symlink found while
        # walking the archived directory must not be followed (zf.write would
        # otherwise inline the target's content under the symlink's name).
        await workspace_fs.fs_write("pkg/real.txt", "ok")
        os.symlink(self.root / "pkg" / "real.txt", self.root / "pkg" / "link.txt")
        await workspace_fs.fs_archive(["pkg"], "bundle.zip", format="zip")
        with zipfile.ZipFile(self.root / "bundle.zip") as zf:
            names = zf.namelist()
        self.assertIn("pkg/real.txt", names)
        self.assertNotIn("pkg/link.txt", names)

    async def test_fs_archive_then_extract_roundtrip(self):
        # Full bundle -> extract roundtrip: a single dir archived and extracted
        # into a fresh destination reproduces the source under `<dest>/<dirname>/`.
        await workspace_fs.fs_write("src/x.txt", "X")
        await workspace_fs.fs_write("src/y.txt", "Y")
        await workspace_fs.fs_archive(["src"], "bundle.zip", format="zip")
        out = await workspace_fs.fs_extract("bundle.zip", "restored", format="zip")
        self.assertIn("Extracted 2", out)
        self.assertEqual((self.root / "restored" / "src" / "x.txt").read_text(), "X")
        self.assertEqual((self.root / "restored" / "src" / "y.txt").read_text(), "Y")

    # --- Gap-fill #2: fs_extract failure modes -----------------------------

    async def test_fs_extract_missing_archive(self):
        out = await workspace_fs.fs_extract("ghost.zip", "out")
        self.assertIn("not found", out.lower())

    async def test_fs_extract_unknown_format_auto_detect(self):
        # File with unknown extension and format='auto' should error cleanly.
        (self.root / "blob.xyz").write_bytes(b"random bytes")
        out = await workspace_fs.fs_extract("blob.xyz", "out")
        self.assertIn("cannot auto-detect", out.lower())

    async def test_fs_extract_bad_format_arg(self):
        (self.root / "any.dat").write_bytes(b"x")
        out = await workspace_fs.fs_extract("any.dat", "out", format="rar")
        self.assertIn("unsupported format", out.lower())

    async def test_fs_archive_missing_source(self):
        out = await workspace_fs.fs_archive(["does-not-exist.txt"], "bundle.tar.gz")
        self.assertIn("not found", out.lower())

    async def test_fs_archive_bad_format(self):
        await workspace_fs.fs_write("a.txt", "1")
        out = await workspace_fs.fs_archive(["a.txt"], "bundle.rar", format="rar")
        self.assertIn("must be tar.gz or zip", out)


# =============================================================================
# Regression bundle: scenarios that have historically broken
# =============================================================================

class TestRegressions(WorkspaceFSTestBase):
    async def test_default_subdirs_writable(self):
        # tool-outputs / jobs / notes / uploads must be writable.
        for sub in ("notes/x.md", "tool-outputs/y.txt", "jobs/z.log", "uploads/w.bin"):
            out = await workspace_fs.fs_write(sub, "v")
            self.assertIn("Wrote", out, msg=f"failed: {sub} -> {out}")

    async def test_multiple_projects_isolated(self):
        _set_pid("proj-a")
        await workspace_fs.fs_write("only-in-a.txt", "A")
        _set_pid("proj-b")
        await workspace_fs.fs_write("only-in-b.txt", "B")
        # Each project sees only its own file
        out_a_from_b = await workspace_fs.fs_read("only-in-a.txt")
        self.assertIn("not found", out_a_from_b.lower())
        _set_pid("proj-a")
        out_a = await workspace_fs.fs_read("only-in-a.txt")
        self.assertIn("A", out_a)

    async def test_resolve_safe_symlink_escape_rejected(self):
        # Create a symlink inside workspace pointing OUTSIDE, then try to
        # read through it. _resolve_safe should reject because .resolve()
        # follows symlinks.
        outside = Path(self.tmp) / "outside_secret.txt"
        outside.write_text("SECRET")
        os.symlink(str(outside), str(self.root / "escape_link"))
        out = await workspace_fs.fs_read("escape_link")
        self.assertNotIn("SECRET", out)
        self.assertIn("Error", out)


if __name__ == "__main__":
    unittest.main()
