# ADR: Durable cross-artifact native function matching

- **Status:** In progress
- **Scope:** First cross-version native function comparison, with QBinDiff as an evaluated engine reference
- **Decision date:** 2026-10-19

## Context

REAmon's visualizer endpoint at `webapp/src/app/api/projects/[id]/visualizer/similar-functions/route.ts`
is a useful interactive lead finder, but it is not a durable binary-diff workflow. It
starts from one selected function and analysis task, searches observations in the
active workspace import, and returns a bounded ranked list. It does not create a
comparison record for two selected artifact versions, preserve a complete pairwise
result set, or record an analyst decision on a proposed correspondence.

The existing `instruction-similarity.ts` matcher compares compatible instruction
sequences and optional CFG metrics. This is useful evidence, but sequence similarity
alone does not model the broader graph and semantic features used for native binary
diffing.

There is also a storage constraint: `ReamonObservation` rows are upserted on
`(projectId, source, stableKey)`. A later run can replace the task, artifact, and
attributes on that row. A historical match must not rely on an observation ID alone
to mean that its original evidence is still present.

## Decision

Implement native cross-artifact comparison as a separate, bounded, project-scoped
operation over two exact artifacts and completed analysis runs. Keep the current
similar-functions endpoint as an ephemeral visualizer aid; do not turn its response
into identity or accepted-name evidence.

Persist a comparison record and immutable candidate snapshots. At minimum, record:

- Project and comparison ID; creation time; comparison status; matcher name, version,
  and configuration.
- For each side: artifact ID, SHA-256, task/run ID, provider ID and version, and
  normalized architecture/endianness where available.
- For each function: source observation ID as a lookup hint, stable/canonical key,
  function name, address, and a bounded snapshot or digest of the exact matching
  features used (for example instruction sequence and CFG metrics).
- Candidate scores by feature and overall score, plus limitations or truncation
  state. A score is a ranking signal, not a probability of identity.
- Review state and immutable review receipt: decision, authenticated reviewer,
  timestamp, and rationale.

Model candidate pairs as **proposed** until an analyst accepts them. Rejection must
also be durable. Only an accepted pair may provide a provisional name/identity hint
to later analysis, and that hint must retain the accepted comparison and reviewer
provenance. Do not automatically overwrite symbols, source, or maintained code.

The first implementation is native-only and requires compatible normalized
architectures and comparable evidence. It does not claim cross-architecture matching,
bytecode matching, behavioral equivalence, or universal language support. Missing or
incompatible architecture metadata should make a pair ineligible or explicitly
uncertain, not silently broaden the match.

## QBinDiff reuse

[QBinDiff](https://github.com/quarkslab/qbindiff) is the preferred engine reference
for graph-based native function matching. The reviewed repository revision is
`eac842094ac614cfa4ee99bcf9ab295d0cb6cdec`; its license is Apache-2.0. Evaluate it
behind an isolated, resource-bounded analyzer adapter that accepts only the two
selected artifacts and returns normalized candidate pairs and feature scores. Keep
REAmon's database as the authority for comparison history, evidence, review, and
later project context. The initial adapter should be optional and version-pinned;
do not add QBinDiff to the webapp runtime dependency path.

Before packaging or copying code, review the pinned source and its complete Python
dependency tree, record compatible license notices/attributions, and retain the
Apache-2.0 license and NOTICE obligations for any reused code. No QBinDiff code is
copied by this decision. Preserve the adapter boundary so REAmon's existing
instruction/CFG matcher remains available where QBinDiff cannot run or lacks
suitable input.

The companion [Quokka](https://github.com/quarkslab/quokka) project is a possible
normalized disassembler-export input, not a decompiler or an automatic dependency.
Its Apache-2.0 license does not change the licensing of IDA or Binary Ninja, whose
exporter plugins require those separately licensed products. Any Quokka path must
preserve the exact binary digest, exporter/backend versions, addresses, and run
provenance.

## Implementation seams

- Add comparison and candidate persistence models plus a migration; do not store
  review state only in JSON or mutable observations.
- Add project-authorized create/read/review endpoints for comparisons. Validate that
  both artifacts and completed tasks belong to the project and that run inputs match
  the stored artifact hashes.
- Reuse architecture normalization and instruction/CFG feature extraction where
  applicable. Put QBinDiff invocation behind a provider/adapter boundary.
- Add explicit UI actions to compare two artifact versions and review proposed
  pairs. Show each side's artifact digest, run, provider, address, scores, and review
  state. Keep accepted matches distinguishable from raw engine suggestions.

## Consequences and validation

The comparison becomes reproducible after observation rows change, and review history
can be audited against exact binaries and runs. This requires bounded snapshot storage
and lifecycle handling for artifacts that are later removed. The first release will
cover native, architecture-compatible pairs only; it must be evaluated on pinned,
redistributable fixtures with known function correspondences before score thresholds
or name propagation are treated as reliable.

Related project references: [upstream reuse audit](REAMON_UPSTREAM_REUSE.md),
[reference portfolio](REAMON_REFERENCE_PORTFOLIO.md), and
[language support matrix](REAMON_LANGUAGE_MATRIX.md).

## Implementation status

REAmon now lets an analyst save a ranked native function pair from the visualizer
as a durable `reamon_function_matches` record. Each record snapshots both
artifact hashes, run and provider versions, function identities, the exact
bounded instruction/CFG features and their SHA-256 digests, architecture, and
feature scores. The review endpoint appends accepted or rejected decisions with
reviewer and timestamp; it never mutates the source observations or propagates a
name. The project database remains the authority after provider observations are
refreshed.

This is the selected-pair foundation, not whole-artifact QBinDiff integration.
The UI currently saves candidates surfaced by REAmon's bounded instruction/CFG
ranker, and only native functions with a matching recognized architecture qualify.
The isolated QBinDiff adapter, full candidate-set snapshots, and reviewed-name
context propagation beyond the AI explanation path remain open. An accepted pair
whose exact binary and function are selected is now included as bounded context
for AI explanations, with its counterpart name, artifact digest, provider, score,
and review timestamp. This remains a naming hint; it does not establish behavioral
equivalence or rewrite maintained source. Upstream process reference:
[decomp.wtf](https://github.com/i12bp8/decomp.wtf)
assigns work one function at a time and validates attempts with the original
compiler and exact bytes; REAmon adopts the reviewable function unit while
keeping its multi-language evidence and validation boundaries.
