"""
Unit + regression tests for agentic/agent_context.py and the back-compat
re-exports from tools.py.

Covers:
  - All 4 contextvars exist and default to expected values
  - set_tenant_context() sets both user and project together
  - set_phase_context() / set_graph_view_context() helpers work
  - get_phase_context() / get_graph_view_context() return current values
  - REGRESSION: `from tools import current_project_id` returns the SAME
    ContextVar object as `from agent_context import current_project_id`
    (refactor must preserve binding-identity for existing callers like
    orchestrator_helpers/nodes/execute_tool_node.py)

Run with: python3 -m unittest tests.test_agent_context -v
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import MagicMock

_AGENTIC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _AGENTIC_DIR)

import agent_context  # noqa: E402


class TestContextVars(unittest.TestCase):
    def setUp(self):
        # Reset to defaults before each test
        agent_context.current_user_id.set("")
        agent_context.current_project_id.set("")
        agent_context.current_phase.set("informational")
        agent_context.current_graph_view_cypher.set(None)

    def test_all_contextvars_exist(self):
        for name in (
            "current_user_id", "current_project_id",
            "current_phase", "current_graph_view_cypher",
        ):
            self.assertTrue(hasattr(agent_context, name), f"missing: {name}")

    def test_set_tenant_context_sets_both(self):
        agent_context.set_tenant_context("user-1", "proj-1")
        self.assertEqual(agent_context.current_user_id.get(), "user-1")
        self.assertEqual(agent_context.current_project_id.get(), "proj-1")

    def test_set_phase_context_roundtrip(self):
        agent_context.set_phase_context("exploitation")
        self.assertEqual(agent_context.get_phase_context(), "exploitation")

    def test_graph_view_roundtrip(self):
        agent_context.set_graph_view_context("MATCH (n:Domain) RETURN n")
        self.assertEqual(
            agent_context.get_graph_view_context(),
            "MATCH (n:Domain) RETURN n",
        )

    def test_graph_view_default_none(self):
        agent_context.set_graph_view_context(None)
        self.assertIsNone(agent_context.get_graph_view_context())


class TestToolsReExportIdentity(unittest.TestCase):
    """REGRESSION: tools.py must re-export the SAME ContextVar objects
    as agent_context, not new ones. Otherwise existing callers that do
    `from tools import current_project_id` will see a different var than
    workspace_fs (which reads from agent_context) - causing project_id
    to appear missing from tool calls."""

    def setUp(self):
        # Stub the heavy deps so we can import tools.py on the host.
        for mod_name in [
            "langchain_core", "langchain_core.tools",
            "langchain_core.language_models", "langchain_core.messages",
            "langchain_mcp_adapters", "langchain_mcp_adapters.client",
            "langchain_neo4j",
            "graph_db", "graph_db.tenant_filter",
            "prompts",
        ]:
            if mod_name not in sys.modules:
                sys.modules[mod_name] = MagicMock()
        sys.modules["graph_db.tenant_filter"].find_disallowed_write_operation = lambda *a, **kw: None
        sys.modules["graph_db.tenant_filter"].inject_tenant_filter = lambda c, *a, **kw: c
        sys.modules["prompts"].TEXT_TO_CYPHER_SYSTEM = ""

        def _identity_tool(fn=None, **_kw):
            if callable(fn):
                return fn
            return lambda f: f
        sys.modules["langchain_core.tools"].tool = _identity_tool

    def test_current_project_id_is_same_object(self):
        import tools
        self.assertIs(tools.current_project_id, agent_context.current_project_id)

    def test_current_user_id_is_same_object(self):
        import tools
        self.assertIs(tools.current_user_id, agent_context.current_user_id)

    def test_current_phase_is_same_object(self):
        import tools
        self.assertIs(tools.current_phase, agent_context.current_phase)

    def test_current_graph_view_cypher_is_same_object(self):
        import tools
        self.assertIs(tools.current_graph_view_cypher, agent_context.current_graph_view_cypher)

    def test_set_through_tools_visible_through_agent_context(self):
        import tools
        tools.current_project_id.set("via-tools")
        self.assertEqual(agent_context.current_project_id.get(), "via-tools")

    def test_set_helpers_re_exported(self):
        import tools
        self.assertIs(tools.set_tenant_context, agent_context.set_tenant_context)
        self.assertIs(tools.set_phase_context, agent_context.set_phase_context)


if __name__ == "__main__":
    unittest.main()
