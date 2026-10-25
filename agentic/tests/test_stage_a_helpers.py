"""
Stage-A tests: upload, mkdir, archive-download, preview, properties helpers,
plus the protected-subdir enforcement on rename/delete.

Run with: python3 -m unittest tests.test_stage_a_helpers -v
"""
from __future__ import annotations

import base64
import io
import os
import shutil
import stat
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

_AGENTIC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _AGENTIC_DIR)

import workspace_fs  # noqa: E402


class StageABase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="redamon-stagea-")
        self._orig_root = workspace_fs.WORKSPACE_ROOT
        self._orig_umask = os.umask(0)  # mirror production
        workspace_fs.WORKSPACE_ROOT = Path(self.tmp)

    def tearDown(self):
        os.umask(self._orig_umask)
        workspace_fs.WORKSPACE_ROOT = self._orig_root
        for p, dirs, files in os.walk(self.tmp):
            for d in dirs:
                try:
                    os.chmod(Path(p) / d, 0o777)
                except Exception:
                    pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _mode(self, p: Path) -> int:
        return stat.S_IMODE(p.stat().st_mode)

    def _seed_project(self, pid: str = "proj") -> Path:
        return workspace_fs.resolve_for_project(pid, ".")


# =============================================================================
# is_protected_path + delete/rename gates
# =============================================================================

class TestProtectedSubdirs(StageABase):
    def test_is_protected_path_for_defaults(self):
        for p in ("notes", "tool-outputs", "jobs", "uploads", "/notes", "notes/"):
            self.assertTrue(workspace_fs.is_protected_path(p), f"{p!r} should be protected")

    def test_root_is_protected(self):
        for p in ("", ".", "/"):
            self.assertTrue(workspace_fs.is_protected_path(p))

    def test_nested_paths_not_protected(self):
        for p in ("notes/sub", "tool-outputs/findings.txt", "uploads/x/y"):
            self.assertFalse(workspace_fs.is_protected_path(p))

    def test_user_dirs_not_protected(self):
        for p in ("my-folder", "custom", "scratch"):
            self.assertFalse(workspace_fs.is_protected_path(p))

    def test_delete_refuses_default_subdir(self):
        self._seed_project()
        for sub in ("notes", "tool-outputs", "jobs", "uploads"):
            with self.assertRaises(ValueError, msg=f"{sub} should be protected"):
                workspace_fs.delete_for_project("proj", sub, recursive=True)
            # Subdir must still exist
            self.assertTrue((Path(self.tmp) / "proj" / sub).is_dir())

    def test_rename_refuses_default_subdir(self):
        self._seed_project()
        for sub in ("notes", "tool-outputs", "jobs", "uploads"):
            with self.assertRaises(ValueError):
                workspace_fs.rename_for_project("proj", sub, f"renamed-{sub}")
            self.assertTrue((Path(self.tmp) / "proj" / sub).is_dir())

    def test_delete_user_file_inside_protected_subdir_works(self):
        # Files INSIDE notes/ etc. are deletable - only the subdir itself is protected.
        root = self._seed_project()
        (root / "notes" / "scratch.txt").write_bytes(b"v")
        workspace_fs.delete_for_project("proj", "notes/scratch.txt")
        self.assertFalse((root / "notes" / "scratch.txt").exists())

    def test_rename_user_file_inside_protected_subdir_works(self):
        root = self._seed_project()
        (root / "notes" / "old.txt").write_bytes(b"v")
        workspace_fs.rename_for_project("proj", "notes/old.txt", "new.txt")
        self.assertTrue((root / "notes" / "new.txt").exists())


# =============================================================================
# upload_for_project
# =============================================================================

