# Mutated-artifact provider control — 2026-11-09

This archive records a matched baseline/candidate run of the behavior-mutated
PyInstaller executable. Both clean clones use product commit
`aef36478e647bef9c33eafdd3b9b87dfeb6b2536`, pushed directly to `main`. The
comparison is a same-commit repeatability check, not a product-improvement
claim. The fixture artifact SHA-256 is
`aecfd1df0d72809f1b09fff28fb7f29eb081b4a00eeb347164a16b4b84df610f`.

## Measured results

`comparison.json` reports `NO_REGRESSION_OBSERVED`, with no metric deltas across
the six declared measurements. On both successful sides:

- The runtime oracle passed (1/1) and the executable printed `2485`.
- The provider enumerated 180 modules; known source values matched 70/70.
- Recovered source matched the mutated `"under"` oracle for 70/70 known modules.
- The original `"below"` source was falsely accepted 0/70 times.
- The queued worker reached its terminal page (1/1).
- The direct PostgreSQL integration and queued-worker integration passed 2/2.

These measurements exercise the executable through REAmon's live direct
provider and queued worker. The hidden source is held by the evaluator and is
not mounted into the analyzer or provider. This is one synthetic Python
3.12.8 / PyInstaller 6.13.0 Linux x86-64 fixture and does not establish general
source fidelity, cross-format accuracy, malformed or obfuscated handling,
whole-project reconstruction, or behavioral equivalence beyond the fixture's
explicit assertions.

## Repeatability observation

The first candidate integration attempt had one failure: the direct test's
final smoke assertion selected an arbitrary decompiled module and found an
empty persisted source file. All 70 scored known modules had already passed
their content checks before that assertion. The queued-worker test passed on
the first attempt, and a retry from the same clean candidate clone passed both
tests and produced the archived candidate evidence. The failed attempt did not
emit evidence JSON because the integration suite only writes evidence after the
direct test completes. The event is retained in
[`repeatability-note.md`](repeatability-note.md); it is outside the scored
fixture set and does not count as a successful run or alter the paired metrics.
The test now checks source hashes for each scored module instead of selecting an
unrelated decompiled row.

## Provenance

The paired receipts bind the same clean product commit, matching fixture and
evaluation hashes, clean worktrees, and exact toolchain image IDs. The raw
integration evidence and merged evidence are both included. The exact builder,
requirements, fixture recipe, manifests, enrollment record, and build receipt
used by the merger are archived alongside the comparison. The builder and
isolated extractor ran in Docker; the target executable was not run on the
host. The full `./redamon.sh test unit` gate was not run for this measurement.
