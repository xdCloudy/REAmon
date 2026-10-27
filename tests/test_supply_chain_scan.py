"""Unit tests for the L1 CLEAN scan runner + shared artifact assembly.

No binaries: the osv runner is injected/mocked. Focuses on input-path safety
(S7), mode selection, artifact assembly, ecosystem filtering, and that the
runner always returns a boundary-valid artifact.

Run: python -m unittest tests.test_supply_chain_scan
"""

import json
import os
import sys
import stat
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)
_SCANNERS = os.path.join(_REPO, "scanners")
if _SCANNERS not in sys.path:
    sys.path.insert(0, _SCANNERS)

from supply_chain_common.artifact import (
    empty_artifact, add_osv_findings, add_guarddog_findings, osv_mode_for_path,
)
from supply_chain_common.security import validate_artifact
from supply_chain_scan.supply_chain_runner import (
    SupplyChainRunner, resolve_input_path, SupplyChainInputError,
)
from supply_chain_scan.main import save_scan_artifact


class _FakeOsv:
    def __init__(self, parsed, error=None):
        self._parsed = parsed
        self._error = error
        self.calls = []

    def run_osv_scan(self, target, *, mode, db_path):
        self.calls.append((target, mode, db_path))
        return {"raw": {}, "parsed": self._parsed, "exit_code": 1,
                "error": self._error}


class TestArtifactHelpers(unittest.TestCase):
    def test_empty_artifact_mode_normalized(self):
        self.assertEqual(empty_artifact("lockfile")["mode"], "lockfile")
        self.assertIsNone(empty_artifact("bogus")["mode"])

    def test_add_osv_findings_splits(self):
        art = empty_artifact("lockfile")
        add_osv_findings(art, {
            "packages": [{"purl": "pkg:npm/x@1", "name": "x", "version": "1",
                          "ecosystem": "npm"}],
            "malicious": [{"purl": "pkg:npm/x@1", "name": "x",
                           "advisory_id": "MAL-1", "ecosystem": "npm"}],
            "vulnerable": [{"purl": "pkg:npm/x@1", "name": "x",
                            "advisory_id": "CVE-1", "ecosystem": "npm"}]})
        self.assertEqual(len(art["packages"]), 1)
        self.assertEqual(art["malicious"][0]["confidence"], "malicious")
        self.assertEqual(art["vulnerable"][0]["confidence"], "suspicious")
        validate_artifact(art)  # must stay boundary-valid

    def test_cvss_vector_survives_to_the_graph_writer(self):
        # osv_runner.cvss_vector_for_vuln extracted this and add_osv_findings
        # dropped it, so Vulnerability.cvss_metrics was always null even though
        # the writer asks for the field.
        art = empty_artifact("lockfile")
        add_osv_findings(art, {
            "packages": [],
            "malicious": [],
            "vulnerable": [{"purl": "pkg:npm/x@1", "name": "x", "ecosystem": "npm",
                            "advisory_id": "GHSA-1",
                            "cvss_vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}]})
        self.assertEqual(art["vulnerable"][0]["cvss_vector"],
                         "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")
        # The vector contains '/' and ':' - it must clear the boundary gate as
        # capped free text, not be rejected as a hostile structured field.
        clean = validate_artifact(art)
        self.assertEqual(clean["vulnerable"][0]["cvss_vector"],
                         "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")

    def test_completed_run_artifact_is_atomically_published(self):
        with tempfile.TemporaryDirectory() as directory:
            out = os.path.join(directory, "supply_chain_project.json")
            with open(out, "w", encoding="utf-8") as fh:
                fh.write('{"run_id":"previous"}')
            payload = {"project_id": "project", "user_id": "owner",
                       "run_id": "current", "artifact": {"packages": []}}

            actual = save_scan_artifact(directory, "project", payload)

            self.assertEqual(actual, out)
            with open(out, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), payload)
            self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o644)
            self.assertEqual(os.listdir(directory), ["supply_chain_project.json"])

    def test_osv_mode_for_path(self):
        self.assertEqual(osv_mode_for_path("/x/package-lock.json"), "lockfile")
        self.assertEqual(osv_mode_for_path("/x/bom.cdx.json"), "sbom")
        self.assertEqual(osv_mode_for_path("/x/anything", is_dir=True), "dir")


class TestResolveInputPath(unittest.TestCase):
    def test_rejects_traversal_and_abs(self):
        for bad in ["../etc/passwd", "/etc/passwd", "a/b.json"]:
            with self.assertRaises(SupplyChainInputError):
                resolve_input_path("/uploads", bad)

    def test_rejects_bad_extension(self):
        with self.assertRaises(SupplyChainInputError):
            resolve_input_path("/uploads", "evil.sh")

    def test_missing_file(self):
        with self.assertRaises(SupplyChainInputError):
            resolve_input_path("/uploads", "package-lock.json")

    def test_accepts_valid_upload(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "package-lock.json")
            with open(p, "w") as fh:
                fh.write("{}")
            self.assertEqual(resolve_input_path(d, "package-lock.json"), p)


class TestRunner(unittest.TestCase):
    def _uploads_with(self, name="package-lock.json"):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, name), "w") as fh:
            fh.write("{}")
        return d

    def test_runs_and_reports_malicious(self):
        d = self._uploads_with()
        fake = _FakeOsv({
            "packages": [{"purl": "pkg:npm/lodahs@1", "name": "lodahs",
                          "version": "1", "ecosystem": "npm"}],
            "malicious": [{"purl": "pkg:npm/lodahs@1", "name": "lodahs",
                           "advisory_id": "MAL-1", "ecosystem": "npm"}],
            "vulnerable": []})
        r = SupplyChainRunner(uploads_dir=d, sbom_file="package-lock.json",
                              db_path="/osv-db", project_id="p", osv=fake)
        art = r.run()
        self.assertEqual(r.stats["packages"], 1)
        self.assertEqual(r.stats["malicious"], 1)
        self.assertEqual(fake.calls[0][1], "lockfile")

    def test_missing_input_yields_valid_error_artifact(self):
        r = SupplyChainRunner(uploads_dir="/nope", sbom_file="",
                              db_path="/osv-db", project_id="p", osv=_FakeOsv({}))
        art = r.run()
        self.assertTrue(art["errors"])  # boundary-valid artifact with an error
        self.assertEqual(art["packages"], [])

    def test_ecosystem_filter(self):
        d = self._uploads_with()
        fake = _FakeOsv({
            "packages": [{"purl": "pkg:npm/a@1", "name": "a", "ecosystem": "npm"},
                         {"purl": "pkg:pypi/b@1", "name": "b", "ecosystem": "PyPI"}],
            "malicious": [], "vulnerable": []})
        r = SupplyChainRunner(uploads_dir=d, sbom_file="package-lock.json",
                              db_path="/osv-db", project_id="p",
                              ecosystems=["npm"], osv=fake)
        art = r.run()
        self.assertEqual(len(art["packages"]), 1)
        self.assertEqual(art["packages"][0]["ecosystem"], "npm")


if __name__ == "__main__":
    unittest.main()
