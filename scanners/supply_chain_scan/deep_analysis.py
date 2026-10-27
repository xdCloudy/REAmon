"""L1 deep behavioural analysis (GuardDog), dispatched to the DIRTY analyzer.

The toggle `SUPPLY_CHAIN_DEEP_ANALYSIS_ENABLED` was parsed by
supply_chain_scan/project_settings.py and read NOWHERE, so it was a dead switch
in the UI.

This module never unpacks a tarball itself: it sends a job to the analyzer over
the broker socket. The broker allowlists the image and mounts.

Only packages the offline OSV pass ALREADY flagged are sent, capped, exactly
like the L2 pass.
"""

import os

from supply_chain_common import analyzer_dispatch as _ad
from supply_chain_common.artifact import add_guarddog_findings

_MAX_PACKAGES = int(os.environ.get("SUPPLY_CHAIN_DEEP_MAX_PACKAGES", "10"))
_TIMEOUT = int(os.environ.get("SUPPLY_CHAIN_DEEP_TIMEOUT", "180"))
_SC_COMMON_PATH = os.environ.get("SUPPLY_CHAIN_COMMON_HOST_PATH",
                                 "/app/supply_chain_common")

# OSV ecosystem brand -> GuardDog slug. Ecosystems GuardDog cannot analyse
# (Maven, Packagist, NuGet) are absent on purpose and get skipped.
_OSV_TO_GUARDDOG_ECO = {
    "npm": "npm", "PyPI": "pypi", "Go": "go",
    "crates.io": "crates", "RubyGems": "rubygems",
}


def flagged_specs(artifact, limit=_MAX_PACKAGES):
    """Unique OSV-flagged packages as GuardDog coordinates. Malicious first."""
    seen, out, dropped = set(), [], 0
    for bucket in ("malicious", "vulnerable"):
        for f in artifact.get(bucket) or []:
            name = f.get("name")
            gd_eco = _OSV_TO_GUARDDOG_ECO.get(f.get("ecosystem"))
            if not name or not gd_eco:
                continue
            key = (gd_eco, name, f.get("version"))
            if key in seen:
                continue
            seen.add(key)
            if len(out) >= limit:
                dropped += 1
                continue
            out.append({"ecosystem": gd_eco, "name": name,
                        "version": f.get("version"), "purl": f.get("purl"),
                        "osv_ecosystem": f.get("ecosystem")})
    if dropped:
        print("[!][SupplyChain] deep analysis cap: {} flagged package(s) beyond "
              "SUPPLY_CHAIN_DEEP_MAX_PACKAGES={} were NOT analysed"
              .format(dropped, limit))
    return out


def deep_analyze(artifact, *, limit=_MAX_PACKAGES, timeout=_TIMEOUT,
                 sc_common_path=None, dispatch=None):
    """Run GuardDog over the flagged packages. Mutates and returns (artifact, stats)."""
    ad = dispatch or _ad
    stats = {"scanned": 0, "suspicious": 0, "soft_errors": 0, "failed": 0}
    specs = flagged_specs(artifact, limit=limit)
    if not specs:
        return artifact, stats

    job_dir = ad.new_work_dir(prefix="sc-l1-guarddog")
    try:
        res = ad.run_analyzer_job(
            {"mode": "purls", "target": "/work", "deep_analysis": True,
             "guarddog_packages": [
                 {"ecosystem": s["ecosystem"], "name": s["name"],
                  "version": s["version"]} for s in specs]},
            job_dir, sc_common_path or _SC_COMMON_PATH,
            allow_registry_egress=True, timeout=timeout * max(1, len(specs)))
    except Exception as exc:
        stats["failed"] = len(specs)
        for spec in specs:
            _soft_error(artifact, spec, "guarddog dispatch raised: {}".format(exc))
        return artifact, stats
    finally:
        import shutil
        shutil.rmtree(job_dir, ignore_errors=True)

    out = res.get("artifact")
    if out is None:
        # A dispatch failure must never read as "analysed, nothing found";
        # the saved artifact preserves soft-error evidence for the operator.
        stats["failed"] = len(specs)
        for spec in specs:
            _soft_error(artifact, spec,
                        "guarddog did not run: {}".format(res.get("error")))
        return artifact, stats

    by_name = {s["name"]: s for s in specs}
    for f in out.get("suspicious") or []:
        spec = by_name.get(f.get("name"))
        add_guarddog_findings(
            artifact,
            [{"package": f.get("name"), "version": f.get("version"),
              "rule": f.get("rule"), "severity": f.get("severity"),
              "confidence": "suspicious", "message": f.get("message") or "",
              "soft_error": bool(f.get("soft_error"))}],
            ecosystem=(spec or {}).get("osv_ecosystem") or f.get("ecosystem"),
            name=f.get("name"), version=f.get("version"),
            purl=(spec or {}).get("purl"))
        if f.get("soft_error"):
            stats["soft_errors"] += 1
        else:
            stats["suspicious"] += 1
    stats["scanned"] = len(specs)
    for err in out.get("errors") or []:
        artifact["errors"].append(err)
    return artifact, stats


def _soft_error(artifact, spec, message):
    artifact["suspicious"].append({
        "name": spec["name"], "version": spec["version"],
        "ecosystem": spec["osv_ecosystem"], "purl": spec["purl"],
        "rule": "guarddog-not-run", "severity": "low",
        "confidence": "suspicious", "message": str(message)[:2000],
        "soft_error": True,
    })
    return artifact
