"""Issue #169 - unit tests for the /app/graph_db bind source of every scan spawn.

The bug: the orchestrator DERIVED graph_db's host path by string surgery on a
sibling source path (``sibling_host_path(recon_path, "graph_db")``). Wherever
Docker reports a rewritten bind ``Source`` (Docker Desktop on Windows/WSL2) that
guess names a path that does not exist. Docker does not treat a missing bind
source as an error - it auto-creates an EMPTY root-owned directory and mounts it,
shadowing the good graph_db baked into the scan image. The spawned scan then dies
with ``cannot import name 'Neo4jClient' from 'graph_db' (unknown location)``.

The fix: prefer the AUTO-DETECTED host path (Docker's own mount table, via
api.py's GRAPH_DB_PATH), and never let the unverifiable guess shadow a baked-in
copy. These tests lock both halves in.

``_graph_db_mount`` touches no docker client, so we build a ContainerManager
without running __init__ (same pattern as test_d1_resource_ceilings).

Run:  docker exec redamon-recon-orchestrator sh -c 'cd /app && python -m unittest tests.test_graph_db_mount -v'
"""

import unittest

from container_manager import ContainerManager, parent_host_path, sibling_host_path

BIND = "/app/graph_db"
DERIVED = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu-24.04/graph_db"
REAL = "/home/user/redamon/graph_db"


def _mgr(graph_db_host_path=None) -> ContainerManager:
    m = ContainerManager.__new__(ContainerManager)
    if graph_db_host_path is not None:
        m.graph_db_host_path = graph_db_host_path
    return m


class TestDetectedPathWins(unittest.TestCase):
    def test_detected_path_is_used_not_the_guess(self):
        m = _mgr(REAL)
        for baked in (True, False):
            with self.subTest(baked=baked):
                self.assertEqual(
                    m._graph_db_mount(DERIVED, baked_into_image=baked),
                    {REAL: {"bind": BIND, "mode": "ro"}},
                )

    def test_detected_path_is_stripped(self):
        m = _mgr(f"  {REAL}\n")
        self.assertEqual(m._graph_db_mount(DERIVED, baked_into_image=True),
                         {REAL: {"bind": BIND, "mode": "ro"}})

    def test_mount_is_read_only(self):
        mount = _mgr(REAL)._graph_db_mount(DERIVED, baked_into_image=True)
        self.assertEqual(mount[REAL]["mode"], "ro")


class TestUndetectedFallsBackSafely(unittest.TestCase):
    """No detected path: never shadow a good baked-in copy with a guess."""

    def test_baked_image_gets_no_mount_at_all(self):
        for value in ("", "   ", None):
            with self.subTest(value=value):
                m = _mgr(value)
                self.assertEqual(m._graph_db_mount(DERIVED, baked_into_image=True), {})

    def test_missing_attribute_is_treated_as_undetected(self):
        # api.py sets graph_db_host_path AFTER construction; a spawn that races
        # it (or an older api.py) must not raise AttributeError.
        m = ContainerManager.__new__(ContainerManager)
        self.assertEqual(m._graph_db_mount(DERIVED, baked_into_image=True), {})

    def test_unbaked_image_still_gets_the_guess(self):
        # supply-chain does NOT bake graph_db, so no mount would be strictly
        # worse than a guess that might be right.
        m = _mgr("")
        self.assertEqual(m._graph_db_mount(DERIVED, baked_into_image=False),
                         {DERIVED: {"bind": BIND, "mode": "ro"}})

    def test_fallback_never_yields_an_empty_source_key(self):
        # A "" key would make docker-py send a malformed bind.
        m = _mgr("")
        for derived in (DERIVED, "", "   ", None):
            with self.subTest(derived=derived):
                mount = m._graph_db_mount(derived, baked_into_image=False)
                self.assertNotIn("", mount)
                self.assertTrue(all(k and k.strip() for k in mount))

    def test_nothing_detected_and_nothing_derivable_binds_nothing(self):
        self.assertEqual(_mgr("")._graph_db_mount("", baked_into_image=False), {})


