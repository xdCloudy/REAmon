# Craft Anything: REAmon adoption bootstrap

**Status:** evaluated as a reference and candidate source; **no Craft Anything code is incorporated into REAmon by this document.**

**Review date:** 2026-11-05.

**Upstream:** [storytold/craft-anything](https://github.com/storytold/craft-anything), inspected at [869eb8548ae3cf9162181659c3ab47441b9c300d](https://github.com/storytold/craft-anything/commit/869eb8548ae3cf9162181659c3ab47441b9c300d).

**REAmon owner:** upstream-reuse and reconstruction workstreams. Re-evaluate every candidate against an exact upstream revision before importing it.

This is a **source-informed adoption plan**, not a completed dependency/security audit, an integration record, or a claim of measured REAmon improvements. Keep [feature status](REAMON_FEATURE_MATRIX.md), [reconstruction status](REAMON_RECONSTRUCTION_STAGES.md), [language coverage](REAMON_LANGUAGE_MATRIX.md), [weighted progress](REAMON_PROGRESS.md), and [readiness](REAMON_READINESS_MATRIX.md) tied to REAmon evidence rather than upstream demonstrations.

## Product boundary

Craft Anything's advertised flow is **Study → Build → Check → Refine**, often producing a newly written lookalike app, site, or game. Its default **Clean room** mode restricts target inspection to externally observed evidence; **Deep** mode allows internal analysis. The engine is Rust, with desktop, CLI, and MCP front ends.

REAmon's north star remains **import compiled artifact → preserve provider evidence → reconstruct semantics, source and project structure → review → validate against an authorized oracle → export with traceable provenance**. A visually similar or runnable clone does not establish equivalent recovered source. Generated scaffolding is a generated approximation, not recovered original code. Do not change REAmon into a website or game-cloning product to match the upstream interface.

## What was inspected

- [Upstream README](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/README.md), [status and known limits](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/docs/STATUS.md), [roadmap](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/docs/ROADMAP.md), and [extension interfaces](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/docs/extending.md).
- [Tool registration and result convention](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/crates/engine/src/tools/mod.rs), [clean-room allowlist](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/crates/engine/src/clean_room.rs), [rebuild orchestrator](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/crates/ai/src/rebuild/mod.rs) and [target/check extension contract](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/crates/ai/src/rebuild/kinds/mod.rs).
- [Tool catalogue](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/docs/tools.md), [workspace dependency declarations](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/Cargo.toml), [MIT](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/LICENSE-MIT) and [Apache-2.0](https://github.com/storytold/craft-anything/blob/869eb8548ae3cf9162181659c3ab47441b9c300d/LICENSE-APACHE) top-level license texts.

Tool totals and release descriptions change across generated indexes and status pages: **do not hard-code a verified tool count as a REAmon capability**. The current upstream status explicitly documents limited real-world validation for some adapters, agent approvals, local-model builds and app/game behavioural checks. Source inspection is not equivalent to executing the tools or independently reproducing the claimed results.

## Candidate adoption matrix

**Status convention:** all rows below are **candidate / not integrated**. These priorities rank investigation and earn no implementation-completion credit. However, formally accepting CA-1/CA-2 expanded REAmon's weighted goal, so the [progress model](REAMON_PROGRESS.md) has been recalibrated from 31.9% to 29.0% (2026-11-05); new scope belongs in the denominator before it is delivered.

| Priority | Craft Anything source/concept | Fit for REAmon | Proposed approach | Acceptance evidence |
| --- | --- | --- | --- | --- |
| P0 | Engine ToolSpec registry; one tool exposed to UI, CLI, MCP and agents | High: reduce discrepancies between browser/agent/MCP operations | Compare tool descriptors against REAmon's capability manifests and MCP handlers; prototype one REAmon-owned typed operation, not a second tool registry | Same argument schema, auth scope, errors and provenance across entrypoints; mismatched or unsupported calls fail closed |
| P0 | Evidence summary-first responses and paged core_evidence_browse | High: large analysis results should not overflow model context | Adapt summary/continuation semantics onto existing PostgreSQL observations, artifact hashes and authorized cursor endpoints | Page/continue across restarts; stable counts; tenant isolation; explicit omitted/truncated evidence; no hidden successful claim |
| P1 | Trait/registry-driven TargetKind and Check/CheckResult | High: provider-specific reconstruction validators need a shared contract | Adapt typed, pluggable check definitions to REAmon's existing artifact/provider/worker stages | Structured passed/failed/unavailable verdict; exact input/candidate hashes, check version, scope, environment and coverage; failures block promotion |
| P1 | Iterative Study/Build/Check/Refine controller | High if converted from clone-building to source reconstruction | Use REAmon's durable per-unit attempts and review receipts; feed validation counterexamples into bounded retries | Resumable attempt IDs; explicit budgets and cancellation; no acceptance on compilation or screenshot similarity alone |
| P1 | Native cross-build alignment and selective native/managed format readers | Potential targeted gap filler, not blanket engine replacement | Benchmark a single parser/matcher through a narrow Rust worker or subprocess adapter against REAmon's current providers and matched fixtures | Architecture/format/version coverage, false matches, unsupported cases, runtime/memory caps and source hash provenance |
| P2 | External-observation versus deep-inspection classification | Useful for optional non-invasive assessments and tool authorization | Define REAmon-owned access profiles as a policy layer with explicit scope and capability restrictions | Integration tests prove denied tools, agent escape paths, project isolation and broker enforcement |
| P2 | Websites' multi-width pixel comparison and UI state capture | Adjacent; useful only for explicitly requested UI equivalence evidence | Optional external-output validator with baseline captures, not proof of source correctness | Deterministic capture fixtures, dynamic-content masking, reproducible viewport configuration and uncertainty |
| Defer | Desktop egui frontend, whole engine vendoring, game/asset generation, backend stand-ins | Low fit or duplicates REAmon infrastructure | No bulk import. Reassess only for a concrete REAmon test case | Written cost/benefit and risk review first |

### Architecture mapping

- **Do not introduce a second project database or graph.** Craft session/evidence records must map to REAmon's project-owned artifacts, tasks, findings, code-unit observations, provider runs and Neo4j relationships; exact SHA-256 identity remains authoritative.
- **Do not bypass the broker.** External executables, parsers handling untrusted bytes, original-program execution and generated build/test commands run through REAmon's authenticated, bounded execution workers. Craft's Clean room allowlist is **not an operating-system sandbox**, and its agent permissions are not uniformly enforced across backends.
- **Do not overwrite canonical source.** Distinguish raw provider decompilation, inferred claims, generated approximation, candidate maintained source, reviewed source, and validated assertions.
- **Do not equate success criteria.** A build pass is compilation evidence; UI likeness is presentation evidence; native matching is correspondence evidence. Each needs its own typed receipt. Behavioral equivalence requires a suitable original oracle, controlled inputs, reproducible execution and recorded counterexamples.
- **Do not block independent engines.** Integrate through REAmon's existing provider contracts and expose unknowns, unsupported instructions, partial coverage and conflicting results instead of treating one engine's answer as authoritative.

## Reuse and licensing gate

Upstream's root workspace declares **MIT OR Apache-2.0**, and its root license files contain the corresponding texts. This permits possible reuse **subject to a per-file, dependency and distribution audit**. Do not infer that third-party tools, bundled resources, fetched model weights, external agents, fonts, generated assets or Ghidra are covered by those root licenses.

For every proposed import:

1. Record exact repository URL, commit SHA, paths, author/notices, SPDX or other applicable terms, dependency/transitive-license list, and the selected license option. Check whether files inherit different licences or contain vendored code.
2. Prefer a narrowly scoped subprocess/CLI/MCP adapter, then a small isolated Rust library, then selected source copying. Reject bulk vendoring without measured benefit. Reuse of an idea without copying code still requires technical validation.
3. Preserve original copyright and licence notices, applicable NOTICE content, modification history, upstream link and pinned revision; amend [THIRD-PARTY-LICENSES.md](../THIRD-PARTY-LICENSES.md) and any vendoring manifest **when actual code or binary enters REAmon**, not for a reference-only entry.
4. Inventory transitive dependencies and operational assumptions (Rust edition/toolchain, platform, network/child-process privileges, architecture, resource limits). Security-review input parsing, tool-call authorization, process lifetimes, retries and data egress.
5. Implement a fixture-backed adapter with malformed/untrusted input tests, bounded resources, comparison to the existing REAmon provider, cross-version degradation and explicit unsupported statuses.
6. Keep the experiment opt-in until tested. Report measured gains and regressions on the declared corpus. Update the feature, language, reconstruction and readiness matrices **only with REAmon-run evidence**, not upstream claims.

This document provides engineering guidance, not a legal determination or a warranty of safety.

## Bootstrap work packages and stop/go gates

| ID | First deliverable | Depends on | Proof before broader rollout |
| --- | --- | --- | --- |
| CA-0 | Complete upstream file/dependency/security audit for one candidate and pin an exact version | None | Licence/NOTICE review, path list, integration decision and documented rejection reasons |
| CA-1 | Unify one REAmon analysis capability's tool descriptor and result contract across browser, MCP and agent | CA-0 for copied code; independent if design-only | Contract tests for error types, authorization and equivalent output |
| CA-2 | Summary-first, replayable code-unit evidence with stable pagination | CA-1 shared result semantics | PostgreSQL cursor replay and isolation tests, oversize-result/model-budget tests |
| CA-3 | Typed validation/check receipt and checker registry; no execution outside worker | CA-1; current reconstruction milestone M2/M4 | Compile-only versus behaviour/unavailable test cases; exact hashes and safety audit |
| CA-4 | Bounded reconstruction feedback controller with human acceptance boundary | CA-2, CA-3 | Failure counterexample replay, cancellation, restart recovery, rollback and regression guard |
| CA-5 | Single narrow upstream native parser or cross-build matcher comparison spike | CA-0; pinned real fixtures | Precision/recall or coverage/fidelity versus current providers; memory/time and malformed-file behaviour |
| CA-6 | Optional external-UI or clean-room observation validator | CA-3 plus documented user value | Separate visual accuracy from semantic equivalence; verify policy enforcement through all agent adapters |

Each package should be a standalone PR where possible. **CA-0 is documentation/research and not proof that reuse is safe.** Begin with the smallest testable slice; run no wholesale migration of REAmon's Next.js, PostgreSQL, Neo4j, analyzer fleet or Docker broker.

### Evaluation scoreboard (fill only from REAmon runs)

| Metric | Baseline | Candidate | Decision rule |
| --- | --- | --- | --- |
| Supported input/function coverage with discovered/visited/returned counts | Not measured for candidate | Not measured | No hidden omission or inflated success |
| Correct symbol/type/function correspondence on held-out ground truth | Not measured | Not measured | Improvement without unacceptable false positives |
| Recompilation / behavioral differential pass rate by declared scope | Not measured | Not measured | Passes supported oracle; do not score unavailable as pass |
| Peak memory, wall time, crash rate, malicious input handling | Not measured | Not measured | Meets worker caps and threat model |
| Provenance, partial-result and cancellation/restart integrity | Not measured | Not measured | No loss of source, revision, or reviewer decision |
| Human review burden and agent context/token footprint | Not measured | Not measured | Evidence of meaningful reduction, not marketing claims |

### Test fixture minimum

Use known-source binaries in versioned compiler/optimization pairs (native PE/ELF/Mach-O where supported), small managed/bytecode projects, stripped and obfuscated controls, malformed inputs, and paired releases for function matching. Store independent ground truth, original/run hashes, provider versions, commands, safe execution profile and failure examples. A claim like “equivalent” must state *which* inputs/behaviors and what was not tested.

## Decisions for this bootstrap

- **Adopt as references now:** tool-schema parity, summary-first evidence, typed checks, bounded autonomous refinement, honest limitations.
- **Research before importing:** Rust parsers, function matching, session/evidence persistence, dynamic observation controls.
- **Do not adopt by default:** unrestricted agent execution, second authoritative store, clone-oriented output as a substitute for recovered source, or large vendored code drops.
- **Current integration status:** documentation only. REAmon provider coverage, implementation results, release readiness and benchmarks are unchanged; the weighted **overall progress estimate decreased** because CA-1/CA-2 are now part of the accepted scope. See [scope recalibration](REAMON_PROGRESS.md).
- **Future scope changes:** Update the progress JSON, weighted matrix, and README bar together whenever acceptance criteria are added or removed, even in documentation-only PRs. Retain explicit coverage boundaries and never grant upstream work implementation credit.

See [reference portfolio](REAMON_REFERENCE_PORTFOLIO.md), [upstream reuse rules](REAMON_UPSTREAM_REUSE.md), [goals](REAMON_GOALS.md), [agentic reconstruction milestones](REAMON_RECONSTRUCTION_MILESTONES.md) and [architecture](REAMON_ARCHITECTURE.md).
