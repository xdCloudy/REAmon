"""P0-3 — /text-to-cypher must be auth-gated and must not echo detail.

The endpoint was unauthenticated while spending the BODY-NAMED user's LLM
provider key, and one request can cost up to 9 provider calls (3 attempts, each
wrapped in retry_llm_call). With the agent port on 0.0.0.0 in the base compose,
anyone on the LAN could burn any user's budget without logging in.

`require_internal_auth` is the right dependency rather than the auth-only one:
this is a BILLED endpoint, so it needs the token bucket and the daily spend cap,
not just a key check.

Runs inside the agent container (imports the FastAPI app + its deps).
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import api  # noqa: E402


def _dep_names(route):
    names = []
    for d in list(getattr(route, "dependencies", []) or []):
        call = getattr(d, "dependency", None)
        names.append(getattr(call, "__name__", str(call)))
    return names


def _route(path, method="POST"):
    for r in api.app.routes:
        if getattr(r, "path", "") == path and method in (getattr(r, "methods", set()) or set()):
            return r
    return None


class TextToCypherAuthTests(unittest.TestCase):
    def test_endpoint_is_registered(self):
        self.assertIsNotNone(_route("/text-to-cypher"), "/text-to-cypher route missing")

    def test_requires_billed_internal_auth(self):
        deps = _dep_names(_route("/text-to-cypher"))
        self.assertIn(
            "require_internal_auth",
            deps,
            f"/text-to-cypher is not gated by the BILLED dependency (deps: {deps})",
        )
        self.assertIn("require_configured_master_internal_auth", deps)

    def test_not_merely_auth_only(self):
        # require_internal_auth_only skips the token bucket and the daily spend
        # cap, which is exactly what this endpoint needs.
        deps = _dep_names(_route("/text-to-cypher"))
        self.assertNotIn("require_internal_auth_only", deps)

    def test_unauthenticated_call_is_rejected_before_the_handler_runs(self):
        import os
        from unittest import mock

        from fastapi.testclient import TestClient

        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": "s3cret"}, clear=False):
            os.environ.pop("SCANNER_API_KEY", None)
            client = TestClient(api.app)
            resp = client.post(
                "/text-to-cypher",
                json={"question": "list ips", "user_id": "u1", "project_id": "p1"},
            )
        self.assertEqual(resp.status_code, 401)

    def test_scanner_key_cannot_select_a_users_provider_key(self):
        import os
        from unittest import mock
        from fastapi.testclient import TestClient

        with mock.patch.dict(os.environ, {
            "INTERNAL_API_KEY": "master-secret",
            "SCANNER_API_KEY": "scanner-secret",
        }, clear=False):
            client = TestClient(api.app)
            resp = client.post(
                "/text-to-cypher",
                headers={"X-Internal-Key": "scanner-secret"},
                json={"question": "list ips", "user_id": "victim", "project_id": "victim-project"},
            )
        self.assertEqual(resp.status_code, 401)


class TextToCypherErrorNormalisationTests(unittest.TestCase):
    """A stable safe string leaves the process; detail goes to the server log.

    Every caller-visible message on this path is the second argument of a
    `_CypherSetupError(...)`, so that is where the assertion lives. A raised
    error must carry a LITERAL string: a provider message, a Neo4j error or a
    generated Cypher fragment must never travel out through one.
    """

    # Names holding an upstream message, a Neo4j error or a Cypher fragment.
    BANNED = {"e", "err", "last_error", "last_cypher", "cypher", "filtered"}

    def _raised_messages(self):
        """The message argument of every `_CypherSetupError(...)` construction."""
        import ast
        import inspect
        import textwrap

        for fn in (
            api.text_to_cypher,
            api._build_cypher_manager,
            api._generate_validated_cypher,
        ):
            tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
                if name != "_CypherSetupError":
                    continue
                # _CypherSetupError(status, message)
                if len(node.args) >= 2:
                    yield fn.__name__, node.args[1]

    def test_no_raised_error_message_carries_exception_detail(self):
        import ast

        raised = list(self._raised_messages())
        self.assertTrue(raised, "no _CypherSetupError raises found - did the path move?")

        for fn_name, msg in raised:
            for sub in ast.walk(msg):
                if isinstance(sub, ast.Name) and sub.id in self.BANNED:
                    self.fail(
                        f"{fn_name} puts '{sub.id}' in a caller-visible message; "
                        "log the detail and raise a stable safe string instead"
                    )
                if isinstance(sub, ast.Call) and getattr(sub.func, "id", None) == "str":
                    self.fail(f"{fn_name} stringifies a value into a caller-visible message")

    def test_the_endpoint_returns_only_the_normalised_message(self):
        import inspect

        src = inspect.getsource(api.text_to_cypher)
        self.assertIn('content={"error": e.message}', src)
        # ...and nothing else builds an error body in the handler.
        self.assertEqual(src.count('"error"'), 1)


if __name__ == "__main__":
    unittest.main()
