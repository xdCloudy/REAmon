"""Unit tests for CypherFix tree-sitter navigation tools (D1):
github_symbols, github_find_definition, github_find_references, github_repo_map.

Real-parser paths run on a small .py fixture (tree_sitter_language_pack is in the
agent image); graceful degradation paths are covered by monkeypatching
_get_parser -> None and using an unsupported extension.

Run: pytest tests/test_cypherfix_navigation_tools.py
"""
from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cypherfix_codefix.state import CodeFixState
from cypherfix_codefix.tools import symbols_tool
from cypherfix_codefix.tools.symbols_tool import github_symbols, _get_parser
from cypherfix_codefix.tools.find_definition_tool import github_find_definition
from cypherfix_codefix.tools.find_references_tool import github_find_references
from cypherfix_codefix.tools.repo_map_tool import github_repo_map


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


_SAMPLE = '''\
import os


def helper(x):
    return x + 1


class Widget:
    def __init__(self, name):
        self.name = name

    def render(self):
        return helper(self.name)


def main():
    w = Widget("hi")
    return w.render()
'''

_PARSER_AVAILABLE = _get_parser("python") is not None


@unittest.skipUnless(_PARSER_AVAILABLE, "tree-sitter python parser not available")
class TestSymbolsReal(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state = CodeFixState()
        self.state.repo_path = Path(self.tmp)
        (Path(self.tmp) / "mod.py").write_text(_SAMPLE, encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_symbols_lists_top_level_and_nested_definitions(self):
        out = run(github_symbols(self.state, "mod.py"))
        self.assertIn("helper", out)
        self.assertIn("Widget", out)
        self.assertIn("render", out)   # nested method
        self.assertIn("main", out)

    def test_symbols_missing_file_returns_error(self):
        out = run(github_symbols(self.state, "nope.py"))
        self.assertIn("File not found", out)

    def test_symbols_unsupported_extension_reports_supported_list(self):
        (Path(self.tmp) / "x.zzz").write_text("nothing\n", encoding="utf-8")
        out = run(github_symbols(self.state, "x.zzz"))
        self.assertIn("Unsupported language", out)

    def test_symbols_parser_unavailable_degrades_gracefully(self):
        orig = symbols_tool._get_parser
        symbols_tool._get_parser = lambda lang: None
        try:
            out = run(github_symbols(self.state, "mod.py"))
        finally:
            symbols_tool._get_parser = orig
        self.assertIn("parser not available", out)


@unittest.skipUnless(_PARSER_AVAILABLE, "tree-sitter python parser not available")
class TestFindDefinition(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state = CodeFixState()
        self.state.repo_path = Path(self.tmp)
        (Path(self.tmp) / "mod.py").write_text(_SAMPLE, encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_find_definition_locates_function(self):
        out = run(github_find_definition(self.state, "helper"))
        self.assertIn("mod.py", out)
        self.assertIn("helper", out)

    def test_find_definition_unknown_symbol_suggests_grep(self):
        out = run(github_find_definition(self.state, "does_not_exist_sym"))
        self.assertIn("No definition found", out)

    def test_find_definition_missing_scope_dir_errors(self):
        out = run(github_find_definition(self.state, "helper", scope="no_such_dir"))
        self.assertIn("Directory not found", out)


@unittest.skipUnless(_PARSER_AVAILABLE, "tree-sitter python parser not available")
class TestFindReferences(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state = CodeFixState()
        self.state.repo_path = Path(self.tmp)
        (Path(self.tmp) / "mod.py").write_text(_SAMPLE, encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_find_references_reports_usage_sites(self):
        # helper is called inside Widget.render -> at least one reference
        out = run(github_find_references(self.state, "helper"))
        self.assertIn("mod.py", out)
        self.assertIn("helper", out)

    def test_find_references_none_for_absent_symbol(self):
        out = run(github_find_references(self.state, "totally_absent_xyz"))
        self.assertIn("No references found", out)


@unittest.skipUnless(_PARSER_AVAILABLE, "tree-sitter python parser not available")
class TestRepoMap(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state = CodeFixState()
        self.state.repo_path = Path(self.tmp)
        (Path(self.tmp) / "mod.py").write_text(_SAMPLE, encoding="utf-8")
        (Path(self.tmp) / "other.py").write_text(
            "def util():\n    return 2\n", encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_repo_map_lists_files_with_signatures(self):
        out = run(github_repo_map(self.state))
        self.assertIn("Repository Map", out)
        self.assertIn("mod.py", out)
        self.assertIn("Widget", out)

    def test_repo_map_empty_repo_reports_no_sources(self):
        empty = tempfile.mkdtemp()
        try:
            st = CodeFixState()
            st.repo_path = Path(empty)
            out = run(github_repo_map(st))
            self.assertIn("No source files found", out)
        finally:
            shutil.rmtree(empty, ignore_errors=True)

    def test_repo_map_focus_paths_scopes_to_subset(self):
        out = run(github_repo_map(self.state, focus_paths=["other.py"]))
        self.assertIn("other.py", out)


if __name__ == "__main__":
    unittest.main()
