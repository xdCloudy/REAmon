"""Partial Nuclei, SecurityChecks, SubdomainTakeover, VhostSni, OriginDiscovery
over several roots.

Each hands every root and its group scope to the vuln-scan builder, validates a
custom subdomain against any root, and attaches a user subdomain to its OWN
root's Domain (a generic IP/URL UserInput to the first root, whose Domain node
exists in a batch).

Fixture roots are alpha.test / beta.test / gamma.test only.
"""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from recon.partial_recon_modules import origin_enrichment, vulnerability_scanning  # noqa: E402

ROOTS = ["alpha.test", "beta.test", "gamma.test"]
GROUPS = [{"rootDomain": r, "prefixes": ["*"], "batch": True} for r in ROOTS]
BASE = {"_settings": {}, "domains": ROOTS, "domain": ROOTS[0], "domain_groups": GROUPS}


def _empty_recon(roots):
    return {
        "domain": roots[0], "domains": roots, "subdomains": [],
        "dns": {"domain": {"ips": {"ipv4": [], "ipv6": []}, "has_records": False}, "subdomains": {}},
        "http_probe": {"by_url": {}, "by_host": {}, "live_urls": []},
        "port_scan": {"by_ip": {}, "by_host": {}},
        "resource_enum": {"by_base_url": {}, "discovered_urls": []},
        "metadata": {"include_root_domain": False},
    }


class _Session:
    def __init__(self, calls, matched=1):
        self.calls = calls
        self._matched = matched

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def run(self, query, **params):
        self.calls.append((query, params))
        result = MagicMock()
        result.single.return_value = {"matched": self._matched, "name": "x", "url": "x"}
        result.__iter__ = lambda s: iter([])
        return result


@pytest.fixture
def graph(monkeypatch):
    calls = []
    client = MagicMock()
    client.verify_connection.return_value = True
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    client.driver.session.side_effect = lambda: _Session(calls)
    for m in ("update_graph_from_vuln_scan", "update_graph_from_subdomain_takeover",
              "update_graph_from_vhost_sni", "update_graph_from_origin_discovery"):
        getattr(client, m).return_value = {}
    module = MagicMock()
    module.Neo4jClient.return_value = client
    monkeypatch.setitem(sys.modules, "graph_db", module)
    return calls, client


def _sub_domain_links(calls):
    return {p["sub"]: p["domain"] for q, p in calls
            if "MERGE (d)-[:HAS_SUBDOMAIN]->(s)" in q and "sub" in p and "domain" in p}


def _userinput_domains(calls):
    return [p["domain"] for q, p in calls
            if "MERGE (d)-[:HAS_USER_INPUT]->(ui)" in q]


class TestNuclei:
    def test_builder_gets_every_root(self, graph, monkeypatch):
        builder = MagicMock(side_effect=lambda roots, *a, **kw: _empty_recon(roots))
        monkeypatch.setattr(vulnerability_scanning, "_build_vuln_scan_data_from_graph", builder)
        with patch("recon.main_recon_modules.vuln_scan.run_vuln_scan",
                   side_effect=lambda rd, settings=None: rd):
            with pytest.raises(SystemExit):   # empty graph, no user URLs
                vulnerability_scanning.run_nuclei(dict(BASE))
        assert builder.call_args.args[0] == ROOTS
        assert builder.call_args.kwargs["domain_groups"] == GROUPS

    def test_a_generic_user_url_input_hangs_off_the_first_root(self, graph, monkeypatch):
        calls, _ = graph
        builder = MagicMock(side_effect=lambda roots, *a, **kw: _empty_recon(roots))
        monkeypatch.setattr(vulnerability_scanning, "_build_vuln_scan_data_from_graph", builder)
        with patch("recon.main_recon_modules.vuln_scan.run_vuln_scan",
                   side_effect=lambda rd, settings=None: rd), \
             patch("recon.main_recon_modules.add_mitre.run_mitre_enrichment",
                   side_effect=lambda rd, settings=None: rd):
            vulnerability_scanning.run_nuclei({**BASE, "user_targets": {
                "urls": ["https://custom.example/x"], "url_attach_to": None}})
        assert _userinput_domains(calls) == ["alpha.test"]