class TestUpload(StageABase):
    def test_basic_upload(self):
        self._seed_project()
        new_path = workspace_fs.upload_for_project(
            "proj", "uploads", b"hello", "greeting.txt",
        )
        self.assertEqual(new_path, "uploads/greeting.txt")
        target = Path(self.tmp) / "proj" / "uploads" / "greeting.txt"
        self.assertEqual(target.read_bytes(), b"hello")
        # Mode 0o666 (host-writable)
        self.assertEqual(self._mode(target), 0o666)

    def test_upload_to_nested_dir(self):
        self._seed_project()
        # Pre-create a nested dir
        workspace_fs.mkdir_for_project("proj", "uploads/2026")
        workspace_fs.upload_for_project(
            "proj", "uploads/2026", b"v", "data.bin",
        )
        self.assertTrue((Path(self.tmp) / "proj" / "uploads" / "2026" / "data.bin").exists())

    def test_upload_rejects_collision_without_overwrite(self):
        self._seed_project()
        workspace_fs.upload_for_project("proj", "uploads", b"v1", "x.txt")
        with self.assertRaises(FileExistsError):
            workspace_fs.upload_for_project("proj", "uploads", b"v2", "x.txt")
        # First version preserved
        self.assertEqual(
            (Path(self.tmp) / "proj" / "uploads" / "x.txt").read_bytes(),
            b"v1",
        )

    def test_upload_overwrites_when_flag_set(self):
        self._seed_project()
        workspace_fs.upload_for_project("proj", "uploads", b"v1", "x.txt")
        workspace_fs.upload_for_project("proj", "uploads", b"v2", "x.txt", overwrite=True)
        self.assertEqual(
            (Path(self.tmp) / "proj" / "uploads" / "x.txt").read_bytes(),
            b"v2",
        )

    def test_upload_rejects_traversal_in_filename(self):
        self._seed_project()
        for bad in ("../escape.txt", "sub/x.txt", "..", ".", "", "x\x00y"):
            with self.assertRaises(ValueError, msg=f"filename {bad!r} should be rejected"):
                workspace_fs.upload_for_project("proj", "uploads", b"v", bad)

    def test_upload_to_nonexistent_dir_raises(self):
        self._seed_project()
        with self.assertRaises(ValueError):
            workspace_fs.upload_for_project("proj", "ghost-dir", b"v", "x.txt")

    def test_stream_upload_reads_in_bounded_blocks_and_returns_size(self):
        import io

        self._seed_project()

        class TrackingStream(io.BytesIO):
            largest_read = 0

            def read(self, size=-1):
                self.largest_read = max(self.largest_read, size)
                return super().read(size)

        content = b"abc123" * (1024 * 1024)
        source = TrackingStream(content)
        new_path, size = workspace_fs.upload_stream_for_project(
            "proj", "uploads", source, "large.bin",
        )

        target = Path(self.tmp) / "proj" / new_path
        self.assertEqual(size, len(content))
        self.assertEqual(target.read_bytes(), content)
        self.assertEqual(source.largest_read, 1024 * 1024)

    def test_stream_upload_failure_cleans_temp_and_preserves_destination(self):
        import io

        self._seed_project()
        workspace_fs.upload_for_project("proj", "uploads", b"original", "x.txt")

        class BrokenStream(io.BytesIO):
            reads = 0

            def read(self, size=-1):
                self.reads += 1
                if self.reads > 1:
                    raise OSError("source failed")
                return super().read(size)

        with self.assertRaisesRegex(OSError, "source failed"):
            workspace_fs.upload_stream_for_project(
                "proj", "uploads", BrokenStream(b"partial"), "x.txt", overwrite=True,
            )

        folder = Path(self.tmp) / "proj" / "uploads"
        self.assertEqual((folder / "x.txt").read_bytes(), b"original")
        self.assertEqual(list(folder.glob("*.upload-tmp")), [])

    def test_upload_to_file_path_raises(self):
        self._seed_project()
        workspace_fs.upload_for_project("proj", "uploads", b"v", "a.txt")
        with self.assertRaises(ValueError):
            workspace_fs.upload_for_project("proj", "uploads/a.txt", b"v", "b.txt")

    def test_upload_tmp_cleanup_on_success(self):
        # No `.upload-tmp` files should be left after a successful upload
        self._seed_project()
        workspace_fs.upload_for_project("proj", "uploads", b"v", "clean.txt")
        leftovers = list((Path(self.tmp) / "proj" / "uploads").glob("*.upload-tmp"))
        self.assertEqual(leftovers, [])

    def test_upload_rejects_traversal_in_dest_dir(self):
        self._seed_project()
        with self.assertRaises(ValueError):
            workspace_fs.upload_for_project("proj", "../escape", b"v", "x.txt")


# =============================================================================
# mkdir_for_project
# =============================================================================

class TestMkdir(StageABase):
    def test_basic_mkdir(self):
        self._seed_project()
        new_path = workspace_fs.mkdir_for_project("proj", "my-folder")
        self.assertEqual(new_path, "my-folder")
        created = Path(self.tmp) / "proj" / "my-folder"
        self.assertTrue(created.is_dir())
        self.assertEqual(self._mode(created), 0o777)

    def test_nested_mkdir_creates_parents(self):
        self._seed_project()
        workspace_fs.mkdir_for_project("proj", "a/b/c/d")
        self.assertTrue((Path(self.tmp) / "proj" / "a" / "b" / "c" / "d").is_dir())

    def test_mkdir_on_existing_dir_raises(self):
        self._seed_project()
        workspace_fs.mkdir_for_project("proj", "exists")
        with self.assertRaises(ValueError):
            workspace_fs.mkdir_for_project("proj", "exists")

    def test_mkdir_inside_default_subdir_allowed(self):
        # protection covers default-subdirs themselves, not their contents
        self._seed_project()
        new_path = workspace_fs.mkdir_for_project("proj", "uploads/2026")
        self.assertEqual(new_path, "uploads/2026")

    def test_mkdir_rejects_traversal(self):
        self._seed_project()
        for bad in ("../escape", "/abs/path", "..", "."):
            with self.assertRaises(ValueError, msg=f"path {bad!r} should be rejected"):
                workspace_fs.mkdir_for_project("proj", bad)


