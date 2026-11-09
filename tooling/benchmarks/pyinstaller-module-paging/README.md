# PyInstaller module paging fixture

This synthetic MIT-licensed program builds a Linux x86_64 one-file PyInstaller
executable. It contains 70 dynamically imported known-source modules and prints
`2485` when run. Its purpose is to make fixture enrollment reproducible for the
existing PyInstaller paging and PostgreSQL continuation integration check.

Build with Docker Desktop from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/pyinstaller-module-paging/build.ps1
```

The builder runs the generated program as its enrollment oracle, then builds the
checked-in isolated extractor and verifies all three paging responses. It writes
the binary and a per-run receipt to `work/benchmarks/pyinstaller-module-paging/`
and prints the receipt. The recorded enrollment artifact is 7,262,776 bytes with SHA-256
`ad8998bd53353c3f52c7c81a6bfb9251719da84541439ecf445b012f24188db0`. Its
separate [receipt](enrollment-receipt.json) records a successful runtime oracle
and the isolated analyzer's 180-module inventory (64, 64, and 52 modules per
page). The same artifact also passed the direct-provider/PostgreSQL persistence
integration, which retained readable recovered source and verified the expected
`VALUE` constants for all 70 known-source modules (extractor indices 82–151).
The queued worker resumed from saved attempt rows and completed the terminal
page. The remaining 110 extracted modules and complete project structure were
not compared with ground truth. The analyzer receives only the executable; do not mount
`build_fixture.py` or other source inputs into the analysis container.

The manifest pins the base image by digest, Python version, PyInstaller and
Python package versions, source license, architecture, and runtime oracle. This
recipe does not promise a fixed binary hash across Docker/build environments;
each run must record the emitted artifact hash and toolchain receipt. Fixture
enrollment is not a reconstruction pass. The archived v1 evaluation keeps source
correspondence `UNAVAILABLE`; its results must be compared under that pinned
contract.

## Paired receipt comparison

`tooling/benchmarks/compare_receipts.py` compares baseline and candidate JSON
receipts against the checked-in [fixture manifest](manifest.json) and
[evaluation manifest](evaluation-manifest.json). A run receipt must record the
manifest file hashes, exact fixture artifact hash, every declared metric,
metric state and denominator, a toolchain manifest hash, component revisions,
the full commit, and whether its worktree was clean. Dirty runs and unavailable
metrics produce an `INCOMPLETE` result. The comparator applies only the
declared direction (`higher`, `lower`, or exact equality); it has no numeric
thresholds and never grants a release certification.

`tooling/benchmarks/record_receipt.py` builds the provenance envelope around
machine-readable measurements. The evidence JSON must contain the exact fixture
and metric inventories from the manifests; each metric is explicitly
`MEASURED` with a value and denominator, or `UNAVAILABLE` with a reason. The
toolchain JSON must identify every measured component revision:

```json
{
  "schemaVersion": 1,
  "components": {
    "pyinstaller_extractor": "<full revision>",
    "pycdc": "<full revision>"
  }
}
```

Record a receipt from the repository root after the evidence files have been
produced by the fixture evaluation:

```powershell
python tooling/benchmarks/record_receipt.py `
  --repo-root . `
  --fixture-manifest tooling/benchmarks/pyinstaller-module-paging/manifest.json `
  --evaluation-manifest tooling/benchmarks/pyinstaller-module-paging/evaluation-manifest-source-v2.json `
  --evidence work/benchmarks/pyinstaller-module-paging/evidence.json `
  --toolchain-manifest work/benchmarks/pyinstaller-module-paging/toolchain.json `
  --output work/benchmarks/pyinstaller-module-paging/candidate-receipt.json
