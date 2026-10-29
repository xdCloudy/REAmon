# Agentic reconstruction milestones

This specification makes five capabilities independently measurable within
REAmon's long-term goal of turning difficult compiled software into comprehensible,
editable, testable, maintainable source projects. It complements the existing
[Agentic Semantic Symbol Recovery (ASSR) milestone](REAMON_SEMANTIC_SYMBOL_RECOVERY.md);
it does not redefine or double-count ASSR. Status and weighted completion are in the
[feature matrix](REAMON_FEATURE_MATRIX.md), [language matrix](REAMON_LANGUAGE_MATRIX.md),
and [progress ledger](REAMON_PROGRESS.md).

## Evidence classes and status rules

Every claim must keep its evidence class and provenance visible:

1. **Recovered:** directly emitted or recorded by a named provider from an identified
   artifact. Preserve the provider result and exact input/run identity.
2. **Inferred:** a hypothesis derived from evidence. Record the inference method,
   supporting and contradicting evidence, confidence, and uncertainty.
3. **Generated approximation:** synthesized scaffolding, guessed project metadata,
   translated source, or other generated content. Never describe it as recovered fact.
4. **Validated:** a narrowly scoped assertion passed a named check against exact
   hashes, toolchain, inputs, and environment. State what that check did and did not
   establish; passing syntax or compilation is not behavioral equivalence.
5. **Unknown or unrecoverable:** the evidence is absent, contradictory, truncated, or
   compilation has irreversibly discarded it. Preserve the unknown instead of filling
   it with a plausible-looking value.

“Implemented and validated” requires repeatable fixture evidence for the stated scope.
“Implemented, insufficiently tested” means a path exists but representative evidence is
missing. “Partial” means a narrower foundation exists. “Planned” means no qualifying
end-to-end workflow is evidenced. “Unsupported” must be reported to users and excluded
from completion denominators for supported-scope metrics.

## Milestone dependencies

```text
P0 stable artifact/unit identity, coverage, evidence provenance, safe workers
  ├─> P1 multi-provider semantic reconciliation ─┬─> P1 semantic type recovery
  │                                             └─> ASSR semantic symbol recovery
  ├─> P1 protected-binary analysis ───────────────> verified derived layers and usable evidence
  │                                                  ├─> P1 encrypted-region recovery ─> static/runtime region evidence
  │                                                  └─> P1 virtualized-code reconstruction
  ├─> P1 static/dynamic evidence fusion ───────────> type, symbol, and behavior hypotheses
  └─> P1 whole-project source assembly ───────────> controlled build and repair
                                                    └─> P1 behavioral/differential validation
                                                         └─> iterative reconstruction feedback
```

The ordering is a dependency guide, not a requirement to block independent provider
work. P0 identity/provenance and execution isolation remain prerequisites for promoting
claims or running untrusted programs. ASSR owns semantic naming, identity-consistent
renames, and its acceptance policy; type recovery owns type/layout claims; reconciliation
owns comparison and adjudication of competing provider claims; project rebuilding owns
file/module/dependency assembly; behavioral validation owns executable comparisons.
Protected-binary triage owns cross-family layer status; encrypted recovery owns
file-backed/runtime-observed encrypted-region coverage; virtualization recovery owns
custom instruction/interpreter semantics. The latter two consume, but do not duplicate,
protection lineage and M3 trace mapping. Each subsystem stores evidence and links to other
claims instead of copying or silently overwriting their canonical records.

## M1 — Agentic Semantic Type and Data Structure Recovery (P1)

**Current state:** partial, provider- and format-specific type evidence exists. REAmon
stores Ghidra prototypes and variable types, GoReSym/unstrip Go runtime metadata,
ToCode declarations, DEX signatures/references, and Swift/Objective-C metadata. There is
no common, interprocedural type graph with cross-provider contradiction handling or
broadly validated source-level type reconstruction. These provider claims already
receive credit in language support and project memory; this milestone scores only the
new inference, consistency, and validation loop.

### Acceptance

- Recover signatures, parameter and return types, calling conventions, and ABI details
  only within explicitly supported architectures, runtimes, and provider scopes.
- Represent structures, classes, fields, enums, unions, inheritance, layouts, vtables,
  dispatch, RTTI, interfaces, and function pointers when evidence supports those forms.
