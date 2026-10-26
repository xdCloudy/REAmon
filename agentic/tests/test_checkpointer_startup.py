"""Persistent checkpoint configuration must never silently become volatile."""
import os
import sys
import types
import unittest
from unittest.mock import patch

from orchestrator import AgentOrchestrator


class _Pool:
    def __init__(self, **_kwargs):
        self.closed = False
        self.close_calls = 0

    async def open(self):
        return None

    async def close(self):
        self.close_calls += 1
        self.closed = True


class _Saver:
    def __init__(self, _pool):
        pass

    async def setup(self):
        raise OSError("database unavailable")


class CheckpointerStartupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.orchestrator = AgentOrchestrator.__new__(AgentOrchestrator)
        self.orchestrator._checkpoint_pool = None

    async def test_persistent_mode_rejects_missing_database_url(self):
        with patch("orchestrator.get_setting", return_value=True), \
                patch.dict(os.environ, {"DATABASE_URL": ""}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            with self.assertRaisesRegex(RuntimeError, "startup refused"):
                await self.orchestrator._setup_checkpointer()

        self.assertIsNone(self.orchestrator._checkpoint_pool)

    async def test_persistent_setup_failure_closes_pool_and_refuses_volatile_fallback(self):
        pool = _Pool()
        fake_postgres = types.ModuleType("langgraph.checkpoint.postgres.aio")
        fake_postgres.AsyncPostgresSaver = _Saver
        fake_pool_module = types.ModuleType("psycopg_pool")
        fake_pool_module.AsyncConnectionPool = lambda **_kwargs: pool

        with patch("orchestrator.get_setting", return_value=True), \
                patch.dict(os.environ, {"DATABASE_URL": "postgresql://test"}, clear=False), \
                patch.dict(sys.modules, {
                    "langgraph.checkpoint.postgres.aio": fake_postgres,
                    "psycopg_pool": fake_pool_module,
                }), \
                patch("orchestrator.set_checkpointer") as set_checkpointer:
            with self.assertRaisesRegex(RuntimeError, "startup refused"):
                await self.orchestrator._setup_checkpointer()

        self.assertTrue(pool.closed)
        self.assertIsNone(self.orchestrator._checkpoint_pool)
        set_checkpointer.assert_not_called()

    async def test_explicit_nonpersistent_mode_keeps_memory_saver_path(self):
        with patch("orchestrator.get_setting", return_value=False):
            await self.orchestrator._setup_checkpointer()

        self.assertIsNone(self.orchestrator._checkpoint_pool)

    async def test_shutdown_closes_persistent_checkpoint_pool(self):
        pool = _Pool()
        self.orchestrator._checkpoint_pool = pool

        await self.orchestrator.close()

        self.assertTrue(pool.closed)
        self.assertEqual(pool.close_calls, 1)
        self.assertIsNone(self.orchestrator._checkpoint_pool)


if __name__ == "__main__":
    unittest.main()