class TestSubdomainTakeover:
    def test_a_user_subdomain_attaches_to_its_own_root(self, graph, monkeypatch):
        calls, _ = graph
        monkeypatch.setattr(vulnerability_scanning, "_build_vuln_scan_data_from_graph",
                            MagicMock(side_effect=lambda roots, *a, **kw: _empty_recon(roots)))
        monkeypatch.setattr(vulnerability_scanning, "_resolve_hostname",
                            lambda h: {"ipv4": ["10.0.0.9"], "ipv6": []})
        with patch("recon.main_recon_modules.subdomain_takeover.run_subdomain_takeover",
                   side_effect=lambda rd, settings=None: rd.setdefault("subdomain_takeover", {"findings": [], "summary": {}})):
            vulnerability_scanning.run_subdomain_takeover_partial({**BASE, "user_targets": {
                "subdomains": ["takeover.beta.test", "x.gamma.test"]}})
        assert _sub_domain_links(calls) == {"takeover.beta.test": "beta.test", "x.gamma.test": "gamma.test"}

    def test_isolated_worker_fetches_inputs_and_ingests_through_signed_orchestrator(self, graph, monkeypatch):
        _, client = graph
        recon = _empty_recon(ROOTS)
        recon["subdomains"] = ["graph.alpha.test"]
        requests = []

        def request_graph(url, token, payload):
            requests.append((url, token, payload))
            if url.endswith("takeover-inputs"):
                return {"run_id": "run-1", "recon_data": recon}
            return {"run_id": "run-1", "stats": {"takeover": {"vulnerabilities_created": 1}}}

        monkeypatch.setattr(vulnerability_scanning, "_request_partial_takeover_graph", request_graph)
        monkeypatch.setenv("PARTIAL_TAKEOVER_INPUTS_URL", "http://127.0.0.1/takeover-inputs")
        monkeypatch.setenv("PARTIAL_TAKEOVER_INGEST_URL", "http://127.0.0.1/takeover-ingest")
        monkeypatch.setenv("PARTIAL_GRAPH_INGEST_TOKEN", "signed-run-token")
        monkeypatch.setenv("PARTIAL_RECON_RUN_ID", "run-1")
        with patch("recon.main_recon_modules.subdomain_takeover.run_subdomain_takeover",
                   side_effect=lambda data, settings=None: data.update({
                       "subdomain_takeover": {"findings": [{
                           "id": "finding-1", "hostname": "graph.alpha.test",
                       }], "summary": {"count": 1}},
                   })):
            vulnerability_scanning.run_subdomain_takeover_partial(dict(BASE))

        assert [url for url, _, _ in requests] == [
            "http://127.0.0.1/takeover-inputs", "http://127.0.0.1/takeover-ingest",
        ]
        assert all(token == "signed-run-token" for _, token, _ in requests)
        assert requests[0][2]["domain_groups"] == GROUPS
        assert requests[1][2]["findings"][0]["hostname"] == "graph.alpha.test"
        client.verify_connection.assert_not_called()

    def test_a_subdomain_under_no_root_is_rejected(self, graph, monkeypatch, capsys):
        monkeypatch.setattr(vulnerability_scanning, "_build_vuln_scan_data_from_graph",
                            MagicMock(side_effect=lambda roots, *a, **kw: _empty_recon(roots)))
        monkeypatch.setattr(vulnerability_scanning, "_resolve_hostname",
                            lambda h: {"ipv4": ["10.0.0.9"], "ipv6": []})
        with patch("recon.main_recon_modules.subdomain_takeover.run_subdomain_takeover",
                   side_effect=lambda rd, settings=None: rd.setdefault("subdomain_takeover", {"findings": [], "summary": {}})):
            # The one out-of-scope host is skipped, leaving nothing to scan (exit 1).
            with pytest.raises(SystemExit):
                vulnerability_scanning.run_subdomain_takeover_partial({**BASE, "user_targets": {
                    "subdomains": ["x.other.example"]}})
        assert "out-of-scope subdomain: x.other.example" in capsys.readouterr().out


