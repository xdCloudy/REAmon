# PyInstaller malformed CArchive control

This control mutates only the first CArchive table-of-contents entry size in
the pinned structured-source fixture. The outer cookie and TOC bounds remain
valid, so the provider's cookie screening accepts the file and the isolated
extractor must reject the malformed TOC. The executable is never launched by
the mutator or probe.

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
This is one malformed-TOC rejection control; it does not measure obfuscated
archive handling or general malformed-input accuracy.

After saving the probe receipt, remove only the exact staged file after
checking its SHA-256 against `mutation-receipt.json`. Leave the shared `qa`
parent untouched. The committed run archive records hashes and the response;
it does not retain the executable.
