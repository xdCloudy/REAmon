# Same revision, multi-format repeatability matrix

This archived AR-8 matrix runs two independently enrolled fixtures twice at the same clean product revision, `3b67737c436e556a3cdd244d9a18588a24747604`. The baseline and candidate labels identify repeat measurements, not different product revisions. Both receipts record that product revision in `productSourceCommit`; the measurement checkout `commit` is the same direct source checkout. Toolchain manifests contain only fixed tool and service revisions, so they remain reusable for changed-revision comparisons. The result validates that the heterogeneous receipt pipeline can bind distinct fixture contracts and toolchains and compare complete evidence without regression; it does not claim a product improvement.

## Result

- Aggregate status: `NO_REGRESSION_OBSERVED`; both receipt sides report the same full commit and clean worktrees.
- JVM/CFR fixture: 2/2 source files, complete inventory, 2/2 exact `javap` classes, runtime output match, and 8,197/8,197 sampled behavior inputs match on each side. CFR and pinned JDK image IDs are fixed in the fixture toolchain manifest.
- PyInstaller fixture: 180-module inventory, 70/70 known-source values, 70/70 structured source matches, 70/70 mutation rejections, 0/70 false acceptances, and completed worker page on each side. Both integration runs passed 2/2 live database/worker tests. The runtime oracle is inherited from the pinned enrollment build receipt; the integration test itself does not execute the fixture.
- Every paired metric delta is zero. This is one synthetic Java fixture and one synthetic Python/PyInstaller fixture, not broad language coverage, exhaustive behavior equivalence, or a changed-revision regression result.

## Files

`matrix-config.json` and `fixture-manifest.json` define the aggregate. The `jvm/` and `pyinstaller/` directories retain the exact fixture/evaluation/toolchain manifests and constituent receipts. `aggregate/` contains the combined baseline, candidate, comparison, provenance, and fixture contract indexes. Recovered source files and executable artifacts are intentionally not part of the archive.

The matrix tooling and previous changed-revision slice are documented in [`../../README.md`](../../../README.md).
