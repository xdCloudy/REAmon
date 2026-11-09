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
module value. Fixture enrollment verifies only the builder oracle and extractor
inventory; live provider persistence and paired receipts are still required
before claiming source correspondence.

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
