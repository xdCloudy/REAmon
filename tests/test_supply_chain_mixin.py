"""Unit tests for the supply-chain graph writer (Phase 2/4 graph model).

Uses a fake Neo4j session (no live DB), mirroring test_js_recon_graph_ingestion.
Asserts: Package + MalPackageFinding MERGE, MAL-vs-suspicious verdict routing,
name-only purl fallback, dedup stability, and finding_id determinism.

Run: python -m unittest tests.test_supply_chain_mixin
"""

import os
import sys
import unittest
from unittest.mock import MagicMock

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

sys.modules.setdefault("neo4j", MagicMock())
sys.modules.setdefault("dotenv", MagicMock())

from graph_db.mixins.supply_chain_mixin import (
    SupplyChainMixin, _finding_id, _overridable_sources, _SOURCE_RANK,
)


class FakeResult:
    def __init__(self, single=None):
        self._single = single

    def single(self):
        return self._single


class FakeSession:
    def __init__(self, anchor_exists=True, domain_exists=True):
        self.queries = []
        self.anchor_exists = anchor_exists
        self.domain_exists = domain_exists

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def run(self, query, **kwargs):
        self.queries.append((query, kwargs))
        if "MERGE (dom)" in query:
            return FakeResult({"linked": 1 if self.domain_exists else 0})
        if "DEPENDS_ON" in query and "RETURN count" in query:
            return FakeResult({"c": 1 if self.anchor_exists else 0})
        return FakeResult()


class FakeDriver:
    def __init__(self, session):
        self._session = session

    def session(self):
        return self._session


class Writer(SupplyChainMixin):
    def __init__(self, session):
        self.driver = FakeDriver(session)


def artifact(**over):
    a = {"packages": [], "malicious": [], "vulnerable": [], "suspicious": []}
    a.update(over)
    return a


