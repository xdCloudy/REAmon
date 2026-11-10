# Agentic Semantic Symbol Recovery

Agentic Semantic Symbol Recovery (ASSR) is the planned, project-wide capability
that turns evidence-backed symbol analysis into a consistent, maintainable naming
layer. It is a dedicated P1 milestone under source reconstruction. This document
defines acceptance; current product state is recorded separately in the
[feature matrix](REAMON_FEATURE_MATRIX.md) and weighted [progress ledger](REAMON_PROGRESS.md).
ASSR owns symbol identities and names. Type/layout inference is tracked separately in
M1 and whole-project package/build assembly in M4 of the
[agentic reconstruction milestones](REAMON_RECONSTRUCTION_MILESTONES.md); those systems
share evidence and stable identities without double-counting type recovery as renaming.

## Capability status

| Capability | Current status | Scope of the current implementation | Completion evidence |
| --- | --- | --- | --- |
| Autonomous project-wide semantic renaming | Partially implemented foundations | Project symbol scans, persisted identities and aliases, provider evidence, bounded project context, AI rename proposals, and selected one-source binding-aware rename adapters exist. Rename suggestions now report when the 4,096-row accepted-symbol scan is truncated, and the UI warns that older project evidence may be missing. This does not provide a complete project-symbol inventory or denominator. The system does not yet autonomously discover and iteratively name every eligible project symbol. | A whole-project inventory records eligible, named, unnamed, skipped, ambiguous, and unsupported symbols; reproducible benchmark results meet the coverage, accuracy, consistency, calibration, and scale gates below. |
| Cross-file and cross-function propagation | Partial, experimental Go same-package path | The visualizer can propagate a selected Go binding across same-directory package files when sibling source hashes match immutable accepted review receipts. The helper uses `go/types` identity, emits per-file manifests, and re-type-checks the package; changed files remain separate review drafts. Synthetic regressions cover pointer embedding through a second embedded struct, promoted selectors, embedded aliases, and rejection of duplicate-field collisions. Two pinned upstream fixtures verify distinct binding kinds across independent packages: github.com/pkg/errors v0.9.1 covers a private function rename across two files, and a selected github.com/google/uuid v1.6.0 source subset covers six private package constants/variables plus private xtob across three files; all 38 declaration/reference edits across seven rename scenarios have byte-exact spans and expected per-file counts, type-checked outputs, and matching direct/pooled generation plus Parse/ParseBytes/Validate oracles. These are two positive targets, not broad held-out precision/recall evidence. Modules/imports, other languages, rollback acceptance, broader held-out accuracy, and live database/browser acceptance remain open. | On supported language/provider combinations, accepted mappings update all proven references across the project, maintain binding identity, pass language-aware structural checks, and produce no unreviewed unresolved or misbound references. |
| Safe autonomous rename acceptance | Unsupported; human review remains required | Immutable human review/revocation receipts, source hashes, symbol-index snapshots, provenance, and validation records provide a safety foundation. No policy-driven automatic acceptance is implemented. | A versioned policy accepts only changes that pass evidence, ambiguity, confidence-calibration, binding, collision, and applicable structural/behavioral gates; uncertain cases defer to a human, and automated promotion cannot silently alter canonical symbols. |

“Implemented and validated” requires repeatable fixture-backed evidence for the stated
scope. “Implemented, insufficiently tested” means the path exists but lacks broad
fixture evidence. “Partially implemented” means foundations or a narrower workflow
exist. “Planned” means no qualifying end-to-end capability exists. “Unsupported” means
the capability must not be presented as available. A language/provider may be called
supported only for the exact validated scope; experimental and unsupported combinations
must be labeled in results and reports.

### Existing rename adapter scope

These are implemented, source-scoped rename paths, not validated ASSR support. The
feature matrix documents their binding mechanisms and exclusions. Until whole-project
fixtures validate a particular language/provider/reference combination, mark it
**implemented, insufficiently tested** for local renaming and **unsupported** for
autonomous project-wide naming, cross-file propagation, and autonomous acceptance.

