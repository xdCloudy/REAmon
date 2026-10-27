"""AI Attack Surface scan — container entrypoint (Step 2: skeleton).

Control flow (shared spine; no tool yet). Phases are numbered in execution
order so the orchestrator's SSE progress only ever advances:
  [Phase 1] Safety / bounds  — RoE + bounds + hard-guardrail floor (fail fast)
  [Phase 2] Target loading   — consume the orchestrator-resolved target snapshot
  [Phase 3] Attack           — (skeleton) emit one dummy finding per target
  [Phase 4] Findings         — atomically publish a run-bound artifact for ingest

The trusted orchestrator owns graph reads/writes. The worker receives only its
target snapshot and private run directory, then publishes a hashable JSON result
artifact. Phase markers are printed to stdout for the orchestrator's SSE layer.
"""
from __future__ import annotations

import logging
import json
import os
import re
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path

from config import load_config
from normalizer import make_dummy_finding
from safety import SafetyError, enforce
from target_loader import targets_from_payload

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ai-attack-surface")


def _safe_slug(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]", "_", text or "target")[:80]


def run_tool(cfg, targets) -> list:
    """Dispatch the configured tool against the targets -> list[Finding].

    Each adapter is failure-soft: a tool that errors on one target yields no
    findings for it but does not abort the run.
    """
    if cfg.tool == "garak":
        from adapters.garak import run as run_garak
        out_base = Path("/app/ai_attack_surface_scan/output") / (cfg.run_id or "dev")
        findings = []
        for t in targets:
            gdir = out_base / "garak" / _safe_slug(f"{t.baseurl}{t.path}")
            try:
                findings.extend(run_garak(
                    t, cfg.bounds, str(gdir), cfg.run_id,
                    judge_base_url=cfg.judge_base_url or None,
                    target_model=cfg.target_model or None,
                    api_key=cfg.api_key or None,
                    auth_header=cfg.auth_header or None,
                    auth_scheme=cfg.auth_scheme or None,
                    probes=cfg.probes or None,
                ))
            except Exception as e:  # one target failing must not abort the job
                log.exception(f"garak failed on {t.url}: {e}")
                print(f"    [!] garak failed on {t.url}: {e}")
        return findings

    if cfg.tool == "pyrit":
        from adapters.pyrit import run as run_pyrit
        out_base = Path("/app/ai_attack_surface_scan/output") / (cfg.run_id or "dev")
        findings = []
        for t in targets:
            pdir = out_base / "pyrit" / _safe_slug(f"{t.baseurl}{t.path}")
            try:
                findings.extend(run_pyrit(
                    t, cfg.bounds, str(pdir), cfg.run_id,
                    judge_base_url=cfg.judge_base_url or None,
                    attacks=cfg.probes or None,   # probes carries the attack selection
                    objective=cfg.objective or None,
                    target_model=cfg.target_model or None,
                    target_purpose=cfg.target_purpose or None,
                    api_key=cfg.api_key or None,
                    auth_header=cfg.auth_header or None,
                    auth_scheme=cfg.auth_scheme or None,
                ))
            except Exception as e:
                log.exception(f"pyrit failed on {t.url}: {e}")
                print(f"    [!] pyrit failed on {t.url}: {e}")
        return findings

    if cfg.tool == "giskard":
        from adapters.giskard import run as run_giskard
        out_base = Path("/app/ai_attack_surface_scan/output") / (cfg.run_id or "dev")
        findings = []
        for t in targets:
            gdir = out_base / "giskard" / _safe_slug(f"{t.baseurl}{t.path}")
            try:
                findings.extend(run_giskard(
                    t, cfg.bounds, str(gdir), cfg.run_id,
                    judge_base_url=cfg.judge_base_url or None,
                    detectors=cfg.probes or None,   # probes carries the detector selection
                    target_model=cfg.target_model or None,
                    target_purpose=cfg.target_purpose or None,
                    api_key=cfg.api_key or None,
                    auth_header=cfg.auth_header or None,
                    auth_scheme=cfg.auth_scheme or None,
                ))
            except Exception as e:
                log.exception(f"giskard failed on {t.url}: {e}")
                print(f"    [!] giskard failed on {t.url}: {e}")
        return findings

    if cfg.tool == "promptfoo":
        from adapters.promptfoo import run as run_promptfoo
        out_base = Path("/app/ai_attack_surface_scan/output") / (cfg.run_id or "dev")
        findings = []
        for t in targets:
            pdir = out_base / "promptfoo" / _safe_slug(f"{t.baseurl}{t.path}")
            try:
                findings.extend(run_promptfoo(
                    t, cfg.bounds, str(pdir), cfg.run_id,
                    judge_base_url=cfg.judge_base_url or None,
                    plugins=cfg.probes or None,   # probes carries the plugin/chip selection
                    strategies=cfg.strategies or None,
                    target_model=cfg.target_model or None,
                    target_purpose=cfg.target_purpose or None,
                    api_key=cfg.api_key or None,
                    auth_header=cfg.auth_header or None,
                    auth_scheme=cfg.auth_scheme or None,
                ))
            except Exception as e:
                log.exception(f"promptfoo failed on {t.url}: {e}")
                print(f"    [!] promptfoo failed on {t.url}: {e}")
        return findings

    # Default: the Step-2 skeleton (no tool) — one dummy finding per target.
    return [make_dummy_finding(t, cfg.tool, cfg.run_id) for t in targets]


