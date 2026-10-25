"""P18-P20: the published and agent-facing docs do not name what no longer exists.

Deliberately crude. These cannot tell whether a page is well written, only
whether it still names something that was deleted - which is the failure that
actually happens, and the one that is worst where it happens:

  a WIKI page          two of them are mirrored to redamon.org, so a stale claim
                       is public rather than internal
  an AGENT-FACING      the guides under docs/readmes/coding_agent_prompts/ are
  guide                the instructions a coding agent follows. A stale line
                       there does not mislead a reader, it produces wrong code
                       that passes review because the guide said to write it
  a runtime string     playbook.ts is read by the connected agent at run time,
                       so a line naming a deleted tool sends it after something
                       that answers "unknown tool"
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
WIKI = REPO_ROOT / "redamon.wiki"
PROMPTS = REPO_ROOT / "docs" / "readmes" / "coding_agent_prompts"
SKILLS = REPO_ROOT / "skills"

pytestmark = pytest.mark.skipif(not WIKI.is_dir(), reason="the wiki checkout is not present")


def _wiki_pages() -> list[Path]:
    return sorted(WIKI.glob("*.md"))


# --- P18: no wiki page names a deleted tool or disposition -------------------------------

#: Things this programme removed. A page naming one is stale, full stop.
_GONE = {
    "tighten_engagement_roe": "the tool was deleted; the limits are ordinary settings now",
    "tighten_only": "the disposition was deleted; there are three, not four",
    "tighten-only": "the disposition was deleted; there are three, not four",
}


@pytest.mark.parametrize("term", sorted(_GONE))
def test_p18_no_wiki_page_names_something_that_was_deleted(term):
    offenders = []
    for page in _wiki_pages():
        for i, line in enumerate(page.read_text(encoding="utf-8").split("\n"), 1):
            if term in line:
                offenders.append(f"{page.name}:{i}: {line.strip()[:120]}")
    assert offenders == [], f"{term}: {_GONE[term]}"


def test_p18_no_wiki_page_calls_the_engagement_record_mcp_settable():
    """The record is UI-only, and a page saying otherwise sends somebody to a refusal."""
    claims = re.compile(
        r"roe(ClientName|ClientContact\w*|EmergencyContact|Notes|RawText|EngagementType)"
        r"[^\n]{0,80}(settable|update_recon_settings|writable)",
        re.I,
    )
    offenders = []
    for page in _wiki_pages():
        for i, line in enumerate(page.read_text(encoding="utf-8").split("\n"), 1):
            if claims.search(line):
                offenders.append(f"{page.name}:{i}: {line.strip()[:120]}")
    assert offenders == []


def test_p18_the_roe_page_states_the_split():
    """The page's whole subject changed; a page that still describes one concept is stale."""
    page = WIKI / "Rules-of-Engagement.md"
    if not page.is_file():
        pytest.skip("the wiki checkout does not include Rules-of-Engagement.md")
    text = page.read_text(encoding="utf-8")
    assert "Engagement limits" in text
    assert "Engagement record" in text
    # The claim Part C removes.
    assert "become read-only afterward" not in text


def test_p18_no_page_claims_the_roe_settings_are_fixed_at_creation():
    """They are not. Only the RECORD is; the limits are editable for the project's life."""
    offenders = []
    stale = re.compile(r"RoE settings are (configured|fixed).{0,60}(creation|created)", re.I)
    for page in _wiki_pages():
        for i, line in enumerate(page.read_text(encoding="utf-8").split("\n"), 1):
            if stale.search(line):
                offenders.append(f"{page.name}:{i}: {line.strip()[:120]}")
    assert offenders == []


# --- P20: no agent-facing guide names a deny reason the registry dropped ------------------

def _agent_facing_files() -> list[Path]:
    out: list[Path] = []
    if PROMPTS.is_dir():
        out += sorted(PROMPTS.glob("*.md"))
    if SKILLS.is_dir():
        out += sorted(SKILLS.rglob("*.md"))
    return out


def _registry_deny_reasons() -> set[str]:
    import json

    schema = json.loads(
        (REPO_ROOT / "recon_settings" / "registry.schema.json").read_text(encoding="utf-8")
    )
    return set(schema["definitions"]["deny_reason"]["enum"])


