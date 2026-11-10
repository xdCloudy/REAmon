# Held-out multi-class JVM fixture for CFR

This fixture is a small, independently authored Java project with two source classes. The source files carry the MIT license in `LICENSE`. `manifest.json` binds the current version 2 fixture to the JAR SHA-256, build target, runtime oracle, and provider version. `build-receipt.json` records the pinned builder image, line-ending-normalized source hashes, and original in-container runtime result. The original version 1 manifest and build receipt remain in `manifest-v1.json` and `build-receipt-v1.json` for earlier CFR/Vineflower measurements.

## Rebuild

Run `build.ps1` from PowerShell with a new output directory. It builds the JAR and runs its oracle only inside Docker:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/jvm-multimodule-cfr/build.ps1 `
  -OutputDirectory work/benchmarks/jvm-multimodule-cfr-build
```

## Recorded decompilation

The archived provider response is `runs/2026-11-09-cfr/provider-receipt.json`. The run used CFR 0.152 via the live isolated `reamon-cfr` service. CFR discovered both expected source units, reported no truncation, and its artifact SHA-256 matched the version 1 manifest in `manifest-v1.json`.

The derived outputs were compiled with `javac --release 17` inside the pinned Docker image. The current-main and paired version 1 run receipts record output hashes and matching observed stdout. The paired run also compares `javap -p -s -c` output per expected class; both classes match the original compiled bytecode on each run, and the outputs repeat across runs. See `runs/2026-11-09-paired-jvm-repeatability/`. A behavior-changing edit to recovered `Main.java` still compiled but changed the program output; the runtime oracle rejected it with exit code 4. The mutation recipe, mutated-source hash, and receipt are archived in the same directory. These checks measure one synthetic project and same-revision repeatability; they do not establish original-source recovery, a product-change comparison, or broad Java/JVM fidelity. The fixture and receipts are evidence for a future paired, multi-format matrix, not a complete AR-0/AR-8 corpus.

To reproduce the runtime-oracle negative control, build the fixture and make a fresh CFR run first, then pass the recovered `sources` directory and a new output path:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/jvm-multimodule-cfr/run_negative_control.ps1 `
  -BuildDirectory work/benchmarks/jvm-multimodule-cfr-build `
  -SourceDirectory work/benchmarks/jvm-multimodule-cfr-run/sources `
  -OutputDirectory work/benchmarks/jvm-multimodule-cfr-negative-control
```

The command refuses an existing output directory, checks the fixture JAR hash, copies and mutates only the recovered `Main.java`, and compiles/runs the mutation in the pinned network-disabled Docker image. Exit code 4 from the inner validator is the expected rejected-candidate outcome; any other exit is an error. The archived result records the product revision, artifact and mutated-source hashes, expected and observed output, and validator exit code.

## Common matrix evidence

`evaluation-manifest.json` defines the JVM metrics used by the shared AR-8
receipt format. After a fresh `run.ps1` invocation, convert the build, provider,
and validation receipts into measured matrix evidence:

Version 2 fixes the JAR entry date so rebuilds are byte-for-byte reproducible
and hashes Java source after normalizing CRLF/LF line endings. This keeps
artifact and source identity stable across Windows and Linux checkouts.

```powershell
python tooling/benchmarks/merge_jvm_evidence.py `
  --fixture-manifest tooling/benchmarks/jvm-multimodule-cfr/manifest.json `
  --build-receipt work/benchmarks/jvm-build/build-receipt.json `
  --provider-receipt work/benchmarks/jvm-run/provider-receipt.json `
  --validation-receipt work/benchmarks/jvm-run/validation-receipt.json `
  --output work/benchmarks/jvm-run/evidence.json
```

The adapter preserves partial exact-bytecode counts, records the sampled
8,197-input behavior oracle as a strict pass/fail result, and marks that metric
unavailable when the full sample is absent. Source inventory, runtime, and
bytecode results are accepted only when their receipt hashes and denominators
agree with the enrolled fixture. Use `record_receipt.py` to bind this evidence
to a clean source revision and a hash-pinned toolchain manifest before adding
it to a matrix config.

## Reproduce the full fixture run

With Docker running, the `reamon-cfr` service available, and a fresh build directory, run:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/jvm-multimodule-cfr/run.ps1 `
  -BuildDirectory work/benchmarks/jvm-multimodule-cfr-build `
  -OutputDirectory work/benchmarks/jvm-multimodule-cfr-run
```

The runner verifies the JAR against its manifest, stages it under a unique path in `reamon_artifacts`, calls the live CFR service, checks the returned inventory and hashes, copies the derived sources into the requested output folder, then compiles and runs them in the pinned Docker image with networking disabled and resource limits set. It removes the staged input only after verifying its SHA-256. The output folder must not already exist; provider and validation receipts plus recovered sources are written there. The recorded run receipts in `runs/2026-11-09-cfr-runner/` show the script completing this flow. This one fixture does not complete the broader benchmark-corpus requirement.

## Vineflower provider measurement

A second live JVM provider measurement is archived in `runs/2026-11-10-vineflower/`. Rebuild the held-out JAR with `build.ps1`, then run `run_vineflower.ps1` with a fresh output directory. The runner submits the SHA-256-bound JAR to the isolated Vineflower service, verifies the complete expected source inventory and output hashes, then compiles and validates the recovered sources in the pinned Docker JDK.

On the recorded run, Vineflower 1.12.0 returned both expected files without truncation and matched the runtime oracle. Exact `javap -p -s -c` output matched 1/2 classes; `RuleEngine` differed. This is bounded same-revision provider evidence, not source-equivalence proof or a changed-revision comparison.

## Sampled behavior differential

The pinned validator now compares each recovered `RuleEngine.classify` implementation directly against the original JAR on 8,197 inputs: every integer from -4096 through 4096 plus the four `Integer.MIN_VALUE`/`MAX_VALUE` boundary values. This supplements the fixture `Main` stdout and exact per-class `javap -p -s -c` comparison; finite sampling still does not prove exhaustive behavior equivalence.

The paired CFR/Vineflower run is archived in `runs/2026-11-10-sampled-behavior-differential/`. Both recovered providers matched all 8,197 outputs. CFR bytecode correspondence was 2/2 classes; Vineflower was 1/2. The reproducible `run_behavior_negative_control.ps1` mutation inserts a changed result for input 4095 without changing the three `Main` examples, and the sampled oracle rejects it for both providers.

Run the negative control against fresh recovered sources:

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/jvm-multimodule-cfr/run_behavior_negative_control.ps1 `
  -BuildDirectory work/benchmarks/jvm-multimodule-cfr-build `
  -SourceDirectory work/benchmarks/jvm-multimodule-cfr-run/sources `
  -OutputDirectory work/benchmarks/jvm-multimodule-cfr-behavior-negative-control
```
