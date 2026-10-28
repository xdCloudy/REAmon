# M6 — Protected-binary analysis and recovery (P1)

## Goal and status

This P1 milestone treats protection as a first-class condition that can coexist with
stripping, optimization, obfuscation, and partial corruption. The current implementation
is limited to a static PE inspector that reads at most 1 MiB of headers and samples at
most 64 KiB from each executable section, with a 256 KiB aggregate sample cap. It records
section metadata, architecture, entry-point RVA-to-section mapping, import and certificate
directory locations, sampled Shannon entropy, and conventional UPX section-name indicators
as **suspected** evidence in project observations. It does not parse import names or verify
certificate contents. High
entropy is only a generic packing/encryption/data indicator; it does not identify a family.
Synthetic PE fixtures do not establish detector precision/recall on real binaries. The
inspector does not execute or unpack the file, detect arbitrary packers, identify a
commercial protector, extract a layer, or prove that a marker corresponds to a genuine
UPX-packed file. All other protection capabilities below are planned.

The original artifact remains authoritative and immutable. A protection hypothesis is
never a replacement for the input hash, provider output, or validated reconstruction.
“Detected” means a specified indicator was observed; “suspected” means one or more
family-specific indicators plus format or structural context support a hypothesis;
“confirmed” requires an independently validated format- or version-specific analysis
result; “unknown” means available evidence does not resolve the condition. No result may
imply “unprotected” merely because a signature was absent.

## Pipeline and evidence contract

1. **Identify.** Inspect the executable format, architecture, section table, entry point,
   imports, relocations, signature data, entropy by mapped region, and bounded strings.
   Store each indicator with method/version, offsets or section identity, exact artifact
   hash, confidence calibration, false-positive limitations, and truncation. Keep
   protection family separate from evidence class and analysis state.
2. **Represent layers.** Preserve the original bytes. Every extracted, transformed,
   reconstructed, or runtime-observed layer is an immutable derived artifact with its
   own SHA-256, parent hash, transformation/provider/version/options, input/output sizes,
   timestamps, and verification result. Providers run against an explicit layer ID;
   never silently replace the selected original.
3. **Recover safely.** Prefer deterministic, non-executing format inspection and static
   unpacking. Integrate unpackers/emulators only behind versioned, auditable adapters with
   fixture coverage and license review. Dynamic work requires explicit operator
   authorization and an isolated worker with bounded CPU, memory, disk, process count,
   time, restricted filesystem, explicit network policy, controlled side effects, and
   verified cleanup. Authorization and worker evidence bind to the exact input hash.
4. **Record blocked code.** Mark suspected virtualized methods, interpreter dispatch,
   opaque predicates, inaccessible encrypted regions, and unknown/truncated bytes with
   address range, architecture, originating layer, and evidence. Link unresolved units to
   the persistent M5 failed-unit investigation queue. A proposed equivalent source is
   semantic reconstruction, not recovered original source.
5. **Validate.** Keep failed hypotheses, alternatives, counterexamples, and diagnostics.
   Compare candidate output against static instruction/CFG evidence, independent provider
   results, authorized traces, compiler receipts, or a reproducible behavioral oracle.
   If no safe oracle exists, status is `unavailable` or `incomplete`, never successful.
6. **Surface and export.** Show protection state/family hypothesis, layer chain, analysis
   coverage, blocked regions, provider alternatives, agent investigation progress,
   verification evidence, and unresolved uncertainty in project UI and exports. The
   export manifest carries the complete artifact lineage and validation limits.

## Scope by protection condition