class TestSupplyChainMixin(unittest.TestCase):
    def test_package_and_malicious_merge(self):
        sess = FakeSession()
        w = Writer(sess)
        data = artifact(
            packages=[{"purl": "pkg:npm/lodahs@1.0.0", "name": "lodahs",
                       "version": "1.0.0", "ecosystem": "npm", "source": "osv"}],
            malicious=[{"purl": "pkg:npm/lodahs@1.0.0", "name": "lodahs",
                        "advisory_id": "MAL-2025-25502", "severity": "high",
                        "confidence": "malicious", "title": "bad"}])
        stats = w.update_graph_from_supply_chain(
            data, "u1", "p1", anchor_label="BaseURL", anchor_key="url",
            anchor_value="https://t")
        self.assertEqual(stats["packages_merged"], 1)
        self.assertEqual(stats["malicious_merged"], 1)
        self.assertEqual(stats["relationships_created"], 1)
        joined = " ".join(q for q, _ in sess.queries)
        self.assertIn("MERGE (p:Package", joined)
        self.assertIn("MERGE (mf:MalPackageFinding", joined)
        self.assertIn("DEPENDS_ON", joined)
        self.assertIn("FLAGGED_AS", joined)

    def test_tenant_scoping_in_keys(self):
        sess = FakeSession()
        w = Writer(sess)
        w.update_graph_from_supply_chain(
            artifact(packages=[{"purl": "pkg:npm/x@1", "name": "x", "ecosystem": "npm"}]),
            "u1", "p1", anchor_label="GithubRepository", anchor_key="id",
            anchor_value="repo1")
        # every package/finding MERGE carries user_id + project_id
        for q, kw in sess.queries:
            if "MERGE (p:Package" in q:
                self.assertEqual(kw["uid"], "u1")
                self.assertEqual(kw["pid"], "p1")

    def test_suspicious_routes_to_suspicious_not_malicious(self):
        sess = FakeSession()
        w = Writer(sess)
        stats = w.update_graph_from_supply_chain(
            artifact(
                packages=[{"purl": "pkg:npm/evil@1", "name": "evil", "ecosystem": "npm"}],
                suspicious=[{"purl": "pkg:npm/evil@1", "name": "evil", "ecosystem": "npm",
                             "rule": "npm-install-script", "severity": "high",
                             "confidence": "suspicious", "message": "hook"}]),
            "u1", "p1", anchor_label="BaseURL", anchor_key="url", anchor_value="https://t")
        self.assertEqual(stats["suspicious_merged"], 1)
        self.assertEqual(stats["malicious_merged"], 0)

    def test_name_only_purl_fallback_for_guarddog(self):
        sess = FakeSession()
        w = Writer(sess)
        stats = w.update_graph_from_supply_chain(
            artifact(suspicious=[{"name": "evil", "ecosystem": "npm",
                                  "rule": "typosquatting", "confidence": "suspicious"}]),
            "u1", "p1", anchor_label="BaseURL", anchor_key="url", anchor_value="https://t")
        self.assertEqual(stats["suspicious_merged"], 1)

    def test_finding_id_deterministic(self):
        a = _finding_id("pkg:npm/x@1", "MAL-1")
        b = _finding_id("pkg:npm/x@1", "MAL-1")
        c = _finding_id("pkg:npm/x@1", "MAL-2")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertEqual(len(a), 16)

    def test_no_depends_on_when_anchor_absent(self):
        sess = FakeSession(anchor_exists=False)
        w = Writer(sess)
        stats = w.update_graph_from_supply_chain(
            artifact(packages=[{"purl": "pkg:npm/x@1", "name": "x", "ecosystem": "npm"}]),
            "u1", "p1", anchor_label="BaseURL", anchor_key="url", anchor_value="https://absent")
        self.assertEqual(stats["packages_merged"], 1)
        self.assertEqual(stats["relationships_created"], 0)

    def test_no_anchor_creates_floating_packages(self):
        # Uploaded-SBOM case: no repo/URL parent. Packages + findings created,
        # but NO DEPENDS_ON edge attempted.
        sess = FakeSession()
        w = Writer(sess)
        stats = w.update_graph_from_supply_chain(
            artifact(packages=[{"purl": "pkg:npm/x@1", "name": "x", "ecosystem": "npm"}],
                     malicious=[{"purl": "pkg:npm/x@1", "name": "x",
                                 "advisory_id": "MAL-1", "confidence": "malicious"}]),
            "u1", "p1")
        self.assertEqual(stats["packages_merged"], 1)
        self.assertEqual(stats["malicious_merged"], 1)
        self.assertEqual(stats["relationships_created"], 0)
        self.assertNotIn("DEPENDS_ON", " ".join(q for q, _ in sess.queries))

    def test_anchor_without_key_raises(self):
        with self.assertRaises(ValueError):
            Writer(FakeSession()).update_graph_from_supply_chain(
                artifact(), "u1", "p1", anchor_label="BaseURL")

    def test_L2_4_anchor_key_whitelisted(self):
        # L2-4 regression: anchor_key is interpolated into Cypher, so a value
        # outside {id,url} must be rejected (injection surface).
        with self.assertRaises(ValueError):
            Writer(FakeSession()).update_graph_from_supply_chain(
                artifact(), "u1", "p1", anchor_label="BaseURL",
                anchor_key="url} DETACH DELETE n //", anchor_value="x")

    def test_bad_anchor_label_raises(self):
        with self.assertRaises(ValueError):
            Writer(FakeSession()).update_graph_from_supply_chain(
                artifact(), "u1", "p1", anchor_label="Domain", anchor_key="name",
                anchor_value="x")


