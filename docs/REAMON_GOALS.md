# REAmon goals and roadmap

This document turns the [product vision](REAMON_PRODUCT_VISION.md) into outcomes that
can be checked. It is a direction and prioritization guide, not a release promise.

## North-star outcome

For a selected target, an operator can trace each recovered source unit to its input
artifact and analysis evidence, understand how far it has progressed, improve it with
project-consistent names and structure, validate the change using the strongest
available method, and export the accepted result with its provenance.

## Goals

### G1. Make analysis coverage truthful

- Track discovered, analyzed, decompiled, maintained, reviewed, and validated units as
  separate counts.
- Tie each count to a defined population, provider run, and truncation state.
- Make missing, skipped, unsupported, failed, and partial work visible.

### G2. Produce maintainable source

- Preserve raw disassembly and each provider's original decompilation.
- Let AI improve names, structure, types, and explanations using bounded project
  context, with the transformation and evidence inspectable.
- Keep accepted maintained source separate from generated drafts until review.
- Make source changes addressable at function, method, class, module, or file scope.

### G3. Make project memory consistent

- Persist symbols, aliases, types, callers/callees, references, relationships,
  observations, drafts, review decisions, and validation results in the workspace.
- Build each AI context from the same project records and show which records informed
  the result.
- Preserve provenance and artifact identity across reruns; never merge same-named units
  from unrelated inputs without evidence.

### G4. Validate at the strongest available level

- Use exact instruction or binary matching when a known toolchain and target layout
  make it meaningful.
- Otherwise run applicable parsers, compilers, static checks, tests, or runtime checks.
- Record the method and result; distinguish syntax validity from behavioral evidence.
- Never report a failed or unavailable validator as a successful reconstruction.

### G5. Keep the workflow universal

- Route through provider contracts and preserve engine-specific evidence.
- Build toward high practical fluency across all major language families, with
  language-aware source recovery rather than treating generic pseudocode as support.
- Add formats based on actual engines and validators; publish measured coverage,
  fidelity, and gaps instead of a perfect-recovery claim.
- Evaluate source-to-source transpilers and architecture-neutral binary lifters as
  explicit stages in source recovery. Track their mappings, coverage, unsupported
  operations, versions, and validation separately from original decompiler output.
- Keep the visualizer useful across source, bytecode, native code, resources, and
  mixed projects.

### G6. Reach secure, reliable production operation

- Require configured authentication for sensitive agent REST controls and preserve
  project ownership checks at the webapp boundary.
- Establish passing, repeatable Docker and webapp test gates for the supported stack.
- Verify worker availability, large-import recovery, upgrades, backups, and restore
  procedures against a running deployment.
- Track security-audit coverage and deployment assumptions; do not treat an incomplete
  scan or a passing focused test as production certification.

### G7. Recover semantic symbols consistently across a project

- Discover and name eligible functions, methods, parameters, locals, types, and other
  supported symbols from stored program evidence, with confidence, uncertainty, and
  provenance.
- Preserve stable symbol identities and propagate accepted names across proven
  references using language-aware binding checks and reversible change history.
- Allow autonomous acceptance only under explicit evidence and validation policies;
  defer uncertain cases, preserve original artifacts, and never let model confidence or
  syntax validity alone change the canonical symbol map.

“100% fluency” is a direction to cover the major languages and their important
toolchains, formats, and idioms. Completion is measured by declared input coverage,
unit recovery, identifier/type/relationship recovery, readable source output,
language-aware editing, validation depth, and fixture results. It does not mean exact
recovery of source details erased by compilation or obfuscation.

## Priority order

| Priority | Outcome | Why it comes here |
| --- | --- | --- |
| P0 | Reliable unit inventory, evidence provenance, and truthful coverage | The agent and operator need to agree on what exists and what has been processed. |
| P0 | Database-backed project memory and consistent symbol identity | Every later draft depends on project-wide context that does not contradict itself. |
| P0 | Secure service boundaries and repeatable release checks | Direct agent controls, tenant boundaries, worker availability, and recovery need evidence before production claims. |
| P1 | One-unit work lifecycle with attempts, review, and validation records | This adapts decomp.wtf's most valuable process and bounds agent mistakes. |
| P1 | Visualizer connects artifact, unit, relationships, draft, and review state | Results need to be understandable and actionable in one workspace. |
| P1 | Agentic Semantic Symbol Recovery (ASSR-1 project-wide naming, ASSR-2 cross-file propagation, ASSR-3 safe autonomous acceptance) | Maintainable reconstruction needs consistent, evidence-backed symbols across a project; autonomous promotion needs separate validation and rollback gates. |
| P2 | Language-specific validators and repeatable fixture corpora | Confidence should grow from measured provider behavior, not broad claims. |
| P2 | Concurrent agents with atomic leases and conflict protection | Parallel work is useful after unit ownership and promotion rules are sound. |
| P2 | Major-language capability portfolio and fidelity tracking | Breadth should grow with language-aware engines, validators, and measured evidence. |
| P2 | Transpiler and binary-lifting evaluation | Validate the existing C#-to-Visual-Basic bridge and experimental Recurse lift, then evaluate a broader source-language bridge and architecture-neutral lifter only against the provenance, coverage, and fixture acceptance criteria. |
| P3 | More formats, alternate providers, dynamic analysis, and collaborative sharing | Extend breadth without weakening persistence, provenance, or review. |

## Completion checks for a reverse-engineering slice

A slice is ready for wider use only when:

1. Inputs and outputs have stable project-scoped identities and hashes.
2. The relevant units, relationships, provider versions, and warnings are stored.
3. AI-generated changes retain the original source and identify their evidence.
4. A reviewer can accept or reject the change and inspect a useful diff.
5. The applicable validation method and its limits are visible.
6. Coverage and exports reflect accepted, validated work rather than task completion
   alone.

Current implementation status is tracked in the [feature matrix](REAMON_FEATURE_MATRIX.md)
and per-language status in the [language matrix](REAMON_LANGUAGE_MATRIX.md). The
production gate status is tracked in the [readiness matrix](REAMON_READINESS_MATRIX.md).
The dedicated [Agentic Semantic Symbol Recovery specification](REAMON_SEMANTIC_SYMBOL_RECOVERY.md)
defines this P1 milestone, its current capability boundaries, benchmark gates, and
separate acceptance criteria for autonomous naming, cross-file propagation, and safe
autonomous acceptance.
The artifact ingestion → analysis → disassembly → decompilation → IR lifting →
deobfuscation → symbol recovery → source reconstruction → transpilation → compilation
→ validation → iterative refinement → export path is tracked stage by stage in the
[reconstruction stage matrix](REAMON_RECONSTRUCTION_STAGES.md); an integrated stage
does not imply that every language or artifact has complete support.
The README's weighted full-goal progress estimate is generated from the committed
machine-readable [progress data](REAMON_PROGRESS.json). The human-readable
[progress matrix](REAMON_PROGRESS.md) shows the workstream weights, estimates,
evidence, and remaining gaps; both are refreshed after pushes to `main`. The weighted
estimate now includes security and production operations. It is a progress estimate,
not a release-readiness certification; use the readiness matrix for release gates.
