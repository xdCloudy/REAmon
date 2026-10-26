"""Security regressions for model-authored Kali shell and code execution."""
from __future__ import annotations

import os
import asyncio
import json
import signal
import shutil
import sys
import tempfile
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
import project_worker_client as worker_client  # noqa: E402
import untrusted_process as exec_utils  # noqa: E402


class TestUntrustedExecution(unittest.IsolatedAsyncioTestCase):
    async def test_async_project_worker_disconnects_on_cancellation(self):
        request_received = asyncio.Event()
        client_disconnected = asyncio.Event()

        async def handle(reader, writer):
            try:
                head = await reader.readuntil(b"\r\n\r\n")
                headers = {}
                for line in head.decode("latin1").split("\r\n")[1:]:
                    if ":" in line:
                        name, value = line.split(":", 1)
                        headers[name.lower()] = value.strip()
                await reader.readexactly(int(headers["content-length"]))
                request_received.set()
                await reader.read()
                client_disconnected.set()
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        with mock.patch.dict(os.environ, {"SCANNER_API_KEY": "transport-test-key"}), \
                mock.patch.object(worker_client, "WORKER_URL", f"http://127.0.0.1:{port}/worker/execute"):
            task = asyncio.create_task(worker_client.run_project_worker_async(
                ["sleep", "300"], timeout=300, ctx="signed", tool_name="kali_shell",
            ))
            await asyncio.wait_for(request_received.wait(), timeout=2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            await asyncio.wait_for(client_disconnected.wait(), timeout=2)
        server.close()
        await server.wait_closed()

    def test_project_worker_client_uses_transport_auth_and_decodes_bounded_output(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                import base64
                import json
                return json.dumps({
                    "exit_code": 0,
                    "stdout_b64": base64.b64encode(b"worker output").decode("ascii"),
                    "stderr_b64": base64.b64encode(b"compiler warning").decode("ascii"),
                    "timed_out": False,
                }).encode()

        with mock.patch.dict(os.environ, {"SCANNER_API_KEY": "scanner-transport-key"}), \
                mock.patch.object(worker_client.urllib.request, "urlopen", return_value=Response()) as urlopen:
            result = worker_client.run_project_worker(
                ["python3", "-c", "print('ok')"], timeout=10,
                ctx="signed-context", tool_name="execute_code",
            )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "worker output")
        self.assertEqual(result.stderr, "compiler warning")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("X-internal-key"), "scanner-transport-key")
        self.assertEqual(json.loads(request.data)["ctx"], "signed-context")

    async def test_kali_shell_uses_verified_project_worker_context(self):
        completed = recon.subprocess.CompletedProcess([], 0, "uid=65534\n", "")
        with mock.patch.object(
            recon, "_resolve_execution_project", return_value="project-123"
        ) as resolve_scope, mock.patch.object(
            recon, "_execution_workspace_root", return_value="/workspace/project-123"
        ), mock.patch.object(
            recon, "_prepare_project_worker_paths"
        ) as prepare_paths, mock.patch.object(
            recon, "_run_project_worker_async", new=mock.AsyncMock(return_value=completed)
        ) as run:
            result = await recon.kali_shell("id", "signed-context")

        self.assertIn("uid=65534", result)
        prepare_paths.assert_called_once_with("/workspace/project-123")
        run.assert_called_once_with(
            ["bash", "-c", "id"], timeout=300, ctx="signed-context",
            tool_name="kali_shell",
        )
        resolve_scope.assert_called_once_with("signed-context", "kali_shell")

    async def test_kali_shell_preserves_partial_output_after_timeout(self):
        timeout = recon.subprocess.TimeoutExpired(
            ["bash", "-c", "long-task"], 300, output="partial stdout", stderr="partial stderr",
        )
        with mock.patch.object(
            recon, "_resolve_execution_project", return_value="project-123"
        ), mock.patch.object(
            recon, "_execution_workspace_root", return_value="/workspace/project-123"
        ), mock.patch.object(
            recon, "_prepare_project_worker_paths"
        ), mock.patch.object(
            recon, "_run_project_worker_async", new=mock.AsyncMock(side_effect=timeout)
        ):
            result = await recon.kali_shell("long-task", "signed-context")
        self.assertIn("Command timed out", result)
        self.assertIn("partial stdout", result)
        self.assertIn("partial stderr", result)

    async def test_proxy_brain_uses_worker_with_signed_context_and_sdk_environment(self):
        workspace = tempfile.mkdtemp(prefix="reamon-proxy-brain-test-")
        os.chmod(workspace, 0o777)
        try:
            completed = recon.subprocess.CompletedProcess([], 0, "finding summary", "")
            with mock.patch.dict(os.environ, {"REDAMON_AGENT_URL": "http://agent.test:8080"}), \
                    mock.patch.object(recon, "_resolve_execution_project", return_value="project-123"), \
                    mock.patch.object(recon, "_execution_workspace_root", return_value=workspace), \
                    mock.patch.object(recon, "_prepare_project_worker_paths") as prepare_paths, \
                    mock.patch.object(recon, "_run_project_worker_async", new=mock.AsyncMock(return_value=completed)) as run:
                result = await recon.proxy_brain("print('safe')", "signed-proxy-context")

            self.assertEqual(result, "finding summary")
            prepare_paths.assert_called_once_with(workspace)
            argv = run.call_args.args[0]
            self.assertEqual(argv[0], "python3")
            self.assertTrue(argv[1].startswith("/workspace/pb_"))
            self.assertEqual(run.call_args.kwargs["timeout"], 180)
            self.assertEqual(run.call_args.kwargs["ctx"], "signed-proxy-context")
            self.assertEqual(run.call_args.kwargs["tool_name"], "proxy_brain")
            self.assertEqual(
                run.call_args.kwargs["env"]["REDAMON_AGENT_URL"],
                "http://agent.test:8080",
            )
            self.assertEqual(
                run.call_args.kwargs["env"]["REDAMON_CTX"],
                "signed-proxy-context",
            )
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

    async def test_execute_code_uses_unique_readable_file_and_cleans_it_up(self):
        code = "print('before')\nREDAMON_CODE_EOF\nprint('after')"
        calls = []
        workspace = tempfile.mkdtemp(prefix="reamon-code-test-")
        os.chmod(workspace, 0o777)

        async def run(*args, **kwargs):
            source_arg = next(arg for arg in args[0] if arg.startswith("/workspace/") and arg.endswith(".py"))
            source_path = os.path.join(workspace, os.path.basename(source_arg))
            with open(source_path, encoding="utf-8") as source_file:
                self.assertEqual(source_file.read(), code + "\n")
            calls.append((args, kwargs, source_path))
            return recon.subprocess.CompletedProcess(args[0], 0, "ok", "")

        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": "master-secret"}, clear=False), \
                mock.patch.object(recon, "_resolve_execution_project", return_value="project-123"), \
                mock.patch.object(recon, "_execution_workspace_root", return_value=workspace), \
                mock.patch.object(recon, "_prepare_project_worker_paths"), \
                mock.patch.object(recon, "_run_project_worker_async", side_effect=run) as run_worker:
            self.assertEqual(await recon.execute_code(code, filename="same-name", _redamon_ctx="signed"), "ok")
            self.assertEqual(await recon.execute_code(code, filename="same-name", _redamon_ctx="signed"), "ok")

        self.assertEqual(run_worker.call_count, 2)
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(calls[0][2], calls[1][2])
        for args, kwargs, source_path in calls:
            self.assertEqual(kwargs["ctx"], "signed")
            self.assertEqual(kwargs["tool_name"], "execute_code")
            self.assertTrue(any(arg.startswith("/workspace/") for arg in args[0]))
            self.assertFalse(os.path.exists(source_path))
        os.rmdir(workspace)

    async def test_compiled_output_is_written_inside_project_scratch(self):
        workspace = tempfile.mkdtemp(prefix="reamon-compiled-test-")
        os.chmod(workspace, 0o755)
        calls = []

        async def run_worker(argv, **kwargs):
            calls.append(argv)
            return recon.subprocess.CompletedProcess(argv, 0, "compiled output", "")

        with mock.patch.object(recon, "_resolve_execution_project", return_value="project-123"), \
                mock.patch.object(recon, "_execution_workspace_root", return_value=workspace), \
                mock.patch.object(recon, "_prepare_project_worker_paths"), \
                mock.patch.object(recon, "_run_project_worker_async", side_effect=run_worker):
            result = await recon.execute_code(
                "int main(void) { return 0; }", language="c", _redamon_ctx="signed",
            )

        self.assertEqual(result, "compiled output")
        self.assertEqual(len(calls), 2)
        self.assertTrue(any(
            "-o" in argv and argv[argv.index("-o") + 1].startswith("/workspace/.reamon-tmp/")
            for argv in calls
        ))
        self.assertTrue(any(arg.startswith("/workspace/.reamon-tmp/") for arg in calls[-1]))
        shutil.rmtree(workspace)

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

    def test_real_untrusted_child_inherits_tight_file_and_core_limits(self):
        if os.name != "posix" or os.geteuid() != 0:
            self.skipTest("requires a POSIX test container running as root")
        code = (
            "import resource; "
            "print(resource.getrlimit(resource.RLIMIT_NOFILE)); "
            "print(resource.getrlimit(resource.RLIMIT_CORE))"
        )
        result = recon._run_untrusted_child([sys.executable, "-c", code], timeout=10)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.splitlines(),
            [f"({exec_utils.UNTRUSTED_EXEC_NOFILE_LIMIT}, "
             f"{exec_utils.UNTRUSTED_EXEC_NOFILE_LIMIT})", "(0, 0)"],
        )

    async def test_playwright_script_uses_verified_project_workspace(self):
        workspace = tempfile.mkdtemp(prefix="reamon-playwright-test-")
        os.chmod(workspace, 0o777)
        completed = recon.subprocess.CompletedProcess([], 0, "65534\nNone", "")
        try:
            with mock.patch.object(
                playwright, "resolve_execution_project", return_value="project-123"
            ), mock.patch.object(
                playwright, "execution_workspace_root", return_value=workspace
            ), mock.patch.object(
                playwright, "prepare_project_worker_paths"
            ), mock.patch.object(
                playwright, "run_project_worker_async", new=mock.AsyncMock(return_value=completed)
            ) as run:
                result = await playwright._run_playwright_script(
                    "import os; print(os.getuid()); print(os.environ.get('INTERNAL_API_KEY'))",
                    timeout=10, ctx_token="signed-context",
                )
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

        self.assertEqual(result.splitlines(), [str(exec_utils.UNTRUSTED_EXEC_UID), "None"])
        self.assertEqual(run.call_args.args[0][0], "python3")
        self.assertTrue(run.call_args.args[0][1].startswith("/workspace/playwright_"))
        self.assertEqual(run.call_args.kwargs["ctx"], "signed-context")
        self.assertEqual(run.call_args.kwargs["tool_name"], "execute_playwright")

    async def test_playwright_script_fails_closed_without_signed_scope(self):
        with mock.patch.object(playwright, "run_project_worker_async") as run:
            result = await playwright._run_playwright_script("print('must not run')")

        self.assertIn("Scoped Playwright authorization failed", result)
        run.assert_not_called()


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
