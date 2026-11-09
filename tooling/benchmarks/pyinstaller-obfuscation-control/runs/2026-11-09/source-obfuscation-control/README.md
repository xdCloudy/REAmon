# Paired PyInstaller obfuscation control — 2026-11-09

This run compares clean and source-obfuscated variants built from matched
70-module Python fixtures. Both passed the same Docker runtime oracle (`2485`)
and branch assertions before either artifact reached the analyzer.

## Provider result

The live isolated service was image
`sha256:dfd6e00b359c5144b39510685e15faa4dbc48645b3b0f9fe5a39669e9e5a40d3`,
extractor revision
`2aa0ec9e58317ac717fdeec84a02d5a67de7b96c2-reamon1`. Both requests returned
HTTP 200 and `status=completed`. Each inventory was complete at 180/180 modules
in pages of 64, 64, and 52; each exposed all 70/70 target modules.

The clean side retained the `classify` function name and both plaintext strings
in 70/70 target modules. The obfuscated side retained the short `_1` function
name in 70/70 and had zero of 70 target modules containing either original
plaintext string. Total module counts matched. The service returns bytecode,
so deobfuscation and reconstructed-source behavior are **UNAVAILABLE**.

Clean executable SHA-256:
`d3c076e84d3e50cdc07ff052b29496338994b92d7401115f1bce01ba5d320bab`.
Obfuscated executable SHA-256:
`152759d2c798e1407442edb8c3ad0f423c00886810533af32f4a7fdeea504fc5`.
The staging receipt confirms both volume copies were hash-checked and removed.

## Evidence and limits

`build-receipt.json` binds both generated artifact hashes to the pinned builder
image and toolchain. `provider-receipt.json` records the live provider image,
revision, paged denominators, target-module bytecode hashes and symbol/string
markers. `manifest.json` pins the builder, fixture tests and probe.

This is one generated Python 3.12.8 / PyInstaller 6.13.0 control for short
identifier names and XOR-encoded string constants. It measures module extraction
under those transformations, not source deobfuscation, commercial protectors,
packing, encryption, virtualization, project persistence, worker behavior, or
general reconstruction fidelity. It adds no completion credit to AR-0/AR-8.
