#!/usr/bin/env bash
# =============================================================================
# Test suite for `./redamon.sh update`'s changed-file -> core-service map
# (_map_core_changes).
#
# The map is the only thing that decides whether an update rebuilds a service
# whose source is baked into its image. A path it does not cover is updated on
# disk and silently NOT in the running container. recon_settings/ was such a
# path: the agent COPY-bakes it and refuses every RoE upload with a 503 once the
# registry digest it was built with no longer matches.
#
# Hermetic: sources redamon.sh, no git, no Docker. Run:
#   bash tests/redamon_update_map_test.sh
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1090
source "$REPO_ROOT/redamon.sh"
set +e

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); printf '  \033[0;32mPASS\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  \033[0;31mFAIL\033[0m %s\n' "$1"; }
assert_eq() { if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (got='$2' expected='$3')"; fi; }
section() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# map <changed files, one per line> -> "rebuild=<...> restart=<...>"
map() {
    local rebuild_core=() restart_only=()
    _map_core_changes "$1"
    echo "rebuild=${rebuild_core[*]-} restart=${restart_only[*]-}"
}

section "recon_settings/ is baked into the agent and mounted by the orchestrator"
assert_eq "a registry-only release rebuilds the agent and restarts the orchestrator" \
    "$(map 'recon_settings/registry.json')" \
    "rebuild=agent restart=recon-orchestrator"
assert_eq "the generated RoE prompt alone does the same" \
    "$(map 'recon_settings/roe_parse_prompt.py')" \
    "rebuild=agent restart=recon-orchestrator"
assert_eq "an agentic/ change in the same release rebuilds the agent once" \
    "$(map $'agentic/api.py\nrecon_settings/registry.yaml')" \
    "rebuild=agent restart=recon-orchestrator"
assert_eq "an orchestrator source change in the same release restarts it once" \
    "$(map $'recon_orchestrator/api.py\nrecon_settings/registry.json')" \
    "rebuild=agent restart=recon-orchestrator"
assert_eq "an orchestrator that is rebuilt anyway is not restarted as well" \
    "$(map $'recon_orchestrator/Dockerfile\nrecon_settings/registry.json')" \
    "rebuild=recon-orchestrator agent restart="

section "the existing rules are unchanged"
assert_eq "webapp/ rebuilds the webapp" "$(map 'webapp/src/lib/triageRun.ts')" "rebuild=webapp restart="
assert_eq "agentic/ rebuilds the agent" "$(map 'agentic/cypherfix_triage/layers.py')" "rebuild=agent restart="
assert_eq "graph_db/ rebuilds the agent" "$(map 'graph_db/mixins/recon/triage_mixin.py')" "rebuild=agent restart="
assert_eq "project worker image source rebuilds its image" \
    "$(map 'services/project_worker/Dockerfile')" "rebuild=project-worker-image restart="
assert_eq "docker broker source rebuilds the core broker" \
    "$(map 'services/docker_broker/project_worker.py')" "rebuild=docker-broker restart="
assert_eq "an orchestrator .py change only restarts it" "$(map 'recon_orchestrator/api.py')" \
    "rebuild= restart=recon-orchestrator"
assert_eq "an mcp/ change only restarts the sandbox" "$(map 'mcp/servers/foo.py')" "rebuild= restart=kali-sandbox"
assert_eq "docs and tests rebuild nothing" "$(map $'docs/readmes/README.md\ntests/test_x.py\nskills/a/SKILL.md')" \
    "rebuild= restart="

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[[ $FAIL -eq 0 ]]