class TestDisplayFieldsPersisted(unittest.TestCase):
    """Fields the artifact carries that the writer used to silently drop.

    Each one is a column in the Supply-Chain SCA table; a dropped field is a
    column that reads as "nothing here" when the data existed all along.
    """

    @staticmethod
    def _kwargs_for(sess, marker):
        for q, kw in sess.queries:
            if marker in q:
                return kw
        return None

    def test_soft_error_flag_is_persisted(self):
        # A soft error means GuardDog never produced a verdict. Without this
        # flag on the node it is indistinguishable from a real low-severity
        # suspicious hit, which is the false-clean the marker exists to prevent.
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain(
            artifact(suspicious=[{"purl": "pkg:npm/x@1", "name": "x",
                                  "ecosystem": "npm", "rule": "guarddog-not-run",
                                  "severity": "low", "confidence": "suspicious",
                                  "message": "download failed", "soft_error": True}]),
            "u1", "p1")
        kw = self._kwargs_for(sess, "MERGE (mf:MalPackageFinding")
        self.assertIsNotNone(kw)
        self.assertIs(kw["soft_error"], True)

    def test_soft_error_defaults_to_false(self):
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain(
            artifact(malicious=[{"purl": "pkg:npm/x@1", "name": "x",
                                 "advisory_id": "MAL-1"}]),
            "u1", "p1")
        kw = self._kwargs_for(sess, "MERGE (mf:MalPackageFinding")
        self.assertIs(kw["soft_error"], False)

    def test_aliases_are_persisted_and_capped(self):
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain(
            artifact(malicious=[{"purl": "pkg:npm/x@1", "name": "x",
                                 "advisory_id": "MAL-1",
                                 "aliases": ["GHSA-a", "CVE-2020-1"] + ["X"] * 100}]),
            "u1", "p1")
        kw = self._kwargs_for(sess, "MERGE (mf:MalPackageFinding")
        self.assertEqual(kw["aliases"][:2], ["GHSA-a", "CVE-2020-1"])
        self.assertEqual(len(kw["aliases"]), 50)

    def test_source_path_is_persisted(self):
        # On an L1 repo scan osv-scanner walks every lockfile in the tree; the
        # source path is the only way to tell WHICH one carries the package.
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain(
            artifact(packages=[{"purl": "pkg:npm/x@1", "name": "x",
                                "ecosystem": "npm", "source": "osv",
                                "source_path": "web/package-lock.json"}]),
            "u1", "p1")
        kw = self._kwargs_for(sess, "MERGE (p:Package")
        self.assertEqual(kw["source_path"], "web/package-lock.json")

    def test_source_path_write_is_coalesced(self):
        # A later L2 sighting of the same purl carries no source_path; it must
        # not erase what the repo scan established.
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain(
            artifact(packages=[{"purl": "pkg:npm/x@1", "name": "x",
                                "ecosystem": "npm", "source": "sourcemap"}]),
            "u1", "p1")
        query = next(q for q, _ in sess.queries if "MERGE (p:Package" in q)
        self.assertIn("coalesce($source_path, p.source_path)", query)


def _pkgs(n):
    return [{"purl": "pkg:npm/p%d@1.0.0" % i, "name": "p%d" % i,
             "version": "1.0.0", "ecosystem": "npm", "source": "sourcemap"}
            for i in range(n)]


