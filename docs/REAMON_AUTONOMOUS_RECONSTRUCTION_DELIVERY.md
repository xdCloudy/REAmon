# REAmon autonomous reconstruction and fidelity delivery plan

**Status:** accepted roadmap and test specification, not a completed implementation.
**Scope decision:** 2026-11-05.
**Implementation baseline:** existing REAmon capabilities on main before this documentation change.
**Canonical implementation evidence:** [feature matrix](REAMON_FEATURE_MATRIX.md), [reconstruction stage matrix](REAMON_RECONSTRUCTION_STAGES.md), [language matrix](REAMON_LANGUAGE_MATRIX.md), and [readiness matrix](REAMON_READINESS_MATRIX.md).

## North-star acceptance scenario

An authorized operator imports a known-source executable or application, independently
analyzes it using applicable providers, reconciles competing evidence, recovers
project-wide identities and types, prepares an editable multi-file source project,
compiles or otherwise validates it under a reproducible recipe, resolves bounded
failures, reviews the result, and exports source plus an inspectable evidence bundle.

Every step must be resumable and provenance-linked. A useful partial result is valid,
but it must be labeled partial with unresolved units and missing validation. One passing
fixture is a bounded supported-scope demonstration, not proof of universal recovery.

A delivered end-to-end slice must preserve all of the following:
- Original artifact and each provider output remain immutable, with exact SHA-256,
  versions, options, architecture/ABI, analysis run and address/module mappings.
- Discovered, visited, returned, indexed, reconstructed, reviewed and validated
  populations have distinct denominators, omissions and truncation states.
- Recovered facts, evidence-supported hypotheses, generated scaffolding, human
  review decisions, validated assertions, and unknowns are separately typed.
- Semantic source changes never overwrite canonical provider evidence or reviewed
  source without the required compare-and-swap review/promotion policy.
- Where an oracle is unavailable or unsafe, behavioral validation is
  UNAVAILABLE—not PASSED, FAILED by default, or silently omitted.
- A failed, cancelled, expired or restarted worker cannot publish accepted output.
- Export includes source, dependency/resource inventory, exact receipts, known
  differences, build/test commands, and unsupported or inaccessible regions.

## Delivery streams and crosswalk

| Recommendation | Existing REAmon owner or reference | New delivery gate |
| --- | --- | --- |
| Autonomous import-to-source-to-export reconstruction | M4 whole-project rebuilding, durable rewrite attempts, reviewed export | AR-6 one complete, replayable, scope-declared application reconstruction; no manual hidden step |
| Real-world benchmark and regression corpus | Fixture-backed fidelity workstream and M1–M5 acceptance protocol | AR-0/AR-8 versioned held-out projects, paired inputs, reproducible scoring and no-regression decision |
| Shared web/agent/MCP tool interfaces | Craft Anything adoption CA-1, existing provider and MCP contracts | AR-1 identical typed requests/results, ownership checks, errors and capability-state semantics |
| Durable summary-first paged evidence | Craft Anything adoption CA-2, persisted observations | AR-2 cursor replay, hash-bound totals, budget limits, restarted-session continuity, no omitted success |
| Multi-decompiler semantic reconciliation | M5 and failed-unit investigation queue | AR-3 evidence-ranked disagreement adjudication; correlated providers are not independent votes |
| Automatic validation, feedback and repair | M2/M4, CA-3/CA-4, attempts, checkers and review receipts | AR-5 typed oracle checks, counterexamples, bounded retry and rollback, human acceptance gate |
| Project-wide symbols, types and dependencies | ASSR-1/2/3, M1 and M4 | AR-4 stable cross-file bindings, contradictory hypotheses and versioned type layouts; no identity drift |
| Static/dynamic analysis fusion | M3, authorized worker execution | AR-4b exact module/relocation/function/block mapping, coverage and fallback to static-only |
| Web/application behaviour evidence | Existing browser and application analysis tools; CA-6 candidate | AR-7 separate captured UI/network/runtime observations with replayable behavioral oracles |

These streams share underlying implementation; progress must not count the same
existing component as completed in more than one workstream. CA-0/CA-5 remain
research or optional provider comparison until real REAmon integration passes fixtures.
The new independent benchmark and external-observation acceptance scopes have their
own zero-complete weighted rows in [progress data](REAMON_PROGRESS.json). All other
recommendations expand the acceptance detail of established workstreams and do not
generate fresh completion credit.

## Work packages and explicit pass conditions

### AR-0 — Baseline and fixture inventory (P0)