class TestVhostSni:
    def test_builder_gets_every_root_and_a_user_sub_attaches_to_its_root(self, graph, monkeypatch):
        calls, _ = graph
        builder = MagicMock(side_effect=lambda roots, *a, **kw: _empty_recon(roots))
        monkeypatch.setattr(vulnerability_scanning, "_build_vuln_scan_data_from_graph", builder)
        monkeypatch.setattr(vulnerability_scanning, "_resolve_hostname",
                            lambda h: {"ipv4": ["10.0.0.9"], "ipv6": []})
        with patch("recon.main_recon_modules.vhost_sni_enum.run_vhost_sni_enrichment",
                   side_effect=lambda rd, settings=None: rd.setdefault("vhost_sni", {"findings": [], "summary": {}})):
            vulnerability_scanning.run_vhost_sni_partial({**BASE, "user_targets": {
                "subdomains": ["vhost.gamma.test"], "ips": []}})
        assert builder.call_args.args[0] == ROOTS
        assert _sub_domain_links(calls).get("vhost.gamma.test") == "gamma.test"


class TestSecurityChecks:
    def test_builder_gets_every_root(self, graph, monkeypatch):
        builder = MagicMock(side_effect=lambda roots, *a, **kw: _empty_recon(roots))
        monkeypatch.setattr(vulnerability_scanning, "_build_vuln_scan_data_from_graph", builder)
        with patch("recon.helpers.run_security_checks",
                   side_effect=lambda **kw: {"security_checks": {"findings": []}}):
            with pytest.raises(SystemExit):   # empty graph, no custom targets
                vulnerability_scanning.run_security_checks_partial(dict(BASE))
        assert builder.call_args.args[0] == ROOTS
        assert builder.call_args.kwargs["domain_groups"] == GROUPS

    @pytest.mark.parametrize("batch_mode", [True, False])
    def test_the_write_says_whether_the_run_is_a_batch(self, graph, monkeypatch, batch_mode):
        # The writer keys a domain-level finding (SPF...) on its root only in a batch.
        _, client = graph
        recon = _empty_recon(ROOTS)
        recon["dns"]["subdomains"] = {"api.beta.test": {"ips": {"ipv4": ["10.0.2.1"], "ipv6": []},
                                                        "has_records": True}}
        monkeypatch.setattr(vulnerability_scanning, "_build_vuln_scan_data_from_graph",
                            MagicMock(return_value=recon))
        with patch("recon.helpers.run_security_checks",
                   side_effect=lambda **kw: {"security_checks": {"findings": []}}):
            vulnerability_scanning.run_security_checks_partial({**BASE, "batch_mode": batch_mode})
        written = client.update_graph_from_vuln_scan.call_args.kwargs["recon_data"]
        assert written["metadata"]["domain_batch"] is batch_mode


class TestOriginDiscovery:
    def test_builder_and_fronted_query_cover_every_root(self, graph, monkeypatch):
        calls, _ = graph
        builder = MagicMock(side_effect=lambda roots, *a, **kw: _empty_recon(roots))
        monkeypatch.setattr(origin_enrichment, "_build_vuln_scan_data_from_graph", builder)
        with patch("recon.main_recon_modules.origin_discovery.run_origin_discovery_enrichment",
                   side_effect=lambda rd, settings=None: rd):
            origin_enrichment.run_origin_discovery(dict(BASE))
        assert builder.call_args.args[0] == ROOTS
        # The fronted-host query is scoped to the run's roots.
        fronted = [p for q, p in calls if "ci.is_cdn = true" in q]
        assert fronted and fronted[0]["domains"] == ROOTS

    def test_a_user_subdomain_under_any_root_is_accepted(self, graph, monkeypatch):
        monkeypatch.setattr(origin_enrichment, "_build_vuln_scan_data_from_graph",
                            MagicMock(side_effect=lambda roots, *a, **kw: _empty_recon(roots)))
        monkeypatch.setattr(origin_enrichment, "_resolve_hostname",
                            lambda h: {"ipv4": ["10.0.0.9"], "ipv6": []})
        captured = {}
        with patch("recon.main_recon_modules.origin_discovery.run_origin_discovery_enrichment",
                   side_effect=lambda rd, settings=None: captured.update(rd) or rd):
            origin_enrichment.run_origin_discovery({**BASE, "user_targets": {
                "subdomains": ["fronted.beta.test", "x.other.example"]}})
        hosts = {v.get("host") for v in captured["http_probe"]["by_url"].values()}
        assert "fronted.beta.test" in hosts and "x.other.example" not in hosts


