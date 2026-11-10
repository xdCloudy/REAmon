# Benchmark matrix tooling

`aggregate_matrix_receipts.py` combines independently measured, per-fixture
baseline/candidate receipts into one comparison. It is the aggregation step of
AR-8; it does not build fixtures, run providers, or execute targets. Fixture
execution adapters must produce receipts first.

The matrix config points at a combined fixture manifest, then binds each
fixture ID to its one-fixture manifest, evaluation contract, toolchain manifest,
and paired receipts. A top-level evaluation or toolchain manifest can serve as
the shared default; fixture-specific manifests let native, managed, and bytecode
fixtures retain their own metrics, denominators, and provider versions:

```json
{
  "schemaVersion": 1,
  "fixtureManifest": "corpus.json",
  "toolchainManifest": "toolchain.json",
  "fixtures": {
    "native-linux-debug": {
      "fixtureManifest": "native-linux-debug.json",
      "evaluationManifest": "evaluations/native.json",
      "toolchainManifest": "toolchains/native.json",
      "baselineReceipt": "runs/baseline/native-linux-debug.json",
      "candidateReceipt": "runs/candidate/native-linux-debug.json"
    },
    "managed-jar": {
      "fixtureManifest": "managed-jar.json",
      "evaluationManifest": "evaluations/managed.json",
      "toolchainManifest": "toolchains/managed.json",
      "baselineReceipt": "runs/baseline/managed-jar.json",
      "candidateReceipt": "runs/candidate/managed-jar.json"
    }
  }
}
```

The matrix's fixture IDs and artifact hashes must exactly match its per-fixture
manifests. All receipts on one side must name the same full source commit. Each
baseline/candidate pair must use the fixture's exact same toolchain manifest and
component revisions; different fixtures may use different pinned toolchains.
This allows heterogeneous formats without treating a provider-version change
between revisions as an implementation result. Set top-level
`evaluationManifest` and `toolchainManifest` values as shared defaults, or give
each fixture its own manifests. Every receipt must match the selected manifest
hashes, metric inventory, denominators, and component revisions.
Baseline/candidate denominator mismatches remain `INCOMPLETE`. Missing fixtures,
duplicate coverage, commit drift, or within-fixture toolchain drift abort
aggregation. Constituent receipt hashes are retained in the aggregate receipts.
When fixture-specific contracts are used, `evaluation-manifest-index.json`
binds each fixture to its evaluation-manifest SHA-256; fixture-specific
toolchains are similarly bound by `toolchain-manifest-index.json`. Aggregate
receipts and the comparison use the corresponding index hashes.

```powershell
python tooling/benchmarks/aggregate_matrix_receipts.py `
  --config work/benchmarks/matrix/config.json `
  --output-dir work/benchmarks/matrix/aggregate `
  --run-prefix reamon-candidate
```

The command refuses an existing output directory and publishes `baseline.json`,
`candidate.json`, `comparison.json` and `provenance.json` together, plus the
evaluation-manifest index for fixture-specific contracts. A measured
multi-format baseline/candidate corpus is still needed for AR-0/AR-8; utility
tests do not count as that evidence.

The first changed-revision integrated slice is archived at
[`pyinstaller-module-structured-source/runs/2026-11-10-changed-revision-872-to-c4d1/`](pyinstaller-module-structured-source/runs/2026-11-10-changed-revision-872-to-c4d1/README.md).
It compares one enrolled PyInstaller artifact with a shared harness and reports
seven unchanged metrics. The runtime oracle is inherited from enrollment, and
the analyzer/worker service images are fixed across revisions; this result
does not complete multi-format or full service-revision acceptance.

A same-revision, two-format repeatability matrix is archived at
[`runs/2026-11-10/multiformat-repeatability-3b67737c/`](runs/2026-11-10/multiformat-repeatability-3b67737c/README.md).
It measures one JVM/CFR fixture and one PyInstaller fixture at clean product
commit `3b67737c436e556a3cdd244d9a18588a24747604`, with fixture-specific,
hash-bound evaluation and toolchain manifests. All five JVM and seven
PyInstaller metrics are complete with zero baseline/candidate deltas; the
aggregate reports `NO_REGRESSION_OBSERVED`. This validates heterogeneous
receipt aggregation and repeatability on these two synthetic fixtures. It
does not measure a product change or complete changed-revision, multi-format
acceptance; that remains the next AR-0/AR-8 gate.
