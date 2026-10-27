"""Target resolver and worker snapshot parser (§6.1).

The trusted orchestrator reads the AI surface that recon annotated and renders
the §2 selectors. The uncredentialed attack worker only parses the resulting
target snapshot. Each tool declares its `applies_to` interface-type filter; the
resolver applies it. No tool reimplements node selection.

The request shape comes from recon automatically (§2.3): each Endpoint already
carries ai_interface_type / ai_model_family_guess / ai_supports_* so the attack
tools are pre-configured from the graph.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger("ai-attack-surface")


# Attack-type -> applicable Endpoint.ai_interface_type values (§2.1).
INTERFACE_FILTERS: dict[str, list[str]] = {
    "llm-chat": ["llm-chat"],
    "llm-chat-completion": ["llm-chat", "llm-completion"],
    "llm-tool-call": ["llm-tool-call"],
    "mcp": ["mcp"],
}

# The chat surface the four core tools attack (§2.2). recon stamps EVERY crawled
# endpoint with an ai_interface_type, using the literal 'non-llm' sentinel for
# non-LLM endpoints — so "IS NOT NULL" is NOT a safe selector. The headless
# (no-explicit-selection) path defaults to these attackable types; non-chat
# tools (future RAG/tool-call cards) pass their own interface_types.
ATTACK_SURFACE_INTERFACE_TYPES: list[str] = ["llm-chat", "llm-completion"]
# Sentinel recon writes for classified-but-not-LLM endpoints — never attackable.
NON_LLM_SENTINEL = "non-llm"


@dataclass
class Target:
    """A selected attack target, enriched from recon annotations."""
    baseurl: str
    path: str
    method: str = "POST"
    ai_interface_type: str | None = None
    ai_model_family_guess: str | None = None
    ai_model_ids: list | None = None
    ai_supports_tools: bool | None = None
    ai_supports_streaming: bool | None = None

    @property
    def url(self) -> str:
        base = (self.baseurl or "").rstrip("/")
        path = self.path or "/"
        if not path.startswith("/"):
            path = "/" + path
        return f"{base}{path}"


_RETURN = """
    e.baseurl AS baseurl, e.path AS path,
    coalesce(e.method, 'POST') AS method,
    e.ai_interface_type AS ai_interface_type,
    e.ai_model_family_guess AS ai_model_family_guess,
    e.ai_model_ids AS ai_model_ids,
    e.ai_supports_tools AS ai_supports_tools,
    e.ai_supports_streaming AS ai_supports_streaming
"""


def _row_to_target(row) -> Target:
    return Target(
        baseurl=row.get("baseurl") or "",
        path=row.get("path") or "/",
        method=row.get("method") or "POST",
        ai_interface_type=row.get("ai_interface_type"),
        ai_model_family_guess=row.get("ai_model_family_guess"),
        ai_model_ids=row.get("ai_model_ids"),
        ai_supports_tools=row.get("ai_supports_tools"),
        ai_supports_streaming=row.get("ai_supports_streaming"),
    )


def targets_from_payload(rows: list[dict] | None) -> list[Target]:
    """Build targets already resolved by the trusted orchestrator.

    Scan workers receive only tenant-authorized target records; they never need
    graph credentials or direct access to the project's graph.
    """
    targets = []
    for row in rows or []:
        if not isinstance(row, dict) or not row.get("baseurl"):
            continue
        targets.append(_row_to_target(row))
    return targets


def load_targets(
    session,
    user_id: str,
    project_id: str,
    interface_types: list[str] | None = None,
    selected: list[dict] | None = None,
) -> list[Target]:
    """Load attack targets from the graph.

    - `selected`: explicit picker rows ({baseurl, path, method}); each is matched
      to its Endpoint and enriched. This is the normal UI path (the user must
      explicitly select which nodes to attack, §2).
    - else: load every attackable chat Endpoint. `interface_types` narrows it;
      when omitted it defaults to the chat surface (NOT "any ai_interface_type"
      — recon stamps every crawled endpoint, mostly with the 'non-llm' sentinel).
    """
    if selected:
        return _load_selected(session, user_id, project_id, selected)
    if interface_types is None:
        interface_types = ATTACK_SURFACE_INTERFACE_TYPES
    return _load_all_ai(session, user_id, project_id, interface_types)


def _load_all_ai(session, user_id, project_id, interface_types) -> list[Target]:
    cypher = f"""
        MATCH (e:Endpoint {{user_id: $uid, project_id: $pid}})
        WHERE e.ai_interface_type IN $ifaces
          AND e.ai_interface_type <> $non_llm
        RETURN {_RETURN}
    """
    rows = session.run(cypher, uid=user_id, pid=project_id,
                       ifaces=interface_types, non_llm=NON_LLM_SENTINEL)
    targets = [_row_to_target(r.data()) for r in rows]
    logger.info(f"Target loader: {len(targets)} AI endpoint(s) (filter={interface_types})")
    return targets


def _load_selected(session, user_id, project_id, selected) -> list[Target]:
    targets: list[Target] = []
    for sel in selected:
        baseurl = sel.get("baseurl")
        path = sel.get("path") or "/"
        method = sel.get("method")
        if not baseurl:
            logger.warning(f"Skipping selection without baseurl: {sel}")
            continue
        cypher = f"""
            MATCH (e:Endpoint {{baseurl: $baseurl, user_id: $uid, project_id: $pid}})
            WHERE e.path = $path AND ($method IS NULL OR coalesce(e.method,'POST') = $method)
            // Prefer the AI-typed endpoint over a bare sibling on the same path.
            WITH e ORDER BY (CASE WHEN e.ai_interface_type IS NOT NULL THEN 0 ELSE 1 END) LIMIT 1
            RETURN {_RETURN}
        """
        row = session.run(
            cypher, baseurl=baseurl, path=path, method=method,
            uid=user_id, pid=project_id,
        ).single()
        if row:
            targets.append(_row_to_target(row.data()))
        else:
            # Not in the graph: either a custom URL the operator typed, or a
            # selection the graph lost. Build a placeholder from the raw
            # selection, carrying any interface_type/model the operator supplied
            # for a custom target (so the request shape can still be inferred).
            model = sel.get("model")
            model_ids = [model] if model else None
            if sel.get("custom"):
                logger.info(f"Custom (off-graph) target: {baseurl}{path}")
            else:
                logger.warning(f"Selected endpoint not found in graph: {baseurl} {path}")
            targets.append(Target(
                baseurl=baseurl, path=path, method=method or "POST",
                ai_interface_type=sel.get("interface_type"),
                ai_model_ids=model_ids,
            ))
    logger.info(f"Target loader: {len(targets)} selected endpoint(s)")
    return targets