# --- regressions from the deep review -------------------------------------------------

class _RowsSession(_Session):
    """A session whose reads return rows chosen per query."""

    def __init__(self, calls, rows_for):
        super().__init__(calls)
        self._rows_for = rows_for

    def run(self, query, **params):
        self.calls.append((query, params))
        result = MagicMock()
        rows = self._rows_for(query)
        result.__iter__ = lambda s: iter(rows)
        result.single.return_value = rows[0] if rows else {"matched": 1}
        return result


class TestOriginDiscoveryLiteralGroup:
    def test_origin_discovery_does_not_probe_a_literal_groups_unlisted_fronted_host(self, graph, monkeypatch):
        """Bug: the CDN-fronted host injection read every Subdomain under the run's
        roots, so a host another writer hung under a LITERAL group was probed."""
        calls, client = graph
        groups = [
            {"rootDomain": "alpha.test", "prefixes": ["*"], "batch": True},
            {"rootDomain": "beta.test", "prefixes": ["www."], "batch": True},   # literal
            {"rootDomain": "gamma.test", "prefixes": ["*"], "batch": True},
        ]

        def rows(query):
            if "ci.is_cdn = true" in query:
                return [
                    {"root": "beta.test", "host": "cdn-x.beta.test", "favicon": None, "cdn": "c", "ip": "10.0.2.9"},
                    {"root": "beta.test", "host": "www.beta.test", "favicon": None, "cdn": "c", "ip": "10.0.2.8"},
                    {"root": "gamma.test", "host": "edge.gamma.test", "favicon": None, "cdn": "c", "ip": "10.0.3.9"},
                ]
            return []

        client.driver.session.side_effect = lambda: _RowsSession(calls, rows)
        monkeypatch.setattr(origin_enrichment, "_build_vuln_scan_data_from_graph",
                            MagicMock(side_effect=lambda roots, *a, **kw: _empty_recon(roots)))
        captured = {}
        with patch("recon.main_recon_modules.origin_discovery.run_origin_discovery_enrichment",
                   side_effect=lambda rd, settings=None: captured.update(rd) or rd):
            origin_enrichment.run_origin_discovery({**BASE, "domain_groups": groups})
        hosts = {v.get("host") for v in captured["http_probe"]["by_url"].values()}
        assert "cdn-x.beta.test" not in hosts                      # unlisted in a literal group
        assert {"www.beta.test", "edge.gamma.test"} <= hosts        # listed, and a wildcard root


class TestNucleiBatchMarker:
    @pytest.mark.parametrize("batch_mode", [True, False])
    def test_nuclei_marks_a_batch_run_for_domain_level_findings(self, graph, monkeypatch, batch_mode):
        """Bug: run_vuln_scan runs the DNS security checks once per root, but only
        partial SecurityChecks stamped metadata.domain_batch, so a partial Nuclei
        run wrote every root's SPF/DMARC finding into one Vulnerability node."""
        recon = _empty_recon(ROOTS)
        recon["http_probe"]["by_url"] = {"https://api.beta.test": {"url": "https://api.beta.test",
                                                                   "host": "api.beta.test", "status_code": 200}}
        monkeypatch.setattr(vulnerability_scanning, "_build_vuln_scan_data_from_graph",
                            MagicMock(return_value=recon))
        seen = {}
        with patch("recon.main_recon_modules.vuln_scan.run_vuln_scan",
                   side_effect=lambda rd, settings=None: seen.update(rd) or rd), \
             patch("recon.main_recon_modules.add_mitre.run_mitre_enrichment",
                   side_effect=lambda rd, settings=None: rd):
            vulnerability_scanning.run_nuclei({**BASE, "batch_mode": batch_mode})
        assert seen["metadata"]["domain_batch"] is batch_mode