def write_result_artifact(path: str, cfg, targets, findings) -> None:
    """Publish a run-bound result artifact atomically for trusted ingestion."""
    if not path:
        raise ValueError("AI_ATTACK_RESULT_PATH is required")
    target_path = Path(path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "metadata": {
            "project_id": cfg.project_id,
            "user_id": cfg.user_id,
            "run_id": cfg.run_id,
            "tool": cfg.tool,
        },
        "targets": [asdict(target) for target in targets],
        "findings": [asdict(finding) for finding in findings],
    }
    fd, tmp_path = tempfile.mkstemp(prefix=f".{target_path.name}.", dir=target_path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp_path, 0o644)
        os.replace(tmp_path, target_path)
        dir_fd = os.open(target_path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def run() -> int:
    cfg = load_config()
    print("=" * 64)
    print(f"[*] AI Attack Surface scan — tool={cfg.tool} run_id={cfg.run_id or 'dev'}")
    print(f"[*] project={cfg.project_id} user={cfg.user_id}")
    print("=" * 64)

    if not cfg.project_id or not cfg.user_id:
        print("[!] ERROR: PROJECT_ID and USER_ID are required")
        return 1

    # [Phase 1] Safety / bounds — fail fast before touching a target.
    print("[Phase 1] Safety / bounds")
    try:
        enforce(cfg)
    except SafetyError as e:
        print(f"[!] Safety check failed: {e}")
        return 1

    # [Phase 2] Targets were resolved by the trusted orchestrator.
    print("[Phase 2] Target loading")
    targets = targets_from_payload(cfg.targets)
    print(f"    [+] {len(targets)} authorized target(s) received")
    if not targets:
        print("[!] No AI targets found/selected — nothing to do")
        return 0

    # [Phase 3] Attack
    print(f"[Phase 3] Attack (tool={cfg.tool})")
    if cfg.dry_run:
        print("    [+] dry-run: no payloads will be sent; not persisting")
        return 0
    findings = run_tool(cfg, targets)
    print(f"    [+] {len(findings)} finding(s) from {cfg.tool}")

    # [Phase 4] Persist a run-bound artifact; graph writes happen in the
    # credentialed orchestrator after project/user/run validation.
    print("[Phase 4] Findings")
    write_result_artifact(os.environ.get("AI_ATTACK_RESULT_PATH", ""), cfg, targets, findings)
    print(f"    [+] published {len(findings)} finding(s) for trusted graph ingest")
    print("=" * 64)
    print(f"[*] Done. {len(targets)} target(s), {len(findings)} finding(s).")
    print("=")
    return 0


def main() -> int:
    try:
        return run()
    except Exception as e:  # never crash silently; surface to the orchestrator logs
        log.exception("AI Attack Surface scan crashed")
        print(f"[!] Unexpected error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
