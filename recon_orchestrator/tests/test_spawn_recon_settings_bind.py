"""The /app/recon_settings bind of a real spawn.

The recon settings registry decides every parameter's bound and every rate's
engagement ceiling, and the loader refuses to start a scan without it. So it is
baked into the scan images, and this bind overlays the host's fresher copy so a
registry edit takes effect without a rebuild.

That makes its failure modes deliberately different from graph_db's, and the
difference is the point of these tests:

  graph_db         a wrong guess binds an empty auto-created dir OVER the baked
                   copy, and the scan dies on an import error
  recon_settings   no guess is ever made. Binding nothing costs freshness and
                   never correctness, because the baked copy is still there.

Driven through the ACTUAL spawn path with a stubbed docker client, so it fails
if the helper is right but a spawn site stops calling it.

Run:  docker exec redamon-recon-orchestrator sh -c 'cd /app && python -m pytest tests/test_spawn_recon_settings_bind.py -v'
"""

import asyncio
import os
import re
import types
import unittest
from unittest import mock

import container_manager as cm
from container_manager import ContainerManager, sibling_host_path
from models import ReconStatus

BIND = "/app/recon_settings"
REPO = "/repo"
RECON_PATH = f"{REPO}/recon"
REAL_REGISTRY = f"{REPO}/recon_settings"
REAL_GRAPH_DB = f"{REPO}/graph_db"

# What Docker Desktop on WSL2 can report as the bind Source for ./recon.
WSL_SOURCE = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu-24.04/9f3a2b1c"


def _fake_docker_client(captured: dict):
    client = mock.MagicMock()

    def _run(image, **kwargs):
        captured.update(kwargs)
        captured["image"] = image
        return types.SimpleNamespace(id="test-container-id")

    client.containers.run.side_effect = _run
    return client


def _spawn(registry_host_path: str, recon_path: str = RECON_PATH) -> dict:
    """Drive start_partial_recon; return the volumes dict handed to containers.run."""
    captured: dict = {}
    os.makedirs("/tmp/redamon", exist_ok=True)

    async def _go():
        with mock.patch.object(cm.docker, "from_env",
                               return_value=_fake_docker_client(captured)):
            mgr = ContainerManager()
        mgr.graph_db_host_path = REAL_GRAPH_DB
        mgr.recon_settings_host_path = registry_host_path
        mgr.get_status = mock.AsyncMock(
            return_value=types.SimpleNamespace(status=ReconStatus.IDLE))
        mgr._admit_scan = mock.AsyncMock(return_value=None)
        state = await mgr.start_partial_recon(
            project_id="p1",
            tool_id="SubdomainDiscovery",
            config={"tool_id": "SubdomainDiscovery", "user_id": "u1", "domains": ["example.com"]},
            recon_path=recon_path,
        )
        assert getattr(state, "error", None) in (None, ""), f"spawn failed: {state.error}"
        return captured

    with mock.patch.dict(os.environ, {
        "SCANNER_API_KEY": "test-scanner-key",
        "INTERNAL_API_KEY": "test-internal-key",
    }):
        return asyncio.run(_go())


def _registry_binds(volumes: dict) -> dict:
    return {src: b for src, b in volumes.items() if b.get("bind") == BIND}


class TestReconSettingsBind(unittest.TestCase):
    def test_detected_path_is_bound_read_only(self):
        vols = _spawn(REAL_REGISTRY)["volumes"]
        self.assertEqual(_registry_binds(vols),
                         {REAL_REGISTRY: {"bind": BIND, "mode": "ro"}})

    def test_an_undetected_path_binds_nothing_rather_than_guessing(self):
        """The baked registry serves. Stale beats absent, and absent stops the scan."""
        vols = _spawn("")["volumes"]
        self.assertEqual(_registry_binds(vols), {})

    def test_a_rewritten_source_never_produces_a_derived_guess(self):
        """
        The graph_db bug, which this helper avoids by never guessing.

        With a rewritten bind Source the sibling derivation names a path that
        exists nowhere; Docker would auto-create it EMPTY and the empty dir would
        shadow the baked registry, stopping every scan.
        """
        would_have_bound = sibling_host_path(WSL_SOURCE, "recon_settings")
        self.assertNotEqual(would_have_bound, REAL_REGISTRY)
        vols = _spawn("", recon_path=WSL_SOURCE)["volumes"]
        self.assertNotIn(would_have_bound, vols)
        self.assertEqual(_registry_binds(vols), {})

    def test_the_rest_of_the_mounts_are_unaffected(self):
        with_detect = _spawn(REAL_REGISTRY)["volumes"]
        without = _spawn("")["volumes"]
        self.assertEqual(set(with_detect) - set(without), {REAL_REGISTRY})
        self.assertEqual(set(without) - set(with_detect), set())
        self.assertIn(RECON_PATH, without)

    def test_subdomain_worker_keeps_settings_but_does_not_mount_graph_db(self):
        """The least-privilege writer keeps settings and drops direct graph access."""
        vols = _spawn(REAL_REGISTRY)["volumes"]
        self.assertIn(REAL_REGISTRY, vols)
        self.assertNotIn(REAL_GRAPH_DB, vols)

    def test_the_helper_is_used_by_every_spawn_that_binds_graph_db(self):
        """
        A spawn site that binds graph_db but not the registry is how a scanner
        that starts reading the registry later fails closed in production.
        """
        source = (cm.__file__ or "")
        with open(source, encoding="utf-8") as fh:
            text = fh.read()
        methods = re.split(r"(?=^    (?:async )?def )", text, flags=re.MULTILINE)
        graph_spawns = [method for method in methods
                        if "_graph_db_mount(" in method and "def _graph_db_mount(" not in method]
        self.assertEqual(len(graph_spawns), 2)
        self.assertTrue(
            all("**self._recon_settings_mount()" in method for method in graph_spawns),
            "every graph_db bind site must also bind the settings registry",
        )


if __name__ == "__main__":
    unittest.main()
