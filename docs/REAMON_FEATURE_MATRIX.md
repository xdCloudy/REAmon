# REAmon feature matrix

This matrix describes product capabilities, not a promise that every engine or input
works for every artifact. “Implemented” means a workflow exists in the current
checkout; it does not imply broad fixture coverage or behavioral equivalence. See the
[language matrix](REAMON_LANGUAGE_MATRIX.md) for format-level limits.

| Area | Current state | Product gap / next outcome |
| --- | --- | --- |
| Workspace and artifact identity | Implemented: projects/workspaces, targets, imports, artifact hashes, logical paths, and derived provenance records. | Keep source lineage visible from every visualizer unit and export. |
| Provider execution | Implemented for several isolated engines and format-specific adapters. | Persist exact provider options and make alternate outputs comparable side by side. |
| Function / class visualization | Implemented for supported decompiler outputs with code units and relationships. | Treat the unit map as the work queue and expose recovery, review, and validation state together. |
| Project memory | Implemented: analysis observations and maintenance context are stored and used to ground AI requests. | Establish canonical symbol/alias review and stale-context handling across all provider types. |
| Explanations | Implemented as an AI-assisted workflow with project evidence context. | Keep explanations linked to cited code and distinguish facts from inference. |
| Maintainable-source drafts | Implemented for selected source/decompiled-language workflows. AI rewrite attempts persist per unit and source hash, including provider, request, outcome, syntax result, and returned source. Expired rewrite leases close orphaned attempts as interrupted, and late responses must still own the lease before recording success. A saved draft links to its originating successful attempt; provider and validation metadata are loaded from that record and checked against the draft output. | Move rewrites into durable, resumable jobs; preserve this lineage through draft revisions and accepted reviews; expand language-aware edits while preserving original source and supported project-wide names. |
| Review and acceptance | Saving maintained source or Smali requires a rationale and creates an immutable acceptance receipt tied to reviewer ID, time, and the exact maintained-source hash. A source-hash compare-and-swap guard rejects stale concurrent promotions before recording a receipt. The visualizer shows recent receipt history. AI project memory verifies the receipt pointer and hash before using maintained code or its symbols. | Add rejection receipts, explicit rollback/revoke decisions, and validation regression guards; keep unreviewed attempts distinct from accepted maintained source. |
| Validation | Rewrite attempts persist validator status, method, and message; Tree-sitter parse/member-contract checks are labeled separately from behavior proof. Editing a saved draft clears its old validation metadata. | Add language-specific compiler/build, differential, and runtime validators; keep each result tied to exact source and artifact hashes. |
| Decompilation coverage | Metrics exist for selected providers and run scopes. | Use a stable denominator with explicit excluded, unsupported, truncated, and failed units. |
| Language and format support | Mixed: usable Java/.NET, low-level WebAssembly, early Python/JavaScript/Lua and Go metadata support, partial native pseudocode. | Use [the language matrix](REAMON_LANGUAGE_MATRIX.md) as the single detailed status ledger and validate each row with fixtures. |
| Concurrent agent work | Same-unit AI rewrites are fenced by a short-lived database lease scoped to project, artifact, run, code unit, and exact source hash. Maintained-source and Smali promotions compare the loaded hash inside a transaction; stale collisions return a conflict without replacing the current source or receipt. General analysis tasks have owner IDs, run-token fencing, heartbeat renewal, operator cancellation, and stale recovery. | Move long AI rewrites into durable, resumable jobs with cancellation and lease renewal; guard external derived-file edits and validation regressions. |
| Reproducible project export | Export workflows exist for selected maintained source and Android resource/Smali cases. | Export consistent source plus evidence manifest and a reproducible rebuild/validation recipe where possible. |
| Dynamic analysis | Existing platform-specific work exists in the wider REAmon repository. | Connect runtime observations to static units and the same project identity model without requiring dynamic analysis for basic decompilation. |

## Product-critical distinctions

- Decompilation output and AI-maintained source are separate artifacts.
- A completed provider task is not proof of full analysis coverage.
- A parsed candidate is not necessarily compilable; a compiled candidate is not
  necessarily behaviorally equivalent.
- A recovered name is a proposal until its evidence and review state are recorded.
- Similarity helps locate useful examples, but project identity and behavioral claims
  require stronger evidence.

For the intended process and state model, see [the workflow](REAMON_WORKFLOW.md).
