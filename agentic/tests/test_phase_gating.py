"""
Unit + regression tests for project_settings.is_tool_allowed_in_phase()
after the Phase-2 fs_*/job_* foundational-tool bypass was added.

Covers:
  - fs_* and job_* are allowed in every phase (foundational bypass)
  - Pre-existing TOOL_PHASE_MAP entries still work (regression)
  - Unknown tool with no manifest entry still returns False (regression)
  - Bypass uses prefix match - 'fs_x' / 'job_x' work, 'fsx' / 'fooFs' don't

Run with: python3 -m unittest tests.test_phase_gating -v
"""
from __future__ import annotations

import os
import sys
import unittest

_AGENTIC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _AGENTIC_DIR)

import project_settings  # noqa: E402


class TestFoundationalBypass(unittest.TestCase):
    def test_evidence_tools_are_offered_for_old_maps_and_can_be_disabled(self):
        project_settings._settings = {"TOOL_PHASE_MAP": {"query_graph": ["informational"]}}
        project_settings._current_project_id = "old-project"
        for tool in ("workspace_list_evidence", "workspace_get_evidence"):
            for phase in ("informational", "exploitation", "post_exploitation"):
                self.assertTrue(project_settings.is_tool_allowed_in_phase(tool, phase))
                self.assertIn(tool, project_settings.get_allowed_tools_for_phase(phase))
        project_settings._settings["TOOL_PHASE_MAP"]["workspace_get_evidence"] = []
        self.assertFalse(project_settings.is_tool_allowed_in_phase("workspace_get_evidence", "informational"))
        self.assertNotIn("workspace_get_evidence", project_settings.get_allowed_tools_for_phase("informational"))
        project_settings._settings = None
        project_settings._current_project_id = None

    def test_code_unit_tools_are_offered_for_old_maps_and_can_be_disabled(self):
        project_settings._settings = {"TOOL_PHASE_MAP": {"query_graph": ["informational"]}}
        project_settings._current_project_id = "old-project"
        for tool in ("workspace_list_code_units", "workspace_get_code_unit"):
            for phase in ("informational", "exploitation", "post_exploitation"):
                self.assertTrue(project_settings.is_tool_allowed_in_phase(tool, phase))
                self.assertIn(tool, project_settings.get_allowed_tools_for_phase(phase))
        project_settings._settings["TOOL_PHASE_MAP"]["workspace_get_code_unit"] = []
        self.assertFalse(project_settings.is_tool_allowed_in_phase("workspace_get_code_unit", "informational"))
        self.assertNotIn("workspace_get_code_unit", project_settings.get_allowed_tools_for_phase("informational"))
        project_settings._settings = None
        project_settings._current_project_id = None

    def test_every_fs_tool_allowed_in_every_phase(self):
        fs_tools = [
            "fs_read", "fs_write", "fs_edit", "fs_multi_edit", "fs_undo_edit",
            "fs_delete", "fs_move", "fs_copy", "fs_mkdir", "fs_chmod",
            "fs_symlink_create", "fs_grep", "fs_glob", "fs_find", "fs_list",
            "fs_tree", "fs_symbols", "fs_symlink_read", "fs_hash", "fs_diff",
            "fs_extract", "fs_archive", "fs_stat", "fs_read_many",
        ]
        for tool in fs_tools:
            for phase in ("informational", "exploitation", "post_exploitation"):
                self.assertTrue(
                    project_settings.is_tool_allowed_in_phase(tool, phase),
                    f"{tool} should be allowed in {phase}",
                )

    def test_every_job_tool_allowed_in_every_phase(self):
        for tool in ("job_spawn", "job_status", "job_wait", "job_cancel", "job_list"):
            for phase in ("informational", "exploitation", "post_exploitation"):
                self.assertTrue(
                    project_settings.is_tool_allowed_in_phase(tool, phase),
                    f"{tool} should be allowed in {phase}",
                )

    def test_bypass_is_prefix_match_not_substring(self):
        # 'fsx' or 'fooFs' must NOT match the fs_ prefix bypass.
        self.assertFalse(project_settings.is_tool_allowed_in_phase("fsx", "informational"))
        self.assertFalse(project_settings.is_tool_allowed_in_phase("fooFs_read", "informational"))
        self.assertFalse(project_settings.is_tool_allowed_in_phase("xjob_spawn", "informational"))

    def test_arbitrary_phase_string_still_allowed_for_fs(self):
        # The bypass returns True regardless of phase string - even garbage phases.
        # This is intentional: fs_* shouldn't care about phase at all.
        self.assertTrue(project_settings.is_tool_allowed_in_phase("fs_read", "nonsense"))


