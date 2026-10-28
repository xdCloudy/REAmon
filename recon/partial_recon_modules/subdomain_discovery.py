import os
import sys
import json
import uuid
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from recon.partial_recon_modules.helpers import (
    STATUS_NO_RESULTS,
    STATUS_OK,
    _norm_host,
    host_in_roots,
    partial_settings,
    root_for_host,
    run_per_root,
    scope_roots,
)


def _ingest_graph_result(url: str, token: str, root: str, recon_data: dict,
                        user_subdomains: list[str]) -> dict:
    """Send a bounded, run-scoped graph write to the trusted orchestrator."""
    if not url or not token:
        raise RuntimeError("Partial graph ingest URL and token must both be configured")
    payload = json.dumps({
        "root": root,
        "recon_data": recon_data,
        "user_subdomains": user_subdomains,
    }, separators=(",", ":")).encode("utf-8")
    if len(payload) > 24 * 1024 * 1024:
        raise RuntimeError("Partial graph ingest payload exceeds the configured limit")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Partial-Graph-Token": token,
        },
        method="POST",
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status < 200 or response.status >= 300:
                    raise RuntimeError(f"Graph ingest returned HTTP {response.status}")
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code < 500 or attempt == 2:
                raise RuntimeError(f"Graph ingest rejected the result (HTTP {exc.code})") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == 2:
                raise RuntimeError("Graph ingest service was unavailable") from exc
        time.sleep(0.25 * (2 ** attempt))
    raise RuntimeError("Graph ingest did not complete")


def _enumerable_roots(roots: list, config: dict, settings: dict) -> list:
    """The roots subdomain enumeration may run on.

    A single-domain project always enumerates; a Domain batch enumerates only a
    wildcard group, and scans a literal group exactly as uploaded (no
    discovery). Decided by the same group_discovery_enabled the full pipeline
    calls per group, with the run-wide toggle forced on because the operator
    explicitly triggered this tool.
    """
    from recon.helpers.batch_groups import group_discovery_enabled, parse_target

    groups = config.get("domain_groups") or []
    batch_groups = groups if config.get("batch_mode") else []
    enumerable = []
    for root in roots:
        group = next((g for g in groups
                      if _norm_host(g.get("rootDomain")) == _norm_host(root)), None)
        info = parse_target(root, list(group.get("prefixes") or []) if group else [])
        info["root_domain"] = root
        if group_discovery_enabled(settings, batch_groups, info):
            enumerable.append(root)
    return enumerable