Record exact toolchains, source licenses, architectures, run flags, platform images,
versions, fixture hashes and expected outputs. Include native PE/ELF for more than one
optimization level, debug/stripped pairs, managed .NET, JVM/JAR, DEX/Android, a
Python/bytecode target, intentionally difficult malformed or obfuscated controls, and
at least one multi-module project. Match fixture selection to supported environments:
do not mark unsupported architectures or unavailable compilers as failures of a
different supported scope. Keep independent ground truth hidden from agent prompts.

**Pass:** a reproducible one-command baseline run produces per-fixture receipts and
explicit coverage/truncation, including failures and skipped/inapplicable cases.
Separate fixture enrollment from genuine full end-to-end recovery.

### AR-1 — Cross-surface analysis contract (P0; CA-1)

Use one REAmon-owned versioned capability description: input/output JSON schema,
artifact and project scope, tool permissions, supported states, resource limits,
error taxonomy, cancellation, provenance, and version constraints. Browser, agent
and MCP adapters map to this same operation without a second authoritative registry.

**Pass:** compare semantic request/result identity, permissions, unsupported states,
hashes and errors across all applicable entrypoints. Deny stale or foreign-project
requests and prevent an agent-specific bypass. Never promote a tool inventory count
to an implemented or exercised capability count.

### AR-2 — Durable evidence access (P0; CA-2)

Return summary-first evidence and stable, bounded continuation cursors. Preserve the
complete retained server-side analysis and its provider/source ancestry. An evidence
page records exact run/artifact identity, counts, selected range, omitted portions and
cursor expiry/restart semantics. Context limits affect transmission, not saved truth.

**Pass:** high-cardinality fixtures, concurrent updates, restart recovery, token
budget limits, deduplication, project isolation and missing-page detection are tested.
All omitted or unvisited work remains explicitly discoverable.

### AR-3 — Reconcile independent providers (P1; M5)

For the same verified binary unit, identify disagreements in boundaries, CFG,
branches, data flow, instruction effects, signatures, references and names. Map
equivalent functions with auditable provenance. Store alternatives and dependence
between engines; solicit targeted disassembly, IR, trace or provider follow-up only
when it can distinguish hypotheses. Never silently overwrite an alternative with
a synthesized consensus.

**Pass:** held-out correspondence, false-match, calibrated confidence and conflict
resolution reports beat a pinned baseline without unacceptable regressions. Tests
include known correlated provider mistakes and unresolved ambiguity.

### AR-4 — Project-wide semantic consistency (P1; ASSR/M1/M4)

Give each verified binding, symbol, type, module and function stable identity. Use
call/reference graphs and compiler/runtime/ABI evidence to reconcile names, structs,
fields, signatures, imports, build targets and resource relationships. Apply changes
only to proven bindings, with conflict detection, review, exact-source guards and
reversible snapshots. Preserve unsupported declarations and absent metadata.

**Pass:** cross-file binding precision, type/layout precision and recall, compile
errors, no unintended reference changes and rollback are measured on versioned
multi-file fixtures. Keep ASSR approval rules separate from M1 type inference.

### AR-4b — Static/dynamic evidence correlation (P1; M3)

When authorized, capture bounded runtime events and map process/module identity,
load bias, ASLR and address ranges back to immutable static units. Record invocation
inputs, coverage, environment, debugger version and dropped-event counts. Traces
are evidence, not proof of full observed behavior.

**Pass:** replayable mapping precision/recall and overhead measurements, an isolation
and cleanup test, and an explicitly supported static-only route.

### AR-5 — Pluggable checks and bounded repair (P1; CA-3/CA-4, M2)

Represent every check with exact input/candidate hashes, checker/toolchain version,
execution environment, scope, declared oracle, coverage and PASSED/FAILED/UNAVAILABLE
state. Order parsing and structural checks before applicable builds, differentials
and controlled runtime behavior tests. Supply concrete failing inputs, traces or
instructions to the same bounded durable attempt lifecycle. Enforce retries, cost,
time, concurrent leases, interruption, cancellation, and rollback.

**Pass:** deliberately incorrect candidates fail under a trustworthy oracle;
repaired candidates must rerun the relevant check. No compilation or screenshot-only
result is promoted as behaviorally equivalent. Human review remains the promotion
boundary until the separately defined ASSR-3 policy qualifies.

### AR-6 — Complete project assembly and export (P1; M4)

Assemble reviewed modules, dependencies, resources, manifests, entry points and
source mapping into a coherent project. Attempt a reproducible build using exact
pinned toolchains only where supported. Report missing files/dependencies without
inventing them as recovered originals. Export all relevant work, validated scope,
failed checks, review decisions and replay recipes.

