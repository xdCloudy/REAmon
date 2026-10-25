"""Issue #169 - end-to-end guard on the /app/graph_db bind of a real spawn.

test_graph_db_mount.py covers the decision helper in isolation. This file drives
the ACTUAL ``start_partial_recon`` spawn path with a stubbed docker client and
inspects the ``volumes`` dict that would reach ``containers.run`` - so it fails if
the helper is correct but a spawn site stops using it, or starts passing the wrong
``baked_into_image``.

Partial recon is the path the bug was reported on: full recon wraps its graph
imports in try/except and merely stops writing to Neo4j in silence, while partial
recon crashes with
``cannot import name 'Neo4jClient' from 'graph_db' (unknown location)``.

No docker daemon is needed: docker.from_env is patched for the whole construction.

Run:  docker exec redamon-recon-orchestrator sh -c 'cd /app && python -m unittest tests.test_spawn_graph_db_bind -v'
"""

import asyncio
import os
import types
import unittest
from unittest import mock

import container_manager as cm
from container_manager import ContainerManager, sibling_host_path
from models import ReconStatus

GRAPH_BIND = "/app/graph_db"
REPO = "/repo"
RECON_PATH = f"{REPO}/recon"
REAL_GRAPH_DB = f"{REPO}/graph_db"

# What Docker Desktop on WSL2 can report as the bind Source for ./recon. Its
# "sibling graph_db" is a path that exists nowhere, which is what made Docker
# auto-create an empty dir and shadow the image's good copy.
WSL_SOURCE = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu-24.04/9f3a2b1c"


def _fake_docker_client(captured: dict):
    client = mock.MagicMock()

    def _run(image, **kwargs):
        captured.update(kwargs)
        captured["image"] = image
        return types.SimpleNamespace(id="test-container-id")

    client.containers.run.side_effect = _run
    return client


def _spawn(graph_db_host_path: str, recon_path: str = RECON_PATH) -> dict:
    """Drive start_partial_recon; return the volumes dict handed to containers.run."""
    captured: dict = {}
    os.makedirs("/tmp/redamon", exist_ok=True)

    async def _go():
        with mock.patch.object(cm.docker, "from_env",
                               return_value=_fake_docker_client(captured)):
            mgr = ContainerManager()
        mgr.graph_db_host_path = graph_db_host_path
        # Bypass the two gates that need real state; neither touches mounts.
        mgr.get_status = mock.AsyncMock(
            return_value=types.SimpleNamespace(status=ReconStatus.IDLE))
        mgr._admit_scan = mock.AsyncMock(return_value=None)
        state = await mgr.start_partial_recon(
            project_id="p1",
            tool_id="SubdomainDiscovery",
            config={"tool_id": "SubdomainDiscovery", "user_id": "u1"},
            recon_path=recon_path,
        )
        # A spawn that errored would leave the error on the state instead of
        # raising, and captured would be empty - surface that clearly.
        assert getattr(state, "error", None) in (None, ""), f"spawn failed: {state.error}"
        return captured

    with mock.patch.dict(os.environ, {
        "SCANNER_API_KEY": "test-scanner-key",
        "INTERNAL_API_KEY": "test-internal-key",
    }):
        return asyncio.run(_go())


def _graph_binds(volumes: dict) -> dict:
    return {src: b for src, b in volumes.items() if b.get("bind") == GRAPH_BIND}


class TestPartialReconSpawnBind(unittest.TestCase):
    def test_detected_path_is_bound_read_only(self):
        vols = _spawn(REAL_GRAPH_DB)["volumes"]
        self.assertEqual(_graph_binds(vols),
                         {REAL_GRAPH_DB: {"bind": GRAPH_BIND, "mode": "ro"}})

    def test_wsl_rewritten_source_no_longer_shadows_the_baked_copy(self):
        """The reported failure, at the spawn site.

        With a rewritten Source the old code bound
        <source-parent>/graph_db - a path that exists nowhere - and Docker
        auto-created it empty. Now nothing is bound and the image's copy serves.
        """
        would_have_bound = sibling_host_path(WSL_SOURCE, "graph_db")
        self.assertNotEqual(would_have_bound, REAL_GRAPH_DB)  # the guess is wrong

        vols = _spawn("", recon_path=WSL_SOURCE)["volumes"]
        self.assertEqual(_graph_binds(vols), {})
        self.assertNotIn(would_have_bound, vols)

    def test_undetected_path_binds_nothing_rather_than_guessing(self):
        vols = _spawn("")["volumes"]
        self.assertEqual(_graph_binds(vols), {})

    def test_the_rest_of_the_mounts_are_unaffected(self):
        """Skipping the graph_db bind must not disturb the other mounts."""
        with_detect = _spawn(REAL_GRAPH_DB)["volumes"]
        without = _spawn("")["volumes"]
        self.assertEqual(set(with_detect) - set(without), {REAL_GRAPH_DB})
        self.assertEqual(set(without) - set(with_detect), set())
        self.assertIn(RECON_PATH, without)  # /app/recon still bound

    def test_spawn_still_runs_partial_recon(self):
        captured = _spawn(REAL_GRAPH_DB)
        self.assertIn("partial_recon.py", captured["command"])


if __name__ == "__main__":
    unittest.main()