class TestReconWriteIsNotRepeatedPerBaseUrl(unittest.TestCase):
    """REGRESSION: the L2 entry point re-wrote the WHOLE artifact per BaseURL.

    update_graph_from_supply_chain_recon called update_graph_from_supply_chain
    once for every BaseURL, so every Package, MalPackageFinding and
    Vulnerability MERGE ran N times. A real scan (122 packages, 2 BaseURLs)
    issued ~500 Cypher round-trips where ~250 were needed, and reported
    packages_merged=244 for 122 actual nodes.

    The DATA was never wrong - MERGE is idempotent - so nothing failed loudly.
    Only the cost and the reported counts were wrong, and a target with 10
    BaseURLs (several ports/subdomains is ordinary) paid 10x.
    """

    def _recon(self, packages, base_urls):
        return {"supply_chain_recon": {
            "artifact": artifact(packages=packages), "base_urls": base_urls}}

    def test_packages_are_merged_once_regardless_of_base_url_count(self):
        sess = FakeSession()
        stats = Writer(sess).update_graph_from_supply_chain_recon(
            self._recon(_pkgs(5), ["http://a", "http://b", "http://c"]), "u1", "p1")
        merges = [q for q, _ in sess.queries if "MERGE (p:Package" in q]
        self.assertEqual(len(merges), 5,
                         "packages re-written once per BaseURL")
        self.assertEqual(stats["packages_merged"], 5,
                         "reported count must be node count, not writes")

    def test_one_anchor_query_per_base_url_not_per_package(self):
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain_recon(
            self._recon(_pkgs(10), ["http://a", "http://b"]), "u1", "p1")
        anchors = [q for q, _ in sess.queries if "DEPENDS_ON" in q]
        self.assertEqual(len(anchors), 2,
                         "edges must be batched with UNWIND, one query per anchor")

    def test_every_base_url_still_gets_its_edges(self):
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain_recon(
            self._recon(_pkgs(3), ["http://a", "http://b"]), "u1", "p1")
        values = [kw.get("anchor_value") for q, kw in sess.queries if "DEPENDS_ON" in q]
        self.assertEqual(sorted(values), ["http://a", "http://b"])

    def test_all_purls_are_passed_to_the_anchor_query(self):
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain_recon(
            self._recon(_pkgs(4), ["http://a"]), "u1", "p1")
        _, kw = next((q, k) for q, k in sess.queries if "DEPENDS_ON" in q)
        self.assertEqual(len(kw["purls"]), 4)

    def test_anchor_query_is_tenant_scoped(self):
        """S10: both the anchor and the packages must be filtered by tenant."""
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain_recon(
            self._recon(_pkgs(2), ["http://a"]), "u1", "p1")
        q, kw = next((q, k) for q, k in sess.queries if "DEPENDS_ON" in q)
        self.assertIn("user_id: $uid", q)
        self.assertIn("project_id: $pid", q)
        self.assertEqual((kw["uid"], kw["pid"]), ("u1", "p1"))

    def test_anchor_is_matched_never_created(self):
        """Inventing a BaseURL the scan never observed would put a fabricated
        target in the graph."""
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain_recon(
            self._recon(_pkgs(2), ["http://a"]), "u1", "p1")
        q, _ = next((q, k) for q, k in sess.queries if "DEPENDS_ON" in q)
        self.assertIn("MATCH (a:BaseURL", q)
        self.assertNotIn("MERGE (a:BaseURL", q)

    def test_no_base_urls_falls_back_to_a_floating_write(self):
        sess = FakeSession()
        stats = Writer(sess).update_graph_from_supply_chain_recon(
            self._recon(_pkgs(3), []), "u1", "p1")
        self.assertEqual(stats["packages_merged"], 3)
        self.assertEqual([q for q, _ in sess.queries if "DEPENDS_ON" in q], [])

    def test_missing_anchor_node_is_not_an_error(self):
        """A BaseURL that does not exist yet simply yields no edges."""
        sess = FakeSession(anchor_exists=False)
        stats = Writer(sess).update_graph_from_supply_chain_recon(
            self._recon(_pkgs(2), ["http://gone"]), "u1", "p1")
        self.assertEqual(stats["relationships_created"], 0)
        self.assertEqual(stats["errors"], [])

    def test_packages_without_a_purl_are_not_anchored(self):
        sess = FakeSession()
        pkgs = _pkgs(2) + [{"name": "nopurl", "version": None,
                            "ecosystem": "npm", "source": "sourcemap"}]
        Writer(sess).update_graph_from_supply_chain_recon(
            self._recon(pkgs, ["http://a"]), "u1", "p1")
        _, kw = next((q, k) for q, k in sess.queries if "DEPENDS_ON" in q)
        self.assertEqual(len(kw["purls"]), 2)

    def test_anchor_label_and_key_are_whitelisted(self):
        """They are string-interpolated into Cypher, so they must never come
        from data."""
        w = Writer(FakeSession())
        with self.assertRaises(ValueError):
            w._anchor_packages_to("Evil", "url", "x", ["pkg:npm/a@1"], "u", "p")
        with self.assertRaises(ValueError):
            w._anchor_packages_to("BaseURL", "evil", "x", ["pkg:npm/a@1"], "u", "p")