**Pass:** a held-out multi-file project survives import, analysis, source review,
rebuild, differential test where a safe oracle exists, browser restart and reimport
of the exported tree. Only passing gates earn end-to-end completion.

### AR-7 — Web and application behaviour evidence (P2; CA-6)

Treat web/app analysis as one optional evidence-producing interface, not a separate
unreviewed cloning engine. For explicitly authorized scopes, capture stateful UI
flows, accessibility/DOM evidence, relevant network requests and responses,
viewport settings, navigation, console failures and, where permitted, runtime
observations from CDP or platform instrumentation. Track session identity and
mask secrets/personal data. Keep clean-room external observations distinct from
deep internal code/bytecode evidence. Require the same project isolation, worker
broker, permissions, rate limits and network policies as other REAmon tools.

Use paired versioned test applications and fixtures to compare specific input/action
to output/side-effect behavior; deterministic capture and stable selectors are more
important than screenshot similarity. Classify non-deterministic third-party calls,
dynamic content and inaccessible routes as unknown/unsupported.

**Pass:** replay the declared UI/network state transitions in a bounded fixture;
record mismatches, state coverage and environment; prove tenant/tool authorization;
keep screenshot/layout agreement in a separate metric. This does not certify recovered
source and does not imply REAmon already has an integrated AR-7 checker.

### AR-8 — Scoring, regression and documentation consistency (P0)

Pin a baseline commit, fixtures and toolchain versions, then compare each candidate
revision on the same eligible corpus. The evaluation result should contain:

| Metric | Required reporting |
| --- | --- |
| Inventory and coverage | Discovered, visited, analyzed, returned, indexed, reconstructed, accepted, validated; known denominators and caps |
| Reconstruction fidelity | Function correspondence, symbol/type precision and recall, unresolved contradictions, source and dependency completeness |
| Build and behaviour | Parse/build pass, exact binary/instruction match where meaningful, differential pass, counterexamples and oracle-unavailable counts |
| Web/app observation | Stateful transition and network-effect checks, missing states, external dependencies, separate visual/layout similarity |
| Operational quality | Runtime, peak memory, worker failures, cancellations, recovery, retries, model token/cost budget and human review burden |
| Safety/provenance | Exact input/run/candidate/test hashes, source-truth separation, project isolation and authorized replay |

Report overall results by format, architecture, compiler/version, optimization,
obfuscation and supported oracle. An unavailable check must not inflate the pass
rate; unknown or truncated units must not disappear from a denominator. A proposal
is a regression if it weakens an existing supported fixture, falsifies provenance,
silently raises supported-scope claims, damages existing imports/exports, or breaks
previously protected authorization/review behaviour.

**Pass:** identical baseline/candidate fixture manifests, independently verifiable
receipts, reproducible aggregate computation, negative controls, and a reviewable
before/after report. Do not invent benchmark thresholds or claim a new score before
REAmon-run evidence exists.

## Sequence and release policy

1. **P0:** freeze corpus/ground truth; implement AR-1 contract and AR-2 replayable
   evidence; establish a full-system baseline and scope-specific pass/fail reporting.
2. **P1:** use M5, M1 and ASSR to build a coherent source candidate; add CA-3/CA-4
   validation and bounded repair; demonstrate M4 complete export on one fixture.
3. **P1:** add authorized M3 runtime evidence where it materially resolves static
   uncertainty, without blocking static-only work.
4. **P2:** add AR-7 external web/application observation adapter and separate
   behavioral checks; expand corpus and independent adapters only after measured value.

Every feature PR should update its exact feature/stage/language/readiness evidence,
fixtures, and [weighted progress](REAMON_PROGRESS.md) only for genuinely accepted
implementation. Documentation-only scope changes belong in the denominator first;
they never raise completion. Readiness and security gates can block a release at any
weighted score.

## Documentation and implementation non-regression checklist

- Preserve existing capability statements, evidence, caveats, previous dates,
  links, milestone owners, acceptance thresholds and review boundaries unless a
  separately verified implementation deliberately changes them.
- Keep the status of CA-1/CA-2 and AR-0 through AR-8 as planned until their own
  fixtures pass. Never import upstream performance claims as REAmon achievements.
- Keep README progress, progress JSON and generated progress matrix synchronized;
  total workstream weight is exactly 100 and no old completion rating changes without
  new implementation evidence.
- Check local Markdown links, all previously tracked milestone identifiers, core
  stage rows, supported-language claims and production-readiness blockers.
- Run repository documentation and product-progress checks before merge. This
  specification does not represent a live service, quality gate or benchmark run.