- Use memory accesses, pointer arithmetic, allocations, data flow, and cross-function
  relationships for interprocedural inference. Propagate only claims whose identity and
  evidence links are preserved across functions and files.
- Detect incompatible types, offsets, widths, calling conventions, and dispatch
  hypotheses. Keep alternatives and explain what evidence would distinguish them.
- Label every type as provider-recovered, inferred, reviewed, validated, or unknown;
  preserve confidence, evidence, exact artifact and unit identity, provider/tool version,
  and reversible edit history.
- Never require exact recovery of original declarations that compilation erased. Score
  evidence-supported semantic types separately from exact source-declaration recovery.

### Completion gates

- On supported ground-truth fixtures, report signature/type precision and recall per
  type category; require ≥95% precision and ≥80% recall for claimed recovered primitive,
  pointer, and function-signature types.
- Require ≥95% correct field offsets, widths, aggregate size, and alignment on layouts
  explicitly declared supported, and ≥95% calling-convention/ABI classification on the
  supported architecture/compiler matrix. Unknown layouts are excluded from accuracy
  but must appear in coverage counts.
- Require ≥98% agreement for propagated types of the same stable symbol identity across
  functions/providers after adjudication; zero silent overwrites when claims conflict.
- Keep confidently wrong accepted types below 2%; publish per-language/provider results,
  confidence intervals, ambiguity counts, and the ground-truth availability for each
  case. Source edits that depend on changed types must pass the applicable compiler or
  structural validator and retain a reversible receipt.

## M2 — Autonomous Behavioural Validation and Differential Testing (P1)

**Current state:** narrow fixture/runtime evidence exists, including a small C#→VB
compile-and-run fixture and a stripped Lua bytecode runtime comparison. Syntax checks,
compile receipts, binary view round trips, and LLM reviews do not constitute application
behavior validation. There is no broad autonomous test-generation/differential feedback
loop. Execution remains gated by REAmon's secure worker and explicit target authorization.

### Acceptance

- Generate candidate test inputs from recovered signatures, types, constraints, control
  flow, project tests, and reproducible seeds. Treat generated inputs and tests as
  proposals until their oracle and preconditions are recorded.
- Compare the original and reconstructed target only when each can run safely under an
  approved isolated worker, with explicit execution authorization, resource/time limits,
  controlled files/network/side effects, and pinned environments.
- Support differential and property-based tests and fuzzing where useful; evaluate
  symbolic/concolic execution only for cases where its engine, licensing, and target
  coverage are suitable.
- Compare relevant outputs, return values, exceptions, state/memory effects, and declared
  external side effects. Store counterexamples, trace/input/output hashes, exact original
  and candidate artifact hashes, environment, tools, and replay instructions.
- Measure statement/branch/path coverage for executed test harnesses and report untested
  or unreachable code separately. Feed a reproducible mismatch back to the corresponding
  source unit as evidence for a later reconstruction attempt, without auto-accepting it.
- If the original cannot execute, no trustworthy oracle exists, or the safety boundary
  cannot be established, report behavior validation **unavailable**, not passed.

### Completion gates

- For declared supported entry points, generated and curated inputs cover at least 80%
  of the statically enumerated feasible branches that the benchmark harness exposes;
  always report the denominator, path truncation, and untested regions.
- Detect at least 90% of seeded behavior-changing mutants or known differential defects,
  with ≤2% false discrepancy reports on equivalent builds; report both per-project and
  macro averages. These gates measure the validator, not universal equivalence.
- Reproduce ≥99% of saved counterexamples with three deterministic replays under the
  recorded environment; every retained finding includes a replayable input and toolchain
  identity or is explicitly marked non-deterministic/unreproducible.
- On the supported benchmark slice, ≥90% of independent oracle checks pass for completed
  reconstructions. This is tested-sample agreement only, never a formal equivalence claim.
- Every run meets declared CPU, memory, disk, process, network, and wall-clock budgets;
  zero execution requests bypass worker authorization or isolation. Publish median and
  p95 cost per covered unit and timeout/cancellation recovery.

## M3 — Static and Dynamic Analysis Fusion (P1)

**Current state:** REAmon has rich static provider observations and platform-specific
dynamic-analysis work elsewhere in the repository, but the feature matrix does not show
a validated REAmon runtime trace-to-static identity workflow. Static-only analysis must
continue to work when instrumentation is unavailable.

### Acceptance

