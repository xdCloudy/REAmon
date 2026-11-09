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

The derived outputs were compiled with `javac --release 17` inside the pinned Docker image. The current-main and paired run receipts record output hashes and matching observed stdout. The paired run also compares `javap -p -s -c` output per expected class; both classes match the original compiled bytecode on each run, and the outputs repeat across runs. See `runs/2026-11-09-paired-jvm-repeatability/`. A behavior-changing edit to recovered `Main.java` still compiled but changed the program output; the runtime oracle rejected it with exit code 4. The mutation recipe, mutated-source hash, and receipt are archived in the same directory. These checks measure one synthetic project and same-revision repeatability; they do not establish original-source recovery, a product-change comparison, or broad Java/JVM fidelity. The fixture and receipts are evidence for a future paired, multi-format matrix, not a complete AR-0/AR-8 corpus.

To reproduce the runtime-oracle negative control, build the fixture and make a fresh CFR run first, then pass the recovered `sources` directory and a new output path:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/jvm-multimodule-cfr/run_negative_control.ps1 `
  -BuildDirectory work/benchmarks/jvm-multimodule-cfr-build `
  -SourceDirectory work/benchmarks/jvm-multimodule-cfr-run/sources `
  -OutputDirectory work/benchmarks/jvm-multimodule-cfr-negative-control
```

The command refuses an existing output directory, checks the fixture JAR hash, copies and mutates only the recovered `Main.java`, and compiles/runs the mutation in the pinned network-disabled Docker image. Exit code 4 from the inner validator is the expected rejected-candidate outcome; any other exit is an error. The archived result records the product revision, artifact and mutated-source hashes, expected and observed output, and validator exit code.

## Reproduce the full fixture run

With Docker running, the `reamon-cfr` service available, and a fresh build directory, run:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/jvm-multimodule-cfr/run.ps1 `
  -BuildDirectory work/benchmarks/jvm-multimodule-cfr-build `
  -OutputDirectory work/benchmarks/jvm-multimodule-cfr-run
```

The runner verifies the JAR against its manifest, stages it under a unique path in `reamon_artifacts`, calls the live CFR service, checks the returned inventory and hashes, copies the derived sources into the requested output folder, then compiles and runs them in the pinned Docker image with networking disabled and resource limits set. It removes the staged input only after verifying its SHA-256. The output folder must not already exist; provider and validation receipts plus recovered sources are written there. The recorded run receipts in `runs/2026-11-09-cfr-runner/` show the script completing this flow. This one fixture does not complete the broader benchmark-corpus requirement.
