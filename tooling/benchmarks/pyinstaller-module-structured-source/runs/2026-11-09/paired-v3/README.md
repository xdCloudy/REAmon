# PyInstaller structured-source paired run — 2026-11-09

This archive contains a matched baseline/candidate measurement for the v3 synthetic PyInstaller fixture. Both receipts were generated from clean checkouts at product commit `87203c3f408d1d574c3d49f1d6af79274f57c569`; baseline and candidate are the same product revision. This is a repeatability and scoped no-regression check, not evidence of improvement over an earlier revision.

## Measured results

The comparator returned `NO_REGRESSION_OBSERVED`, with no regressions and clean receipts on both sides. Baseline and candidate were equal on all five measured values:

- Runtime oracle: 1/1 passed.
- Extracted modules: 180/180.
- Known module values: 70/70.
- Structured source matches: 70/70, where each expected module includes a value, function, and branch body.
- Worker terminal page: 1/1.

The artifact SHA-256 is `746c550fc3324ebf285c0ee4a555ea2afb3d5b12c9c191eb2bf4f0978d263971`. The isolated extractor enumerated pages of 64, 64, and 52 modules. The integration test ran direct PostgreSQL persistence and the queued-worker path in each clean checkout; each run passed 2/2 tests.

## Scope and limits

This evidence covers one synthetic Linux x86-64 executable built with PyInstaller 6.13.0 from Python 3.12.8. The test oracle knows the generated fixture sources; those sources were not provided to the analyzer services. The 70 source checks cover only the known modules in this fixture. The other 110 enumerated modules are not source-scored. The result does not establish fidelity for other binaries, project-level reconstruction, or general behavioural equivalence. The full `./redamon.sh test unit` gate was not run for this measurement.

## Provenance

`fixture-manifest.json`, `evaluation-manifest.json`, and `enrollment-receipt.json` are byte-for-byte copies of the checked-in contract files used by the merger. `build-receipt.json` records the artifact builder and extractor. `baseline-integration-evidence.json` and `candidate-integration-evidence.json` are the raw outputs from the two clean worktrees. The paired `*-evidence.json` files add builder/oracle measurements; each receipt binds its merged evidence, manifest hashes, toolchain manifest, commit, and clean-worktree state. `comparison.json` is the comparator output.
