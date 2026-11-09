"""Partial-recon graph builders over several project roots.

Every builder used to MATCH one Domain by name, so a Domain-batch project fed a
partial run the targets of one arbitrary root. They now take the run's roots and
each root's group scope:

  - every root's Subdomains are loaded;
  - a root's apex is a target only when its group includes it ('.' prefix);
  - a LITERAL batch group loads only its listed hosts. Writers hang other names
    under a root (certificate SANs, urlscan), and a literal group's contract is
    "scan exactly what was uploaded";
  - a wildcard group, and a single-domain project, keep every Subdomain.

The fake graph applies the same `IN $list` filters Neo4j would, so a builder that
passes the wrong list loads the wrong rows here too.

Fixture roots are alpha.test / beta.test / gamma.test only.
"""
import sys
from pathlib import Path
from unittest import mock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from recon.partial_recon_modules import graph_builders as gb  # noqa: E402

APEX_IPS = {"alpha.test": "10.0.0.1", "beta.test": "10.0.0.2", "gamma.test": "10.0.0.3"}
SUBDOMAINS = [
    # (root, subdomain, ip)
    ("alpha.test", "www.alpha.test", "10.0.1.1"),
    ("alpha.test", "san-only.alpha.test", "10.0.1.2"),   # hung there by a writer
    ("beta.test", "api.beta.test", "10.0.2.1"),
    ("beta.test", "san-only.beta.test", "10.0.2.2"),
    ("gamma.test", "mail.gamma.test", "10.0.3.1"),
    ("old.test", "www.old.test", "10.0.9.1"),             # a stale root's host
]
PORTS = {"10.0.0.1": [443], "10.0.0.2": [8443], "10.0.1.1": [443, 993], "10.0.2.1": [443]}

# alpha: literal, www + apex. beta: wildcard. gamma: wildcard + apex.
GROUPS = [
    {"rootDomain": "alpha.test", "prefixes": ["www.", "."], "batch": True},
    {"rootDomain": "beta.test", "prefixes": ["*"], "batch": True},
    {"rootDomain": "gamma.test", "prefixes": ["*", "."], "batch": True},
]


def _ports(ip):
    nums = PORTS.get(ip)
    if not nums:
        return [{"number": None, "protocol": None}]
    return [{"number": n, "protocol": "tcp"} for n in nums]


BASEURLS = [
    # (url, host)
    ("https://www.alpha.test", "www.alpha.test"),
    ("https://san-only.alpha.test", "san-only.alpha.test"),   # literal group never listed it
    ("https://alpha.test", "alpha.test"),                     # apex, included
    ("https://beta.test", "beta.test"),                       # apex, excluded
    ("https://api.beta.test:8443", ""),                       # host only in the URL
    ("https://www.old.test", "www.old.test"),                 # a stale root's host
    ("http://10.0.9.9:8080", "10.0.9.9"),                     # an IP: under no root
    ("https://cdn.thirdparty.example", "cdn.thirdparty.example"),
]
GRAPH_DOMAINS = ["alpha.test", "beta.test", "gamma.test", "old.test"]


class _Result(list):
    def single(self):
        return self[0] if self else None


class _Session:
    def __init__(self, calls):
        self.calls = calls

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def run(self, cypher, **params):
        self.calls.append((cypher, params))
        rows = _Result()
        if "collect(DISTINCT s.name)" in cypher:
            rows.append({"subdomains": [sub for root, sub, _ in SUBDOMAINS if root in params["domains"]]})
        elif "HAS_SUBDOMAIN" in cypher:
            for root, sub, ip in SUBDOMAINS:
                if root in params["domains"]:
                    rows.append({"root": root, "subdomain": sub, "address": ip, "ip": ip,
                                 "version": "ipv4", "ports": _ports(ip),
                                 "is_cdn": None, "cdn_name": None, "asn": None})
        elif "RESOLVES_TO" in cypher:
            for root in params["apex_roots"]:
                ip = APEX_IPS[root]
                rows.append({"root": root, "address": ip, "ip": ip, "version": "ipv4",
                             "ports": _ports(ip), "is_cdn": None, "cdn_name": None, "asn": None})
        elif "RETURN d.name AS name" in cypher:
            rows.extend({"name": name} for name in GRAPH_DOMAINS)
        elif "MATCH (b:BaseURL" in cypher and "HAS_ENDPOINT" not in cypher:
            for url, host in BASEURLS:
                rows.append({"url": url, "host": host, "status_code": 200,
                             "content_type": "text/html", "is_cdn": False, "cdn": None, "asn": None})
        elif "HAS_ENDPOINT" in cypher and "base_url" in cypher:
            for url, _ in BASEURLS:
                rows.append({"base_url": url, "endpoints": [{"path": "/x", "method": "GET"}],
                             "parameters": [{"name": "q"}]})
        elif "HAS_ENDPOINT" in cypher and "e.full_url" in cypher:
            for url, _ in BASEURLS:
                rows.append({"url": url + "/e?a=1", "baseurl": url})
        return rows


