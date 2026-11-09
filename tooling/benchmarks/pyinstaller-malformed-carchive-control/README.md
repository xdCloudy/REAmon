# PyInstaller malformed CArchive control

This benchmark has two single-field CArchive controls derived from the pinned
structured-source fixture. Both preserve the outer cookie and bounded TOC, so
the provider's cookie check accepts the artifact before the isolated extractor
rejects the invalid TOC entry. The executable is never launched by the mutator
or probe.

## Build the input and malformed variant

Build the known synthetic input in Docker, then mutate its bytes on the host
(the mutator does not execute the artifact):

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/pyinstaller-module-structured-source/build.ps1 `
  -OutputDirectory work/benchmarks/pyinstaller-malformed-control-source
python tooling/benchmarks/pyinstaller-malformed-carchive-control/mutate_carchive.py `
  --input work/benchmarks/pyinstaller-malformed-control-source/pyinstaller-module-structured-source `
  --output work/benchmarks/pyinstaller-malformed-control/malformed-carchive `
  --receipt work/benchmarks/pyinstaller-malformed-control/mutation-receipt.json
```

The builder refuses to overwrite an existing output or receipt. The mutation
receipt binds source and malformed SHA-256 values and records the exact TOC
field offset and before/after values.

To build the second malformed variant, use distinct output and receipt paths:

```powershell
python tooling/benchmarks/pyinstaller-malformed-carchive-control/mutate_carchive.py `
  --input work/benchmarks/pyinstaller-malformed-control-source/pyinstaller-module-structured-source `
  --output work/benchmarks/pyinstaller-malformed-control/entry-position-outside-overlay `
  --receipt work/benchmarks/pyinstaller-malformed-control/entry-position-mutation-receipt.json `
  --mutation first-entry-position-outside-overlay
```

This changes only the first entry's data position to one byte beyond the
calculated CArchive overlay size. See `manifest-data-bounds.json` for that
control's expected provider outcome and limits.

## Live provider control

Copy the malformed artifact into a new, disposable file under the existing
`reamon_artifacts` volume at `qa/pyinstaller-malformed-control/fixture`. Do not
reuse or overwrite an existing path. The `pyinstaller-analyzer` service mounts
that volume read-only. Run `probe_endpoint.py` in a disposable container that
shares the analyzer's network namespace and mounts the volume read-only:

```powershell
docker run --rm --network container:reamon-pyinstaller `
  -v reamon_artifacts:/data/reamon-artifacts:ro `
  -v "${PWD}/work/benchmarks/pyinstaller-malformed-control:/control:ro" `
  -v "${PWD}/tooling/benchmarks/pyinstaller-malformed-carchive-control:/probe:ro" `
  python:3.12-slim python /probe/probe_endpoint.py `
  --artifact-path /data/reamon-artifacts/qa/pyinstaller-malformed-control/fixture `
  --artifact-sha256 <sha256-from-mutation-receipt> `
  --output /control/provider-receipt.json
```

The acceptance condition is HTTP 400 with a generic malformed/unsupported
archive error, no recovered modules, and a healthy pinned extractor revision.
For the second mutation, the runner stages and hash-checks the exact artifact,
calls `server.has_pyinstaller_cookie` from the running analyzer image, probes
the endpoint with distinct request identifiers, and removes the exact staged
file only after another hash check:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/pyinstaller-malformed-carchive-control/run-data-bounds.ps1 `
  -ArtifactPath work/benchmarks/pyinstaller-malformed-control/entry-position-outside-overlay `
  -MutationReceiptPath work/benchmarks/pyinstaller-malformed-control/entry-position-mutation-receipt.json `
  -OutputDirectory work/benchmarks/pyinstaller-malformed-control-bounds-run
```

The runner writes staging, preflight, and provider receipts under the selected
output directory. Together, these controls cover only two malformed TOC
fields. They do not measure obfuscated archives or general malformed-input
accuracy.

After saving the probe receipt, remove only the exact staged file after
checking its SHA-256 against `mutation-receipt.json`. Leave the shared `qa`
parent untouched. The committed run archive records hashes and the response;
it does not retain the executable.
