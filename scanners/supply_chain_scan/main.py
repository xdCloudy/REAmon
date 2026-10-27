#!/usr/bin/env python3
"""RedAmon - Supply-Chain Scan (L1 "Other Scans") entry point.

Runs a standalone supply-chain audit of an operator-uploaded SBOM / lockfile
against the OFFLINE OSV database and saves a run-bound JSON artifact. The
orchestrator, not this scanner, owns Neo4j credentials and graph writes.

Env (set by the orchestrator):
    PROJECT_ID, USER_ID, WEBAPP_API_URL,
    SUPPLY_CHAIN_UPLOADS_DIR (default /data/supply-chain-uploads),
    OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY (default /osv-db),
    SUPPLY_CHAIN_OUTPUT_DIR (default /app/supply_chain_scan/output)
"""

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

PROJECT_ID = os.environ.get("PROJECT_ID", "")
USER_ID = os.environ.get("USER_ID", "")

try:
    from supply_chain_scan.project_settings import get_setting, load_project_settings
    from supply_chain_scan.supply_chain_runner import SupplyChainRunner
except ImportError:
    from project_settings import get_setting, load_project_settings
    from supply_chain_runner import SupplyChainRunner


def run_supply_chain_scan(project_id: str) -> dict:
    # There is no SUPPLY_CHAIN_ENABLED gate. The scan is launched explicitly
    # from Other Scans, so reaching this code IS the operator's intent; a second
    # switch that had to be flipped first only ever produced a scan that
    # silently did nothing. (The setting existed, was parsed, and was never
    # read - it gated nothing even when it was present.)
    input_mode = get_setting("SUPPLY_CHAIN_INPUT_MODE", "upload")
    sbom_file = get_setting("SUPPLY_CHAIN_SBOM_FILE", "")
    repo_url = get_setting("SUPPLY_CHAIN_REPO_URL", "")
    repo_ref = get_setting("SUPPLY_CHAIN_REPO_REF", "")
    ecosystems_raw = get_setting("SUPPLY_CHAIN_ECOSYSTEMS", "")
    ecosystems = [e.strip() for e in (ecosystems_raw or "").split(",") if e.strip()]

    uploads_dir = os.environ.get("SUPPLY_CHAIN_UPLOADS_DIR", "/data/supply-chain-uploads")
    db_path = os.environ.get("OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY", "/osv-db")
    output_dir = os.environ.get("SUPPLY_CHAIN_OUTPUT_DIR",
                                str(Path(__file__).parent / "output"))
    run_id = os.environ.get("SUPPLY_CHAIN_RUN_ID", "")

    print("\n" + "=" * 70)
    print("           RedAmon - Supply-Chain Scan (L1)")
    print("=" * 70)
    if input_mode == "github":
        print(f"  Repository:     {repo_url or '(not set)'}")
        print(f"  Host:           {get_setting('SUPPLY_CHAIN_GITHUB_HOST', 'github.com')}")
        print(f"  Ref:            {repo_ref or '(default branch)'}")
    else:
        print(f"  Input file:     {sbom_file or '(not set)'}")
    print(f"  Ecosystems:     {', '.join(ecosystems) or '(all)'}")
    print(f"  OSV DB:         {db_path}")
    print("=" * 70 + "\n")

    # Repository input: clone first, then scan the checkout as a directory so
    # osv-scanner picks up EVERY lockfile in the tree, not just one file.
    repo_dir = None
    repo_scratch = None
    repo_slug = None
    if input_mode == "github":
        if not repo_url:
            print("[!] ERROR: no repository configured (set one in Other Scans -> Supply Chain)")
            return {"error": "no repository configured"}
        try:
            from supply_chain_scan.repo_clone import clone_repo, parse_repo_target, RepoCloneError
        except ImportError:
            from repo_clone import clone_repo, parse_repo_target, RepoCloneError
        try:
            # github.com plus, if the operator configured one, their GitHub
            # Enterprise host. Nothing else may be cloned from, whatever the URL
            # or the batch override says.
            allowed_hosts = [h for h in (get_setting("SUPPLY_CHAIN_GHE_HOST", ""),) if h]
            host, owner, name = parse_repo_target(repo_url, allowed_hosts)
            repo_slug = f"{owner}/{name}"
            token = get_setting("GITHUB_ACCESS_TOKEN", "") or None
            print(f"[*] Cloning {repo_slug} from {host}"
                  f"{' @ ' + repo_ref if repo_ref else ''}"
                  f"{' (authenticated)' if token else ' (anonymous)'}...")
            repo_dir = clone_repo(repo_url, ref=repo_ref or None, token=token,
                                  allowed_hosts=allowed_hosts)
            repo_scratch = os.path.dirname(repo_dir)
            print(f"[+] Cloned to {repo_dir}")
        except RepoCloneError as exc:
            # Never a silent empty scan: a clone that did not happen is an
            # error, not a repository with no dependencies.
            print(f"[!] ERROR: {exc}")
            return {"error": f"clone failed: {exc}"}
    elif not sbom_file:
        print("[!] ERROR: no SBOM/lockfile configured (upload one in Other Scans -> Supply Chain)")
        return {"error": "no input file configured"}

    try:
        runner = SupplyChainRunner(
            uploads_dir=uploads_dir, sbom_file=sbom_file, db_path=db_path,
            project_id=project_id, ecosystems=ecosystems, repo_dir=repo_dir)
        artifact = runner.run()
    finally:
        # The checkout is attacker-authored content on a shared filesystem.
        # Remove it whether or not the scan succeeded.
        if repo_scratch:
            import shutil as _shutil
            _shutil.rmtree(repo_scratch, ignore_errors=True)

    # Deep behavioural analysis (GuardDog), opt-in. Dispatched to the DIRTY
    # analyzer over the broker socket; this scanner does not hold graph credentials.
    deep_stats = None
    if get_setting("SUPPLY_CHAIN_DEEP_ANALYSIS_ENABLED", False):
        try:
            # Same dual-context dance as the project_settings import at the top
            # of this module: the container runs main.py both as a package
            # member and as a plain script. Without the fallback the import
            # raises, the outer `except Exception` swallows it, and deep
            # analysis silently never runs.
            try:
                from supply_chain_scan.deep_analysis import (
                    deep_analyze, flagged_specs, _soft_error,
                )
            except ImportError:
                from deep_analysis import deep_analyze, flagged_specs, _soft_error
            from supply_chain_common.security import validate_artifact, ArtifactError
            from supply_chain_common.deep_recovery import recover_invalid_deep_artifact
            artifact, deep_stats = deep_analyze(artifact)
            try:
                # GuardDog output quotes attacker-authored package source, so it
                # must clear the boundary gate too.
                artifact = validate_artifact(artifact)
            except ArtifactError as exc:
                # This used to do `artifact["suspicious"] = []`, which erased the
                # soft-error markers for packages GuardDog never analysed and so
                # reported them as behaviourally CLEAN. L2 was fixed for exactly
                # that (D1); L1 was not. Both now share one implementation.
                print(f"[!] deep analysis artifact invalid: {exc}")
                artifact = recover_invalid_deep_artifact(
                    artifact, exc, validate=validate_artifact,
                    flagged_specs=flagged_specs, add_soft_error=_soft_error)
        except Exception as exc:
            print(f"[!] deep analysis failed: {exc}")
            artifact.setdefault("errors", []).append(f"deep analysis failed: {exc}")

    # Incident context (B). MUST come after the LAST validate_artifact above: the
    # incident_* properties are deliberately absent from the artifact allowlist,
    # so enriching before the gate would fail validation. Mirrors L2 exactly -
    # the two paths have drifted before and share one implementation now.
    try:
        from supply_chain_common.intel import enrich_findings, load_intel

        _intel = load_intel()
        enrich_findings(artifact, _intel)
        if not _intel.available:
            print("[!] incident intel unavailable; findings carry no incident context")
    except Exception as exc:
        print(f"[!] incident enrichment failed: {exc}")
        artifact.setdefault("errors", []).append(f"incident enrichment failed: {exc}")

    print("\n" + "=" * 70)
    print("                    SCAN SUMMARY")
    print("=" * 70)
    print(f"  Packages:       {runner.stats['packages']}")
    print(f"  MALICIOUS:      {runner.stats['malicious']}")
    print(f"  Vulnerable:     {runner.stats['vulnerable']}")
    if deep_stats:
        print(f"  Deep analysis:  scanned={deep_stats['scanned']} "
              f"suspicious={deep_stats['suspicious']} "
              f"soft_errors={deep_stats['soft_errors']} failed={deep_stats['failed']}")
    if artifact.get("errors"):
        print(f"  Errors:         {artifact['errors']}")
    print("=" * 70 + "\n")

    # Save the artifact.
    payload = {
        "project_id": project_id,
        "user_id": USER_ID,
        "run_id": run_id,
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "input_mode": input_mode,
        "input_file": repo_slug or sbom_file,
        "repository": repo_slug,
        "repository_ref": repo_ref if repo_slug else None,
        "artifact": artifact,
    }
    out_file = save_scan_artifact(output_dir, project_id, payload)
    print(f"[+] Saved artifact to {out_file}")

    return {
        "input_mode": input_mode,
        "input_file": repo_slug or sbom_file,
        "statistics": runner.stats,
        "output_file": out_file,
    }


