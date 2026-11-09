# Held-out multi-class JVM fixture for CFR

This fixture is a small, independently authored Java project with two source classes. The source files carry the MIT license in `LICENSE`. `manifest.json` binds the fixture to the JAR SHA-256, build target, runtime oracle, and provider version. `build-receipt.json` records the pinned builder image, exact source hashes, and original in-container runtime result.

## Rebuild

Run `build.ps1` from PowerShell with a new output directory. It builds the JAR and runs its oracle only inside Docker:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/jvm-multimodule-cfr/build.ps1 `
  -OutputDirectory work/benchmarks/jvm-multimodule-cfr-build
```

## Recorded decompilation

The archived provider response is `runs/2026-11-09-cfr/provider-receipt.json`. The run used CFR 0.152 via the live isolated `reamon-cfr` service. CFR discovered both expected source units, reported no truncation, and its artifact SHA-256 matched the manifest.

The derived outputs were compiled with `javac --release 17` inside the pinned Docker image. `runs/2026-11-09-cfr/validation-receipt.json` records output hashes and the matching observed stdout. This checks one behavior on one synthetic project; it does not establish original-source recovery or broad Java/JVM fidelity. The fixture and receipts are evidence for a future paired, multi-format matrix, not a complete AR-0/AR-8 corpus.
