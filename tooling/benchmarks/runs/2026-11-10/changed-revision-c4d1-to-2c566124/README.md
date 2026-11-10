# Changed-revision three-format matrix — 2026-11-10

This AR-0/AR-8 matrix compares product source `c4d1e957b920e9f725db40266d81425852cd86fb` against `2c5661240352fdbe3810433d1f1e3e40ef51bc51`. All fixture receipts on each side share one clean measurement commit: baseline `3d84a42b7cd340aec5a5ee049303a8995519028b`, candidate `23cb87edf70b5e3b39c56eb4c3125dc8ab7bdb9b`. Product-source commits are recorded separately. Fixture-specific evaluation and toolchain manifests are hash-bound.

| Fixture | Live and bounded evidence | Metrics | Result |
| --- | --- | ---: | --- |
| JVM/CFR, two classes | PostgreSQL persistence passed 1/1 per side; 2/2 exact bytecode classes, matching stdout, and 8,197 sampled inputs | 5 | zero deltas |
| PyInstaller structured source, 180 modules | PostgreSQL/worker integration passed 2/2 per side; 70/70 known-source matches, 70/70 mutation rejections, 0/70 false acceptances | 7 | zero deltas |
| Stripped Lua 5.4, one module | PostgreSQL persistence passed 1/1 per side; persisted-source SHA verified; parser and 10/10 runtime inputs passed | 8 | containment improved 0/1 to 1/1; seven zero deltas |

The aggregate reports `NO_REGRESSION_OBSERVED`, clean worktrees, and no thresholds applied. The PyInstaller runtime oracle is inherited from its enrollment receipt, not re-executed in these pair runs. Overall, 20 fixture metrics are measured: one improvement and 19 zero deltas.

These are three synthetic fixtures, not broad language or toolchain coverage. The Lua runtime oracle samples ten inputs and is not exhaustive. The comparison does not establish full project reconstruction, dependency recovery, or production readiness.
