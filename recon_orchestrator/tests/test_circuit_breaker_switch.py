"""RECON_CIRCUIT_BREAKERS reaches both recon spawns.

The orchestrator has no env_file: the operator's value arrives through its own
compose `environment:` block and must be forwarded into every recon container
it spawns, full and partial, or the off switch is silently inert.

Driven through the actual spawn paths with docker stubbed.
"""
from __future__ import annotations

import asyncio
import os
import sys
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import container_manager as cm  # noqa: E402
from models import ReconState, ReconStatus  # noqa: E402


def _full_recon_env() -> dict:
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
    mgr._docker_op_executor = ThreadPoolExecutor(max_workers=2)
    mgr.supply_chain_osv_db_volume = "redamon-osv-db"
    mgr.sca_intel_volume = "redamon-sca-intel"
    mgr.recon_image = "redamon-recon:latest"
    mgr.running_states = {}
    mgr.partial_recon_states = {}

    async def _idle(pid):
        return ReconState(project_id=pid, status=ReconStatus.IDLE)

    async def _noop(*a, **kw):
        return None

    async def _admit(*a, **kw):
        return "key"

    mgr.get_status = _idle
    mgr._count_active_partial_recons = lambda pid: 0
    mgr._admit_scan = _admit
    mgr.ensure_osv_db_fresh_async = _noop
    mgr.ensure_sca_intel_fresh_async = _noop
    mgr._get_container_name = lambda pid: f"redamon-recon-{pid}"
    mgr._scanner_env = lambda *_args: {}
    mgr._scanner_hardening = lambda drop_caps=True: {}
    mgr._container_mem_limit = lambda kind: None
    mgr._container_pids_limit = lambda: None
    mgr._container_cpu_limit = lambda: None

    state = asyncio.run(mgr.start_recon(
        project_id="p1", user_id="u1", webapp_api_url="http://webapp:3000",
        recon_path="/app/recon", scan_mode=None,
    ))
    assert state.status == ReconStatus.RUNNING, f"spawn failed: {state.error}"
    return calls[0]["environment"]


def _partial_recon_env() -> dict:
    captured: dict = {}
    os.makedirs("/tmp/redamon", exist_ok=True)

    def _run(image, **kwargs):
        captured.update(kwargs)
        return types.SimpleNamespace(id="test-container-id")

    client = mock.MagicMock()
    client.containers.run.side_effect = _run

    async def _go():
        with mock.patch.object(cm.docker, "from_env", return_value=client):
            mgr = cm.ContainerManager()
        mgr.graph_db_host_path = "/repo/graph_db"
        mgr.recon_settings_host_path = "/repo/recon_settings"
        mgr.get_status = mock.AsyncMock(
            return_value=types.SimpleNamespace(status=ReconStatus.IDLE))
        mgr._admit_scan = mock.AsyncMock(return_value=None)
        state = await mgr.start_partial_recon(
            project_id="p1", tool_id="SubdomainDiscovery",
            config={"tool_id": "SubdomainDiscovery", "user_id": "u1", "domains": ["example.com"]},
            recon_path="/repo/recon",
        )
        assert getattr(state, "error", None) in (None, ""), f"spawn failed: {state.error}"

    with mock.patch.dict(os.environ, {
        "SCANNER_API_KEY": "test-scanner-key",
        "INTERNAL_API_KEY": "test-internal-key",
    }):
        asyncio.run(_go())
    return captured["environment"]


class TestCircuitBreakerSwitchForwarding(unittest.TestCase):
    def test_off_reaches_the_full_recon_container(self):
        with mock.patch.dict(os.environ, {"RECON_CIRCUIT_BREAKERS": "off"}):
            self.assertEqual(_full_recon_env()["RECON_CIRCUIT_BREAKERS"], "off")

    def test_off_reaches_the_partial_recon_container(self):
        with mock.patch.dict(os.environ, {"RECON_CIRCUIT_BREAKERS": "off"}):
            self.assertEqual(_partial_recon_env()["RECON_CIRCUIT_BREAKERS"], "off")

    def test_unset_defaults_to_on_in_both(self):
        env = dict(os.environ)
        env.pop("RECON_CIRCUIT_BREAKERS", None)
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(_full_recon_env()["RECON_CIRCUIT_BREAKERS"], "on")
            self.assertEqual(_partial_recon_env()["RECON_CIRCUIT_BREAKERS"], "on")


if __name__ == "__main__":
    unittest.main()