def save_scan_artifact(output_dir: str, project_id: str, payload: dict) -> str:
    """Atomically publish a completed run so readers never see partial JSON."""
    os.makedirs(output_dir, exist_ok=True)
    out_file = os.path.join(output_dir, f"supply_chain_{project_id}.json")
    fd, pending_path = tempfile.mkstemp(prefix=".supply_chain_", suffix=".tmp", dir=output_dir)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
        os.replace(pending_path, out_file)
    finally:
        if os.path.exists(pending_path):
            os.unlink(pending_path)
    return out_file


def main() -> int:
    if not PROJECT_ID:
        print("[!] ERROR: PROJECT_ID environment variable not set")
        return 1
    if not os.environ.get("SUPPLY_CHAIN_RUN_ID"):
        print("[!] ERROR: SUPPLY_CHAIN_RUN_ID environment variable not set")
        return 1

    load_project_settings(PROJECT_ID)
    start = datetime.now()
    try:
        results = run_supply_chain_scan(project_id=PROJECT_ID)
        if "error" in results:
            print(f"\n[!] Scan failed: {results['error']}")
            return 1
    except KeyboardInterrupt:
        print("\n[!] Scan interrupted by user")
        return 130
    except Exception as e:
        print(f"\n[!] Unexpected error: {e}")
        raise

    print(f"\n[*] Total scan time: {(datetime.now() - start).total_seconds():.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