class TestRegressionPreservedNonFsBehaviour(unittest.TestCase):
    def setUp(self):
        # Force the cached settings to a known map so we don't depend on
        # whatever was loaded from postgres earlier.
        project_settings._settings = {
            "TOOL_PHASE_MAP": {
                "execute_hydra": ["exploitation", "post_exploitation"],
                "query_graph": ["informational", "exploitation", "post_exploitation"],
            },
        }
        project_settings._current_project_id = "test-cached"

    def tearDown(self):
        project_settings._settings = None
        project_settings._current_project_id = None

    def test_hydra_rejected_in_informational(self):
        self.assertFalse(
            project_settings.is_tool_allowed_in_phase("execute_hydra", "informational")
        )

    def test_hydra_allowed_in_exploitation(self):
        self.assertTrue(
            project_settings.is_tool_allowed_in_phase("execute_hydra", "exploitation")
        )

    def test_query_graph_allowed_in_all(self):
        for phase in ("informational", "exploitation", "post_exploitation"):
            self.assertTrue(
                project_settings.is_tool_allowed_in_phase("query_graph", phase)
            )

    def test_unknown_tool_rejected_when_not_in_map_and_not_in_manifest(self):
        # An unknown tool (no map entry, no manifest entry) should still be
        # rejected. The Phase-2 bypass MUST NOT have widened this gate.
        self.assertFalse(
            project_settings.is_tool_allowed_in_phase("totally_unknown_tool", "informational")
        )


class TestGetAllowedToolsIncludesFoundational(unittest.TestCase):
    """BUG #20a regression: get_allowed_tools_for_phase (which builds the
    LLM's visible-tools enum) must include fs_*/job_* tools. Without this,
    the LLM literally doesn't know they exist and falls back to
    `kali_shell mkdir` for filesystem ops - defeating project scoping and
    the workspace umask discipline."""

    def setUp(self):
        project_settings._settings = {
            "TOOL_PHASE_MAP": {
                "execute_curl": ["informational", "exploitation", "post_exploitation"],
                "kali_shell": ["informational", "exploitation", "post_exploitation"],
            },
        }
        project_settings._current_project_id = "test-cached"

    def tearDown(self):
        project_settings._settings = None
        project_settings._current_project_id = None

    def test_fs_tools_present_in_each_phase(self):
        for phase in ("informational", "exploitation", "post_exploitation"):
            allowed = set(project_settings.get_allowed_tools_for_phase(phase))
            for fs_tool in ("fs_read", "fs_write", "fs_mkdir", "fs_grep",
                            "fs_edit", "fs_extract"):
                self.assertIn(
                    fs_tool, allowed,
                    f"{fs_tool} missing from allowed_tools for phase {phase!r} - "
                    f"LLM enum would omit it (bug #20a regression)",
                )

    def test_job_tools_present_in_each_phase(self):
        for phase in ("informational", "exploitation", "post_exploitation"):
            allowed = set(project_settings.get_allowed_tools_for_phase(phase))
            for job_tool in ("job_spawn", "job_status", "job_wait",
                             "job_cancel", "job_list"):
                self.assertIn(
                    job_tool, allowed,
                    f"{job_tool} missing from allowed_tools for phase {phase!r}",
                )

    def test_existing_map_tools_still_present(self):
        # Non-regression: the fix mustn't have crowded out the existing entries.
        allowed = set(project_settings.get_allowed_tools_for_phase("informational"))
        self.assertIn("execute_curl", allowed)
        self.assertIn("kali_shell", allowed)


if __name__ == "__main__":
    unittest.main()


# =============================================================================
# Graph companion tools (mcp_plan 7.8)
# =============================================================================
#
# graph_schema and graph_summary INHERIT query_graph's gating. The operator sees
# one tool; enabling it grants all three. They must never become
# TOOL_PHASE_MAP keys of their own, because two separate mechanisms would then
# disable them permanently on existing projects with no visible error:
# is_tool_allowed_in_phase returns False for an unmapped tool, and
# fetch_agent_settings REPLACES the stored map rather than merging into it.
#
# Both gating functions are asserted, not just one. Patching only
# is_tool_allowed_in_phase leaves the tools permitted but never OFFERED, since
# get_allowed_tools_for_phase builds the LLM's available-tools enum - the exact
# shape of BUG #20 recorded in that function's own docstring.

_PHASES = ("informational", "exploitation", "post_exploitation")
_COMPANIONS = ("graph_schema", "graph_summary")


