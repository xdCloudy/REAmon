# Encrypted-binary analysis and recovery

## Purpose and ownership

Encrypted executable content is a separate P1 capability from generic packing and
deobfuscation. This milestone owns encrypted executable-region identification, access
classification, safe observation of legitimate plaintext, and the resulting coverage
and lineage. The [protected-binary milestone](REAMON_PROTECTED_BINARY_RECOVERY.md) owns
cross-family triage and artifact-layer provenance; [M3](REAMON_RECONSTRUCTION_MILESTONES.md)
owns static/runtime evidence mapping; [M5](REAMON_RECONSTRUCTION_MILESTONES.md) owns
provider disputes and agent investigation. This document does not authorize bypassing
access controls or acquiring keys.

**Current state:** the bounded PE inspector records only conventional UPX section-name
markers as suspected evidence. It does not identify encrypted content, access runtime
plaintext, or recover encrypted regions. Existing import/string/decompiler paths do not
qualify as encrypted-binary recovery.

## Workflow

1. **Triage without overclaiming.** Record format, architecture, loader/entrypoint,
   sections, imports/relocations, signatures, entropy samples, and related metadata with
   offsets, hashes, bounded read scope, and provider version. High entropy is a clue, not
   proof: compression, certificates, media, and random data can look similar. Classify
   `suspected`, `unknown`, `confirmed unsupported`, and `confirmed` only under calibrated,
   version-specific evidence. Absence of a marker never means plaintext or unprotected.
2. **Map regions.** For each section/function/resource, record whether bytes are
   file-backed, statically readable, known encrypted, runtime-observed, or inaccessible.
   Bind ranges to the exact parent artifact, image base/relocation model, architecture,
   and uncertainty. Do not invent boundaries when the loader or format does not expose
   them.
3. **Observe only with authorization.** Static inspection is preferred. A runtime
   capture requires explicit operator authorization, a signed task bound to the input
   hash, isolated worker policy, no implicit network, bounded CPU/memory/disk/processes,
   timeout, cancellation, side-effect controls, and verified cleanup. Observe legitimate
   execution; do not request or extract secret keys, credentials, or protected data.
4. **Preserve plaintext as evidence.** Every captured region is a separate immutable
   child artifact with hash, exact execution and tool versions, authorized inputs and
   environment, module/load address, relocation and mapping details, capture time,
   coverage conditions, and cleanup receipt. Preserve original ciphertext unchanged.
5. **Submit evidence for reconstruction.** Run compatible static/decompilation
   providers against a verified captured child. Keep their outputs separate, map functions
   and addresses to their parent region, and send conflicts or incomplete functions to
   M5. Runtime-observed bytes from one run are not complete program coverage.
6. **Validate and report.** Keep detected, recovered, decompiled, reconstructed,
   compiled, behaviorally validated, and unresolved units as distinct counts. If the
   decryption key, executable plaintext, authorized context, or reliable oracle is
   unavailable, report that stage unavailable/incomplete with evidence and reason.

## Supported-scope matrix

| Scenario | Current implementation | Required next evidence |
| --- | --- | --- |
| Fully encrypted artifact or embedded payload | Unsupported | Format-specific container fixture and lawful, known key/plaintext pair; never infer decryptability from entropy. |
| Encrypted executable section | Unsupported | Known PE/ELF/Mach-O mapped ranges, relocation and loader behavior, encrypted/clear paired fixture. |
| Individually encrypted functions / runtime-decrypted code | Unsupported | Authorized synthetic fixture with exact address map and deterministic capture replay. |
| Encrypted modules/libraries or VM bytecode | Unsupported | Exact module/VM version, loader relation, bytecode and behavior ground truth. |
| Encrypted resources, strings, embedded data | Unsupported as encryption recovery | Preserve ordinary resource/string observations; separate encryption hypothesis from content classification. |
| Layered encryption + packing + virtualization | Unsupported | Independently verifiable chain of parent/child hashes, per-layer method, coverage and reproducible bounded test. |
| Self-modifying/dynamic code | Unsupported for encrypted recovery | Isolated authorized trace, write/execute ranges, mapping and deterministic replay; static-only remains available. |

## Acceptance and benchmark gates

Use controlled, generated fixtures with known plaintext, keys, source, and build recipes;
do not commit third-party protected binaries or sensitive target data. Include whole-file,
section, function, module, bytecode, resource, layered and runtime-decrypted cases, plus
compressed-but-not-encrypted and high-entropy non-code controls. Vary architecture, OS,
compiler, optimization, ASLR/relocations, stripping, malformed/truncated data, and
observation inputs. Pin hashes, builder, protector/encryptor version, options, toolchain,
runtime and worker image.

- For each declared fixture class, achieve ≥95% precision and ≥85% recall for identifying
  the *condition*, with separate confusion matrices against compression and random-data
  controls. A name or entropy threshold alone cannot satisfy the gate.
- Report byte and executable-region coverage across `statically readable`,
  `runtime-observed`, `unavailable`, and `unknown`; ≥95% of known fixture bytes must be
  assigned one explicit state, and all omitted ranges must be counted.
- Every captured child has a verified digest and complete parent/hash/address/runtime
  provenance; zero original-artifact mutation, unreported truncation, cross-project
  links, or publication from an expired/cancelled worker.
- Address/function mapping precision ≥98% and recall ≥90% on labeled fixtures. Publish
  ambiguity and unmatched ranges separately; no forced mapping.
- Recovered plaintext byte equality must be 100% only for fixtures where the complete
  expected region is known. Partial capture reports exact range coverage and is not called
  whole-region recovery.
- Any reconstruction behavior claim requires a suitable oracle and M2 differential or
  replay gates. No safe oracle means validation unavailable, not pass.
- Fault injection verifies task authorization, isolation policy, resource bounds,
  cancellation latency, interruption recovery, cleanup, and audit receipts; unauthorized
  execution and uncleaned worker state must be zero.
- Report wall time, peak memory/disk, CPU, trace overhead, capture loss, cancellation,
  and recovery latency by artifact and layer size.

## Dependencies and release ordering

1. Stable artifact identity, evidence records, region coverage and immutable child
   artifact lineage.
2. Fixture generator and calibrated static-only classifier; false-positive controls.
3. Read-only runtime capture interface only after authorization, worker isolation,
   resource, cancellation, egress and cleanup release gates pass.
4. Address/relocation mapping through static/dynamic fusion M3.
5. Provider re-analysis and conflicts through M5; type/name recovery and whole-project
   assembly consume only linked regions with explicit unknowns.
6. Differential test M2 validates behavior only when a trustworthy, authorized oracle is
   available.

Dynamic capture is an optional evidence source. Static-only REAmon remains usable if no
safe execution or accessible plaintext exists. This milestone does not promise universal
decryption, key recovery, complete runtime coverage, or source recovery.