def run_subdomain_discovery(config: dict) -> dict:
    """
    Run partial subdomain discovery, once per enumerable root, using the exact
    same functions as the full pipeline in domain_recon.py.

    Over a Domain batch only wildcard roots enumerate; a literal group is scanned
    exactly as uploaded and is reported as skipped. With no enumerable root, the
    run exits 1.
    """
    from recon.main_recon_modules.domain_recon import discover_subdomains, resolve_all_dns, run_puredns_resolve

    roots = scope_roots(config)
    user_inputs = config.get("user_inputs", [])

    user_id = os.environ.get("USER_ID", "")
    project_id = os.environ.get("PROJECT_ID", "")

    print(f"[*][Partial Recon] Loading project settings...")
    settings = partial_settings(config)

    # The operator explicitly triggered discovery, so the run-wide toggle is on;
    # the per-root wildcard rule still decides which roots enumerate.
    settings["SUBDOMAIN_DISCOVERY_ENABLED"] = True

    print(f"\n{'=' * 50}")
    print(f"[*][Partial Recon] Subdomain Discovery")
    print(f"[*][Partial Recon] Roots: {', '.join(roots)}")
    if user_inputs:
        print(f"[*][Partial Recon] User inputs: {len(user_inputs)} custom subdomains")
    print(f"{'=' * 50}\n")

    enumerable = _enumerable_roots(roots, config, settings)
    skipped = {r: "not scanned: a literal group is scanned as uploaded, not enumerated"
               for r in roots if r not in enumerable}
    for root in skipped:
        print(f"[!][Partial Recon] {root}: {skipped[root]}")

    if not enumerable:
        print("[!][Partial Recon] No root may enumerate subdomains "
              "(every group is literal; nothing to discover).")
        sys.exit(1)

    # Validate user inputs against ANY root; each is scanned with the root it
    # sits under.
    valid_user_subs = []
    for sub in user_inputs:
        sub = sub.strip().lower()
        if sub and host_in_roots(sub, roots):
            valid_user_subs.append(sub)
        elif sub:
            print(f"[!][Partial Recon] Skipping invalid user input: {sub} (under no project root)")

    def _one_root(domain: str) -> str:
        print(f"[*][Partial Recon] Running subdomain discovery for {domain}...")
        result = discover_subdomains(
            domain=domain,
            bruteforce=settings.get("USE_BRUTEFORCE_FOR_SUBDOMAINS", False),
            resolve=True,
            save_output=False,
            project_id=project_id,
            settings=settings,
        )

        discovered_subs = result.get("subdomains", [])
        print(f"[+][Partial Recon] {domain}: discovery found {len(discovered_subs)} subdomains")

        my_user_subs = [s for s in valid_user_subs if root_for_host(s, roots) == domain]
        new_user_subs = [s for s in my_user_subs if s not in discovered_subs]
        if new_user_subs:
            print(f"[*][Partial Recon] Adding {len(new_user_subs)} user-provided subdomains under {domain}")
            all_subs = sorted(set(discovered_subs + new_user_subs))
            all_subs = run_puredns_resolve(all_subs, domain, settings)
            print(f"[*][Partial Recon] Resolving DNS for {len(all_subs)} subdomains...")
            result["subdomains"] = all_subs
            result["subdomain_count"] = len(all_subs)
            dns_workers = settings.get('DNS_MAX_WORKERS', 50)
            dns_record_parallel = settings.get('DNS_RECORD_PARALLELISM', True)
            result["dns"] = resolve_all_dns(domain, all_subs, max_workers=dns_workers,
                                            record_parallelism=dns_record_parallel, settings=settings)
            subdomain_status_map = {}
            if result["dns"]:
                dns_subs = result["dns"].get("subdomains", {})
                for s in all_subs:
                    info = result["dns"].get("domain", {}) if s == domain else dns_subs.get(s, {})
                    if info.get("has_records", False):
                        subdomain_status_map[s] = "resolved"
            result["subdomain_status_map"] = subdomain_status_map

        result["domain"] = domain
        final_count = len(result.get("subdomains", []))
        print(f"[+][Partial Recon] {domain}: final subdomain count: {final_count}")

        ingest_url = os.environ.get("PARTIAL_GRAPH_INGEST_URL")
        ingest_token = os.environ.get("PARTIAL_GRAPH_INGEST_TOKEN")
        if ingest_url or ingest_token:
            print(f"[*][Partial Recon] Sending graph results through the trusted orchestrator...")
            receipt = _ingest_graph_result(ingest_url or "", ingest_token or "", domain,
                                           result, my_user_subs)
            print(f"[+][Partial Recon] {domain}: {json.dumps(receipt.get('stats', {}), default=str)}")
            if receipt.get("status") != "ingested":
                raise RuntimeError("Graph ingest completed with partial errors")
        else:
            # Compatibility for local/manual runs. Orchestrated SubdomainDiscovery
            # always receives the run-scoped ingest capability and never this path.
            print(f"[*][Partial Recon] Updating graph database...")
            from graph_db import Neo4jClient
            with Neo4jClient() as graph_client:
                if not graph_client.verify_connection():
                    print("[!][Partial Recon] Neo4j not reachable, graph not updated")
                    return STATUS_NO_RESULTS if not final_count else STATUS_OK

                user_input_id = None
                if my_user_subs:
                    user_input_id = str(uuid.uuid4())
                    graph_client.create_user_input_node(
                        domain=domain,
                        user_input_data={
                            "id": user_input_id,
                            "input_type": "subdomains",
                            "values": my_user_subs,
                            "tool_id": "SubdomainDiscovery",
                        },
                        user_id=user_id,
                        project_id=project_id,
                    )

                stats = graph_client.update_graph_from_partial_discovery(
                    recon_data=result,
                    user_id=user_id,
                    project_id=project_id,
                    user_input_id=user_input_id,
                )
                if user_input_id:
                    graph_client.update_user_input_status(user_input_id, "completed", stats)
                    print(f"[+][Partial Recon] Created UserInput + linked to discovery results")
                print(f"[+][Partial Recon] {domain}: {json.dumps(stats, default=str)}")

        return STATUS_OK if (final_count or my_user_subs) else STATUS_NO_RESULTS

    statuses = run_per_root(enumerable, _one_root, "SubdomainDiscovery")
    statuses.update(skipped)
    return statuses
