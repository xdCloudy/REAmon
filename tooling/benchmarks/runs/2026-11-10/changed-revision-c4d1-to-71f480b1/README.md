# Changed-revision JVM and PyInstaller matrix — 2026-11-10

This AR-0/AR-8 comparison measures product source `c4d1e957b920e9f725db40266d81425852cd86fb` against `71f480b131d4bacc9955b0933a56cb5542591421` on two enrolled synthetic fixtures. Baseline measurement checkout `5f63d5e4d8fe5e7cbd910b8a4aa5a5bcaf1c7e14` contains a clean local harness overlay recorded in `baseline-measurement-overlay.patch`; candidate measurements use clean checkout `71f480b131d4bacc9955b0933a56cb5542591421`. Each side has one measurement commit and one product source commit across both fixture receipts.

The aggregate comparison reports `NO_REGRESSION_OBSERVED`, clean worktrees, no thresholds, no regressions, and zero deltas across all 12 measured metrics.

| Fixture | Bounded evidence on both revisions | Metrics |
| --- | --- | ---: |
| JVM/CFR, artifact SHA-256 `747346a392096bdac3613ac295ee4b8a743e22689a3738aeca1ad8ffc92fb7cf` | 2/2 recovered source files persisted with SHA-verified database rows; 2/2 exact bytecode classes; runtime oracle and 8,197 sampled behavior inputs match | 5 |
| PyInstaller structured source, artifact SHA-256 `746c550fc3324ebf285c0ee4a555ea2afb3d5b12c9c191eb2bf4f0978d263971` | 180 modules inventoried; 70/70 known values and structured source matches; 70/70 mutations rejected and 0/70 false acceptances; enrolled runtime oracle and live worker terminal page pass | 7 |

Both PyInstaller live PostgreSQL/worker runs passed 2/2 integration tests. Both JVM database persistence runs passed 1/1 integration test. Fixture-specific evaluation contracts and pinned toolchains are retained separately and hash-bound in the receipts. The PyInstaller runtime oracle is inherited from its enrollment build receipt rather than re-executed in this comparison. CFR, PyInstaller, pycdc, worker, and integration-test images were held constant within each fixture pair.

This is evidence that the measured paths remain stable across these two product source revisions. It does not show a fidelity improvement or establish broad language coverage, provider-version changes, full project reconstruction, exhaustive behavioral equivalence, or production readiness. No fixture executables or recovered source outputs are included in this archive.

`matrix-config.json` and `fixture-manifest.json` define the aggregate. Per-fixture directories contain manifests, toolchain records, receipts, and measured evidence. `aggregate/` contains baseline/candidate matrix receipts, comparison, provenance, and manifest indexes.