| Condition | Required handling | Current REAmon evidence |
| --- | --- | --- |
| Conventional executable compression/packing | Detect format-specific signatures/section/entrypoint changes; test deterministic extraction on owned fixtures; hash and re-analyze the output as a child artifact. | Suspected UPX PE section-name indicator, entry-point-to-section mapping, import/certificate directory locations, and bounded executable-section entropy samples; no calibrated detection or extraction. |
| Encrypted or runtime-decrypted code | Mark file and runtime-visible layers separately; preserve address and observation provenance; do not claim static recovery where ciphertext remains. | Planned. |
| Import reconstruction and relocation complications | Preserve original and reconstructed tables separately; validate RVAs, relocation targets, and imports against independent analysis or execution evidence. | Planned. |
| Anti-analysis, anti-debugging, anti-tamper | Record evidence and observed effects; report interference and unsupported execution conditions. Do not disable protections implicitly. | Planned. |
| Control-flow obfuscation / opaque predicates | Link recovered CFG and transformation claims to original addresses, provider evidence, and bounded validation; retain unresolved edges. | Existing provider-specific CFF analysis is partial; not a general protected-binary pipeline. |
| Virtualized functions / custom interpreters | Identify probable dispatch/bytecode regions; preserve interpreter and virtual instruction evidence; queue each unresolved function for M5 investigation. | Planned. |
| Partial protection | Keep per-region status and coverage; recover accessible units while preserving inaccessible ranges and denominator. | Planned. |
| Nested/layered protection | Build a hash-linked parent/child chain and independently classify each layer; bound depth, bytes, and total resource use; detect cycles and failed extraction. | Planned. |

## Acceptance gates

All thresholds apply to a preregistered, held-out benchmark and are reported per format,
architecture, protector version, and protection condition, with confidence intervals.

- **Detection:** for each declared family/version scope, achieve ≥95% precision and ≥85%
  recall for *supported fixture strata*. Unsupported families remain `unknown`; do not
  extrapolate a product-name signature into generic support. Report false positives on
  ordinary, malformed, and adversarially renamed-section fixtures.
- **Layer integrity:** 100% of published child artifacts have verified hashes, parent
  links, transformation identity/options, and immutable originals; zero silent overwrite,
  cross-project link, or unreported truncation.
- **Coverage:** report executable bytes, mapped sections, analyzable functions, extracted
  regions, virtualized/blocked ranges, and unknown bytes separately. ≥95% of benchmark
  regions must have a status; no denominator may omit inaccessible regions.
- **Recovery:** report extraction success and recovered-unit coverage by exact tool and
  fixture versions. Recovery success is not source reconstruction. No generic “commercial
  protector supported” claim without at least one reproducible, lawfully held sample per
  explicitly declared exact version/platform combination.
- **Validation:** ≥90% precision for claims marked validated against an available oracle;
  syntax/build success alone does not satisfy this gate. Behavioural parity is reported
  only for tested inputs and conditions. Missing or unsafe oracles are unavailable.
- **Safety:** dynamic tasks require explicit authorization, isolation profile, resource
  limits, network policy, audit receipt, timeout, cancellation, and verified cleanup.
  Zero unauthorized execution or unresolved cleanup failures in fault-injection tests.
- **Recovery lifecycle:** use M5 queue gates for resume, cancellation, budgets, source
  diffs, human review, and rollback. Protection findings may not bypass those gates.
- **Performance:** publish wall time, peak memory/disk, CPU, coverage, cancellation latency,
  cleanup time, and failure/retry counts by artifact size and layer depth.

The benchmark uses licensed, compiled open-source samples with source trees and reproducible
build recipes, plus clean/packed pairs created with pinned open tools (UPX is the initial
fixture candidate). Include x86 and x64 PE, debug/release, optimization levels, stripped
symbols, malformed/truncated files, renamed sections, nested layers, and protected and
ordinary counterexamples. Do not commit third-party commercial protected binaries or
sensitive target data. Any commercial sample must have explicit lawful acquisition and
redistribution terms; otherwise run a local-only benchmark and publish only hashes and
non-sensitive results. Exact original source names are not required when compilation erased
them; score semantic usefulness separately.

## Commercial family evidence and declared limits

This survey records vendor-described features as test-stratification context only. Vendor
claims are not REAmon detection or recovery evidence. A supported sample requires exact
artifact hash, producer version, architecture, format, enabled protection options, and a
reproducible lawful fixture.

