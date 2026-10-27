"""Trusted graph boundary for AI Attack Surface target resolution and results."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

from graph_db import Neo4jClient

MAX_AI_ATTACK_ARTIFACT_BYTES = 64 * 1024 * 1024
MAX_AI_ATTACK_FINDINGS = 100_000


class AIArtifactValidationError(ValueError):
    """The worker artifact is permanently malformed or bound to another run."""


def _scanner_module(module_name: str):
    candidates = (
        Path("/app/ai_attack_surface_scan"),
        Path(__file__).resolve().parents[1] / "scanners" / "ai_attack_surface_scan",
    )
    module_path = next((root / f"{module_name}.py" for root in candidates
                        if (root / f"{module_name}.py").is_file()), None)
    if module_path is None:
        raise RuntimeError(f"AI attack scanner module is unavailable: {module_name}")
    name = f"_reamon_ai_attack_{module_name}"
    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load AI attack scanner module: {module_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def resolve_targets(user_id: str, project_id: str, selected: list[dict] | None) -> list[dict]:
    """Resolve tenant-scoped graph targets before starting an uncredentialed worker."""
    target_loader = _scanner_module("target_loader")
    uri = os.environ.get("ORCHESTRATOR_NEO4J_URI", "").strip() or "bolt://neo4j:7687"
    with Neo4jClient(uri=uri) as client:
        if not client.verify_connection():
            raise RuntimeError("Neo4j is unreachable; AI attack target selection was not resolved")
        with client.driver.session() as session:
            targets = target_loader.load_targets(
                session, user_id=user_id, project_id=project_id, selected=selected or None,
            )
    from dataclasses import asdict
    return [asdict(target) for target in targets]


def ingest_result_artifact(path: str | Path, *, user_id: str, project_id: str,
                           run_id: str) -> int:
    """Validate a run-bound scanner artifact and idempotently ingest its findings."""
    artifact_path = Path(path)
    if not artifact_path.is_file():
        raise AIArtifactValidationError("AI attack result artifact is unavailable")
    size = artifact_path.stat().st_size
    if size <= 0 or size > MAX_AI_ATTACK_ARTIFACT_BYTES:
        raise AIArtifactValidationError("AI attack result artifact has an invalid size")
    try:
        data = json.loads(artifact_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AIArtifactValidationError("AI attack result artifact is unreadable or invalid JSON") from exc
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise AIArtifactValidationError("AI attack result artifact has an unsupported schema")
    metadata = data.get("metadata")
    if not isinstance(metadata, dict) or any((
        metadata.get("user_id") != user_id,
        metadata.get("project_id") != project_id,
        metadata.get("run_id") != run_id,
    )):
        raise AIArtifactValidationError("AI attack result artifact does not match the completed run")
    findings = data.get("findings")
    targets = data.get("targets")
    if not isinstance(findings, list) or not isinstance(targets, list):
        raise AIArtifactValidationError("AI attack result artifact is missing findings or targets")
    if len(findings) > MAX_AI_ATTACK_FINDINGS:
        raise AIArtifactValidationError("AI attack result artifact exceeds the finding limit")

    normalizer = _scanner_module("normalizer")
    target_index = {
        ((target.get("baseurl") or "").rstrip("/"), target.get("path") or "/"):
            SimpleNamespace(**target)
        for target in targets if isinstance(target, dict)
    }
    normalized = []
    for raw in findings:
        if not isinstance(raw, dict):
            raise AIArtifactValidationError("AI attack artifact contains a malformed finding")
        try:
            finding = normalizer.Finding(**raw)
        except (TypeError, ValueError) as exc:
            raise AIArtifactValidationError("AI attack artifact contains an invalid finding") from exc
        normalized.append(finding)

    uri = os.environ.get("ORCHESTRATOR_NEO4J_URI", "").strip() or "bolt://neo4j:7687"
    with Neo4jClient(uri=uri) as client:
        if not client.verify_connection():
            raise RuntimeError("Neo4j is unreachable")
        with client.driver.session() as session:
            for finding in normalized:
                target = target_index.get(((finding.baseurl or "").rstrip("/"), finding.path or "/"))
                status = normalizer.write_finding(
                    session, finding, user_id, project_id, target=target,
                )
                if status not in ("existing", "created"):
                    raise AIArtifactValidationError("AI attack finding was not linked into the graph")
    return len(normalized)