- Evaluate existing debugger, instrumentation, and coverage-guided tools before building
  new tracing infrastructure. The [Ghidra Debugger static-mapping guide](https://ghidra.re/ghidra_docs/GhidraClass/Debugger/A6-MemoryMap.html)
  describes dynamic-to-static address mappings and relocation/ASLR shifts; [Frida
  Stalker](https://frida.re/docs/stalker/) provides call/return/block/instruction event
  modes; LLVM [libFuzzer](https://llvm.org/docs/LibFuzzer.html) needs a matching
  instrumented compiler and fuzz target, so it applies to buildable source/reference
  harnesses rather than arbitrary black-box binaries. These are candidates, not selected
  dependencies; audit licensing, supported platforms, overhead, target safety, and REAmon
  isolation before adoption.
- Collect only authorized runtime evidence: calls, returns, branches, address mappings,
  and memory/data observations available from the chosen platform/tool. Persist runtime,
  target module and build identity, run inputs, environment, trace coverage/truncation,
  and instrumentation version.
- Correlate module/relocation/ASLR-adjusted runtime addresses with stable static artifact,
  function, block, reference, and symbol identities. Unmapped or ambiguous events remain
  unattached and visible.
- Use observed executions to refine uncertain CFG edges, indirect calls, type claims, and
  semantic naming proposals, while stating that a trace proves only what occurred under
  its recorded inputs/environment and does not enumerate program behavior.
- Compare static predictions with runtime observations, keep contradictions explicit,
  and permit project-memory consumers to distinguish static from runtime-derived evidence.

### Completion gates

- Achieve ≥98% precision and ≥90% recall for runtime-to-static function mapping on
  supported module/relocation/ASLR fixtures; report unresolved mappings and never attach
  a trace to a different artifact hash.
- On repeated identical inputs, achieve ≥95% agreement for observed call/branch sets
  after accounting for known nondeterminism; preserve nondeterministic runs separately.
- Measure median and p95 overhead by platform and tracing mode; initial supported-scope
  gate is ≤3× median slowdown for call/block tracing on the reference fixtures. If a mode
  exceeds that bound, keep it experimental and publish the measured overhead.
- Demonstrate that trace-derived changes improve a pre-registered CFG/type/name benchmark
  over static-only evidence with a statistically reported comparison; no majority trace
  or single-run inference is treated as semantic proof.
- All executions pass the same authorization/isolation gate as M2; trace capture,
  cancellation, storage bounds, sensitive-data handling, and failure recovery are tested
  per declared platform. Static-only workflows must pass when dynamic analysis is off.

## M4 — Autonomous Whole-Project Reconstruction and Rebuilding (P1)

**Current state:** partial project-build and export slices exist. C# compiles up to 32
review-accepted files / 2 MiB into a library; Go compiles up to 64 accepted files / 8 MiB
within one module root using imported `go.mod`/`go.sum` with downloads and CGO disabled;
Java can replace one accepted class in a separate unsigned derived JAR; Android can
rebuild a saved Apktool project with reviewed Smali/resource edits; C#→VB has a small
two-file compile/runtime fixture. Maintained-source exports preserve separate decompiled
and reviewed-source trees, hashes, review/provenance and some build receipts, but do not
restore a full original build tree with dependencies and build scripts. None of these
slices means a complete application rebuild.

### Acceptance

- Recover project-relative files, classes, packages, namespaces, modules, entry points,
  imports/exports, call/type/reference relations, resources/assets, and non-code inputs
  only where evidence permits. Give every emitted or omitted source-tree path a status
  and lineage to its original artifact/unit.
- Identify compiler/runtime versions, framework, ABI/architecture, flags, build systems,
  manifests, lockfiles, resources, and generated inputs where recoverable. Distinguish
  recovered metadata from inferred/generative scaffolding; list unresolved dependencies,
  missing proprietary components, and unrecoverable build settings.
- Assemble only reviewed or otherwise policy-eligible units into a coherent project tree.
  Check cross-file symbols, types, visibility, imports, dependency closure, and path
  collisions before compiling.
- Build in a documented, pinned, controlled toolchain with downloads disabled by default.
  A separately authorized dependency acquisition step must be hash/license recorded.
  Store exact sources, manifests, toolchain, flags, logs, output hashes, and build receipt.
- Support incremental rebuild after accepted edits; invalidate dependent outputs and
  receipts when a source, manifest, resource, compiler, or dependency hash changes.
- Export the complete available tree, resources, manifests, provenance, validation,
  unknowns, and build recipe. Ensure normal IDE/build tooling can open it; make no claim
  of byte identity or recovery of the exact original project unless separately proven.

### Completion gates

- For source-available benchmark projects, account for ≥95% of original source, resource,
  manifest, and required non-code files by path/hash or explicit unknown/excluded status;
  zero silent omissions. Report recovered, inferred, generated, validated, and unknown
  coverage separately.
- Classify 100% of statically discovered direct dependencies as resolved, unavailable,
  unsupported, or unknown. A supported build cannot pass with an undeclared unresolved
  dependency or unrecorded network fetch.
- Achieve ≥80% clean build success across each language/provider stratum declared
  supported, using only the recorded toolchain/dependencies. Publish per-project results;
  a file bundle or syntax check does not count as a project build.
- Preserve ≥99% of statically resolvable cross-file symbol/reference bindings on the
  declared scope, with zero collision/path traversal and zero unresolved required import
  reported as resolved. Type confidence and source relationship confidence remain visible.
- Repeated clean builds yield the same success/failure, tests, and normalized output
  digest for deterministic fixtures. For nondeterministic builds, record the cause and
  compare normalized outputs; never conceal unstable outputs.
- For each advertised runtime/OS target, launch the reconstructed project and pass the
  pinned startup/interface smoke checks in 100% of the supported compatibility fixtures.
  If only compilation can be established, label the project buildable but not
  runtime-validated; deeper behavior agreement remains measured once under M2.
- Run the original project's pinned tests when it can be safely built; runtime/observable
  behavior agreement is measured under M2. Independent maintainers score organization,
  idiomatic structure, editability, and documentation at ≥4/5 median, while remaining
  able to trace each recovered file to evidence. Publish reviewer rubric and inter-rater
  agreement.

## M5 — Multi-Provider Semantic Reconciliation (P1)

**Current state:** REAmon stores hash-attributed alternatives, bounded diffs, similar
function candidates, analyst-reviewed cross-provider function matches, and provider
evidence in project context. Current matching and agreement are evidence for investigation,
not semantic equivalence. There is no general contradiction detector and adjudication
workflow for boundaries, CFG, types, references, or logic. A new run-scoped case intake
can persist failed or cancelled decompile/disassemble tasks with artifact hash,
provider/version, bounded failure context, and request history. Structured provider
failures also retain up to 100 code-unit/function summaries with a run token and original
artifact hash; these diagnostics are snapshotted into the case but are not canonical
observations or success evidence. Provider-asserted derived-source hashes are not
trusted unless REAmon verifies the file bytes. Failure intake now copies allowlisted
provider text and per-unit instruction fields into separate diagnostic snapshots,
with a 48 KiB cap per evidence source family and hashes for each original field and
captured excerpt. These fields remain non-canonical and untrusted when passed to an
agent. The case queue has a user-triggered Run action: the user chooses a saved
OpenAI-compatible provider and one captured function/code unit, or selects a bounded
batch of up to five units. The webapp queues a
static reconstruction attempt through the durable code-attempt worker for C, C++, C#,
Go, Java, JavaScript, Kotlin, Objective-C, Python, Rust, Swift, or TypeScript when a
Tree-sitter grammar is available. Failed decompile and disassemble runs can use the
same path when they retain supported instruction or bytecode evidence. The request
stores bounded evidence, input/evidence hashes, provider/model, source identity, timeout,
and case/task IDs. Results retain source and evidence hashes, uncertainty, syntax status,
and `behavioral_validation=UNAVAILABLE`; they remain separate candidates and never
become accepted source. Each unit has a stable hash-derived attempt identity and a
separate request payload and candidate lifecycle; status reload remains compatible with
earlier case-scoped attempts. The task list shows each attempt's unit name and status and
offers cancellation per unit. Existing attempt claims, heartbeats, cancellation, stale-run
recovery, retry history, and workspace reload apply.

This remains a narrow bounded fallback, not a universal decompiler or autonomous agent
workflow. The allowlist and grammar availability bound current output languages; provider
completeness, resumable investigation budgets, targeted provider follow-ups, candidate
diffs/review receipts, benchmark accuracy, and behavioral validation remain open. Syntax
parsing is not evidence of semantic correctness.

### Acceptance

- For each declared supported binary scope, dispatch every compatible configured
  provider independently, or persist a reason a provider was unavailable/incompatible.
  Preserve original outputs side by side; a failure by one provider must not hide a
  successful result from another.
- Compare only outputs with compatible artifact identity, architecture/ABI, function
  identity, provider scope, and version. Preserve each original provider output and its
  provenance; normalized representations must retain provider-specific fields.
- Detect and classify disagreements in boundaries, control flow, signatures/types,
  references/data, and recovered logic. Record competing hypotheses with supporting and
  contradicting evidence, confidence, and unresolved status.
- Rank hypotheses using independently measured per-provider/format reliability,
  structural correspondence, and applicable validation results. Track shared upstream
  engines, common models, and copied analysis inputs so correlated providers are not
  counted as independent votes.
- Allow agents to request targeted additional analysis only with a stated uncertainty
  and expected resolving evidence. Accepted conclusions must cite their evidence and
  remain linked to project memory, type recovery, ASSR, and source reconstruction.
- When no provider offers an adequate candidate, provide an agent path from assembly,
  bytecode, CFG, IR, references, memory evidence, and explicitly authorized runtime
  observations. Selection or synthesis creates a separate candidate, iterative source
  diff, and compile/test/refinement history; it cannot mutate original provider output.
- A failed-run case with multiple eligible captured units must let an operator queue one
  unit or a bounded batch of up to five. Each attempt must be independently addressable,
  cancellable, hash-bound, and retained as a separate candidate. Reject oversized batches
  and duplicate unit keys; batch dispatch must never auto-accept drafts.
- Provider agreement or majority vote alone must never prove correctness; when evidence
  cannot resolve a conflict, retain the alternatives and report ambiguity.

### Failed-unit investigation lifecycle

The work queue is a durable, project-scoped continuation of M5, not a new provider or
another copy of the task table. A failed or inadequate provider result must retain its
exact input hash, provider/version/options, unit identity, attempted output hashes,
failure reason, and bounded resource usage. The unit may then be queued for an agent
investigation with resumable status (`queued`, `claimed`, `investigating`, `needs review`,
`accepted`, `failed`, or `cancelled`), a renewable claim token, attempt history,
deadline/token/runtime budgets, and cooperative cancellation. Restart recovery must
not discard prior attempts or allow a stale worker to publish a result.

The current manual reconstruction dispatcher enforces a per-case ceiling of 24
persisted attempts and 30 minutes of reserved provider runtime. Reservations use each
attempt's configured timeout, so failed and cancelled attempts remain charged; an
already-active unit can be fetched again without consuming another slot. Dispatches
lock the durable case row while checking and creating attempts, preventing concurrent
requests from oversubscribing the case. This is a bounded local policy, not yet a
user-configurable token budget or a full investigation deadline.

Investigators can also load cases from a project-wide cursor-paged queue rather than
visiting each failed task. The list exposes run identity, effective case/attempt status,
recent unit attempts, active work, and candidate availability; it omits captured failure
text and candidate source. It loads when expanded, refreshes while attempts are active,
and links back to the original task controls. Route and UI tests cover pagination,
authorization, summaries, and task navigation. PostgreSQL-backed pagination and
authenticated browser acceptance remain open; this summary view does not change the
candidate review or acceptance policy.

Each agent attempt works from immutable provider evidence and may request a targeted
provider run, inspect assembly/bytecode/CFG/IR/cross-references, or create a maintained
source draft. Persist the exact evidence snapshot, source diff, tool calls, diagnostics,
and validation status. Compare each candidate with the prior maintained version. A
draft cannot overwrite provider output; human review and an acceptance receipt remain
required. When evidence is inadequate, preserve the unresolved region and report why.

Queue completion requires ≥99% durable resume/replay correctness across forced worker
restarts, cancellation in every nonterminal state, expired-claim recovery, and duplicate
dispatch races; zero stale writes may be accepted. On the held-out fixture set, report
the fraction of failed units that gain useful, reviewable evidence or source, separately
from units whose behavior is validated. Candidate acceptance must preserve full source
diff and exact rollback. Unresolved and unsupported units remain visible in the queue.

### Completion gates

- On labeled compatible-provider fixtures and deliberately perturbed outputs, achieve
  ≥90% precision and ≥80% recall for material semantic disagreements, reported by
  disagreement class and compatible provider pair.
- For oracle-resolvable cases, achieve ≥90% accuracy on adjudicated claims; unresolvable
  cases must remain ambiguous rather than being forced to a winner.
- Calibrate accepted-claim confidence to expected calibration error ≤0.10 on the held-out
  corpus. Confidence is based on benchmark outcomes, not provider self-reported scores.
- 100% of reconciled claims preserve the competing provider records, common ancestry and
  input hashes, decision evidence, and any reviewer/validator receipt. Zero original
  outputs may be overwritten during normalization or reconciliation.
- Demonstrate that targeted follow-up analysis reduces unresolved material disagreements
  on a held-out set without increasing confident false resolutions above 2%.

## Shared benchmark and reporting protocol

Use compiled open-source projects with known original source trees, tests, licenses, and
reproducible build recipes. Include small and large multi-module applications; native,
managed, interpreted, and bytecode formats; complex types, dependencies, frameworks,
resources, and multiple providers. Build debug/release variants, several optimization
levels, stripped/unstripped binaries, and obfuscated/non-obfuscated variants where the
format and license permit. Vary compilers, architectures, ABIs, runtimes, and tool versions.
Pin source revision, build recipe, flags, dependencies, provider versions, environment,
and exact artifact hashes. Keep a held-out project set and publish sample counts, exclusions,
confidence intervals, timeouts, failures, and hardware.

Score per language, provider, project size, artifact state, symbol/type/relationship kind,
and build variant, plus a macro average. Do not score a missing/unrecoverable source fact
as a failed exact-name/type reconstruction; report semantic usefulness where exact source
information was erased. Separate benchmark accuracy from feature adoption or file counts.

### Threshold rationale

These are initial, preregistered release gates for declared supported scopes, not universal
claims about every program. High precision (typically 95% for exact type/layout claims
and 98% for address-to-function mapping) limits confidently wrong structure that could
mislead later edits; lower recall is acceptable only when omitted/ambiguous coverage is
reported and deferred. The 80–90% floors for semantic usefulness, differential detection,
and benchmark build success require broad repeatable value while recognizing erased
metadata and project-specific unavailable dependencies. The 80% branch gate requires
substantial exercised control-flow coverage without treating infeasible or unobservable
paths as missed proofs. A 99% replay/consistency gate
keeps saved regression evidence operationally useful. Zero silent misbindings, policy
bypasses, or unreported omissions are hard safety invariants, not averaged quality scores.
Publish confidence intervals and strata so a macro average cannot hide a failing language.
If the first benchmark run shows a threshold is not statistically or technically
meaningful, revise it before running the held-out evaluation and document the reason;
never tune it after seeing held-out outcomes.

## Architecture and safety contracts

Use existing project/artifact/task/unit identities and the PostgreSQL-owned observation,
derived-artifact, and receipt records as the durable source of truth. A future claim or
trace record must link to stable subject identity, exact input/output hashes, provider or
method/version, evidence class, address/file coordinates and mapping version, confidence,
conditions, and truncation/unknown state. Competing claims link through support and
contradiction edges; claims are not overwritten by canonicalization. Build receipts bind
accepted source, resources, manifests, dependencies, toolchain, flags, output hashes, and
tests. Behavior receipts bind authorization, worker profile, inputs, outputs, side effects,
and replay trace. Human review receipts and current worker security gates remain in force.

## Reuse references

| Reference | Reuse/design question | Boundary |
| --- | --- | --- |
| [decomp.wtf](https://github.com/i12bp8/decomp.wtf) and [ReAgent](https://github.com/Dryxio/reagent) | Reuse the bounded attempt/checker/build-feedback loop already described in the [reference portfolio](REAMON_REFERENCE_PORTFOLIO.md). | Follow their ideas only; keep REAmon's source hashes, DB memory, project isolation, evidence classes, and review receipts authoritative. |
| [DecLib](https://github.com/binsync/declib) and [Quokka](https://github.com/quarkslab/quokka) | Compare backend-neutral function/type/xref contracts and normalized binary graph exports with REAmon observations. | Preserve engine-specific evidence and exact artifact/run identity; do not make a second project database or graph canonical. Review each component license before reuse. |
| [Ghidra Debugger static mappings](https://ghidra.re/ghidra_docs/GhidraClass/Debugger/A6-MemoryMap.html) | Reuse the static/dynamic address-map concept for modules, relocations, lifespan, and ASLR-aware trace correlation. | Candidate architecture, not a claim REAmon has integrated the debugger trace pipeline. |
| [Frida Stalker](https://frida.re/docs/stalker/) | Evaluate call/return/block/instruction event granularity and buffered delivery for optional user-authorized runtime evidence. | Audit license, target/platform coverage, overhead, capture privacy, and isolation before dependency adoption. A trace is sample evidence only. |
| [LLVM libFuzzer](https://llvm.org/docs/LibFuzzer.html) | Use coverage-guided harness fuzzing when source can be rebuilt with a compatible compiler and a trustworthy target entry point exists. | It requires an instrumented build and fuzz target; it is not a general black-box binary validator. Keep replay inputs and build variants hash-bound. |

The reference portfolio and upstream reuse audit remain the licensing and integration
register. These candidates do not imply selected dependencies or shipped functionality.
The separate [protected-binary analysis and recovery milestone](REAMON_PROTECTED_BINARY_RECOVERY.md)
defines protection-family scope, safe layered artifacts, exact-version benchmark gates,
and current detector limits.

## M7 — Encrypted Binary and Executable-Region Recovery (P1)

**Current state:** planned. The PE/UPX indicator does not detect encryption or make
plaintext accessible. Existing runtime observation and string extraction are not an
encrypted-region recovery pipeline.

### Acceptance

- Distinguish encrypted content from compression, random data, and ordinary obfuscation
  using calibrated evidence. Record suspected/unknown/unsupported states and explicit
  region coverage; absence of a signature is not a negative classification.
- Map whole files, sections, functions, modules, VM bytecode, resources, and transient
  runtime-decrypted regions where evidence permits. Preserve exact parent hashes,
  addresses, relocations, load context, conditions, omissions, and capture provenance.
- Dynamic capture requires explicit authorization and all worker isolation, CPU/memory/
  storage/process/time/network and cleanup gates. Preserve legitimate observable bytes as
  immutable derived children; never overwrite ciphertext or claim unavailable plaintext.
- On known paired fixtures, meet ≥95% identification precision and ≥85% recall per
  declared scenario; ≥95% of known bytes receive an explicit readable/observed/unavailable/
  unknown state. Report function mapping precision ≥98% and recall ≥90% separately.
- Recovered known plaintext is byte-exact for complete regions; partial capture reports
  exact offsets and coverage. Behavioral validation remains unavailable without a safe
  oracle and must meet M2 when claimed.
- Verify authorization, cancellation, interruption/resume, bounded-resource behavior,
  cleanup, immutable provenance and zero cross-project artifacts under fault injection.

See the [encrypted-binary recovery specification](REAMON_ENCRYPTED_BINARY_RECOVERY.md)
for scenario matrix, fixture design, metrics, dependencies, and limitations.

## M8 — Virtualized-Code Reconstruction (P1)

**Current state:** planned. Provider-specific IR/lifting and obfuscation analysis exist,
but REAmon does not have a validated general VM-region classifier or custom instruction
semantic recovery workflow. Finding a dispatcher is not reconstructing the protected code.

### Acceptance

- Identify virtualized candidate ranges with benchmarked precision ≥95% and recall ≥80%
  within each declared scope, separately reporting interpreters, dispatch loops, JITs,
  and non-virtualized obfuscation false positives.
- Separate interpreter/runtime code from protected application semantics; recover a
  versioned, address-mapped IR with per-instruction evidence. Meet ≥95% handler mapping
  precision and ≥90% semantic operation accuracy on labeled fixtures. Unsupported effects
  remain unknown, not guessed no-ops.
- On known fixtures, measure semantic function correctness and behavior independently;
  replay consistency is ≥99% for deterministic evidence. Unobserved regions remain in the
  coverage denominator and unresolved.
- Evidence-backed source candidates retain provider alternatives, competing hypotheses,
  immutable diffs, budgets, cancellation/resume, review, validation, and rollback. Only
  suitable M2 oracle checks can mark behavior validated.
- Publish per-family/version/architecture/option performance, memory, token and trace
  overhead, failures and unsupported opcode coverage. No cross-family support inference.

See the [virtualized-code reconstruction specification](REAMON_VIRTUALIZED_CODE_RECOVERY.md)
for workflow, benchmark strata, dependency ownership, and safety boundaries.
