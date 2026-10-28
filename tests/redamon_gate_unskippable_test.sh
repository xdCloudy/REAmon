#!/usr/bin/env bash
# =============================================================================
# The gate must not be able to go green having run nothing.
#
# Two silent skips used to exist in `cmd_test`, and both mattered:
#
#   _test_run_webapp   returned 0 when webapp/node_modules was absent
#   _test_run_section  returned 0 when the section's image was not built
#
# The second is the wider hole: a missing `redamon-recon` image skipped every
# runtime test that protects the engagement rate ceiling. Most of the recon
# settings registry's enforcement is TypeScript, so the first skip made the rest
# of that layer unverified too.
#
# These suites assert the SKIP-IS-A-FAILURE behaviour directly, by calling the
# helpers with their inputs missing. They run on the host with no image and no
# node_modules, which is exactly the situation they describe.
#
# Run:  bash tests/redamon_gate_unskippable_test.sh
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1090
source "$REPO_ROOT/redamon.sh"
set +e

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); printf '  \033[0;32mPASS\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  \033[0;31mFAIL\033[0m %s\n' "$1"; }
assert_eq() { if [[ "$2" == "$3" ]]; then pass "$1 ($2)"; else fail "$1 (got='$2' expected='$3')"; fi; }
assert_contains() { if [[ "$2" == *"$3"* ]]; then pass "$1"; else fail "$1 (missing '$3' in: $2)"; fi; }
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then pass "$1"; else fail "$1 (unexpected '$3' in: $2)"; fi; }
section() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# Keep the helpers' own output capturable rather than silenced: several
# assertions below are about WHAT it prints.

# =============================================================================
section "T26: a missing input fails the unit tier"
# =============================================================================

out="$(_test_missing_input demo "the demo image is not built" "build it" unit 2>&1)"
rc=$?
assert_eq "unit tier returns non-zero" "$rc" "1"
assert_contains "names the section" "$out" "demo"
assert_contains "says it cannot run" "$out" "CANNOT RUN"
assert_contains "gives the fix" "$out" "build it"
assert_contains "names the opt-out" "$out" "REDAMON_TEST_ALLOW_MISSING"

out="$(_test_missing_input demo "not built" "build it" all 2>&1)"
assert_eq "all tier also fails" "$?" "1"

out="$(_test_missing_input demo "not built" "build it" coverage 2>&1)"
assert_eq "coverage tier also fails" "$?" "1"

# The narrower tiers are not the gate, so a missing input there is a skip.
out="$(_test_missing_input demo "not built" "build it" live 2>&1)"
assert_eq "live tier still skips" "$?" "0"

# =============================================================================
section "T26: the opt-out is deliberate, named, and loud"
# =============================================================================

out="$(REDAMON_TEST_ALLOW_MISSING=demo _test_missing_input demo "not built" "build it" unit 2>&1)"
assert_eq "an allowed section returns 0" "$?" "0"
assert_contains "but prints SKIPPED" "$out" "SKIPPED"
assert_contains "and names the opt-out that allowed it" "$out" "REDAMON_TEST_ALLOW_MISSING"

out="$(REDAMON_TEST_ALLOW_MISSING=other _test_missing_input demo "not built" "build it" unit 2>&1)"
assert_eq "a DIFFERENT section in the opt-out does not allow this one" "$?" "1"

out="$(REDAMON_TEST_ALLOW_MISSING=all _test_missing_input demo "not built" "build it" unit 2>&1)"
assert_eq "'all' allows any section" "$?" "0"

out="$(REDAMON_TEST_ALLOW_MISSING="webapp, demo ,recon" _test_missing_input demo "not built" "build it" unit 2>&1)"
assert_eq "a comma list tolerates spaces" "$?" "0"

# An empty opt-out is not an opt-out. This is the case a CI config reaches by
# exporting the variable unset, and it must not silently open the gate.
out="$(REDAMON_TEST_ALLOW_MISSING= _test_missing_input demo "not built" "build it" unit 2>&1)"
assert_eq "an empty opt-out still fails" "$?" "1"

# =============================================================================
section "T26: the real call sites route through it"
# =============================================================================

# Webapp tests must use the Docker target, independent of host node_modules.
# Fake Docker so this routing contract remains hermetic.
_saved_dir="$SCRIPT_DIR"
SCRIPT_DIR="$(mktemp -d)"
docker() { printf 'docker %s\n' "$*"; }
out="$(_test_run_webapp unit 2>&1)"
assert_eq "_test_run_webapp succeeds through Docker" "$?" "0"
assert_contains "builds from the repository root context" "$out" "Dockerfile.test"
assert_contains "uses the whole repository as its test context" "$out" "docker build"
assert_contains "runs the test script in the container" "$out" "run test"
assert_contains "does not invoke host npm" "$out" "docker run --rm --entrypoint npm"

docker() {
    printf 'docker %s\n' "$*"
    [[ "$1" != "build" ]]
}
out="$(_test_run_webapp coverage 2>&1)"
assert_eq "failed image build fails the coverage gate" "$?" "1"
assert_not_contains "does not run tests after a failed image build" "$out" "docker run"

out="$(_test_run_webapp live 2>&1)"
assert_eq "_test_run_webapp still skips outside the gate tiers" "$?" "0"
unset -f docker

# shell suites: no tests/*_test.sh -> non-zero for the gate tier.
out="$(_test_run_shell unit 2>&1)"
assert_eq "_test_run_shell fails when no suites are found" "$?" "1"
rmdir "$SCRIPT_DIR" 2>/dev/null
SCRIPT_DIR="$_saved_dir"

# section: an image that cannot exist -> non-zero for the gate tier.
if command -v docker >/dev/null 2>&1; then
    out="$(_test_run_section demo redamon-no-such-image-xyz /repo /repo tests . "" unit 2>&1)"
    assert_eq "_test_run_section fails on an unbuilt image" "$?" "1"
    assert_contains "names the image" "$out" "redamon-no-such-image-xyz"
else
    pass "docker absent, section-image case not exercised (helper covered above)"
fi

# =============================================================================
section "T27: the runner reports an executed-test count"
# =============================================================================

runner="$REPO_ROOT/tooling/scripts/pytest_isolated.py"
if command -v python3 >/dev/null 2>&1; then
    # Git Bash reports repository paths as /c/... while the Windows Store Python
    # launcher expects a Windows path. Keep this test portable across Windows
    # Git Bash and POSIX runners.
    python_runner_path="$REPO_ROOT/tooling/scripts"
    if command -v cygpath >/dev/null 2>&1; then
        python_runner_path="$(cygpath -w "$python_runner_path")"
    fi
    out="$(python3 -c "
import sys
sys.path.insert(0, r'$python_runner_path')
from pytest_isolated import tests_executed
print(tests_executed('==== 12 passed, 3 skipped in 1.2s ===='))
print(tests_executed('==== 4 failed, 20 passed in 2s ===='))
print(tests_executed('nothing here'))
" 2>&1)"
    assert_eq "a summary line is counted" "$(echo "$out" | sed -n 1p)" "12"
    assert_eq "failures count as executed" "$(echo "$out" | sed -n 2p)" "24"
    assert_eq "no summary means zero" "$(echo "$out" | sed -n 3p)" "0"
    assert_contains "the runner prints the count" "$(grep -c 'TESTS EXECUTED' "$runner")" "1"
    assert_contains "the runner names files that collected nothing" \
        "$(grep -c 'collected NO tests' "$runner")" "1"
else
    fail "python3 unavailable; cannot check the runner"
fi

printf '\n\033[1mresult:\033[0m %d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
