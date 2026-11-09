# PyInstaller mutated-source provider control

This fixture builds a second synthetic Linux x86-64 PyInstaller executable whose
known `classify(candidate)` branch returns `"under"` when `candidate < VALUE`.
The original structured-source fixture returns `"below"` at that branch. Each
fixture contains 70 known modules and the packaged executable asserts both sides
of every branch, then prints `2485`.

`build.ps1` pins the builder inputs, builds and executes the target only inside
Docker, verifies the runtime oracle, and checks that the isolated PyInstaller
extractor enumerates all 180 bytecode modules over pages of 64, 64, and 52.
`manifest.json`, `evaluation-manifest.json`, and `enrollment-receipt.json`
record the artifact and the hidden-source contract. The known source is used by
the evaluator only; it is not mounted into the analyzer or provider containers.

The database integration passes the artifact through REAmon's direct provider
and queued worker. It compares recovered modules with the mutated `"under"`
oracle and separately records false acceptance of the original `"below"`
oracle. A clean paired run and its exact inputs are archived under `runs/`.

This is one bounded provider outcome on a synthetic Python 3.12.8 / PyInstaller
6.13.0 fixture. It does not establish general source fidelity, broad format
coverage, malformed/obfuscated handling, or behavioral equivalence outside the
fixture's explicit runtime assertions.
