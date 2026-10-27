"""Call-site tests for incident enrichment (B) in L1 and L2.

The single thing that can silently break B is ORDERING. Enrichment must run
AFTER the last validate_artifact, because the incident_* properties are
deliberately absent from the artifact allowlist. Get it backwards and either
the artifact fails validation (loud) or, worse, someone "fixes" it by widening
the allowlist, which reopens the DIRTY->CLEAN boundary to those fields coming
from the analyzer itself.

These tests read the source of both call sites and assert the order, because the
alternative is executing a whole scan.

Run: python -m unittest tests.test_sca_intel_callsites
"""

import os
import re
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_L1 = os.path.join(_REPO, "scanners", "supply_chain_scan", "main.py")
_ORCHESTRATOR = os.path.join(_REPO, "recon_orchestrator", "container_manager.py")
_L2 = os.path.join(_REPO, "recon", "main_recon_modules", "supply_chain_recon.py")


def _read(path):
    with open(path) as fh:
        return fh.read()


class TestEnrichmentOrdering(unittest.TestCase):

    def _assert_enrich_after_last_validate(self, path, label):
        src = _read(path)
        enrich = [m.start() for m in re.finditer(r"enrich_findings\(", src)]
        validate = [m.start() for m in re.finditer(r"validate_artifact\(", src)]
        self.assertTrue(enrich, "{}: enrich_findings is not called".format(label))
        self.assertTrue(validate, "{}: validate_artifact is not called".format(label))
        self.assertGreater(
            min(enrich), max(validate),
            "{}: enrichment must run AFTER the last validate_artifact; the "
            "incident_* fields are not on the artifact allowlist".format(label))

    def test_l1_enriches_after_the_last_validation(self):
        self._assert_enrich_after_last_validate(_L1, "L1 supply_chain_scan/main.py")

    def test_l2_enriches_after_the_last_validation(self):
        self._assert_enrich_after_last_validate(_L2, "L2 supply_chain_recon.py")

    def test_l1_enriches_before_publishing_the_artifact(self):
        src = _read(_L1)
        enrich = src.index("enrich_findings(")
        publish = src.index("save_scan_artifact(output_dir, project_id, payload)")
        self.assertLess(enrich, publish,
                        "L1 must enrich before publishing or incident properties "
                        "will not reach the trusted ingest")

    def test_l1_trusted_ingest_checks_run_identity_before_graph_write(self):
        src = _read(_ORCHESTRATOR)
        ingest = src.split("def _ingest_supply_chain(", 1)[1].split(
            "\n    async def pause_supply_chain(", 1)[0]
        identity_check = ingest.index('data.get("run_id") != state.run_id')
        graph_write = ingest.index("update_graph_from_supply_chain(")
        self.assertLess(identity_check, graph_write,
                        "L1 must reject stale artifacts before writing graph data")

    def test_l2_enriches_before_the_result_is_built(self):
        src = _read(_L2)
        enrich = src.index("enrich_findings(")
        built = src.index('combined_result["supply_chain_recon"]')
        self.assertLess(enrich, built,
                        "L2 must enrich before the combined result is assembled")


class TestEnrichmentIsNonFatal(unittest.TestCase):
    """A missing or broken intel volume must never fail a scan (C7)."""

    def _assert_guarded(self, path, label):
        src = _read(path)
        idx = src.index("enrich_findings(")
        window = src[max(0, idx - 600):idx]
        self.assertIn("try:", window,
                      "{}: the enrichment call is not inside a try block".format(label))
        after = src[idx:idx + 800]
        self.assertIn("except Exception", after,
                      "{}: the enrichment call has no broad except".format(label))

    def test_l1_enrichment_is_guarded(self):
        self._assert_guarded(_L1, "L1")

    def test_l2_enrichment_is_guarded(self):
        self._assert_guarded(_L2, "L2")

    def _assert_records_unavailable(self, path, label):
        src = _read(path)
        idx = src.index("enrich_findings(")
        after = src[idx:idx + 800]
        self.assertIn("available", after,
                      "{}: an unavailable catalog must be recorded, never read "
                      "as a clean result (C7)".format(label))

    def test_l1_records_an_unavailable_catalog(self):
        self._assert_records_unavailable(_L1, "L1")

    def test_l2_records_an_unavailable_catalog(self):
        self._assert_records_unavailable(_L2, "L2")


class TestIncidentFieldsStayOffTheAllowlist(unittest.TestCase):

    def test_allowlist_does_not_accept_incident_fields(self):
        """The boundary must not accept these FROM the analyzer.

        They are added later, in the clean zone, from a trusted local file. If
        they ever appear in _FINDING_FIELDS, a compromised analyzer could inject
        arbitrary incident text straight into the graph and the agent prompt.
        """
        import sys

        sys.path.insert(0, os.path.join(_REPO, "scanners"))
        from supply_chain_common.security import _FINDING_FIELDS
        from supply_chain_common.intel import INCIDENT_FIELDS

        overlap = set(INCIDENT_FIELDS) & set(_FINDING_FIELDS)
        self.assertEqual(overlap, set(),
                         "incident fields leaked onto the artifact allowlist: "
                         "{}".format(overlap))


if __name__ == "__main__":
    unittest.main()
