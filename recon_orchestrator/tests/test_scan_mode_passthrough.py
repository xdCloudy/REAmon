"""
Scan Timeline — `mode` passthrough on the full-recon start path.

Contract (plan Section 3.2 / Appendix A): `mode` is HISTORY/TELEMETRY ONLY. The
webapp has already decided what happens to the outgoing graph (frozen as a saved
version, or discarded) before it calls us; the recon pipeline is unchanged and
always wipes + rebuilds the live graph. So the orchestrator must:

  - accept an optional `mode` on ReconStartRequest (and default it to None, so
    older callers keep working),
  - forward it to the recon container as SCAN_MODE,
  - change NOTHING else about the spawn (image, admission, hardening, command).

Run: python3 -m unittest tests.test_scan_mode_passthrough   (from /app in the
recon-orchestrator container, which has `docker`).
"""
from __future__ import annotations

import asyncio
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import container_manager as cm  # noqa: E402
from models import ReconStartRequest, ReconStatus, ReconState  # noqa: E402


def _spawn(scan_mode):
    """Run start_recon with docker intercepted; return the containers.run kwargs."""
    mgr = cm.ContainerManager.__new__(cm.ContainerManager)  # skip docker.from_env
    calls = []

    class _Containers:
        def get(self, name):
            raise cm.NotFound(name)

        def run(self, image, **kw):
            calls.append(kw)
            return mock.Mock(id="container123")

    mgr.client = mock.Mock()
    mgr.client.containers = _Containers()
    mgr.client.images = mock.Mock()
    # start_recon offloads its synchronous docker-py calls through _docker_op,
    # which needs the real __init__'s thread pool. __new__ skips __init__, so
    # supply one here or every spawn raises AttributeError before reaching the
    # assertion under test.
    mgr._docker_op_executor = ThreadPoolExecutor(max_workers=2)
    # The recon spawn mounts the offline OSV database read-only for L2
    # supply-chain recon, so the volume name is now part of the spawn path.
    mgr.supply_chain_osv_db_volume = "redamon-osv-db"
    # ...and the supply-chain incident intel beside it (A2/B/D read it).
    mgr.sca_intel_volume = "redamon-sca-intel"
    mgr.recon_image = "redamon-recon:latest"
    mgr.running_states = {}
    mgr.partial_recon_states = {}

    async def _idle(_pid):
        return ReconState(project_id=_pid, status=ReconStatus.IDLE)

    mgr.get_status = _idle
    mgr._count_active_partial_recons = lambda pid: 0

    async def _admit(*a, **kw):
        return "key"

    mgr._admit_scan = _admit

    # start_recon now also refreshes the offline OSV database before spawning
    # (supply-chain lazy-on-scan sync). That is another collaborator this test
    # does not exercise, and the real one wants constructor state (_osv_db_refresh_lock)
    # that __new__ never built. Stub it like the others.
    async def _osv_fresh(*a, **kw):
        return None

    mgr.ensure_osv_db_fresh_async = _osv_fresh

    # Same reasoning for the sca-intel refresh that runs beside it: this test is
    # about scan-mode passthrough, and the real refresh wants constructor state
    # __new__ never built.
    async def _sca_intel_fresh(*a, **kw):
        return None

    mgr.ensure_sca_intel_fresh_async = _sca_intel_fresh
    mgr._get_container_name = lambda pid: f"redamon-recon-{pid}"
    mgr._scanner_env = lambda *_args: {}
    mgr._scanner_hardening = lambda drop_caps=True: {}
    mgr._container_mem_limit = lambda kind: None
    mgr._container_pids_limit = lambda: None
    mgr._container_cpu_limit = lambda: None

    state = asyncio.run(mgr.start_recon(
        project_id="p1",
        user_id="u1",
        webapp_api_url="http://webapp:3000",
        recon_path="/app/recon",
        scan_mode=scan_mode,
    ))
    assert state.status == ReconStatus.RUNNING, f"spawn failed: {state.error}"
    assert calls, "containers.run was never called"
    return calls[0]