class _Client:
    calls = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def verify_connection(self):
        return True

    @property
    def driver(self):
        driver = mock.MagicMock()
        driver.session.side_effect = lambda: _Session(_Client.calls)
        return driver


@pytest.fixture
def graph(monkeypatch):
    _Client.calls = []
    monkeypatch.setattr("graph_db.Neo4jClient", _Client)
    return _Client.calls


ROOTS = ["alpha.test", "beta.test", "gamma.test"]


class TestPortScanBuilder:
    def build(self, **kw):
        return gb._build_port_scan_data_from_graph(ROOTS, "u1", "p1", domain_groups=GROUPS, **kw)

    def test_every_root_is_loaded_and_a_stale_one_is_not(self, graph):
        by_host = self.build()["port_scan"]["by_host"]
        assert "api.beta.test" in by_host and "mail.gamma.test" in by_host
        assert "www.old.test" not in by_host
        sub_query = next(p for c, p in graph if "HAS_SUBDOMAIN" in c)
        assert sub_query["domains"] == ROOTS

    def test_the_apex_follows_each_group(self, graph):
        data = self.build()
        apex_query = next(p for c, p in graph if "HAS_SUBDOMAIN" not in c)
        assert apex_query["apex_roots"] == ["alpha.test", "gamma.test"]
        assert "beta.test" not in data["port_scan"]["by_host"]
        assert data["port_scan"]["by_ip"]["10.0.0.3"]["hostnames"] == ["gamma.test"]

    def test_the_first_root_apex_fills_dns_domain_and_others_are_hosts(self, graph):
        data = self.build()
        assert data["domain"] == "alpha.test" and data["domains"] == ROOTS
        assert data["dns"]["domain"]["ips"]["ipv4"] == ["10.0.0.1"]
        assert data["dns"]["subdomains"]["gamma.test"]["ips"]["ipv4"] == ["10.0.0.3"]
        assert data["metadata"]["include_root_domain"] is True

    def test_a_literal_group_excludes_a_host_it_never_listed(self, graph):
        by_host = self.build()["port_scan"]["by_host"]
        assert "www.alpha.test" in by_host
        assert "san-only.alpha.test" not in by_host
        assert "10.0.1.2" not in self.build()["port_scan"]["by_ip"]

    def test_a_wildcard_group_keeps_it(self, graph):
        assert "san-only.beta.test" in self.build()["port_scan"]["by_host"]

    def test_ports_come_through(self, graph):
        data = self.build()
        assert sorted(data["port_scan"]["by_host"]["www.alpha.test"]["ports"]) == [443, 993]
        # 8443 is only open on beta.test's apex, which its group does not include.
        assert data["port_scan"]["all_ports"] == [443, 993]

    def test_a_legacy_single_root_call_is_unchanged(self, graph):
        # No domain_groups: the single flag rules and nothing is narrowed.
        data = gb._build_port_scan_data_from_graph("alpha.test", "u1", "p1", include_root_domain=False)
        assert data["domain"] == "alpha.test" and data["domains"] == ["alpha.test"]
        assert set(data["port_scan"]["by_host"]) == {"www.alpha.test", "san-only.alpha.test"}
        assert not any("apex_roots" in p for _, p in graph)
        assert data["metadata"]["include_root_domain"] is False

    def test_a_single_project_keeps_every_subdomain(self, graph):
        single = [{"rootDomain": "alpha.test", "prefixes": ["www."], "batch": False}]
        data = gb._build_port_scan_data_from_graph(["alpha.test"], "u1", "p1", domain_groups=single)
        assert set(data["port_scan"]["by_host"]) == {"www.alpha.test", "san-only.alpha.test"}

    def test_no_roots_queries_nothing(self, graph):
        data = gb._build_port_scan_data_from_graph([], "u1", "p1", domain_groups=GROUPS)
        assert data["port_scan"]["by_ip"] == {} and graph == []


