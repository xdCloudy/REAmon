# Virtualized-code reconstruction

## Purpose and current state

Commercial virtualization is a distinct P1 reverse-engineering problem. A protector may
replace selected native instructions with custom bytecode interpreted by a bundled VM;
the VM dispatcher is infrastructure and is not itself the protected program's logic.
The goal is evidence-supported, maintainable semantic reconstruction of bounded functions,
not recovery of the protector's source, VM keys, or exact original declarations.

**Current state:** REAmon has provider-specific IR, disassembly, CFF evidence, and
obfuscation passes. It has no validated generic virtualized-region classifier, no
virtual-instruction architecture recovery, and no commercial-protector fixture-backed
support. The UPX PE marker inspector does not detect virtualization.

## Investigation lifecycle

1. Identify candidate regions from independent structural evidence (instruction
   distributions, dispatcher/handler relationships, opaque transitions, encrypted
   bytecode, runtime traces) and record alternative explanations. A product signature is
   not proof that a particular function is virtualized.
2. Separate likely VM runtime/dispatch code from candidate application-level VM bytecode
   and handler semantics. Persist boundaries only with evidence; otherwise keep an
   unresolved range and report coverage uncertainty.
3. Recover supported VM instruction semantics incrementally from static data flow,
   dispatcher/handler control flow, controlled owned fixtures, or explicitly authorized
   traces. Keep each observation tied to the exact original artifact, function/range,
   module mapping and execution conditions.
4. Emit a versioned evidence IR whose operations point to bytecode/native addresses,
   handler evidence, inputs/outputs, and unresolved effects. Preserve unsupported opcodes,
   side effects, exceptions, concurrency and unknown semantics rather than replacing
   them with guessed no-ops.
5. Ask multiple providers to analyze the mapped native/intermediate representation when
   compatible; submit disagreements and missing semantics to M5's agent queue. An agent
   can produce a separate equivalent-source candidate with an evidence map and diff.
6. Validate on known input/output pairs or a safe original oracle. Compile, differential
   test and replay traces where possible. A dispatcher match, plausible IR, syntax check,
   or successful compile is not proof of protected-function behavior.

## Acceptance gates

Create controlled fixtures from licensed open-source applications and generated toy
interpreters with known source, bytecode, handler semantics and build recipes. Add
authorized commercial samples only if licensing/distribution terms permit; otherwise keep
them local and publish hashes and aggregate metrics only. Cover VM versions and options,
x86/x64/ARM64, PE/ELF/Mach-O where supported, multiple compilers and optimizations,
stripped symbols, anti-analysis interference, mixed native/virtualized functions, nested
protection, malformed bytecode and unsupported handlers.

- Region classification precision ≥95% and recall ≥80% for each declared fixture scope;
  report false positives from ordinary dispatch loops, interpreters, JITs, and
  obfuscation-only code.
- On labeled fixtures, VM instruction/handler mapping precision ≥95% and semantic
  operation accuracy ≥90%; unsupported semantics stay explicit and reduce measured
  coverage rather than being approximated silently.
- Function semantic correctness is measured against known ground truth and behavioral
  oracles per tested input. Report exact-original-source-name recovery separately from
  semantic usefulness; no source-text similarity substitutes for semantics.
- At least 90% of known virtualized regions have a state and byte/address coverage entry;
  every omitted or unmapped range appears as unresolved.
- Across independent sessions/providers, normalized VM semantics achieve ≥99%
  consistency on replayable fixtures; any intentional nondeterminism and version/option
  differences are segmented.
- A behaviorally validated claim meets M2's oracle, differential replay, and worker
  safety gates. No oracle means `unavailable`, never validated.
- Record CPU, wall time, peak memory, trace overhead, token cost, cancellation, recovery,
  and per-handler progress under explicit budgets. A timeout preserves prior artifacts and
  allows safe resume without duplicate publication.
- Every candidate preserves immutable original outputs, exact hashes, evidence links,
  competing hypotheses, attempt history, source diff, validation, reviewer receipt, and
  rollback. Zero silent claim promotion or canonical-symbol corruption.

## Dependencies and limits

P0 artifact/region identity, M3 static/dynamic mapping, M5 provider reconciliation and
agent investigation, semantic type recovery, and M2 behavioral validation are dependencies.
Protection-family triage is owned by the [protected-binary milestone](REAMON_PROTECTED_BINARY_RECOVERY.md);
encryption identification/capture is owned by [encrypted-binary recovery](REAMON_ENCRYPTED_BINARY_RECOVERY.md).
This specification measures the code-virtualization layer after triage and does not
double-count those systems.

Report declared producer/version/architecture/options per supported scope. VMProtect,
Themida/WinLicense, Enigma Protector, Obsidium and ASProtect are test-family candidates,
not currently supported REAmon protectors. Do not infer that one analyzed VM implementation
generalizes to another version or commercial family. Authorization, isolation, resource
bounds, cleanup, and original-artifact immutability remain mandatory.