class TestReconStartRequestMode(unittest.TestCase):
    def test_mode_is_optional_so_older_callers_keep_working(self):
        req = ReconStartRequest(project_id="p1", user_id="u1", webapp_api_url="http://w")
        self.assertIsNone(req.mode)

    def test_mode_round_trips(self):
        for m in ("new", "overwrite"):
            req = ReconStartRequest(project_id="p1", user_id="u1", webapp_api_url="http://w", mode=m)
            self.assertEqual(req.mode, m)


class TestScanModeReachesContainer(unittest.TestCase):
    def test_mode_is_forwarded_as_scan_mode_env(self):
        for m in ("new", "overwrite"):
            env = _spawn(m)["environment"]
            self.assertEqual(env["SCAN_MODE"], m)

    def test_absent_mode_becomes_an_empty_string_not_a_crash(self):
        env = _spawn(None)["environment"]
        self.assertEqual(env["SCAN_MODE"], "")

    def test_spawn_is_otherwise_unchanged_by_mode(self):
        """The pipeline must behave identically in both modes."""
        new_kw = _spawn("new")
        over_kw = _spawn("overwrite")
        self.assertEqual(new_kw["command"], over_kw["command"])
        self.assertEqual(new_kw["command"], "python /app/recon/main.py")
        self.assertEqual(new_kw["volumes"], over_kw["volumes"])
        self.assertEqual(new_kw["cap_add"], over_kw["cap_add"])
        # UPDATE_GRAPH_DB stays on: both modes rely on the existing wipe+rebuild.
        self.assertEqual(new_kw["environment"]["UPDATE_GRAPH_DB"], "true")
        self.assertEqual(over_kw["environment"]["UPDATE_GRAPH_DB"], "true")
        differing = {
            k for k in set(new_kw["environment"]) | set(over_kw["environment"])
            if new_kw["environment"].get(k) != over_kw["environment"].get(k)
        }
        # RECON_RUN_ID is a fresh uuid per spawn; SCAN_MODE is the field under test.
        self.assertEqual(differing, {"SCAN_MODE", "RECON_RUN_ID"})


class TestConcurrentStartStillRejected(unittest.TestCase):
    """Risk 1: a snapshot must never be taken of a mid-write graph.

    The webapp freezes the graph before calling us, so the existing "one full
    recon at a time" guard is what keeps a second start (and therefore a second
    freeze) from racing the first. Regression-guard it here.
    """

    def _mgr_with_status(self, status):
        mgr = cm.ContainerManager.__new__(cm.ContainerManager)
        mgr.client = mock.Mock()
        mgr.running_states = {}
        mgr.partial_recon_states = {}

        async def _status(_pid):
            return ReconState(project_id=_pid, status=status)

        mgr.get_status = _status
        mgr._count_active_partial_recons = lambda pid: 0
        return mgr

    def _start(self, mgr):
        return asyncio.run(mgr.start_recon(
            project_id="p1", user_id="u1", webapp_api_url="http://w",
            recon_path="/app/recon", scan_mode="new",
        ))

    def test_running_scan_blocks_a_second_start(self):
        with self.assertRaises(ValueError) as ctx:
            self._start(self._mgr_with_status(ReconStatus.RUNNING))
        self.assertIn("already active", str(ctx.exception))

    def test_paused_scan_blocks_a_second_start(self):
        with self.assertRaises(ValueError):
            self._start(self._mgr_with_status(ReconStatus.PAUSED))

    def test_active_partial_recon_blocks_a_full_scan(self):
        mgr = self._mgr_with_status(ReconStatus.IDLE)
        mgr._count_active_partial_recons = lambda pid: 1
        with self.assertRaises(ValueError) as ctx:
            self._start(mgr)
        self.assertIn("Partial recon", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
