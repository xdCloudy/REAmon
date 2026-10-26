"""Security checks for the interactive Kali PTY shell."""
from __future__ import annotations

import os
import asyncio
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

SERVERS = Path(__file__).resolve().parents[1]
if str(SERVERS) not in sys.path:
    sys.path.insert(0, str(SERVERS))

import terminal_server  # noqa: E402


class _FirstFrameSocket:
    def __init__(self, frame):
        self.frame = frame

    async def recv(self):
        return self.frame


class TestTerminalPrivileges(unittest.TestCase):
    def test_init_frame_keeps_only_bounded_graph_context(self):
        env, replay = asyncio.run(terminal_server._read_init_frame(_FirstFrameSocket(
            json.dumps({
                "type": "init", "user_id": "u1", "project_id": "p1",
                "session_id": "s1", "graph_ctx": "signed.context",
            })
        )))
        self.assertEqual(replay, b"")
        self.assertEqual(env["REDAMON_CTX"], "signed.context")

        oversized, _ = asyncio.run(terminal_server._read_init_frame(_FirstFrameSocket(
            json.dumps({"type": "init", "graph_ctx": "x" * 4097})
        )))
        self.assertNotIn("REDAMON_CTX", oversized)

    def test_shell_environment_excludes_controller_secrets(self):
        with mock.patch.dict(os.environ, {
            "INTERNAL_API_KEY": "master",
            "MCP_AUTH_TOKEN": "mcp",
            "TUNNEL_AUTH_TOKEN": "tunnel",
            "SCANNER_API_KEY": "scanner",
            "REDAMON_AGENT_URL": "http://agent:8080",
        }, clear=True):
            env = terminal_server._terminal_shell_env({
                "REDAMON_USER_ID": "user-1",
                "REDAMON_PROJECT_ID": "project-1",
            })

        self.assertEqual(env["REDAMON_USER_ID"], "user-1")
        self.assertEqual(env["REDAMON_PROJECT_ID"], "project-1")
        for secret in (
            "INTERNAL_API_KEY", "MCP_AUTH_TOKEN", "TUNNEL_AUTH_TOKEN", "SCANNER_API_KEY"
        ):
            self.assertNotIn(secret, env)

    def test_shell_child_drops_root_and_supplementary_groups(self):
        if os.name != "posix" or os.geteuid() != 0:
            self.skipTest("requires a POSIX test container running as root")
        code = (
            "import os,sys; sys.path.insert(0,sys.argv[1]); "
            "import terminal_server; terminal_server._drop_terminal_privileges(); "
            "print(os.getuid(), os.getgid(), repr(os.getgroups()))"
        )
        result = subprocess.run(
            [sys.executable, "-c", code, str(SERVERS)],
            capture_output=True, text=True, timeout=10, check=True,
        )
        self.assertEqual(result.stdout.strip(), "65534 65534 []")

    def test_allowlisted_login_shell_starts_and_keeps_only_required_scoped_values(self):
        if os.name != "posix" or os.geteuid() != 0:
            self.skipTest("requires a POSIX test container running as root")
        code = (
            "import os,sys; sys.path.insert(0,sys.argv[1]); import terminal_server; "
            "env=terminal_server._terminal_shell_env({'REDAMON_USER_ID':'u1',"
            "'REDAMON_PROJECT_ID':'p1'}); terminal_server._drop_terminal_privileges(); "
            "os.execvpe('/bin/bash',['/bin/bash','--login','-c',"
            "'id -u; id -g; env'],env)"
        )
        with mock.patch.dict(os.environ, {
            "INTERNAL_API_KEY": "master-secret",
            "SCANNER_API_KEY": "scoped-scanner-key",
        }, clear=False):
            result = subprocess.run(
                [sys.executable, "-c", code, str(SERVERS)],
                capture_output=True, text=True, timeout=10, check=True,
            )
        lines = result.stdout.splitlines()
        self.assertEqual(lines[:2], ["65534", "65534"])
        shell_env = set(lines[2:])
        self.assertIn("REDAMON_PROJECT_ID=p1", shell_env)
        for secret in (
            "INTERNAL_API_KEY=master-secret", "SCANNER_API_KEY=scoped-scanner-key",
            "MCP_AUTH_TOKEN", "TUNNEL_AUTH_TOKEN",
        ):
            self.assertNotIn(secret, shell_env)


if __name__ == "__main__":
    unittest.main()
