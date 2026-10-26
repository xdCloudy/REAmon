"""Project-scoped storage for downloadable Kali output files."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import workspace_fs  # noqa: E402
from orchestrator_helpers.streaming import persist_generated_file  # noqa: E402
from websocket_api import MessageType, StreamingCallback  # noqa: E402


class GeneratedDownloadStorageTests(unittest.IsolatedAsyncioTestCase):
    async def test_persists_file_to_unique_attested_project_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(workspace_fs, "WORKSPACE_ROOT", Path(temp_dir)):
                executor = AsyncMock()
                executor.execute.return_value = {"success": True, "output": ""}

                stored = await persist_generated_file(
                    {
                        "filepath": "/tmp/payload;touch-owned",
                        "filename": "ignored-by-path.exe",
                        "source": "msfvenom",
                        "description": "Generated payload",
                    },
                    "project-1",
                    executor,
                )

                self.assertEqual(stored["projectId"], "project-1")
                self.assertEqual(stored["filename"], "payload_touch-owned")
                self.assertTrue(stored["filepath"].startswith("tool-outputs/"))
                self.assertIn("payload_touch-owned", stored["filepath"])
                self.assertNotIn("/tmp/", stored["filepath"])
                command = executor.execute.await_args.args[1]["command"]
                self.assertIn("'/tmp/payload;touch-owned'", command)
                self.assertIn("/workspace/tool-outputs", command)
                self.assertNotIn(str(Path(temp_dir) / "project-1"), command)
                self.assertIn(" && ", command)
                self.assertTrue(command.endswith("rm -f -- '/tmp/payload;touch-owned'"))

    async def test_rejects_non_tmp_source_and_invalid_project_before_execution(self):
        executor = AsyncMock()
        with self.assertRaises(ValueError):
            await persist_generated_file({"filepath": "/etc/passwd"}, "project-1", executor)
        with self.assertRaises(ValueError):
            await persist_generated_file({"filepath": "/tmp/file"}, "../other", executor)
        executor.execute.assert_not_awaited()

    async def test_failed_copy_does_not_publish_file_metadata(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(workspace_fs, "WORKSPACE_ROOT", Path(temp_dir)):
                executor = AsyncMock()
                executor.execute.return_value = {"success": False, "error": "copy failed"}
                with self.assertRaisesRegex(RuntimeError, "workspace copy failed"):
                    await persist_generated_file({"filepath": "/tmp/output.bin"}, "project-1", executor)

    async def test_file_ready_event_and_persisted_message_use_project_scoped_path(self):
        connection = MagicMock()
        connection.project_id = "project-1"
        connection.user_id = "user-1"
        connection.session_id = "session-1"
        connection.get_key.return_value = "user-1:project-1:session-1"
        connection.send_message = AsyncMock()
        stored = {
            "filepath": "tool-outputs/opaque-output.bin",
            "filename": "output.bin",
            "projectId": "project-1",
        }
        callback = StreamingCallback(connection, tool_executor=object())
        callback._persist = MagicMock()

        with patch(
            "orchestrator_helpers.streaming.persist_generated_file",
            new=AsyncMock(return_value=stored),
        ) as persist_file:
            await callback.on_file_ready({"filepath": "/tmp/output.bin"})

        persist_file.assert_awaited_once_with(
            {"filepath": "/tmp/output.bin"}, "project-1", callback._tool_executor,
        )
        connection.send_message.assert_awaited_once_with(MessageType.FILE_READY, stored)
        callback._persist.assert_called_once_with("file_ready", stored)


if __name__ == "__main__":
    unittest.main()
