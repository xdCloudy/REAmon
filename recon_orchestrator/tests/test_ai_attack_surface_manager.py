"""Unit tests for the AI Attack Surface lifecycle in ContainerManager (Step 3).

Docker + the Ollama judge manager are mocked, so these run with no daemon:

    docker compose exec -T recon-orchestrator python -m unittest \
        tests.test_ai_attack_surface_manager -v

Focus: the ref-counted Ollama lease (start acquires, finish/stop releases,
exactly once), state lifecycle from container exit codes, and the phase-marker
parser (incl. the banner false-match regression).
"""
import asyncio
import glob
import os
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from docker.errors import NotFound

import container_manager as cm
from container_manager import ContainerManager
from models import AiAttackSurfaceState, AiAttackSurfaceStatus


def make_manager():
    with patch("container_manager.docker") as md:
        md.from_env.return_value = MagicMock()
        mgr = ContainerManager()
    mgr.client = MagicMock()
    mgr.local_llm_manager = MagicMock()
    # ensure_up returns a status-like object (base_url/available/warning attrs).
    llm_status = MagicMock()
    llm_status.base_url = "http://localhost:11434"
    llm_status.available = True
    llm_status.warning = None
    mgr.local_llm_manager.ensure_up.return_value = llm_status
    return mgr


def fake_container(status="running", cid="c0ffee", exit_code=0):
    c = MagicMock()
    c.status = status
    c.id = cid
    c.attrs = {"State": {"ExitCode": exit_code}}
    return c


def run(coro):
    return asyncio.run(coro)


class TestPhaseParser(unittest.TestCase):
    def setUp(self):
        self.mgr = make_manager()

    def test_banner_does_not_false_match_phase3(self):
        # Regression: "AI Attack Surface scan" contains "Attack" -> must NOT
        # trigger phase 3. Only explicit [Phase N] markers count.
        ev = self.mgr._parse_ai_attack_log_line(
            "[*] AI Attack Surface scan — tool=skeleton", None, None)
        self.assertIsNone(ev.phase_number)
        self.assertFalse(ev.is_phase_start)

    def test_explicit_markers_map_in_order(self):
        cases = [("[Phase 1] Safety / bounds", 1), ("[Phase 2] Target loading", 2),
                 ("[Phase 3] Attack (skeleton — no tool)", 3), ("[Phase 4] Findings", 4)]
        prev_phase = None
        for line, expected in cases:
            ev = self.mgr._parse_ai_attack_log_line(line, prev_phase, None)
            self.assertEqual(ev.phase_number, expected)
            self.assertTrue(ev.is_phase_start)
            prev_phase = ev.phase

    def test_same_phase_not_restart(self):
        ev = self.mgr._parse_ai_attack_log_line("[Phase 2] Target loading", "Target loading", 2)
        self.assertFalse(ev.is_phase_start)

    def test_levels(self):
        self.assertEqual(self.mgr._parse_ai_attack_log_line("[!] boom", None, None).level, "error")
        self.assertEqual(self.mgr._parse_ai_attack_log_line("[+] ok", None, None).level, "success")
        self.assertEqual(self.mgr._parse_ai_attack_log_line("[*] doing", None, None).level, "action")


class TestLlmLease(unittest.TestCase):
    def setUp(self):
        self.mgr = make_manager()

    def test_release_is_idempotent(self):
        from models import AiAttackSurfaceState
        state = AiAttackSurfaceState(project_id="p", run_id="r", llm_leased=True)
        self.mgr._release_llm(state)
        self.assertFalse(state.llm_leased)
        self.mgr._release_llm(state)  # second call must not release again
        self.mgr.local_llm_manager.release.assert_called_once()

    def test_release_noop_when_not_leased(self):
        from models import AiAttackSurfaceState
        state = AiAttackSurfaceState(project_id="p", run_id="r", llm_leased=False)
        self.mgr._release_llm(state)
        self.mgr.local_llm_manager.release.assert_not_called()

    def test_refresh_completion_releases_lease(self):
        from models import AiAttackSurfaceState
        state = AiAttackSurfaceState(project_id="p", run_id="r",
                                     status=AiAttackSurfaceStatus.RUNNING,
                                     container_id="c0ffee", llm_leased=True)
        self.mgr.client.containers.get.return_value = fake_container(status="exited", exit_code=0)
        self.mgr._refresh_ai_attack_state(state)
        self.assertEqual(state.status, AiAttackSurfaceStatus.COMPLETED)
        self.assertFalse(state.llm_leased)
        self.mgr.local_llm_manager.release.assert_called_once()

    def test_refresh_error_exit_code(self):
        from models import AiAttackSurfaceState
        state = AiAttackSurfaceState(project_id="p", run_id="r",
                                     status=AiAttackSurfaceStatus.RUNNING,
                                     container_id="c0ffee", llm_leased=True)
        self.mgr.client.containers.get.return_value = fake_container(status="exited", exit_code=1)
        self.mgr._refresh_ai_attack_state(state)
        self.assertEqual(state.status, AiAttackSurfaceStatus.ERROR)
        self.assertIn("code 1", state.error)
        self.assertFalse(state.llm_leased)