# =============================================================================
# archive_dir_for_project
# =============================================================================

class TestArchiveDir(StageABase):
    def test_tar_gz_of_user_dir(self):
        root = self._seed_project()
        (root / "scan").mkdir()
        (root / "scan" / "a.txt").write_bytes(b"alpha")
        (root / "scan" / "b.txt").write_bytes(b"beta")
        (root / "scan" / "sub").mkdir()
        (root / "scan" / "sub" / "deep.txt").write_bytes(b"deep")

        archive_bytes, filename = workspace_fs.archive_dir_for_project("proj", "scan")
        self.assertEqual(filename, "scan.tar.gz")
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as tf:
            names = sorted(m.name for m in tf.getmembers() if m.isfile())
        self.assertEqual(names, ["scan/a.txt", "scan/b.txt", "scan/sub/deep.txt"])

    def test_zip_of_user_dir(self):
        root = self._seed_project()
        (root / "scan").mkdir()
        (root / "scan" / "x.txt").write_bytes(b"x")
        archive_bytes, filename = workspace_fs.archive_dir_for_project(
            "proj", "scan", format="zip",
        )
        self.assertEqual(filename, "scan.zip")
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
            self.assertEqual(zf.namelist(), ["scan/x.txt"])
            self.assertEqual(zf.read("scan/x.txt"), b"x")

    def test_archive_of_default_subdir_works(self):
        # Archiving (read-only op) is fine on protected subdirs
        self._seed_project()
        archive_bytes, filename = workspace_fs.archive_dir_for_project("proj", "tool-outputs")
        self.assertEqual(filename, "tool-outputs.tar.gz")

    def test_archive_on_file_raises(self):
        root = self._seed_project()
        (root / "notes" / "a.txt").write_bytes(b"v")
        with self.assertRaises(ValueError):
            workspace_fs.archive_dir_for_project("proj", "notes/a.txt")

    def test_archive_bad_format_raises(self):
        self._seed_project()
        with self.assertRaises(ValueError):
            workspace_fs.archive_dir_for_project("proj", "notes", format="rar")


# =============================================================================
# preview_for_project
# =============================================================================

class TestPreview(StageABase):
    def test_text_preview(self):
        root = self._seed_project()
        (root / "notes" / "README.md").write_bytes(b"# Hello\n\nWorld")
        out = workspace_fs.preview_for_project("proj", "notes/README.md")
        self.assertFalse(out["isBinary"])
        self.assertEqual(out["content"], "# Hello\n\nWorld")
        self.assertFalse(out["truncated"])
        self.assertEqual(out["mime"], "text/markdown")
        self.assertEqual(out["size"], 14)

    def test_binary_preview_is_base64(self):
        root = self._seed_project()
        (root / "uploads" / "blob.bin").write_bytes(b"\x00\x01\x02ABC")
        out = workspace_fs.preview_for_project("proj", "uploads/blob.bin")
        self.assertTrue(out["isBinary"])
        # base64 decodes back to original
        self.assertEqual(base64.b64decode(out["content"]), b"\x00\x01\x02ABC")

    def test_truncation_at_max_bytes(self):
        root = self._seed_project()
        (root / "uploads" / "big.txt").write_bytes(b"X" * 5000)
        out = workspace_fs.preview_for_project("proj", "uploads/big.txt", max_bytes=1000)
        self.assertTrue(out["truncated"])
        self.assertEqual(len(out["content"]), 1000)
        self.assertEqual(out["size"], 5000)

    def test_preview_on_dir_raises(self):
        self._seed_project()
        with self.assertRaises(ValueError):
            workspace_fs.preview_for_project("proj", "notes")

    def test_preview_missing_file_raises(self):
        self._seed_project()
        with self.assertRaises(ValueError):
            workspace_fs.preview_for_project("proj", "notes/ghost.md")


# =============================================================================
# properties_for_project
# =============================================================================

