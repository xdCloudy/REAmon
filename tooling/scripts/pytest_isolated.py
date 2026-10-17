#!/usr/bin/env python3
"""Per-file-isolated pytest runner (the RedAmon test gate engine).

Runs each test FILE in its own pytest subprocess, in parallel, and aggregates
the results. This reproduces the isolation the legacy per-file
`python -m unittest tests.test_x` runner gave for free: a large body of these
tests stub langchain/langgraph into sys.modules at import time (and bake real
tool objects against a fake decorator during import), which is order-dependent
in a single shared pytest process. One process per file makes the gate
deterministic. See docs/readmes/README.TESTING.md.

Tiers are inferred from the filename (kept in sync with each conftest.py):
  live:        live_*, *_live*, *_smoke*, smoke_*
  integration: *_integration.py, *_skill.py, *_e2e*
  unit:        everything else

The tier is ALSO passed to pytest as `-m`, so an explicit
``@pytest.mark.{unit,integration,live}`` on a single test inside an otherwise
unit-tier file is honoured. Filename selection alone cannot see inside a file,
which is how a wall-clock test that had opted out of the unit tier still ran in
it - and failed whenever the parallel gate loaded the host.

Usage:
  python tooling/scripts/pytest_isolated.py <tier> <testdir> [<testdir> ...]
        [--parallel N] [--cov PKG --cov-floor N]
  tier ∈ {unit, integration, live, all}   (all = unit+integration, skips live)

Exit code: 0 if every selected file passed (or collected no tests, pytest
exit 5, which is treated as a clean no-op); non-zero otherwise.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import os
import re
import subprocess
import sys

_INT = ("_integration.py", "_skill.py", "_e2e")
_LIVE = ("live_", "_live", "_smoke", "smoke_")


def tier_of(basename: str) -> str:
    n = basename.lower()
    if any(f in n for f in _LIVE):
        return "live"
    if any(f in n for f in _INT):
        return "integration"
    return "unit"


def wanted(t: str, want: str) -> bool:
    if want == "all":
        return t in ("unit", "integration")
    return t == want


_SUMMARY_RE = re.compile(r"\b(\d+) (?:passed|failed|error|errors|xpassed|xfailed)\b")


def tests_executed(output: str) -> int:
    """
    How many test CASES a pytest run reported, from its summary line.

    File counts hide an empty gate: twenty files that each collect one trivial
    test look identical to twenty real suites. The case count is what a reader
    can sanity-check against what the suite is supposed to contain.
    """
    total = 0
    for line in reversed(output.splitlines()):
        if "passed" in line or "failed" in line or "error" in line:
            found = _SUMMARY_RE.findall(line)
            if found:
                return sum(int(n) for n in found)
    return total


def collect_files(testpaths, want, exclude=()):
    """Collect test files from the given paths. Each path may be a directory
    (walked for test_*.py) or an explicit file. `exclude` is a set of basenames
    to skip (used to route certain files to a different section/image)."""
    exclude = set(exclude or ())
    files = []
    for p in testpaths:
        if os.path.isfile(p):
            base = os.path.basename(p)
            if base.startswith("test_") and base.endswith(".py") and base not in exclude:
                if wanted(tier_of(base), want):
                    files.append(p)
            continue
        if not os.path.isdir(p):
            continue
        for root, _dirs, names in os.walk(p):
            if "__pycache__" in root or "/node_modules/" in root:
                continue
            for name in sorted(names):
                if not (name.startswith("test_") and name.endswith(".py")):
                    continue
                if name in exclude:
                    continue
                if wanted(tier_of(name), want):
                    files.append(os.path.join(root, name))
    return sorted(set(files))


_PER_FILE_TIMEOUT = int(os.environ.get("REDAMON_TEST_FILE_TIMEOUT", "600"))


# The pytest marker expression for a tier. Mirrors the conftest auto-marking, so
# a file whose name puts it in this tier still contributes every test that has no
# explicit marker of its own.
_MARKEXPR = {
    "unit": "unit",
    "integration": "integration",
    "live": "live",
    "all": "unit or integration",
}


def run_one(path, extra):
    cmd = [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
           "--no-header", *extra, path]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=_PER_FILE_TIMEOUT)
    except subprocess.TimeoutExpired:
        # A hung file must not block the whole gate forever — treat it as a
        # failure so it is surfaced, not silently waited on.
        return path, 124, f"TIMEOUT after {_PER_FILE_TIMEOUT}s (per-file cap)"
    return path, proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("tier", choices=["unit", "integration", "live", "all"])
    ap.add_argument("testdirs", nargs="+", help="directories and/or explicit test files")
    ap.add_argument("--parallel", type=int, default=int(os.environ.get("REDAMON_TEST_PARALLEL", "8")))
    ap.add_argument("--cov", default=None, help="package/path to measure coverage for")
    ap.add_argument("--cov-floor", type=float, default=None)
    ap.add_argument("--exclude", default="", help="comma-separated basenames to skip")
    args = ap.parse_args()

    exclude = [x for x in (args.exclude or "").split(",") if x]
    files = collect_files(args.testdirs, args.tier, exclude=exclude)
    if not files:
        print(f">> {args.tier}: no test files found under {args.testdirs}")
        return 0

    # Coverage: run SERIALLY with --cov-append into one data file (parallel
    # appends can corrupt it), then report + enforce the floor.
    if args.cov:
        cov_file = os.environ.get("COVERAGE_FILE", "/tmp/redamon.coverage")
        for suffix in ("", *(f".{i}" for i in range(64))):
            try:
                os.remove(cov_file + suffix)
            except OSError:
                pass
        print(f">> {args.tier}: {len(files)} files, coverage on '{args.cov}' (serial)")
        for f in files:
            subprocess.run(
                [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
                 "--no-header", "-m", _MARKEXPR[args.tier],
                 f"--cov={args.cov}", "--cov-append", f],
                capture_output=True, text=True,
            )
        rep = subprocess.run([sys.executable, "-m", "coverage", "report", "--skip-covered"],
                             capture_output=True, text=True)
        print("\n".join(rep.stdout.splitlines()[-30:]))
        if args.cov_floor is not None:
            chk = subprocess.run(
                [sys.executable, "-m", "coverage", "report", f"--fail-under={args.cov_floor:g}"],
                capture_output=True, text=True)
            if chk.returncode != 0:
                print(f">> COVERAGE BELOW FLOOR ({args.cov_floor:g}%)")
                return 1
            print(f">> coverage floor OK (>= {args.cov_floor:g}%)")
        return 0

    print(f">> {args.tier}: {len(files)} files (parallel={args.parallel}, per-file isolation)")
    failures = []
    empty_files = []
    passed = 0
    executed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.parallel)) as ex:
        markexpr = ["-m", _MARKEXPR[args.tier]]
        for path, code, out in ex.map(lambda p: run_one(p, markexpr), files):
            if code == 5:            # no tests collected in this file
                empty_files.append(path)
                continue
            executed += tests_executed(out)
            if code != 0:
                failures.append((path, code, out))
            else:
                passed += 1

    for path, code, out in failures:
        print(f"\n==== FAIL {path} (exit {code}) ====")
        # Preserve pytest's assertion details and traceback in CI. Printing
        # only the short summary made isolated failures impossible to diagnose
        # from the workflow logs, even though each subprocess already captured
        # the useful output. Bound each file so a broken suite cannot flood the
        # action log with an unbounded traceback dump.
        failure_output_limit = 32_000
        if len(out) > failure_output_limit:
            print("[failure output truncated to the final 32,000 characters]\n")
            out = out[-failure_output_limit:]
        print(out.rstrip() or "(pytest produced no output)")

    # A file that collects nothing reads as a pass. It is a signal, not a
    # result: a script-style test with no `def test_` exits 5 and the gate has
    # gone green having asserted nothing. Name them so the count is actionable.
    if empty_files:
        print(f"\n>> {args.tier}: {len(empty_files)} file(s) collected NO tests:")
        for path in empty_files:
            print(f"     {path}")

    print(f"\n>> {args.tier}: {passed} files passed, {len(failures)} failed, "
          f"{len(empty_files)} empty/skipped")
    print(f">> {args.tier}: TESTS EXECUTED: {executed}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
