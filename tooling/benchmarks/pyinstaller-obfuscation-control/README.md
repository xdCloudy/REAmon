# PyInstaller obfuscation control

This paired synthetic fixture keeps the same 70 module values, branch results,
and runtime output while shortening identifiers and XOR-encoding two string
literals in the obfuscated modules. Both executables are built and run only
inside the pinned Docker builder. The live analyzer receives each artifact as
read-only input from the dedicated QA path in the `reamon_artifacts` volume.

## Build the pair

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/pyinstaller-obfuscation-control/build.ps1
```

The build script checks every pinned source hash, runs four hermetic fixture
tests inside Docker, builds both executables with the pinned Python/PyInstaller
toolchain, and checks each one against the same runtime and branch oracle. The
output directory must not already exist.

## Measure the live provider

```powershell
powershell -ExecutionPolicy Bypass -File tooling/benchmarks/pyinstaller-obfuscation-control/run-control.ps1
```

The probe verifies both artifact hashes, calls the healthy isolated provider,
collects every inventory page, and checks the 70 named target modules in each
inventory. It parses only extracted `.pyc` metadata to compare known function
names and string constants; it does not execute the artifacts. Staged files are
removed individually only after their SHA-256 values still match the build
receipt. The evidence receipt records the provider image and revision, complete
page denominators, module hashes, obfuscation markers, and cleanup outcome.

## Interpretation

A passing result means the provider inventories both archives completely and
retains the expected clean versus obfuscated bytecode markers. The provider
returns bytecode rather than source, so this does not demonstrate deobfuscation
or reconstruction fidelity. The two Docker runtime oracles establish that the
fixture variants were behaviorally matched before analysis; they do not validate
the semantics of reconstructed output.
