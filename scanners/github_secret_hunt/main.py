#!/usr/bin/env python3
"""
RedAmon - GitHub Secret Hunter Main Entry Point
=================================================
Orchestrates GitHub secret scanning using project settings from the webapp API.

Scans GitHub repositories, gists, and commit history for exposed secrets,
API keys, and credentials related to the target organization or user.

Usage:
    # Run via Docker (managed by recon orchestrator):
    # Container receives PROJECT_ID and WEBAPP_API_URL as environment variables

    # Or run standalone:
    PROJECT_ID=xxx WEBAPP_API_URL=http://localhost:3000 python github_secret_hunt/main.py
"""

import os
import signal
import sys
from pathlib import Path
from datetime import datetime

# Add project root to path for imports
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# Runtime parameters from environment variables (set by orchestrator)
PROJECT_ID = os.environ.get("PROJECT_ID", "")

# GitHub project settings (fetched from webapp API or defaults)
try:
    from github_secret_hunt.project_settings import get_setting, load_project_settings
except ImportError:
    from project_settings import get_setting, load_project_settings

try:
    from github_secret_hunt.github_secret_hunt import GitHubSecretHunter
except ImportError:
    from github_secret_hunt import GitHubSecretHunter


def run_github_secret_hunt(project_id: str) -> dict:
    """
    Run GitHub secret hunting with settings from the webapp API.

    Args:
        project_id: Project ID for output file naming and settings lookup

    Returns:
        Dictionary with scan results or error info
    """
    # Read scan settings from project settings (fetched from webapp API)
    token = get_setting('GITHUB_ACCESS_TOKEN', '')
    target = get_setting('GITHUB_TARGET_ORG', '')
    scan_members = get_setting('GITHUB_SCAN_MEMBERS', False)
    scan_gists = get_setting('GITHUB_SCAN_GISTS', True)
    scan_commits = get_setting('GITHUB_SCAN_COMMITS', True)
    max_commits = get_setting('GITHUB_MAX_COMMITS', 100)
    output_json = get_setting('GITHUB_OUTPUT_JSON', True)
    target_repos = get_setting('GITHUB_TARGET_REPOS', '')

    print("\n" + "=" * 70)
    print("           RedAmon - GitHub Secret Hunter")
    print("=" * 70)
    print(f"  Target Org/User: {target}")
    print(f"  Target Repos:    {target_repos or '(all)'}")
    print(f"  Scan Members:    {scan_members}")
    print(f"  Scan Gists:      {scan_gists}")
    print(f"  Scan Commits:    {scan_commits}")
    print(f"  Max Commits:     {max_commits}")
    print(f"  JSON Output:     {output_json}")
    print("=" * 70 + "\n")

    # Validate required settings
    if not token:
        print("[!] ERROR: GitHub access token not configured")
        print("[!] Set it in the project settings (Integrations → GitHub Secret Hunting)")
        return {"error": "GitHub access token not configured"}

    if not target:
        print("[!] ERROR: GitHub target organization/user not configured")
        print("[!] Set it in the project settings (Integrations → GitHub Secret Hunting)")
        return {"error": "GitHub target organization/user not configured"}

    # Build settings dict for the scanner
    settings = {
        'GITHUB_ACCESS_TOKEN': token,
        'GITHUB_TARGET_ORG': target,
        'GITHUB_SCAN_MEMBERS': scan_members,
        'GITHUB_SCAN_GISTS': scan_gists,
        'GITHUB_SCAN_COMMITS': scan_commits,
        'GITHUB_MAX_COMMITS': max_commits,
        'GITHUB_OUTPUT_JSON': output_json,
        'GITHUB_TARGET_REPOS': target_repos,
    }

    # Run the scanner
    print("[*] Initializing GitHub Secret Hunter...")
    hunter = GitHubSecretHunter(
        token=token,
        target=target,
        project_id=project_id,
        settings=settings,
    )

    findings = hunter.run()

    # Findings are persisted to the mounted JSON artifact. The trusted
    # orchestrator ingests that artifact after the scanner process exits.
    return {
        "target": target,
        "findings_count": len(findings),
        "statistics": hunter.stats,
        "output_file": str(hunter.output_file),
    }


def _install_sigterm_handler():
    """Turn SIGTERM into the KeyboardInterrupt the scan loop already handles.

    Every stop reaches this container as SIGTERM: the orchestrator's stop
    endpoint, and its shutdown cleanup when the stack is restarted. Python's
    default SIGTERM handler exits on the spot, so the final artifact save was
    skipped and an hour of scanning was discarded (observed 2026-08-20: 14
    repos, 799 findings, zero nodes). SIGINT was already handled, which hid it —
    Ctrl-C saved, a restart did not.

    KeyboardInterrupt rather than a custom exception on purpose: it is a
    BaseException, so it passes through the `except Exception: continue` guards
    in the per-file and per-commit loops instead of being swallowed.
    """
    def _raise(signum, frame):
        raise KeyboardInterrupt()

    try:
        signal.signal(signal.SIGTERM, _raise)
    except ValueError:
        pass  # not the main thread; the scan is single-threaded, so this is moot


def main():
    """Main entry point."""

    if not PROJECT_ID:
        print("[!] ERROR: PROJECT_ID environment variable not set")
        return 1

    _install_sigterm_handler()

    # Load per-project settings from webapp API (or use defaults)
    load_project_settings(PROJECT_ID)

    # Run the scan
    start_time = datetime.now()

    try:
        results = run_github_secret_hunt(project_id=PROJECT_ID)

        if "error" in results:
            print(f"\n[!] Scan failed: {results['error']}")
            return 1

    except KeyboardInterrupt:
        print("\n[!] Scan interrupted by user")
        return 130
    except Exception as e:
        print(f"\n[!] Unexpected error: {e}")
        raise

    # Print duration
    duration = (datetime.now() - start_time).total_seconds()
    print(f"\n[*] Total scan time: {duration:.2f} seconds")

    return 0


if __name__ == "__main__":
    sys.exit(main())
