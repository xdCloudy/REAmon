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
- Keep the visualizer useful across source, bytecode, native code, resources, and
  mixed projects.

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
| P1 | One-unit work lifecycle with attempts, review, and validation records | This adapts decomp.wtf's most valuable process and bounds agent mistakes. |
| P1 | Visualizer connects artifact, unit, relationships, draft, and review state | Results need to be understandable and actionable in one workspace. |
| P2 | Language-specific validators and repeatable fixture corpora | Confidence should grow from measured provider behavior, not broad claims. |
| P2 | Concurrent agents with atomic leases and conflict protection | Parallel work is useful after unit ownership and promotion rules are sound. |
| P2 | Major-language capability portfolio and fidelity tracking | Breadth should grow with language-aware engines, validators, and measured evidence. |
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
README's weighted full-goal progress estimate is generated from the committed
[progress ledger](REAMON_PROGRESS.json) after pushes to `main`; it is separate from
the narrower bootstrap release-readiness score.
