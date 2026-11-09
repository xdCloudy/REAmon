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
enrollment is not a reconstruction pass. The end-to-end result remains
`UNAVAILABLE` until recovered modules are matched against separately retained
ground truth and the full AR-0/AR-8 denominators are reported.

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
  --evaluation-manifest tooling/benchmarks/pyinstaller-module-paging/evaluation-manifest.json `
  --evidence work/benchmarks/pyinstaller-module-paging/evidence.json `
  --toolchain-manifest work/benchmarks/pyinstaller-module-paging/toolchain.json `
  --output work/benchmarks/pyinstaller-module-paging/candidate-receipt.json
```

The recorder hashes the evidence and manifests, captures the full Git commit,
component revisions, and worktree cleanliness, validates metric denominators,
and refuses to overwrite a receipt. It records supplied evidence; it does not
run the fixture or independently prove that a measurement command produced the
values. A clean paired comparison still requires an evaluation harness that
produces those evidence files from the pinned artifact and REAmon services.

Example from the repository root:

```powershell
python tooling/benchmarks/compare_receipts.py baseline.json candidate.json `
  --fixture-manifest tooling/benchmarks/pyinstaller-module-paging/manifest.json `
  --evaluation-manifest tooling/benchmarks/pyinstaller-module-paging/evaluation-manifest.json `
  --output comparison.json
```

No matched baseline and candidate receipts currently exist for this contract,
so this tool adds comparison mechanics but does not complete AR-0 or AR-8. The
active local worker used for earlier bounded persistence evidence reported a
dirty external build (`REAMON_BUILD_DIRTY=true`); that evidence is not a clean
candidate end-to-end run.