class TestGraphCompanionInheritance(unittest.TestCase):
    def _set_map(self, phase_map):
        project_settings._settings = {"TOOL_PHASE_MAP": phase_map}
        project_settings._current_project_id = "test-companions"

    def tearDown(self):
        project_settings._settings = None
        project_settings._current_project_id = None

    def test_query_graph_on_everywhere_grants_both_everywhere(self):
        self._set_map({"query_graph": list(_PHASES)})
        for tool in _COMPANIONS:
            for phase in _PHASES:
                self.assertTrue(
                    project_settings.is_tool_allowed_in_phase(tool, phase),
                    f"{tool} should be allowed in {phase}",
                )

    def test_and_both_are_LISTED_for_the_llm(self):
        # The other half of the gate. Permitted-but-not-offered means the agent
        # never calls them.
        self._set_map({"query_graph": list(_PHASES)})
        for phase in _PHASES:
            listed = project_settings.get_allowed_tools_for_phase(phase)
            for tool in _COMPANIONS:
                self.assertIn(tool, listed, f"{tool} missing from the enum for {phase}")

    def test_empty_phase_list_turns_all_three_off(self):
        # Inheritance is total, including OFF.
        self._set_map({"query_graph": []})
        for phase in _PHASES:
            self.assertFalse(project_settings.is_tool_allowed_in_phase("query_graph", phase))
            for tool in _COMPANIONS:
                self.assertFalse(
                    project_settings.is_tool_allowed_in_phase(tool, phase),
                    f"{tool} should be denied in {phase}",
                )
                self.assertNotIn(tool, project_settings.get_allowed_tools_for_phase(phase))

    def test_a_narrower_query_graph_narrows_the_companions_identically(self):
        self._set_map({"query_graph": ["informational"]})
        for tool in _COMPANIONS:
            self.assertTrue(project_settings.is_tool_allowed_in_phase(tool, "informational"))
            self.assertFalse(project_settings.is_tool_allowed_in_phase(tool, "exploitation"))
        self.assertIn("graph_schema", project_settings.get_allowed_tools_for_phase("informational"))
        self.assertNotIn("graph_schema", project_settings.get_allowed_tools_for_phase("exploitation"))

    def test_a_map_that_predates_the_companions_still_grants_them(self):
        # The migration case: a project whose stored jsonb has query_graph but
        # has never heard of the companions. With a TOOL_PHASE_MAP key they
        # would be off forever here; with inheritance they just work.
        self._set_map({"query_graph": list(_PHASES), "execute_nmap": ["exploitation"]})
        for tool in _COMPANIONS:
            self.assertTrue(project_settings.is_tool_allowed_in_phase(tool, "informational"))

    def test_a_project_with_NO_query_graph_entry_denies_them(self):
        # is_tool_allowed_in_phase fails closed on an unmapped tool, and the
        # companions inherit that answer rather than defaulting to open.
        self._set_map({"execute_nmap": ["exploitation"]})
        for tool in _COMPANIONS:
            for phase in _PHASES:
                self.assertFalse(project_settings.is_tool_allowed_in_phase(tool, phase))

    def test_neither_is_ever_a_phase_map_key(self):
        # If one is ever added as a key, the inheritance silently stops being
        # the mechanism and the migration hazard comes back.
        from project_settings import DEFAULT_AGENT_SETTINGS

        default_map = DEFAULT_AGENT_SETTINGS.get("TOOL_PHASE_MAP", {})
        for tool in _COMPANIONS:
            self.assertNotIn(tool, default_map)

    def test_neither_is_dangerous(self):
        # Read-only, no target traffic: no stealth rule, no RoE category, no
        # confirmation gate.
        for tool in _COMPANIONS:
            self.assertNotIn(tool, project_settings.DANGEROUS_TOOLS)

    def test_the_companion_set_is_exactly_these_two(self):
        self.assertEqual(project_settings.GRAPH_COMPANION_TOOLS, frozenset(_COMPANIONS))
        # query_graph itself must NOT be in the set, or the inheritance check
        # would recurse forever.
        self.assertNotIn("query_graph", project_settings.GRAPH_COMPANION_TOOLS)


class TestGraphCompanionRegistry(unittest.TestCase):
    def test_both_are_in_the_tool_registry(self):
        # The registry is the only place the agent learns a tool exists;
        # skipping it ships dead code.
        from prompts.tool_registry import TOOL_REGISTRY

        for tool in _COMPANIONS:
            self.assertIn(tool, TOOL_REGISTRY)
            for field in ("purpose", "when_to_use", "args_format", "description"):
                self.assertTrue(TOOL_REGISTRY[tool].get(field), f"{tool}.{field} is empty")

    def test_all_three_carry_the_same_usage_rule(self):
        from prompts.tool_registry import TOOL_REGISTRY

        for tool in ("query_graph", *_COMPANIONS):
            desc = TOOL_REGISTRY[tool]["description"]
            self.assertIn("Use graph_summary first", desc, f"{tool} is missing the usage rule")
            self.assertIn("Use graph_schema when", desc, f"{tool} is missing the usage rule")

    def test_query_graph_no_longer_hand_lists_node_labels(self):
        # That list is exactly what drifts; graph_schema serves the real thing.
        from prompts.tool_registry import TOOL_REGISTRY

        desc = TOOL_REGISTRY["query_graph"]["description"]
        self.assertNotIn("MultiscannerFinding", desc)
        self.assertNotIn("**Nodes:**", desc)

    def test_the_names_are_reserved_against_user_mcp_servers(self):
        from mcp_registry import _builtin_tool_names

        builtin = _builtin_tool_names()
        for tool in _COMPANIONS:
            self.assertIn(tool, builtin, f"{tool} is not reserved; a user MCP could shadow it")