class TestSourceProvenanceIsNotClobbered(unittest.TestCase):
    """REGRESSION: an L1 upload erased what the LIVE target actually served.

    L1 and L2 dedup into one Package node per purl (intentional), but `source`
    was SET unconditionally, so the last scan to run won. Uploading a
    package-lock.json after a recon scan rewrote lodash@4.17.4 - which
    retire.js had read out of bytes the target really served - to source='osv',
    as though it had only ever appeared in a file someone uploaded.

    Observed live: the guinea-pig validator dropped 174/174 -> 170/174 with
    four "source=retirejs ... (got 'osv')" failures immediately after an L1
    upload of the same packages.

    `source` is how you tell a REACHABLE dependency from a theoretical one, so
    a weaker source must never overwrite a stronger one.
    """

    def test_manifest_source_may_not_overwrite_live_target_evidence(self):
        self.assertNotIn("retirejs", _overridable_sources("osv"))
        self.assertNotIn("wappalyzer", _overridable_sources("osv"))
        self.assertNotIn("sourcemap", _overridable_sources("lockfile"))

    def test_live_target_evidence_may_overwrite_a_manifest(self):
        for weaker in ("osv", "sbom", "lockfile", "dir", "finding"):
            self.assertIn(weaker, _overridable_sources("retirejs"), weaker)

    def test_same_source_refreshes_itself(self):
        """A re-scan by the same source must still update the node."""
        for src in _SOURCE_RANK:
            self.assertIn(src, _overridable_sources(src), src)

    def test_placeholder_is_the_weakest(self):
        """'finding' exists only to hang a verdict on - it has no discovery
        evidence and must never displace a real sighting."""
        self.assertEqual(_overridable_sources("finding"), ["finding"])

    def test_unknown_source_cannot_erase_live_evidence(self):
        overridable = _overridable_sources("something-new")
        self.assertNotIn("retirejs", overridable)
        self.assertIn("finding", overridable)

    def test_unknown_existing_source_is_left_alone(self):
        """Unknown provenance is still provenance - do not clobber it."""
        self.assertNotIn("mystery-tool", _overridable_sources("retirejs"))

    def test_query_guards_the_source_write(self):
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain(
            artifact(packages=[{"purl": "pkg:npm/a@1", "name": "a", "version": "1",
                                "ecosystem": "npm", "source": "osv"}]), "u1", "p1")
        q, kw = next((q, k) for q, k in sess.queries if "MERGE (p:Package" in q)
        self.assertIn("p.source IN $overridable", q,
                      "source must be written conditionally, not unconditionally")
        self.assertNotIn("retirejs", kw["overridable"])

    def test_retire_sighting_passes_the_full_override_set(self):
        sess = FakeSession()
        Writer(sess).update_graph_from_supply_chain(
            artifact(packages=[{"purl": "pkg:npm/a@1", "name": "a", "version": "1",
                                "ecosystem": "npm", "source": "retirejs"}]), "u1", "p1")
        _, kw = next((q, k) for q, k in sess.queries if "MERGE (p:Package" in q)
        self.assertIn("osv", kw["overridable"])
        self.assertIn("sourcemap", kw["overridable"])