| Language | Existing adapter evidence | Current boundary |
| --- | --- | --- |
| JavaScript / TypeScript | Babel scope binding and AST rename | Reviewer-selected mappings in a single source; no project-wide acceptance. |
| Python | LibCST scope metadata and rename command | Selected local bindings in one source; project references are not generally updated. |
| Go | `go/ast` and `go/types` object identity | One-source catalog and reference rename; project-level package propagation is not established. |
| Java | JDK `javac` Trees and element identity | One-source local/private-parameter rename and reference check. |
| C# | Roslyn semantic model | Single-file local symbols and resolved-reference check. |
| Rust | rust-analyzer LSP | Same-file local references; macro invocations, `cfg` variants, external modules, and custom attributes are excluded. |
| C / C++ | clangd LSP | Same-file locals and parameters; macro directives, conditional compilation, and templates are excluded. |
| Lua / Luau | LuaLS / Luau LSP | Single-source local bindings; cross-file edits are excluded. |
| PHP | Phpactor | Adapter exists; broad rename fixture evidence and project propagation are not established. |
| Ruby | Solargraph plus Ripper range checks | Same-file local variables and parameters; keyword labels and cross-file references are excluded. |
| Other languages/providers | No qualifying adapter established by this matrix | Unsupported for semantic rename until an adapter and fixture-backed compatibility scope are recorded. |

This list describes adapter existence only. It does not imply exact name recovery,
semantic naming accuracy, cross-provider symbol equivalence, or safe autonomous use.

The safe-renames route now builds a verified, same-directory Go package snapshot from
accepted sibling-source receipts and asks the `go/types` helper for rename bindings and
an inventory. Each package declaration is listed with a stable snapshot-bound ID, name,
kind, source path and byte offset, resolved reference count, and an explicit
eligible/excluded/unsupported classification with its reason. Name quality remains
`unassessed`. Exact aggregate counts cover every inventory row; detailed rows are capped
at 5,000 and report truncation. The inventory includes private referenced and
unreferenced declarations, exported package APIs, unsupported objects, the `main`
entrypoint, and special `init` functions. The API validates the source-set hash, reviewed
file list, entry IDs and paths, declaration offsets, aggregate counts, classification
reasons, and both inventory and rename-catalog truncation, then returns and persists the
inventory with the proposal. Draft history validates and reloads it, and the visualizer
shows a bounded row preview alongside the counts and snapshot-scope disclosure. Docker
Go regressions check exact classifications and aggregate counts, including a 5,001-row
fixture proving explicit detail truncation with exact totals. The inventory now includes
function and function-literal parameters, receivers, results, local variables,
constants, types, type parameters, and local functions. Referenced local bindings are
eligible inventory entries; unreferenced bindings are explicitly excluded. Local
struct fields, interface methods, labels, and other unsupported object kinds retain
explicit unsupported reasons. The visualizer labels local entries as inventory-only;
the project rename flow still targets package declarations. This does not establish
whole-project file completeness, assess names as meaningful or unnamed, or measure
naming quality.

## P1 milestone and acceptance gates

The milestone is complete only when all three capabilities pass, individually and in
an end-to-end project workflow. Progress on one capability does not imply completion
of another.

### ASSR-1: Autonomous project-wide semantic renaming

- Enumerate unnamed, mangled, compiler-generated, and obfuscated functions, methods,
  parameters, locals, types, and other explicitly supported symbols across the project.
- Analyze decompiled source and available control-flow, data-flow, call-graph, string,
  type, import, and cross-provider evidence. Record missing, truncated, conflicting,
  or provider-specific evidence instead of treating it as complete.
- Propose semantically useful names with confidence, evidence references, uncertainty,
  and naming provenance. Keep proposals distinct from accepted canonical names.
- Refine proposals when new relationships or evidence arrive without changing stable
  symbol identities. The same stored project snapshot must yield consistent naming
  across agents and analysis sessions, subject to recorded model/provider versions.
- Measure eligible-symbol discovery coverage, name coverage, semantic naming quality,
  exact original-name recovery where ground truth survives, confidence calibration,
  and false-positive rate.

The scoped Go inventory is an initial denominator foundation for package-level
declarations only. It does not satisfy the project-wide discovery or semantic quality
acceptance gates above.

### ASSR-2: Cross-file and cross-function propagation
A narrow Go slice is now wired through the project visualizer: same-directory package files are eligible only when each sibling has a current accepted review receipt; the helper preserves `go/types` object identity and emits separate hash-bound drafts. This advances partial implementation status, but does not meet the general ASSR-2 acceptance criteria below. Live database/browser review, rollback, module/import handling, other languages, and held-out integrity measurements remain unverified.


- Apply an accepted mapping only to references proven to bind to the same stable symbol
  identity, including supported cross-module, cross-class, and cross-file references.
- Preserve scopes, overloads, imports/exports, call relationships, language-specific
  binding rules, and original symbol identities. Detect and block collisions,
  shadowing changes, ambiguous references, and unresolved bindings.
- Store each mapping as a versioned, reversible change with input/output hashes,
  language/provider/tool versions, evidence, and a complete edit manifest.