| Family | Public vendor-described scope reviewed | REAmon status |
| --- | --- | --- |
| VMProtect | Vendor release **3.11** (2026-10-08). Vendor overview says native x86/x86-64/ARM64 and .NET assemblies across Windows, Linux, macOS, and Android; protection modes include packing and virtualization. Actual target support depends on edition/options. | Not detected or recovered by REAmon. The vendor's broad scope is a benchmark-stratification lead only; support each exact format/architecture/version separately. |
| Themida / WinLicense | Oreans changelog **3.2.6.0** (2026-08-11). Product comparison lists Windows native x86/x64 EXE/DLL, plus ARM64 and macOS/Linux variants; options include virtualization/mutation, encryption/compression, anti-debug, and integrity checks. WinLicense adds licensing. The changelog says the x64-hosted protector handles x86/x64 Windows. | Not detected or recovered by REAmon. The current demo download on product overview may lag the changelog; record actual protector build and options for any fixture. |
| Enigma Protector | Vendor release **8.10 build 20260930** (2026-09-30), separate x86/x64 Windows editions; official pages describe Windows PE protection, VM markers, anti-debug, licensing, and virtualized file bundling. | Not detected or recovered by REAmon. Record exact x86/x64 edition, build, OS, and enabled VM/protection settings; no generic Enigma support is implied. |
| Obsidium | Vendor release **1.9.0.8 x86** and **1.9.0.12 x64** (2026-09-27). Vendor scope: 32/64-bit Windows native EXE/DLL/SCR and .NET Framework 4.x executables. Evaluation builds disable code virtualization and the command-line version. | Not detected or recovered by REAmon. An evaluation build is not a valid virtualization fixture; retain edition and enabled feature metadata. |
| ASProtect / ASPack | Primary vendor page did not load in this audit. A third-party listing reports **ASProtect SKE 2.68** (2013), and a reseller describes ASProtect/ASPack Windows x86/x64 products; product/version/format details are therefore historical and unverified. | Not detected or recovered by REAmon. Obtain current primary vendor docs and an authorized exact-version fixture before specifying adapter scope. |
| UPX | Official release **5.2.1** (2026-08-27); upstream describes support for multiple executable formats including Windows programs/DLLs, macOS apps, and Linux executables. The REAmon benchmark should pin the UPX host binary and target architecture/format separately. | Static PE section-name suspicion only; no confirmed detection or unpacking support yet. |

Versions and format/platform support must be refreshed at benchmark planning time. The
current audit reviewed the public vendor feature pages and release pages linked below on
2026-10-27; these point-in-time version notes are not a durable REAmon support statement.

## Dependencies and implementation order

1. Complete stable artifact/layer identity, provenance, bounded static inspection, and
   coverage accounting (P0 foundations already partly exist).
2. Implement exact-version clean/UPX fixture generation and false-positive benchmarks.
3. Add independently versioned detection adapters; report evidence and uncertainty before
   adding any extractor.
4. Implement immutable derived-layer storage and safe deterministic unpacking for one
   reproducible open fixture family.
5. Connect blocked units to M5's persistent investigation queue and expose layer/coverage
   status in the visualizer and export.
6. Consider user-authorized dynamic observation only after worker isolation, authorization,
   resource enforcement, and cleanup gates pass; use static/dynamic fusion M3 to correlate
   traces. Then iterate toward type/symbol recovery, project build, and differential checks.

This milestone does not authorize unpacking third-party targets automatically. It does
not promise universal unpacking, commercial protector bypass, original-source recovery,
or behavioral equivalence.

## References

- [UPX upstream repository and security context](https://github.com/upx/upx)
- [UPX 5.2.1 release and source hashes](https://github.com/upx/upx/releases/tag/v5.2.1)
- [UPX official homepage and license notes](https://upx.github.io/)
- [VMProtect product overview](https://www.vmpsoft.com/vmprotect/overview) · [vendor release history](https://vmpsoft.com/news)
- [Oreans feature comparison](https://www.themida.com/CompareProducts.php)
- [Themida 3.2.6.0 release notes](https://www.themida.com/ThemidaAllWhatsNew.php)
- [Enigma Protector feature overview](https://www.enigmaprotector.com/en)
- [Enigma release history](https://enigmaprotector.com/en/news.html)
- [Obsidium protection features](https://www.obsidium.de/product/sps/features)
- [Obsidium version/download information](https://www.obsidium.de/product/sps/download)
- [ASPack Software product family](https://www.aspack.com/) (unavailable during this audit; version details not independently verified)
- [M5 multi-provider and failed-unit investigation gates](REAMON_RECONSTRUCTION_MILESTONES.md#failed-unit-investigation-lifecycle)
- [Architecture and durable evidence model](REAMON_ARCHITECTURE.md)
- [Secure worker and release gates](REAMON_READINESS_MATRIX.md)
