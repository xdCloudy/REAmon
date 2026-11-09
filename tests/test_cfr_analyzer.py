"""Boundary tests for the isolated CFR analyzer."""

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_REPO = Path(__file__).resolve().parents[1]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from analyzers.cfr import server


class TestCfrAnalyzerBoundaries(unittest.TestCase):
    def test_safe_id_accepts_supported_identifiers(self):
        self.assertEqual(server.safe_id("fixture-01_run"), "fixture-01_run")
        self.assertEqual(server.safe_id("A" * 128), "A" * 128)

    def test_safe_id_rejects_path_syntax_and_invalid_values(self):
        for value in ("", "../fixture", "a/b", "a.b", "A" * 129, None, 3):
            with self.subTest(value=value):
                with self.assertRaises(server.AnalysisError):
                    server.safe_id(value)

    def test_resolve_input_requires_supported_file_inside_artifact_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "artifacts"
            root.mkdir()
            jar = root / "fixture.jar"
            jar.write_bytes(b"jar")
            outside = Path(directory) / "outside.jar"
            outside.write_bytes(b"jar")
            with patch.object(server, "ARTIFACT_ROOT", root.resolve()):
                self.assertEqual(server.resolve_input(str(jar)), jar.resolve())
                with self.assertRaises(server.AnalysisError):
                    server.resolve_input(str(outside))
                with self.assertRaises(server.AnalysisError):
                    server.resolve_input(str(root))
                unsupported = root / "fixture.zip"
                unsupported.write_bytes(b"zip")
                with self.assertRaises(server.AnalysisError):
                    server.resolve_input(str(unsupported))

    def test_resolve_input_rejects_symlink_even_when_target_is_inside_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / "fixture.jar"
            target.write_bytes(b"jar")
            alias = root / "alias.jar"
            try:
                alias.symlink_to(target)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"symlink creation unavailable: {error}")
            with patch.object(server, "ARTIFACT_ROOT", root):
                with self.assertRaises(server.AnalysisError):
                    server.resolve_input(str(alias))

    def test_analyze_rejects_unsafe_project_before_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            derived = Path(directory).resolve()
            with patch.object(server, "DERIVED_ROOT", derived):
                with self.assertRaises(server.AnalysisError):
                    server.analyze({
                        "projectId": "../escape",
                        "artifactId": "fixture",
                        "taskId": "task",
                        "runId": "run",
                        "artifactPath": "/outside/fixture.jar",
                    })
            self.assertEqual(list(derived.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
