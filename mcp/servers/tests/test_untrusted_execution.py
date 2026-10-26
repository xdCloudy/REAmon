"""Security regressions for model-authored Kali shell and code execution."""
from __future__ import annotations

import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

SERVERS = Path(__file__).resolve().parents[1]
if str(SERVERS) not in sys.path:
    sys.path.insert(0, str(SERVERS))

if "fastmcp" not in sys.modules:
    _fastmcp = types.ModuleType("fastmcp")

    class _StubMCP:
        def __init__(self, *args, **kwargs):
            pass

        def tool(self, *args, **kwargs):
            def decorate(fn):
                return fn
            return decorate

        def run(self, *args, **kwargs):
            pass

    _fastmcp.FastMCP = _StubMCP
    sys.modules["fastmcp"] = _fastmcp

import network_recon_server as recon  # noqa: E402


class TestUntrustedExecution(unittest.TestCase):
    def assert_untrusted_child(self, call):
        kwargs = call.kwargs
        self.assertEqual(kwargs["user"], 65534)
        self.assertEqual(kwargs["group"], 65534)
        self.assertEqual(kwargs["extra_groups"], ())
        self.assertEqual(kwargs["env"]["HOME"], "/tmp")
        self.assertEqual(kwargs["env"]["TMPDIR"], "/tmp")
        self.assertEqual(kwargs["env"]["PLAYWRIGHT_BROWSERS_PATH"], "/ms-playwright")
        for secret_name in (
            "INTERNAL_API_KEY",
            "MCP_AUTH_TOKEN",
            "SCANNER_API_KEY",
            "TUNNEL_AUTH_TOKEN",
        ):
            self.assertNotIn(secret_name, kwargs["env"])

    def test_kali_shell_runs_without_root_or_inherited_service_secrets(self):
        completed = recon.subprocess.CompletedProcess(["bash"], 0, "uid=65534\n", "")
        with mock.patch.dict(os.environ, {
            "INTERNAL_API_KEY": "master-secret",
            "MCP_AUTH_TOKEN": "mcp-secret",
            "SCANNER_API_KEY": "scanner-secret",
            "TUNNEL_AUTH_TOKEN": "tunnel-secret",
        }, clear=False), mock.patch.object(
            recon.subprocess, "run", return_value=completed
        ) as run:
            result = recon.kali_shell("id")

        self.assertIn("uid=65534", result)
        self.assert_untrusted_child(run.call_args)
        self.assertEqual(run.call_args.args[0], ["bash", "-c", "id"])

    def test_execute_code_uses_unique_readable_file_and_cleans_it_up(self):
        code = "print('before')\nREDAMON_CODE_EOF\nprint('after')"
        calls = []

        def run(*args, **kwargs):
            source_path = args[0][1]
            with open(source_path, encoding="utf-8") as source_file:
                self.assertEqual(source_file.read(), code + "\n")
            calls.append((args, kwargs, source_path))
            return recon.subprocess.CompletedProcess(args[0], 0, "ok", "")

        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": "master-secret"}, clear=False), \
                mock.patch.object(recon.subprocess, "run", side_effect=run):
            self.assertEqual(recon.execute_code(code, filename="same-name"), "ok")
            self.assertEqual(recon.execute_code(code, filename="same-name"), "ok")

        self.assertEqual(len(calls), 2)
        self.assertNotEqual(calls[0][2], calls[1][2])
        for args, kwargs, source_path in calls:
            self.assert_untrusted_child(mock.call(*args, **kwargs))
            self.assertFalse(os.path.exists(source_path))


if __name__ == "__main__":
    unittest.main()