class TestProperties(StageABase):
    def test_file_properties_include_sha256(self):
        root = self._seed_project()
        (root / "notes" / "f.txt").write_bytes(b"hello")
        props = workspace_fs.properties_for_project("proj", "notes/f.txt")
        self.assertEqual(props["type"], "file")
        self.assertEqual(props["size"], 5)
        self.assertEqual(
            props["sha256"],
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )
        self.assertIn("mtime", props)
        self.assertIn("mode", props)

    def test_dir_properties_omit_sha(self):
        self._seed_project()
        props = workspace_fs.properties_for_project("proj", "notes")
        self.assertEqual(props["type"], "dir")
        self.assertNotIn("sha256", props)

    def test_symlink_properties_include_target(self):
        root = self._seed_project()
        (root / "notes" / "target.txt").write_bytes(b"v")
        link = root / "notes" / "lnk"
        os.symlink(str(root / "notes" / "target.txt"), str(link))
        props = workspace_fs.properties_for_project("proj", "notes/lnk")
        self.assertEqual(props["type"], "symlink")
        self.assertIn("target", props)
        self.assertIn("target.txt", props["target"])

    def test_missing_path_raises(self):
        self._seed_project()
        with self.assertRaises(ValueError):
            workspace_fs.properties_for_project("proj", "notes/ghost.md")


class TestBulkArchive(StageABase):
    """bulk_archive_for_project - bundles N entries (files + dirs) into one
    archive. Used by Stage-D multi-select "Download N as zip"."""

    def test_bulk_archive_tar_includes_each_top_level_entry(self):
        root = self._seed_project()
        (root / "scan").mkdir()
        (root / "scan" / "a.txt").write_bytes(b"a")
        (root / "loose.md").write_bytes(b"loose-content")
        archive_bytes, filename = workspace_fs.bulk_archive_for_project(
            "proj", ["scan", "loose.md"],
        )
        self.assertEqual(filename, "bundle.tar.gz")
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as tf:
            top_level = sorted(set(m.name.split("/")[0] for m in tf.getmembers()))
        self.assertIn("scan", top_level)
        self.assertIn("loose.md", top_level)

    def test_bulk_archive_zip_format(self):
        self._seed_project()
        workspace_fs.upload_for_project("proj", "uploads", b"x", "x.txt")
        archive_bytes, filename = workspace_fs.bulk_archive_for_project(
            "proj", ["uploads/x.txt"], format="zip", archive_name="picks",
        )
        self.assertEqual(filename, "picks.zip")
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
            self.assertEqual(zf.namelist(), ["x.txt"])

    def test_bulk_archive_rejects_symlink_path_directly(self):
        # Top-level symlink-to-outside: resolve_for_project follows the link,
        # sees the target lives outside the workspace, and raises BEFORE
        # archive logic runs. Cleaner than letting the symlink reach the
        # archive layer.
        root = self._seed_project()
        outside = Path(self.tmp) / "OUT.txt"
        outside.write_text("SECRET")
        os.symlink(str(outside), str(root / "uploads" / "leak.lnk"))
        with self.assertRaises(ValueError):
            workspace_fs.bulk_archive_for_project("proj", ["uploads/leak.lnk"])

    def test_bulk_archive_dir_contents_skip_inner_symlinks(self):
        # Bug #18 regression - if a dir argument CONTAINS a symlink, that
        # symlink's target content must NOT be archived.
        root = self._seed_project()
        outside = Path(self.tmp) / "OUT_SECRET.txt"
        outside.write_text("CONFIDENTIAL-XYZ")
        (root / "scan").mkdir()
        (root / "scan" / "legit.txt").write_text("ok")
        os.symlink(str(outside), str(root / "scan" / "leak.lnk"))

        archive_bytes, _ = workspace_fs.bulk_archive_for_project(
            "proj", ["scan"], format="zip",
        )
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
            for name in zf.namelist():
                self.assertNotIn(b"CONFIDENTIAL-XYZ", zf.read(name),
                                 f"Inner symlink leaked through {name!r}")

    def test_bulk_archive_rejects_empty_paths(self):
        self._seed_project()
        with self.assertRaises(ValueError):
            workspace_fs.bulk_archive_for_project("proj", [])

    def test_bulk_archive_rejects_missing_path(self):
        self._seed_project()
        with self.assertRaises(ValueError):
            workspace_fs.bulk_archive_for_project("proj", ["ghost.txt"])

    def test_bulk_archive_rejects_traversal_in_any_path(self):
        self._seed_project()
        with self.assertRaises(ValueError):
            workspace_fs.bulk_archive_for_project("proj", ["../escape"])


if __name__ == "__main__":
    unittest.main()
