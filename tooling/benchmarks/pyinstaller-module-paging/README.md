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
integration, which retained a readable recovered source artifact and verified
`VALUE = 1` for the known `module_000.pyc` source. It did not compare the complete
fixture source against ground truth, and its optional queued-worker test was
skipped. The analyzer receives only the executable; do not mount
`build_fixture.py` or other source inputs into the analysis container.

The manifest pins the base image by digest, Python version, PyInstaller and
Python package versions, source license, architecture, and runtime oracle. This
recipe does not promise a fixed binary hash across Docker/build environments;
each run must record the emitted artifact hash and toolchain receipt. Fixture
enrollment is not a reconstruction pass. The end-to-end result remains
`UNAVAILABLE` until recovered modules are matched against separately retained
ground truth and the full AR-0/AR-8 denominators are reported.
