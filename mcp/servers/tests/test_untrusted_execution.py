"""Security regressions for model-authored Kali shell and code execution."""
from __future__ import annotations

import os
import signal
import sys
import types
import unittest
from io import BytesIO
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
import playwright_server as playwright  # noqa: E402
import untrusted_process as exec_utils  # noqa: E402


class TestUntrustedExecution(unittest.TestCase):
    def assert_untrusted_child(self, call):
        kwargs = call.kwargs
        self.assertEqual(kwargs["user"], 65534)
        self.assertEqual(kwargs["group"], 65534)
        self.assertEqual(kwargs["extra_groups"], ())
        self.assertEqual(kwargs["start_new_session"], True)
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
        def popen(*args, **kwargs):
            return _FakeChild("uid=65534\n", "")

        with mock.patch.dict(os.environ, {
            "INTERNAL_API_KEY": "master-secret",
            "MCP_AUTH_TOKEN": "mcp-secret",
            "SCANNER_API_KEY": "scanner-secret",
            "TUNNEL_AUTH_TOKEN": "tunnel-secret",
        }, clear=False), mock.patch.object(
            recon.subprocess, "Popen", side_effect=popen
        ) as run, mock.patch.object(recon.os, "killpg"), mock.patch.object(
            recon, "_resolve_execution_project", return_value="project-123"
        ) as resolve_scope:
            result = recon.kali_shell("id", "signed-context")

        self.assertIn("uid=65534", result)
        self.assert_untrusted_child(run.call_args)
        self.assertEqual(run.call_args.args[0][0:5], [
            "/usr/bin/unshare", "--user", "--map-root-user", "--mount", "/bin/sh"
        ])
        self.assertIn("project-123", run.call_args.args[0])
        self.assertIn("bash", run.call_args.args[0])
        resolve_scope.assert_called_once_with("signed-context", "kali_shell")

    def test_execute_code_uses_unique_readable_file_and_cleans_it_up(self):
        code = "print('before')\nREDAMON_CODE_EOF\nprint('after')"
        calls = []

        def run(*args, **kwargs):
            source_path = args[0][1]
            with open(source_path, encoding="utf-8") as source_file:
                self.assertEqual(source_file.read(), code + "\n")
            calls.append((args, kwargs, source_path))
            return recon.subprocess.CompletedProcess(args[0], 0, "ok", "")

        def popen(*args, **kwargs):
            source_path = args[0][1]
            with open(source_path, encoding="utf-8") as source_file:
                self.assertEqual(source_file.read(), code + "\n")
            calls.append((args, kwargs, source_path))
            return _FakeChild("ok", "")

        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": "master-secret"}, clear=False), \
                mock.patch.object(recon.subprocess, "Popen", side_effect=popen), \
                mock.patch.object(recon.os, "killpg"):
            self.assertEqual(recon.execute_code(code, filename="same-name"), "ok")
            self.assertEqual(recon.execute_code(code, filename="same-name"), "ok")

        self.assertEqual(len(calls), 2)
        self.assertNotEqual(calls[0][2], calls[1][2])
        for args, kwargs, source_path in calls:
            self.assert_untrusted_child(mock.call(*args, **kwargs))
            self.assertFalse(os.path.exists(source_path))

    def test_untrusted_child_caps_stdout_and_stderr(self):
        child = _FakeChild("x" * (recon._UNTRUSTED_OUTPUT_LIMIT_BYTES + 10), "y")
        with mock.patch.object(recon.subprocess, "Popen", return_value=child), \
                mock.patch.object(recon.os, "killpg") as killpg:
            result = recon._run_untrusted_child(["test"], timeout=1)

        self.assertLessEqual(len(result.stdout), recon._UNTRUSTED_OUTPUT_LIMIT_BYTES + len(
            recon._UNTRUSTED_OUTPUT_TRUNCATION
        ))
        self.assertTrue(result.stdout.endswith(recon._UNTRUSTED_OUTPUT_TRUNCATION))
        self.assertEqual(result.stderr, "y")
        killpg.assert_called_once_with(child.pid, signal.SIGKILL)

    def test_untrusted_child_allows_only_explicit_proxy_context_overrides(self):
        child = _FakeChild("ok", "")
        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": "master-secret"}, clear=False), \
                mock.patch.object(recon.subprocess, "Popen", return_value=child) as popen, \
                mock.patch.object(recon.os, "killpg"):
            recon._run_untrusted_child(
                ["python3", "script.py"], timeout=10,
                env_overrides={"REDAMON_CTX": "signed-context"},
            )

        env = popen.call_args.kwargs["env"]
        self.assertEqual(env["REDAMON_CTX"], "signed-context")
        self.assertNotIn("INTERNAL_API_KEY", env)
        with self.assertRaisesRegex(ValueError, "not allowed"):
            recon._run_untrusted_child(
                ["python3", "script.py"], timeout=10,
                env_overrides={"INTERNAL_API_KEY": "master-secret"},
            )

    def test_project_scoped_execution_rejects_unsafe_project_ids(self):
        for project_id in ("../other", "..", ".hidden", "a/b", "a\\b"):
            with self.subTest(project_id=project_id), self.assertRaisesRegex(
                ValueError, "invalid project id"
            ):
                recon._run_untrusted_child(
                    ["bash", "-c", "id"], timeout=1,
                    workspace_project_id=project_id,
                )

    def test_untrusted_child_kills_process_group_after_timeout(self):
        child = _FakeChild("partial", "")
        child.timeout_once = True
        with mock.patch.object(recon.subprocess, "Popen", return_value=child), \
                mock.patch.object(recon.os, "killpg") as killpg:
            with self.assertRaises(recon.subprocess.TimeoutExpired):
                recon._run_untrusted_child(["test"], timeout=1)

        killpg.assert_called_once_with(child.pid, signal.SIGKILL)

    def test_real_untrusted_child_is_unprivileged_and_output_is_bounded(self):
        if os.name != "posix" or os.geteuid() != 0:
            self.skipTest("requires a POSIX test container running as root")
        code = "import os; print('x' * (3 * 1024 * 1024)); print(os.getuid(), file=__import__('sys').stderr)"
        result = recon._run_untrusted_child([sys.executable, "-c", code], timeout=10)

        self.assertEqual(result.returncode, 0)
        self.assertTrue(result.stdout.endswith(recon._UNTRUSTED_OUTPUT_TRUNCATION))
        self.assertIn(str(exec_utils.UNTRUSTED_EXEC_UID), result.stderr)

    def test_playwright_script_runs_unprivileged_without_service_environment(self):
        if os.name != "posix" or os.geteuid() != 0:
            self.skipTest("requires a POSIX test container running as root")
        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": "master-secret"}, clear=False):
            result = playwright._run_playwright_script(
                "import os; print(os.getuid()); print(os.environ.get('INTERNAL_API_KEY'))",
                timeout=10,
            )

        self.assertEqual(result.splitlines(), [str(exec_utils.UNTRUSTED_EXEC_UID), "None"])


class _FakeChild:
    pid = 123
    returncode = 0

    def __init__(self, stdout: str, stderr: str):
        self.stdout = BytesIO(stdout.encode())
        self.stderr = BytesIO(stderr.encode())
        self.timeout_once = False

    def wait(self, timeout=None):
        if self.timeout_once:
            self.timeout_once = False
            raise recon.subprocess.TimeoutExpired("test", timeout)
        return self.returncode


if __name__ == "__main__":
    unittest.main()