- Publish a compatibility matrix by language, provider, syntax/ABI mode, and reference
  type. Unsupported, experimental, truncated, or dynamically resolved references must
  be excluded or explicitly deferred, never reported as safely propagated.

### ASSR-3: Safe autonomous acceptance

- Define versioned policy gates for minimum independent evidence, calibrated confidence,
  ambiguity, collision analysis, binding validation, and applicable structural,
  compilation, differential, or behavioral checks. LLM confidence or syntax validity
  alone must never authorize acceptance.
- Defer uncertainty, conflicting evidence, unsupported constructs, incomplete reference
  coverage, and potentially unsafe edits for human review.
- Keep original artifacts immutable; persist proposals, policy/version, evidence,
  validator results, acceptance identity, and audit history. Provide tested rollback and
  recovery to the exact prior source and canonical symbol-map snapshot.
- Promote canonical symbols atomically with source changes. A failed or partial update
  must leave the previous canonical map intact and visible.

## Benchmark and release criteria

Maintain a versioned benchmark set of compiled open-source projects with licensed,
known source names and reproducible build metadata. Include unstripped and stripped
binaries, symbols irreversibly removed by compilation, obfuscated inputs, multiple
optimization levels (including debug and optimized builds), and representative
multi-language projects. Include source-level projects where native binary evidence
does not expose language bindings. Pin source revisions, compiler/obfuscator versions,
flags, providers, prompts/models where applicable, and the exact evaluated project
snapshot.

Report results per language, provider, symbol kind, optimization/obfuscation stratum,
and project size, plus a macro average. The initial completion gate is:

| Measure | Minimum acceptance gate |
| --- | --- |
| Project-wide discovery coverage | At least 98% of statically enumerable symbols in declared supported scopes are accounted for as named, already meaningful, ambiguous, excluded, or unsupported; disclose denominator and truncation. |
| Semantic naming quality | At least 90% precision and 80% recall for independently reviewed semantically useful names on the supported benchmark; publish per-language results and confidence intervals. |
| Exact original-name recovery | Report precision/recall only where original identifiers are available as ground truth. Do not require exact recovery where compilation irreversibly removed names. Score semantic usefulness separately in those cases. |
| Cross-file reference integrity | 100% of statically resolved references in the declared supported scope remain bound to the same stable symbol after propagation; zero silently unresolved or misbound references. |
| Collision and shadowing safety | Zero introduced binding collisions or shadowing changes in the acceptance corpus; all ambiguous cases defer. |
| Naming consistency | At least 99% agreement on stable symbol identity and accepted name across repeated runs, agents, and analysis sessions over the same evidence snapshot; disagreements remain explicit proposals. |
| Confidence calibration and false positives | Expected calibration error ≤ 0.05 and ≤ 1% false-positive accepted renames on the benchmark; report rates and confidence intervals, not model self-ratings. |
| Autonomous acceptance safety | Zero policy-bypassing acceptances in adversarial/negative fixtures; every accepted edit passes all gates and retains a complete audit record. |
| Rollback and recovery | 100% exact restoration of source bytes and canonical symbol-map snapshot in failure-injection and rollback fixtures. |
| Scale and performance | Complete inventory and analysis for a 100,000-symbol project within 30 minutes on documented reference hardware; bounded memory and resumable progress, with larger-project scaling published. |
| Language/provider compatibility | Every supported cell passes its language-specific binding and integrity suite; experimental and unsupported cells are disclosed and excluded from autonomous acceptance. |

Thresholds apply to the benchmark and declared supported scopes, not all possible
programs. A release report must publish corpus construction, sample sizes, confidence
intervals, exclusions, hardware, timeouts, and failed cases. Behavioral checks are
required when an applicable reproducible test or differential oracle exists; otherwise
the result must state that semantic behavior remains unverified.

## Existing evidence to reuse

REAmon already has project-scoped symbol and relationship observations, stable code-unit
identity, accepted symbol snapshots, hash-bound review/revocation receipts, bounded
project-memory context, cross-provider function-matching evidence, AI rewrite/rename
proposals, and several single-source language-aware binding rename adapters. Those
systems supply useful inputs and safeguards, but they do not satisfy the three
project-wide autonomous acceptance gates by implication. See the exact implementation
limits in the [feature matrix](REAMON_FEATURE_MATRIX.md), the current per-language
capability declarations in the [language matrix](REAMON_LANGUAGE_MATRIX.md), and the
source-to-export gaps in the [reconstruction stage matrix](REAMON_RECONSTRUCTION_STAGES.md).