class TestReconDataBuilder:
    """_build_recon_data_from_graph: Naabu, Masscan, Shodan, OsintEnrichment."""

    def build(self, roots=ROOTS, **kw):
        return gb._build_recon_data_from_graph(roots, "u1", "p1", domain_groups=GROUPS, **kw)

    def test_every_root_is_loaded(self, graph):
        subs = self.build()["dns"]["subdomains"]
        assert "api.beta.test" in subs and "mail.gamma.test" in subs
        assert "www.old.test" not in subs

    def test_the_apex_follows_each_group(self, graph):
        data = self.build()
        assert data["dns"]["domain"]["ips"]["ipv4"] == ["10.0.0.1"]
        assert data["dns"]["domain"]["has_records"] is True
        assert data["dns"]["subdomains"]["gamma.test"]["ips"]["ipv4"] == ["10.0.0.3"]
        assert "beta.test" not in data["dns"]["subdomains"]

    def test_a_literal_group_excludes_an_unlisted_host(self, graph):
        subs = self.build()["dns"]["subdomains"]
        assert "www.alpha.test" in subs and "san-only.alpha.test" not in subs
        assert "san-only.beta.test" in subs

    def test_a_single_root_per_root_call(self, graph):
        # Shodan and OsintEnrichment build one root at a time.
        data = self.build(roots=["beta.test"])
        assert data["domain"] == "beta.test" and data["domains"] == ["beta.test"]
        assert set(data["dns"]["subdomains"]) == {"api.beta.test", "san-only.beta.test"}
        assert data["dns"]["domain"]["ips"]["ipv4"] == []   # beta's apex is out of scope

    def test_the_legacy_call_is_unchanged(self, graph):
        data = gb._build_recon_data_from_graph("alpha.test", "u1", "p1", include_root_domain=True)
        assert data["dns"]["domain"]["ips"]["ipv4"] == ["10.0.0.1"]
        assert set(data["dns"]["subdomains"]) == {"www.alpha.test", "san-only.alpha.test"}
        assert data["metadata"]["include_root_domain"] is True


class TestHttpProbeBuilder:
    """_build_http_probe_data_from_graph: Katana, Hakrawler, ZAP, Ffuf, Kiterunner."""

    def build(self, **kw):
        return gb._build_http_probe_data_from_graph(ROOTS, "u1", "p1", domain_groups=GROUPS, **kw)

    def test_baseurls_are_scoped_to_the_run(self, graph):
        urls = set(self.build()["http_probe"]["by_url"])
        assert urls == {
            "https://www.alpha.test",       # listed
            "https://alpha.test",           # an included apex
            "https://api.beta.test:8443",   # wildcard group; host parsed from the URL
            "http://10.0.9.9:8080",         # under no root: kept, as before
            "https://cdn.thirdparty.example",
        }

    def test_a_stale_roots_baseurl_is_dropped(self, graph):
        assert "https://www.old.test" not in self.build()["http_probe"]["by_url"]

    def test_a_literal_groups_unlisted_host_is_dropped(self, graph):
        assert "https://san-only.alpha.test" not in self.build()["http_probe"]["by_url"]

    def test_an_excluded_apex_is_dropped(self, graph):
        assert "https://beta.test" not in self.build()["http_probe"]["by_url"]

    def test_the_subdomain_scope_list_is_literal_aware(self, graph):
        subs = self.build()["subdomains"]
        assert "san-only.alpha.test" not in subs
        assert {"www.alpha.test", "api.beta.test", "san-only.beta.test", "mail.gamma.test"} <= set(subs)

    def test_a_legacy_call_keeps_the_single_apex_rule_only(self, graph):
        data = gb._build_http_probe_data_from_graph("alpha.test", "u1", "p1", include_root_domain=False)
        urls = set(data["http_probe"]["by_url"])
        assert "https://alpha.test" not in urls                 # its apex is excluded
        assert "https://www.old.test" in urls                   # no stale filter without groups
        assert not any("RETURN d.name AS name" in c for c, _ in graph)


