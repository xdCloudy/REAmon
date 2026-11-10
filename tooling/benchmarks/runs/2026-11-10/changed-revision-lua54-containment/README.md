# Changed-revision Lua 5.4 containment check — 2026-11-10

This paired AR-0/AR-8 slice compares product source `c4d1e957b920e9f725db40266d81425852cd86fb` with `2c5661240352fdbe3810433d1f1e3e40ef51bc51` on the same stripped Lua 5.4 artifact (`8ac4c0d9e5b3261c688f1dcf62394fbe3a1431355cf26dc71264b37844362ef0`). The fixture source was hidden from the analyzer input and compiled with pinned Lua 5.4.4 tooling.

The baseline live PostgreSQL integration passed 1/1. It persisted the module and function prototypes, but no containment observation from the module to its top-level prototypes. The candidate integration passed 1/1 and persists that relationship. Both sides read the recovered source back from the derived volume through the persisted code-unit observation; the source hashes match (`b692c2bafd99ac0d7c07199927e65bcf8f5e609528d8b7a3af75c534d2e89a21`). Both recovered sources parse with `luac5.4 -p` and match the original runtime output on all 10 enrolled integer inputs.

The receipt comparator reports `NO_REGRESSION_OBSERVED`: one measured improvement (`persisted_contains_relationships`, 0 to 1) and zero deltas across the other seven metrics. Baseline and candidate measurement checkouts were clean; receipts bind product-source commits separately from their benchmark harness commits and share the same artifact, evaluation manifest, and pinned toolchain contract.

This verifies one synthetic Lua 5.4 module and ten sampled inputs. It does not prove exhaustive equivalence, project dependency recovery, or coverage of other Lua dialects. It is a standalone third-format changed-revision slice; the JVM and PyInstaller receipts in the earlier two-format matrix have not yet been rerun at these exact source revisions.
