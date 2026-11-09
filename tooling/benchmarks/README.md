# Benchmark matrix tooling

`aggregate_matrix_receipts.py` combines independently measured, per-fixture
baseline/candidate receipts into one comparison. It is the aggregation step of
AR-8; it does not build fixtures, run providers, or execute targets. Fixture
execution adapters must produce receipts first.

The matrix config points at a combined fixture manifest, one shared evaluation
manifest and toolchain manifest, then binds each fixture ID to its one-fixture
manifest and the paired receipts:

```json
{
  "schemaVersion": 1,
  "fixtureManifest": "corpus.json",
  "evaluationManifest": "evaluation.json",
  "toolchainManifest": "toolchain.json",
  "fixtures": {
    "native-linux-debug": {
      "fixtureManifest": "native-linux-debug.json",
      "baselineReceipt": "runs/baseline/native-linux-debug.json",
      "candidateReceipt": "runs/candidate/native-linux-debug.json"
    },
    "managed-jar": {
      "fixtureManifest": "managed-jar.json",
      "baselineReceipt": "runs/baseline/managed-jar.json",
      "candidateReceipt": "runs/candidate/managed-jar.json"
    }
  }
}
```

The matrix's fixture IDs and artifact hashes must exactly match its per-fixture
manifests. All per-fixture receipts on one side must name the same full source
commit; every receipt must share the declared evaluation and toolchain hashes.
The evaluation manifest can set a metric denominator to `null` when each
fixture has a different known denominator; baseline/candidate denominator
mismatches remain `INCOMPLETE`. Missing fixtures, duplicate coverage, commit
drift, or toolchain drift abort aggregation. Constituent receipt hashes are
retained in the aggregate receipts.

```powershell
python tooling/benchmarks/aggregate_matrix_receipts.py `
  --config work/benchmarks/matrix/config.json `
  --output-dir work/benchmarks/matrix/aggregate `
  --run-prefix reamon-candidate
```

The command refuses an existing output directory and publishes `baseline.json`,
`candidate.json`, `comparison.json` and `provenance.json` together. A measured
multi-format baseline/candidate corpus is still needed for AR-0/AR-8; utility
tests do not count as that evidence.
