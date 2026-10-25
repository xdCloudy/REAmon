"""
Regression: the agent's /mcp/* endpoints must require a configured master key.

/mcp/test spawns an operator-supplied stdio command, so test and reload require a
configured master key. This test asserts the expected dependency for each route.

Runs inside the agent container (imports the FastAPI app + its deps):
    python /app/test_mcp_endpoints_gated.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import api  # noqa: E402

GATED = {
    "/mcp/test": "require_configured_master_internal_auth",
    "/mcp/reload": "require_configured_master_internal_auth",
    "/mcp/manifest": "require_internal_auth_only",
}


def _dep_names(route):
    names = []
    for d in list(getattr(route, "dependencies", []) or []):
        call = getattr(d, "dependency", None)
        names.append(getattr(call, "__name__", str(call)))
    return names


class McpEndpointsGatedTests(unittest.TestCase):
    def test_mcp_endpoints_have_the_expected_auth_dependency(self):
        found = {}
        for r in api.app.routes:
            p = getattr(r, "path", "")
            if p in GATED:
                found[p] = _dep_names(r)
        for p, dependency in GATED.items():
            self.assertIn(p, found, f"{p} route not registered")
            self.assertIn(
                dependency,
                found[p],
                f"{p} is not internal-auth gated (deps: {found[p]})",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