#: Reasons an earlier model defined and this one does not. `unbounded` is the one
#: that mattered: a guide told an agent to deny a field for having no UI bound,
#: and the field then became unreachable with nothing failing.
_RETIRED_REASONS = ["unbounded", "othertarget", "intrusive", "wordlist", "headers", "egress"]


def test_p20_the_retired_reasons_really_are_retired():
    """If one of these came back, the test below would be asserting the wrong thing."""
    live = _registry_deny_reasons()
    assert [r for r in _RETIRED_REASONS if r in live] == []


#: A line that says a thing does NOT exist is the instruction we want, not the one
#: we are hunting. Without this the guards fail on their own replacement text,
#: which teaches people to delete the guard rather than the stale line.
_NEGATED = re.compile(r"\b(no|not|never|stopped|deleted|removed|replaced|retired)\b", re.I)


@pytest.mark.parametrize("reason", _RETIRED_REASONS)
def test_p20_no_agent_facing_guide_names_a_retired_deny_reason(reason):
    """Matched on the `deny_reason` KEY, not on the bare word.

    `egress` is also the name of a real guard in the capture proxy, and
    `wordlist` is a real thing a tool reads. Only a line that presents one of
    these AS a deny reason is stale.
    """
    pattern = re.compile(rf"deny[ _-]?reason[^\n]{{0,60}}[`\'\"]{reason}[`\'\"]", re.I)
    offenders = []
    for path in _agent_facing_files():
        for i, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
            if pattern.search(line) and not _NEGATED.search(line):
                offenders.append(f"{path.relative_to(REPO_ROOT)}:{i}: {line.strip()[:120]}")
    assert offenders == []


# --- P19: no guide tells an agent to hand-edit a generated artifact -----------------------

#: Files a generator owns. Editing one by hand is undone by the next build, and
#: the drift test fails afterwards rather than at the edit.
_GENERATED = [
    "reconSettingsAllowlist.generated.ts",
    "registry.json",
    "roe_parse_prompt.py",
    "MCP-API-Reference.md",
    "Project-Settings-Registry.md",
]

_EDIT_VERB = re.compile(
    r"\b(edit|add to|update|hand-edit|modify|append to|extend)\b[^\n]{0,80}", re.I
)


@pytest.mark.parametrize("artifact", _GENERATED)
def test_p19_no_guide_instructs_editing_a_generated_artifact(artifact):
    offenders = []
    for path in _agent_facing_files():
        for i, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
            if artifact not in line:
                continue
            # A line that says it is generated, or says NOT to edit it, is the
            # instruction we want rather than the one we are hunting.
            if re.search(r"\b(generated|never edit|do not edit|build artifact|regenerat)", line, re.I):
                continue
            if _EDIT_VERB.search(line):
                offenders.append(f"{path.relative_to(REPO_ROOT)}:{i}: {line.strip()[:140]}")
    assert offenders == []


def test_p19_no_guide_teaches_the_deleted_allow_deny_tables():
    """The positive allowlist was replaced by registry dispositions.

    A guide still teaching "add the column to the ALLOW table" produces code
    against a file that no longer exists.
    """
    # An INSTRUCTION to use one, not a mention of it. "There is no ALLOW/DENY
    # table" is the correction, and flagging it would teach people to delete the
    # guard rather than the stale line.
    pattern = re.compile(
        r"\b(add|put|place|classif\w*|goes|sits|appears)\b[^\n]{0,80}(ALLOW|DENY)[ /]*(or[ ]*DENY)?\s+table",
        re.I,
    )
    offenders = []
    for path in _agent_facing_files():
        for i, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
            if pattern.search(line) and not _NEGATED.search(line):
                offenders.append(f"{path.relative_to(REPO_ROOT)}:{i}: {line.strip()[:140]}")
    assert offenders == []


def test_p19_no_guide_names_the_deleted_tool():
    offenders = []
    for path in _agent_facing_files():
        for i, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
            if "tighten_engagement_roe" in line:
                offenders.append(f"{path.relative_to(REPO_ROOT)}:{i}: {line.strip()[:140]}")
    assert offenders == []
