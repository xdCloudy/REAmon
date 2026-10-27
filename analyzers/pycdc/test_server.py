import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class ResolveInputTests(unittest.TestCase):
    def test_accepts_project_scoped_pyinstaller_module_storage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            derived_root = root / "derived"
            artifact_root = root / "artifacts"
            stable_prefix = derived_root / "project" / "artifact" / "pyinstaller"
            stable_prefix.mkdir(parents=True)
            bytecode = stable_prefix / "module.pyc"
            bytecode.write_bytes(b"\x42\x43\r\n" + bytes(12))

            with patch.object(server, "ARTIFACT_ROOT", artifact_root), patch.object(server, "DERIVED_ROOT", derived_root):
                resolved = server.resolve_input(str(bytecode), "pyc", (stable_prefix,))

            self.assertEqual(resolved, bytecode.resolve())

    def test_accepts_run_scoped_pyinstaller_module_storage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            derived_root = root / "derived"
            artifact_root = root / "artifacts"
            run_prefix = derived_root / "project" / "artifact" / "task" / "run" / "pyinstaller"
            run_prefix.mkdir(parents=True)
            bytecode = run_prefix / "module.pyc"
            bytecode.write_bytes(b"\x42\x43\r\n" + bytes(12))

            with patch.object(server, "ARTIFACT_ROOT", artifact_root), patch.object(server, "DERIVED_ROOT", derived_root):
                resolved = server.resolve_input(str(bytecode), "pyc", (run_prefix,))

            self.assertEqual(resolved, bytecode.resolve())

    def test_rejects_sibling_derived_paths_and_symlinks_outside_allowed_roots(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            derived_root = root / "derived"
            artifact_root = root / "artifacts"
            allowed_prefix = derived_root / "project" / "artifact" / "pyinstaller"
            allowed_prefix.mkdir(parents=True)
            sibling = derived_root / "project" / "artifact" / "other" / "module.pyc"
            sibling.parent.mkdir(parents=True)
            sibling.write_bytes(b"\x42\x43\r\n" + bytes(12))
            outside = root / "outside.pyc"
            outside.write_bytes(b"\x42\x43\r\n" + bytes(12))
            link = allowed_prefix / "escape.pyc"
            link.symlink_to(outside)

            with patch.object(server, "ARTIFACT_ROOT", artifact_root), patch.object(server, "DERIVED_ROOT", derived_root):
                with self.assertRaises(server.AnalysisError):
                    server.resolve_input(str(sibling), "pyc", (allowed_prefix,))
                with self.assertRaises(server.AnalysisError):
                    server.resolve_input(str(link), "pyc", (allowed_prefix,))


if __name__ == "__main__":
    unittest.main()