class TestGraphqlBuilder:
    """_build_graphql_data_from_graph: GraphqlScan, WebCachePoison."""

    def build(self, groups=GROUPS):
        return gb._build_graphql_data_from_graph(ROOTS, "u1", "p1", settings={}, domain_groups=groups)

    def test_a_stale_host_is_dropped_everywhere(self, graph):
        data = self.build()
        assert "https://www.old.test" not in data["http_probe"]["by_url"]
        assert "https://www.old.test" not in data["resource_enum"]["endpoints"]
        assert "https://www.old.test" not in data["resource_enum"]["parameters"]

    def test_no_apex_rule_is_added(self, graph):
        # GraphQL scanning never honoured Include Root Domain; it still does not.
        assert "https://beta.test" in self.build()["http_probe"]["by_url"]

    def test_the_roots_are_recorded(self, graph):
        data = self.build()
        assert data["domain"] == "alpha.test" and data["domains"] == ROOTS

    def test_a_legacy_call_is_unfiltered(self, graph):
        data = gb._build_graphql_data_from_graph("alpha.test", "u1", "p1", settings={})
        assert "https://www.old.test" in data["http_probe"]["by_url"]


class TestGraphUrlScope:
    def keep(self, graph, **kw):
        session = _Session(graph)
        return gb.graph_url_scope(session, "u1", "p1", ROOTS, GROUPS, **kw)

    def test_rules(self, graph):
        keep = self.keep(graph)
        assert keep("www.alpha.test") and keep("api.beta.test") and keep("10.0.0.1")
        assert not keep("www.old.test")          # stale
        assert not keep("san-only.alpha.test")   # literal, unlisted
        assert not keep("beta.test")             # excluded apex
        assert keep("")                          # unattributable: kept

    def test_without_the_apex_rule(self, graph):
        assert self.keep(graph, apex_filter=False)("beta.test")


class TestVulnScanBuilder:
    """_build_vuln_scan_data_from_graph: Nuclei, SecurityChecks, SubdomainTakeover,
    VhostSni, OriginDiscovery."""

    def build(self, **kw):
        return gb._build_vuln_scan_data_from_graph(ROOTS, "u1", "p1", domain_groups=GROUPS, **kw)

    def test_every_root_and_the_apex_per_group(self, graph):
        data = self.build()
        assert data["dns"]["domain"]["ips"]["ipv4"] == ["10.0.0.1"]          # alpha apex included
        assert data["dns"]["subdomains"]["gamma.test"]["ips"]["ipv4"] == ["10.0.0.3"]
        assert "beta.test" not in data["dns"]["subdomains"]                  # beta apex excluded
        assert {"www.alpha.test", "api.beta.test", "mail.gamma.test"} <= set(data["dns"]["subdomains"])

    def test_a_literal_group_excludes_its_unlisted_host(self, graph):
        data = self.build()
        assert "san-only.alpha.test" not in data["dns"]["subdomains"]
        assert "san-only.alpha.test" not in data["subdomains"]

    def test_baseurls_and_discovered_urls_are_scoped(self, graph):
        data = self.build()
        assert "https://www.old.test" not in data["http_probe"]["by_url"]
        assert "https://beta.test" not in data["http_probe"]["by_url"]        # excluded apex
        assert "https://api.beta.test:8443" in data["http_probe"]["by_url"]
        assert not any("old.test" in u for u in data["resource_enum"]["discovered_urls"])

    def test_the_roots_are_recorded(self, graph):
        data = self.build()
        assert data["domain"] == "alpha.test" and data["domains"] == ROOTS
        assert data["metadata"]["include_root_domain"] is True               # alpha (primary) apex in scope

    def test_injected_client_factory_supplies_the_graph_client(self, graph):
        created = []

        class InjectedClient(_Client):
            def __init__(self):
                created.append(self)

        data = self.build(client_factory=InjectedClient)
        assert data["domain"] == "alpha.test"
        assert len(created) == 1
