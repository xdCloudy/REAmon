# Benchmark matrix tooling

`aggregate_matrix_receipts.py` combines independently measured, per-fixture
baseline/candidate receipts into one comparison. It is the aggregation step of
AR-8; it does not build fixtures, run providers, or execute targets. Fixture
execution adapters must produce receipts first.

The matrix config points at a combined fixture manifest and toolchain manifest,
then binds each fixture ID to its one-fixture manifest, evaluation contract,
and paired receipts. Fixture-specific evaluation contracts let native,
managed, and bytecode fixtures retain different metrics and denominators:

```json
{
  "schemaVersion": 1,
  "fixtureManifest": "corpus.json",
  "toolchainManifest": "toolchain.json",
  "fixtures": {
    "native-linux-debug": {
      "fixtureManifest": "native-linux-debug.json",
      "evaluationManifest": "evaluations/native.json",
      "baselineReceipt": "runs/baseline/native-linux-debug.json",
      "candidateReceipt": "runs/candidate/native-linux-debug.json"
    },
    "managed-jar": {
      "fixtureManifest": "managed-jar.json",
      "evaluationManifest": "evaluations/managed.json",
      "baselineReceipt": "runs/baseline/managed-jar.json",
      "candidateReceipt": "runs/candidate/managed-jar.json"
    }
  }
}
```

The matrix's fixture IDs and artifact hashes must exactly match its per-fixture
manifests. All per-fixture receipts on one side must name the same full source
commit and shared toolchain hash. Set a top-level `evaluationManifest` as a
shared default, or give each fixture its own `evaluationManifest`; each receipt
must match the selected contract's hash, metric inventory, and denominators.
Baseline/candidate denominator mismatches remain `INCOMPLETE`. Missing
fixtures, duplicate coverage, commit drift, or toolchain drift abort
aggregation. Constituent receipt hashes are retained in the aggregate receipts.
When fixture-specific contracts are used, `evaluation-manifest-index.json`
binds every fixture ID to its evaluation-manifest SHA-256, and the comparison
uses the index hash.

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