class TestEveryScanSpawnUsesTheHelper(unittest.TestCase):
    """The regression guard: a new spawn site must not re-introduce a raw bind."""

    def _source(self):
        import inspect
        return inspect.getsource(ContainerManager)

    def test_no_raw_graph_db_bind_outside_the_helper(self):
        src = self._source()
        helper = src[src.index("def _graph_db_mount"):]
        helper = helper[:helper.index("\n    def ", 1)]
        raw_binds = src.count('"bind": "/app/graph_db"') - helper.count('"bind": "/app/graph_db"')
        self.assertEqual(
            raw_binds, 0,
            "a scan spawn binds /app/graph_db directly instead of via "
            "_graph_db_mount(); a wrong derived source there silently mounts an "
            "empty dir over the image's graph_db (issue #169)",
        )

    def test_all_graph_writing_spawn_sites_route_through_the_helper(self):
        # recon and partial-recon. GVM, AI Attack Surface, GitHub Hunt, and
        # Supply-chain workers emit artifacts for trusted orchestrator ingest.
        # TruffleHog is deliberately NOT here: its container is the dirty half of
        # the dirty/clean split and holds no Neo4j credentials, so it has no
        # graph_db to mount. The orchestrator ingests its findings afterwards.
        self.assertEqual(self._source().count("self._graph_db_mount("), 2)

    def test_no_spawn_uses_the_unverified_graph_db_guess(self):
        src = self._source()
        self.assertEqual(src.count("baked_into_image=False"), 0)
        self.assertEqual(src.count("baked_into_image=True"), 2)

    def test_gvm_worker_has_no_graph_credentials_or_mount(self):
        src = self._source()
        start = src.index("    async def start_gvm_scan(")
        end = src.index("\n    async def pause_gvm_scan(", start)
        spawn = src[start:end]
        for forbidden in ('"NEO4J_URI":', '"NEO4J_USER":', '"NEO4J_PASSWORD":',
                          "_graph_db_mount("):
            self.assertNotIn(forbidden, spawn)
        self.assertIn('"GVM_RUN_ID": run_id', spawn)

    def test_supply_chain_worker_has_no_graph_credentials_or_mount(self):
        src = self._source()
        start = src.index("    async def start_supply_chain(")
        end = src.index("\n    async def pause_supply_chain(", start)
        spawn = src[start:end]
        for forbidden in ('"NEO4J_URI":', '"NEO4J_USER":', '"NEO4J_PASSWORD":', "_graph_db_mount("):
            self.assertNotIn(forbidden, spawn)
        self.assertIn("SUPPLY_CHAIN_RUN_ID", spawn)
        self.assertIn("supply_chain_common", spawn)

    def test_github_hunt_worker_carries_no_graph_credentials_or_mount(self):
        src = self._source()
        start = src.index("    async def start_github_hunt(")
        end = src.index("\n    async def pause_github_hunt(", start)
        spawn = src[start:end]
        for forbidden in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD", "_graph_db_mount("):
            self.assertNotIn(forbidden, spawn)
        self.assertIn("_scanner_env(project_id, user_id)", spawn)
        self.assertIn("github_secret_hunt/output", spawn)

    def test_ai_attack_worker_has_no_graph_credentials_or_shared_config_volume(self):
        src = self._source()
        start = src.index("    async def start_ai_attack_surface(")
        end = src.index("\n    async def stop_ai_attack_surface(", start)
        spawn = src[start:end]
        for forbidden in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"):
            self.assertNotIn(forbidden, spawn)
        self.assertIn('"/run/ai-attack/config.json"', spawn)
        self.assertIn('"/run/ai-attack/results.json"', spawn)
        self.assertNotIn('"/tmp/redamon": {"bind": "/tmp/redamon"', spawn)

    def test_trufflehog_spawn_carries_no_neo4j_credentials(self):
        """The regression that matters more than the mount: a TruffleHog
        container parses attacker-controlled bytes (a malicious image layer, a
        hostile repo). If NEO4J_* ever reappears in its environment, a parser
        exploit reaches cross-tenant graph read/write."""
        src = self._source()
        start = src.index("    async def start_trufflehog(")
        end = src.index("\n    def _trufflehog_credential_env(", start)
        spawn = src[start:end]
        for forbidden in ("NEO4J_URI", "NEO4J_PASSWORD", "_scanner_env(", "network_mode=\"host\""):
            self.assertNotIn(forbidden, spawn,
                             f"{forbidden} must not be in the TruffleHog spawn")


class TestDerivationStillCorrectWhereItIsUsed(unittest.TestCase):
    """The guess remains the last-resort fallback, so it must stay right."""

    def test_scanner_climbs_out_of_scanners_dir(self):
        scanner = "/home/user/redamon/scanners/supply_chain_scan"
        self.assertEqual(sibling_host_path(parent_host_path(scanner), "graph_db"),
                         "/home/user/redamon/graph_db")

    def test_recon_sibling_is_repo_root_graph_db(self):
        self.assertEqual(sibling_host_path("/home/user/redamon/recon", "graph_db"),
                         "/home/user/redamon/graph_db")


if __name__ == "__main__":
    unittest.main()