class TestUploadedSbomIsNotAnIsland(unittest.TestCase):
    """REGRESSION: uploaded packages had no parent and floated.

    A repo scan anchors to GithubRepository and a recon scan to BaseURL, but an
    UPLOAD passed anchor_label=None - so every package it produced, plus all
    of their Vulnerability nodes, sat in the graph reachable from nothing.
    Observed live: 4 PyPI packages and 68 vulnerabilities as a disconnected
    island after uploading requirements.txt.

    GRAPH.SCHEMA.md states the opposite rule outright ("No Isolated Nodes"),
    and the inconsistency was visible the moment repo scans started anchoring.
    The file itself is the honest parent: it is what the operator supplied and
    what the packages were read out of.
    """

    def test_sbom_document_id_is_tenant_scoped(self):
        sess = FakeSession()
        doc_id = Writer(sess).ensure_sbom_document("u1", "p1", "requirements.txt")
        self.assertEqual(doc_id, "sbom-u1-p1-requirements.txt")
        q, kw = sess.queries[0]
        self.assertIn("MERGE (d:SbomDocument", q)
        self.assertEqual((kw["uid"], kw["pid"], kw["name"]),
                         ("u1", "p1", "requirements.txt"))

    def test_two_projects_do_not_share_one_document_node(self):
        w = Writer(FakeSession())
        self.assertNotEqual(w.ensure_sbom_document("u1", "p1", "bom.cdx.json"),
                            w.ensure_sbom_document("u1", "p2", "bom.cdx.json"))

    def test_each_upload_gets_its_own_node(self):
        """Recovers information that was lost: every upload used to collapse
        into an indistinguishable pile of source='osv' packages."""
        w = Writer(FakeSession())
        self.assertNotEqual(w.ensure_sbom_document("u1", "p1", "yarn.lock"),
                            w.ensure_sbom_document("u1", "p1", "bom.spdx.json"))

    def test_sbom_document_is_an_accepted_anchor(self):
        sess = FakeSession()
        stats = Writer(sess).update_graph_from_supply_chain(
            artifact(packages=[{"purl": "pkg:pypi/flask@0.12.2", "name": "flask",
                                "version": "0.12.2", "ecosystem": "PyPI",
                                "source": "osv"}]),
            "u1", "p1", anchor_label="SbomDocument", anchor_key="id",
            anchor_value="sbom-u1-p1-requirements.txt")
        self.assertEqual(stats["relationships_created"], 1)
        self.assertTrue(any("DEPENDS_ON" in q for q, _ in sess.queries))

    def test_unknown_anchor_labels_are_still_rejected(self):
        """The label is interpolated into Cypher, so widening the whitelist
        must not widen it to anything."""
        w = Writer(FakeSession())
        with self.assertRaises(ValueError):
            w.update_graph_from_supply_chain(
                artifact(), "u1", "p1", anchor_label="Evil",
                anchor_key="id", anchor_value="x")

    def test_trusted_l1_ingest_anchors_uploads(self):
        """Uploaded SBOMs stay anchored after ingest moved to the orchestrator."""
        src = open(os.path.join(_REPO, "recon_orchestrator", "container_manager.py")).read()
        ingest = src.split("def _ingest_supply_chain(", 1)[1].split(
            "\n    async def pause_supply_chain(", 1)[0]
        code = "\n".join(l for l in ingest.splitlines()
                          if not l.lstrip().startswith("#"))
        self.assertIn("ensure_sbom_document", code)
        self.assertIn('anchor_label = "SbomDocument"', code)
        self.assertIn("ensure_github_repository", code)
        self.assertIn('anchor_label = "GithubRepository"', code)