class TestStartStop(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._scanner_env = patch.dict(os.environ, {
            "SCANNER_API_KEY": "test-scanner-key",
            "INTERNAL_API_KEY": "test-internal-key",
        })
        self._scanner_env.start()
        self.mgr = make_manager()
        self.mgr.client.containers.run.return_value = fake_container()

    def tearDown(self):
        self._scanner_env.stop()

    def tearDown(self):
        for f in glob.glob("/tmp/redamon/ai_attack_p_*.json"):
            try:
                os.unlink(f)
            except OSError:
                pass

    async def _start(self, **cfg):
        base = {"tool": "skeleton", "targets": [], "bounds": {"judge_model": "qwen2.5:0.5b"},
                "roe_confirmed": True, "dry_run": False}
        base.update(cfg)
        return await self.mgr.start_ai_attack_surface(
            project_id="p", user_id="u", webapp_api_url="", run_config=base,
            ai_attack_path="/host/ai_attack_surface_scan")

    async def test_start_acquires_lease_and_runs(self):
        state = await self._start()
        self.assertEqual(state.status, AiAttackSurfaceStatus.RUNNING)
        self.assertTrue(state.llm_leased)
        self.mgr.local_llm_manager.ensure_up.assert_called_once_with("qwen2.5:0.5b")
        self.mgr.client.containers.run.assert_called_once()
        # network_mode host + the config env var must be set.
        kwargs = self.mgr.client.containers.run.call_args.kwargs
        self.assertEqual(kwargs["network_mode"], "host")
        self.assertIn("AI_ATTACK_CONFIG", kwargs["environment"])

    async def test_dry_run_does_not_acquire_lease(self):
        state = await self._start(dry_run=True, roe_confirmed=False)
        self.assertFalse(state.llm_leased)
        self.mgr.local_llm_manager.ensure_up.assert_not_called()

    async def test_no_judge_model_no_lease(self):
        state = await self._start(bounds={})
        self.assertFalse(state.llm_leased)
        self.mgr.local_llm_manager.ensure_up.assert_not_called()

    async def test_start_failure_releases_lease(self):
        self.mgr.client.containers.run.side_effect = RuntimeError("docker boom")
        state = await self._start()
        self.assertEqual(state.status, AiAttackSurfaceStatus.ERROR)
        self.assertFalse(state.llm_leased)  # lease freed despite the failure
        self.mgr.local_llm_manager.release.assert_called_once()
        # completed_at must be set so the status GC can evict this errored run
        # (otherwise it leaks in ai_attack_states forever).
        self.assertIsNotNone(state.completed_at)

    async def test_cleanup_stops_running_ai_attack_containers(self):
        # cleanup() (orchestrator shutdown) must stop in-flight AI-attack scans,
        # not just the other scanner types — else the container orphans.
        state = await self._start()
        run_id = state.run_id
        self.mgr.client.containers.get.return_value = fake_container(status="running")
        await self.mgr.cleanup()
        self.assertNotIn(run_id, self.mgr.ai_attack_states.get("p", {}))
        self.assertFalse(state.llm_leased)   # judge lease released on cleanup

    async def test_config_filename_sanitizes_project_id(self):
        # A project_id with path chars must not escape /tmp/redamon.
        state = await self.mgr.start_ai_attack_surface(
            project_id="p/../x", user_id="u", webapp_api_url="",
            run_config={"tool": "skeleton", "bounds": {}, "roe_confirmed": True},
            ai_attack_path="/host/ai_attack_surface_scan")
        cfg = self.mgr.client.containers.run.call_args.kwargs["environment"]["AI_ATTACK_CONFIG"]
        self.assertTrue(cfg.startswith("/tmp/redamon/ai_attack_"))
        # The real safety property: no '/' in the filename portion, so it can't
        # escape /tmp/redamon (a literal '..' mid-filename is harmless without a
        # surrounding separator). And the env path must equal the file we write.
        self.assertNotIn("/", cfg[len("/tmp/redamon/"):])
        # cleanup the sanitized file
        try:
            Path(cfg).unlink(missing_ok=True)
        except OSError:
            pass

    async def test_stop_releases_lease_and_clears_state(self):
        state = await self._start()
        run_id = state.run_id
        self.mgr.client.containers.get.return_value = fake_container(status="running")
        stopped = await self.mgr.stop_ai_attack_surface("p", run_id)
        self.assertFalse(stopped.llm_leased)
        self.assertNotIn(run_id, self.mgr.ai_attack_states.get("p", {}))

    async def test_status_unknown_run_is_idle(self):
        state = await self.mgr.get_ai_attack_surface_status("nope", "nope")
        self.assertEqual(state.status, AiAttackSurfaceStatus.IDLE)

    async def test_running_count(self):
        await self._start()
        self.assertEqual(self.mgr.get_ai_attack_running_count(), 1)

    async def test_concurrency_limit_raises(self):
        # Fill the project to the cap with running jobs, then start one more.
        self.mgr.ai_attack_states = {"p": {
            f"r{i}": AiAttackSurfaceState(project_id="p", run_id=f"r{i}",
                                          status=AiAttackSurfaceStatus.RUNNING)
            for i in range(cm.MAX_PARALLEL_AI_ATTACK)
        }}
        with self.assertRaises(ValueError):
            await self._start()

    async def test_start_failure_cleans_config_file(self):
        self.mgr.client.containers.run.side_effect = RuntimeError("docker boom")
        state = await self._start()
        cfg = Path(f"/tmp/redamon/ai_attack_p_{state.run_id}.json")
        self.assertFalse(cfg.exists(), "config file must be cleaned on failed spawn")

    async def test_two_tools_share_then_release_judge(self):
        # Two tools of one scan each take a lease; first to finish releases once,
        # the second keeps the judge alive (the shared-judge guarantee).
        s1 = await self._start(tool="garak")
        s2 = await self._start(tool="pyrit")
        self.assertTrue(s1.llm_leased and s2.llm_leased)
        self.assertEqual(self.mgr.local_llm_manager.ensure_up.call_count, 2)

        self.mgr.client.containers.get.return_value = fake_container(status="exited", exit_code=0)
        self.mgr._refresh_ai_attack_state(s1)
        self.assertFalse(s1.llm_leased)
        self.assertTrue(s2.llm_leased)               # sibling still holds its lease
        self.mgr.local_llm_manager.release.assert_called_once()


class TestReaper(unittest.IsolatedAsyncioTestCase):
    async def test_reaper_releases_orphaned_lease(self):
        # A run that finished while no client polled: status still RUNNING in
        # memory, container exited, lease still held. The reaper must release it.
        mgr = make_manager()
        state = AiAttackSurfaceState(
            project_id="p", run_id="r", status=AiAttackSurfaceStatus.RUNNING,
            container_id="c0ffee", llm_leased=True)
        mgr.ai_attack_states = {"p": {"r": state}}
        mgr.client.containers.get.return_value = fake_container(status="exited", exit_code=0)

        reaped = await mgr.reap_ai_attack()
        self.assertEqual(reaped, 1)
        self.assertEqual(state.status, AiAttackSurfaceStatus.COMPLETED)
        self.assertFalse(state.llm_leased)
        mgr.local_llm_manager.release.assert_called_once()

    async def test_reaper_noop_when_no_runs(self):
        mgr = make_manager()
        self.assertEqual(await mgr.reap_ai_attack(), 0)


class TestGetAll(unittest.IsolatedAsyncioTestCase):
    async def test_auto_cleans_old_completed(self):
        mgr = make_manager()
        old = AiAttackSurfaceState(
            project_id="p", run_id="r1", status=AiAttackSurfaceStatus.COMPLETED,
            completed_at=datetime.now(timezone.utc) - timedelta(seconds=120))
        fresh = AiAttackSurfaceState(
            project_id="p", run_id="r2", status=AiAttackSurfaceStatus.COMPLETED,
            completed_at=datetime.now(timezone.utc))
        mgr.ai_attack_states = {"p": {"r1": old, "r2": fresh}}
        runs = await mgr.get_all_ai_attack_surface_statuses("p")
        ids = {r.run_id for r in runs}
        self.assertNotIn("r1", ids)   # >60s old completed -> pruned
        self.assertIn("r2", ids)


if __name__ == "__main__":
    unittest.main(verbosity=2)
