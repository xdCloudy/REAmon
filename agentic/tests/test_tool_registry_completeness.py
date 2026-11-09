"""
Regression test for tool_registry.py / workspace_fs.py / job_runner.py
alignment.

Every fs_* tool in workspace_fs.DISPATCH MUST have a tool_registry entry
(otherwise the LLM never learns about it). Same for every job_* tool in
job_runner.JOB_TOOL_NAMES. Each entry MUST have all 4 fields and a
non-trivially-short description (so partially-typed entries don't slip in).

This test exists because the connection between the three modules is
implicit - a future refactor could rename a tool, forget to update the
registry, and the agent would silently lose the tool from its menu.

Run with: python3 -m unittest tests.test_tool_registry_completeness -v
"""
from __future__ import annotations

import os
import sys
import unittest

_AGENTIC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _AGENTIC_DIR)

import workspace_fs  # noqa: E402
import job_runner  # noqa: E402
from prompts.tool_registry import TOOL_REGISTRY  # noqa: E402


REQUIRED_FIELDS = ("purpose", "when_to_use", "args_format", "description")
MIN_DESCRIPTION_CHARS = 100  # catches stub entries / placeholder text


class TestRegistryAlignment(unittest.TestCase):
    def test_every_fs_tool_in_registry(self):
        missing = sorted(workspace_fs.FS_TOOL_NAMES - set(TOOL_REGISTRY.keys()))
        self.assertEqual(missing, [], f"fs_* tools missing from TOOL_REGISTRY: {missing}")

    def test_every_job_tool_in_registry(self):
        missing = sorted(job_runner.JOB_TOOL_NAMES - set(TOOL_REGISTRY.keys()))
        self.assertEqual(missing, [], f"job_* tools missing from TOOL_REGISTRY: {missing}")

    def test_workspace_evidence_tools_are_documented(self):
        for name in ("workspace_list_evidence", "workspace_get_evidence"):
            entry = TOOL_REGISTRY[name]
            for field in REQUIRED_FIELDS:
                self.assertIn(field, entry, f"{name}.{field} missing")
            self.assertGreaterEqual(len(entry["description"]), MIN_DESCRIPTION_CHARS)

    def test_workspace_code_relationship_reader_is_documented(self):
        name = "workspace_list_code_relationships"
        entry = TOOL_REGISTRY[name]
        for field in REQUIRED_FIELDS:
            self.assertIn(field, entry, f"{name}.{field} missing")
        self.assertGreaterEqual(len(entry["description"]), MIN_DESCRIPTION_CHARS)
        self.assertIn("signed nextCursor pages", entry["description"])

    def test_no_dispatch_orphans(self):
        # Every DISPATCH key must equal an FS_TOOL_NAMES entry.
        self.assertEqual(set(workspace_fs.DISPATCH.keys()), set(workspace_fs.FS_TOOL_NAMES))

    def test_no_registered_fs_tool_without_dispatch(self):
        # Inverse: if the registry advertises an fs_ tool, DISPATCH must serve it.
        for name in TOOL_REGISTRY:
            if name.startswith("fs_"):
                self.assertIn(name, workspace_fs.DISPATCH,
                              f"{name} is in TOOL_REGISTRY but has no DISPATCH handler")

    def test_every_entry_has_all_required_fields(self):
        missing_field = []
        for name, entry in TOOL_REGISTRY.items():
            if not name.startswith(("fs_", "job_")):
                continue  # only checking the Phase-3 additions
            for f in REQUIRED_FIELDS:
                if f not in entry:
                    missing_field.append(f"{name}.{f}")
        self.assertEqual(missing_field, [], f"missing fields: {missing_field}")

    def test_every_description_non_trivial(self):
        too_short = []
        for name, entry in TOOL_REGISTRY.items():
            if not name.startswith(("fs_", "job_")):
                continue
            desc = entry.get("description", "")
            if len(desc) < MIN_DESCRIPTION_CHARS:
                too_short.append(f"{name} ({len(desc)} chars)")
        self.assertEqual(too_short, [],
                         f"description shorter than {MIN_DESCRIPTION_CHARS} chars: {too_short}")

    def test_description_starts_with_tool_name_marker(self):
        # Convention check: every description leads with **tool_name** so the
        # LLM can identify which tool it's reading about.
        bad = []
        for name, entry in TOOL_REGISTRY.items():
            if not name.startswith(("fs_", "job_")):
                continue
            desc = entry.get("description", "")
            if not desc.lstrip().startswith(f"**{name}**"):
                bad.append(name)
        self.assertEqual(bad, [],
                         f"descriptions not leading with **<tool_name>**: {bad}")

    def test_expected_count(self):
        # 24 fs_* + 5 job_* = 29 new tools. Lock the count so accidental
        # additions/removals get caught.
        new_count = sum(1 for n in TOOL_REGISTRY if n.startswith(("fs_", "job_")))
        self.assertEqual(new_count, 29, f"expected 29 new tools, got {new_count}")


if __name__ == "__main__":
    unittest.main()
