# PyInstaller structured-source fixture (v3)

This separate synthetic fixture keeps the v1 and v2 paging artifact and their
receipts immutable. It uses the same 70 known-source modules and 180-module
extracted inventory, but each known module contains a value, a function, and a
branch. The fixture's executable checks both branch outcomes and prints the
same aggregate value (`2485`).

The analyzer receives only the built executable. The module source is produced
inside the fixture builder from the versioned recipe and is used as the hidden
source oracle by the integration test. The existing single-assignment metric
and archives remain unchanged.

Build with Docker Desktop from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/pyinstaller-module-structured-source/build.ps1 `
  -OutputDirectory work/benchmarks/pyinstaller-module-structured-source-v3-run1
```

The enrolled build produced artifact SHA-256
`746c550fc3324ebf285c0ee4a555ea2afb3d5b12c9c191eb2bf4f0978d263971`
(7,270,096 bytes). Its runtime oracle passed and the isolated extractor
enumerated 180 modules over pages of 64, 64, and 52. The checked-in
`enrollment-receipt.json` binds those results to the pinned builder and
extractor inputs. Later builds write separate receipts and do not rewrite the
enrollment manifest.

The evaluation contract measures runtime, inventory, known `VALUE` recall,
worker continuation, and complete source matches across all 70 structured
modules. A source match requires the function and branch body as well as its
module value. The enrolled build alone verifies only the runtime oracle and
extractor inventory; the paired provider run below records measured persistence
and fixture-source correspondence.

Run the live direct-provider and queued-worker integration after the local
stack is healthy. The command copies only the enrolled executable into the
REAmon artifact volume, runs the existing PostgreSQL integration test through
the webapp test image, and writes evidence under `work/benchmarks/`:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/pyinstaller-module-structured-source/run_integration.ps1 `
  -BuildOutputDirectory work/benchmarks/pyinstaller-module-structured-source-v3-run1 `
  -EnvFile C:/path/to/REAmon/.env
```

The runner uses a unique UTC run ID by default, reuses an existing artifact
volume copy only when its hash matches the enrolled binary, and refuses to
overwrite evidence. For clean paired receipts, set
`-EvidenceOutputDirectory` to a directory outside both baseline and candidate
worktrees; otherwise the default output under `work/benchmarks/` is convenient
for a single local run.

## Paired v3 evidence — 2026-11-09

[`runs/2026-11-09/paired-v3/`](runs/2026-11-09/paired-v3/README.md) records the
baseline and candidate integration runs, merged evidence, clean receipts, and
comparator output. Both sides used product commit
`87203c3f408d1d574c3d49f1d6af79274f57c569`, so this validates repeatability
and records no regression on this fixture; it does not measure an improvement
over an earlier product revision.

Both sides measured 180 extracted modules, 70/70 known module values, 70/70
structured source matches, a passing 1/1 fixture runtime oracle, and the 1/1
worker terminal page. These measures cover one synthetic PyInstaller 6.13.0
Python 3.12.8 Linux fixture. They do not establish broad source fidelity,
project reconstruction, or behavioural equivalence for other artifacts.

[`runs/2026-11-09/paired-v3-mutation-controls/`](runs/2026-11-09/paired-v3-mutation-controls/README.md)
adds a paired scorer-sensitivity control from commit
`d6af8238324880e469a824a50ab51faedb33da9e`: changing each recovered module's
`"below"` result to `"under"` was rejected in 70/70 cases, with 0/70 false
acceptances. This mutates recovered text in the test harness; it does not run a
separately mutated executable or measure provider recovery from such an input.

[`../pyinstaller-module-mutated-source-control/runs/2026-11-09/paired-clean-recovery/`](../pyinstaller-module-mutated-source-control/runs/2026-11-09/paired-clean-recovery/README.md)
records the distinct artifact-level control at commit
`aef36478e647bef9c33eafdd3b9b87dfeb6b2536`. That executable was passed through
the live provider and worker; both paired sides recovered 70/70 mutated branch
results and falsely accepted 0/70 original-source results. The archive retains
an initial failed candidate attempt with an empty persisted source file before
the passing retry.