class TestAnchorsReachTheDomain(unittest.TestCase):
    """Anchoring packages to a file/repo stopped them floating individually,
    but the ANCHOR itself was still parentless - so an L1 scan rendered as one
    detached island hanging off nothing. A GitHub Secret Hunt does not have
    this problem because it links Domain -[:HAS_GITHUB_HUNT]-> GithubHunt.
    These cover the same link for the two supply-chain anchors.
    """

    def _domain_query(self, sess):
        for q, kw in sess.queries:
            if "MERGE (dom)" in q:
                return q, kw
        return None, None

    def test_sbom_document_is_linked_to_the_project_domain(self):
        sess = FakeSession()
        Writer(sess).ensure_sbom_document("u1", "p1", "requirements.txt")
        q, kw = self._domain_query(sess)
        self.assertIsNotNone(q, "no Domain link was attempted")
        self.assertIn("MATCH (dom:Domain", q)
        self.assertIn("(dom)-[:HAS_SBOM_DOCUMENT]->(n)", q)
        self.assertEqual((kw["uid"], kw["pid"], kw["nid"]),
                         ("u1", "p1", "sbom-u1-p1-requirements.txt"))

    def test_github_repository_is_linked_to_the_project_domain(self):
        sess = FakeSession()
        Writer(sess).ensure_github_repository("u1", "p1", "acme/app")
        q, kw = self._domain_query(sess)
        self.assertIsNotNone(q, "no Domain link was attempted")
        self.assertIn("(dom)-[:HAS_REPOSITORY]->(n)", q)
        self.assertEqual(kw["nid"], "github-repo-u1-p1-acme/app")

    def test_the_link_is_tenant_scoped(self):
        """A Domain from another project must never adopt this anchor."""
        sess = FakeSession()
        Writer(sess).ensure_sbom_document("u1", "p1", "yarn.lock")
        q, _ = self._domain_query(sess)
        self.assertIn("user_id: $uid", q)
        self.assertIn("project_id: $pid", q)

    def test_a_project_with_no_domain_still_returns_the_anchor_id(self):
        """An SBOM upload can be the FIRST thing done in a project, before any
        recon has created a Domain. That must not fail the scan or lose the
        anchor - the packages are still correctly parented to the file.
        """
        sess = FakeSession(domain_exists=False)
        doc_id = Writer(sess).ensure_sbom_document("u1", "p1", "requirements.txt")
        self.assertEqual(doc_id, "sbom-u1-p1-requirements.txt")

    def test_a_failing_domain_link_does_not_break_the_anchor(self):
        """The graph write is still correct without the Domain edge, so a
        driver error there must not propagate and kill the whole scan."""
        class Boom(FakeSession):
            def run(self, query, **kwargs):
                if "MERGE (dom)" in query:
                    raise RuntimeError("neo4j is unhappy")
                return super().run(query, **kwargs)

        repo_id = Writer(Boom()).ensure_github_repository("u1", "p1", "acme/app")
        self.assertEqual(repo_id, "github-repo-u1-p1-acme/app")

    def test_link_reports_whether_a_domain_was_actually_found(self):
        """The return value is the only signal that an anchor stayed a root.
        Hardcoding True would make a project with no Domain indistinguishable
        from a linked one."""
        w = Writer(FakeSession())
        self.assertTrue(w._link_anchor_to_domain(
            FakeSession(), "u1", "p1", "SbomDocument", "d1", "HAS_SBOM_DOCUMENT"))
        self.assertFalse(w._link_anchor_to_domain(
            FakeSession(domain_exists=False), "u1", "p1",
            "SbomDocument", "d1", "HAS_SBOM_DOCUMENT"))

    def test_anchor_node_is_created_before_the_domain_link(self):
        """MATCH (n:Label {id}) finds nothing if the MERGE has not run yet, so
        ordering is load-bearing, not cosmetic."""
        sess = FakeSession()
        Writer(sess).ensure_sbom_document("u1", "p1", "requirements.txt")
        merge_at = next(i for i, (q, _) in enumerate(sess.queries)
                        if "MERGE (d:SbomDocument" in q)
        link_at = next(i for i, (q, _) in enumerate(sess.queries)
                       if "MERGE (dom)" in q)
        self.assertLess(merge_at, link_at)


if __name__ == "__main__":
    unittest.main()