```

The recorder hashes the evidence and manifests, captures the full Git commit,
component revisions, and worktree cleanliness, validates metric denominators,
and refuses to overwrite a receipt. It records supplied evidence; it does not
run the fixture or independently prove that a measurement command produced the
values. The comparator validates receipts only against the same pinned fixture
and evaluation contract.

The PostgreSQL integration test can emit its measured portion of the evidence
when `REAMON_BENCHMARK_EVIDENCE_PATH` points to a new output file. Set
`REAMON_BENCHMARK_FIXTURE_ID` to the fixture manifest ID and enable the test
with its existing `REAMON_RUN_DB_INTEGRATION=1` service configuration. It
records the observed 180-module inventory and known-source value matches only
after those assertions pass. It also counts exact matches for each of the 70
known-source modules after removing comments and whitespace; a match requires the
entire recovered module to consist of the expected single `VALUE` assignment.
This narrow v2 metric does not score the other 110 extracted modules, project
structure, dependencies, symbols, or types. Set `REAMON_TASK_WORKER_INTEGRATION=1` to measure
the queued worker terminal page; otherwise that metric stays `UNAVAILABLE`.
Runtime-oracle evidence still comes from the pinned fixture builder. Use the
versioned [source evaluation manifest](evaluation-manifest-source-v2.json) for
new runs; the original `evaluation-manifest.json` remains the v1 contract used
by the archived pair.

`tooling/benchmarks/run_pyinstaller_pair.py` packages measured baseline and
candidate evidence in one command. It merges each side against the same build
and enrollment receipts, records a provenance-bound receipt from each Git
checkout, then compares them. Integration evidence and toolchain manifests must
already exist; this command does not build the fixture or launch Docker tests.
Keep the baseline and candidate as sibling Git worktrees, and store the input
receipts/evidence outside both checkout roots so receipt cleanliness reflects
the measured source trees. The runner refuses an existing output directory or
different toolchain manifests and publishes the five result files only after
the comparison completes.

```powershell
python tooling/benchmarks/run_pyinstaller_pair.py `
  --baseline-repo-root ../reamon-baseline `
  --candidate-repo-root . `
  --fixture-manifest tooling/benchmarks/pyinstaller-module-paging/manifest.json `
  --evaluation-manifest tooling/benchmarks/pyinstaller-module-paging/evaluation-manifest-source-v2.json `
  --build-receipt ../paired-inputs/build-receipt.json `
  --enrollment-receipt ../paired-inputs/enrollment-receipt.json `
  --baseline-integration-evidence ../paired-inputs/baseline-integration.json `
  --candidate-integration-evidence ../paired-inputs/candidate-integration.json `
  --baseline-toolchain-manifest ../paired-inputs/toolchain.json `
  --candidate-toolchain-manifest ../paired-inputs/toolchain.json `
  --output-dir ../pyinstaller-module-paging-paired-run
```

Exit codes are `0` for `NO_REGRESSION_OBSERVED`, `1` for
`REGRESSION_DETECTED`, and `2` for `INCOMPLETE` or invalid inputs. The output
contains both merged evidence files, both receipts, and `comparison.json`.
This is evidence packaging, not a one-command benchmark execution or an
AR-0/AR-8 acceptance gate.

`tooling/benchmarks/merge_pyinstaller_evidence.py` performs that bounded join.
It requires the builder receipt, checked-in enrollment receipt, and integration
test evidence to agree on the fixture artifact hash, runtime output, and full
module denominator. It marks the runtime oracle measured only after those checks;
the end-to-end reconstruction metric remains unavailable:

```powershell
python tooling/benchmarks/merge_pyinstaller_evidence.py `
  --fixture-manifest tooling/benchmarks/pyinstaller-module-paging/manifest.json `
  --evaluation-manifest tooling/benchmarks/pyinstaller-module-paging/evaluation-manifest-source-v2.json `
  --build-receipt work/benchmarks/pyinstaller-module-paging/build-receipt.json `
  --enrollment-receipt tooling/benchmarks/pyinstaller-module-paging/enrollment-receipt.json `
  --integration-evidence work/benchmarks/pyinstaller-module-paging/integration-evidence.json `
  --output work/benchmarks/pyinstaller-module-paging/candidate-evidence.json
```

Example from the repository root:

```powershell
python tooling/benchmarks/compare_receipts.py baseline.json candidate.json `
  --fixture-manifest tooling/benchmarks/pyinstaller-module-paging/manifest.json `
  --evaluation-manifest tooling/benchmarks/pyinstaller-module-paging/evaluation-manifest-source-v2.json `
  --output comparison.json
```

The canonical LF-stable paired baseline and candidate run is archived under
`tooling/benchmarks/pyinstaller-module-paging/runs/2026-11-09/paired-canonical-lf/`.
It compares baseline product source `515d1b83d2a8772f4d816eb1efd690189bad2b2d`
with measurement commit `2f88d34ba9e30d5da9168171565302c5b5e64c1a` against
candidate `4a93d892d2784ee569725cc8c70529d172a53b44`. Both clean receipts use the
same artifact, LF-stable manifest bytes, and paired toolchain manifest. The
runtime oracle, 180-module inventory, 70/70 known-source value matches, and
queued worker terminal page are equal, with no regression observed in those
metrics. Complete reconstruction correspondence remains `UNAVAILABLE`, so the
aggregate comparator result is `INCOMPLETE`. The earlier `paired/` archive is
retained for history but superseded after its merged-evidence source hashes were
found to differ across EOL-converted checkouts. One synthetic fixture does not
pass AR-0/AR-8 or establish broad reconstruction fidelity.

The v2 source correspondence run is archived in
[`paired-source-v2/`](runs/2026-11-09/paired-source-v2/README.md). Its separate
evaluation contract measured exact normalized source for all 70 one-assignment
modules, with 70/70 matches on both sides. Runtime, inventory, value recall, and
worker terminal-page checks also matched. The comparison reports
`NO_REGRESSION_OBSERVED` with clean receipts. The provider source was the same on
both sides; this validates the new source-fidelity measurement path, not a
product reconstruction improvement. The other 110 modules and full-project
fidelity remain unmeasured, and the fixture still does not complete AR-0/AR-8.
