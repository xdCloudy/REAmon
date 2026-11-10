# Embedded NUL CArchive name rejected — 2026-11-10

The pinned structured-source fixture was rebuilt in Docker and its existing
runtime oracle passed (`2485`). The clean artifact contains 180 discovered
bytecode modules. A single TOC name byte was replaced with NUL; the mutation
receipt records both artifact SHA-256 values and the exact offset. The malformed
artifact passed the analyzer image's outer cookie check.

The isolated PyInstaller HTTP service then rejected the artifact with HTTP 400,
`status: failed`, and no recovered module payload. The provider receipt records
extractor revision `2aa0ec9e58317ac717fdeec84a02d5a67de7b96c2-reamon2` and the
image used for the acceptance run. The target executable was never launched.

Reproduce with a new, nonexistent output directory:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/pyinstaller-malformed-carchive-control/run-embedded-nul-name.ps1 `
  -OutputDirectory "$env:TEMP/reamon-embedded-nul-reproduction"
```

The runner creates a disposable analyzer container with a read-only fixture
mount, verifies the mutation hash and cookie preflight, writes build/mutation/
preflight/provider receipts, and removes only that analyzer container. It does
not use the application database or its artifact volume.

This is one malformed-name acceptance case on one synthetic Linux x86-64
PyInstaller fixture. It does not establish broad malformed-input accuracy,
project reconstruction fidelity, or a weighted AR-0/AR-8 completion point.
