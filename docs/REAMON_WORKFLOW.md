# REAmon reverse-engineering workflow

This is the intended end-to-end product loop. It adapts decomp.wtf's function-level
claim, attempt, judge, feedback, and accepted-knowledge cycle to heterogeneous inputs
and validators. The detailed inspiration and boundaries are recorded in
[upstream reuse](REAMON_UPSTREAM_REUSE.md).

## Lifecycle

### 1. Import and identify

Create a workspace target and immutable artifact record. Calculate the content hash,
record the logical path and import source, profile the format, and preserve the
original bytes. Related files remain related artifacts; equal names do not establish
identity.

### 2. Analyze with explicit provenance

Select providers from format and capability contracts. Each output records the input
artifact hash, engine name and version, options, warnings, timestamps, and derived
artifact lineage. Keep provider output distinct: JADX Java, Smali, Ghidra pseudocode,
WAT, and an AI-maintained source file are not interchangeable source truths.

### 3. Build the unit map

Index functions, methods, classes, modules, resources, types, strings, call edges, and
other supported relationships. Link each unit to its exact provider output and source
artifact. Store the denominator and truncation information used by coverage metrics.

### 4. Prepare one bounded work item

Select a function or another maintainable unit. Provide the AI with:

- its current decompilation and lower-level evidence;
- exact artifact, provider, and run provenance;
- callers, callees, references, and relevant neighboring units;
- project-approved names, aliases, types, and prior review decisions;
- prior attempts for this unit and any validation feedback.

Context is read from the project database and capped. A similar function can suggest a
search path, but it is never treated as behavioral proof. The AI must distinguish
provider syntax from the binary's likely original language.

### 5. Queue, claim, and work without collisions

The rewrite API stores the exact source, project evidence context, selected provider,
request, timeout, and code-unit lease in a queued database attempt, then returns its
attempt ID. The existing REAmon worker claims queued attempts with a compare-and-swap
status update and a unique run token before calling the AI service. Duplicate requests
for the same project, artifact, analysis run, code unit, and source hash receive a
conflict; a different source hash gets its own lease and history. A queued attempt
survives webapp or worker restarts and remains eligible for dispatch. If a worker stops
after claiming an attempt, the stale-run recovery marks it interrupted; the operator
can start a new attempt from the saved source. A late response must still own its run
token and code-unit lease before it can record success.

### 6. Record an attempt

Keep the original code unchanged and store a candidate as a separate draft. Record the
prompt/context version, proposed names and types, source diff, explanation, and the
evidence cited. The candidate should focus on a bounded change that can be reviewed.
The rewrite queue persists queued, running, failed, and successful attempts with the
exact project, artifact, run, unit, source hash, provider, full request context,
validation state, and returned source. The visualizer polls the authorized attempt
status endpoint while a worker runs and continues to show the latest ten attempts for
the selected source version, including queued work, failures, interrupted attempts,
validation state, and prior successful output. A successful attempt is then saved as a
draft with a validated link to that exact attempt; manual edits preserve its origin
while clearing stale validation evidence. The draft endpoint derives provider and
validator metadata from the linked attempt and does not accept client-supplied
validation as evidence.

### 7. Validate and return specific feedback

Run the strongest applicable checks in order, without conflating their meanings:

| Evidence level | Example | What it proves |
| --- | --- | --- |
| Parse / syntax | Tree-sitter or language parser accepts the candidate | The source is structurally parseable. |
| Build / type check | Original or compatible compiler succeeds | The candidate satisfies that toolchain's compile-time constraints. |
| Differential / binary match | Compile and compare at the original address or against a known output | The validated region matches under the specified toolchain and settings. |
| Tests / runtime comparison | Run a supplied harness on controlled inputs | Tested behavior agrees for those inputs and conditions. |
| Human review | Reviewer checks the evidence and semantic change | A person accepts the change; this is not a universal equivalence proof. |

Each rewrite attempt now retains a validator status (`PASSED`, `FAILED`, or
`UNAVAILABLE`), the check name, and a bounded message. Tree-sitter syntax checks also
preserve recognized callable counts across supported grammars. Java and C/C++ also
retain declaration-form checks. These are structural evidence, not proof of behavioral
equivalence. Editing a saved draft clears its prior validation metadata.

For a failed check, attach the diagnostic, source span, or instruction diff to the
attempt and let the agent revise that same work item. For an unavailable check, record
that validation was unavailable. Never turn a decompilation score or similarity score
into a claim of behavioral equivalence.

### 8. Review and promote

Acceptance is an explicit decision. The visualizer requires a review rationale before
it saves a maintained copy. That transaction records an immutable accepted-review
receipt with reviewer ID, time, rationale, and the SHA-256 of the exact maintained
source bytes, and stores the receipt ID and hash beside the current maintained source.
Later edits create another receipt instead of rewriting the prior one. AI context
checks that pointer, unit, artifact, decision, and hash before using maintained source
or its symbol index as trusted project memory. Older maintained copies without a
receipt stay available to inspect, but must be saved through review before they can
ground future AI names. A proposed rename cannot silently change the project's
canonical symbol map. Rejection receipts and explicit rollback decisions remain
future work.

The acceptance API uses a source-hash compare-and-swap guard for decompiled source and
Smali. The visualizer submits the hash it loaded; if another reviewer promotes a newer
version first, the stale save returns a conflict and cannot replace the current source
or create an acceptance receipt. Reload and review the current version before retrying.
This guards concurrent promotion; it does not yet detect external edits to derived
files or automatically rerun validations.

If an accepted update invalidates a previous validation, mark the affected result
stale and rerun the relevant check. Protect already validated units from accidental
regressions; rollback a candidate when a guard check fails.

### 9. Measure, export, and continue

Show separate counts for discovered, analyzed, decompiled, maintained, reviewed, and
validated units. Export the maintained source with a manifest connecting each output
to input hashes, engine versions, accepted drafts, and validation. Continue work from
the saved project state rather than starting a fresh conversation with undocumented
assumptions.

## Universal completion states

The UI and storage should preserve separate state dimensions, even if displayed as a
single summary:

- **Analysis:** not started, running, complete, partial, failed.
- **Source recovery:** unavailable, disassembled, decompiled, maintained draft.
- **Review:** unreviewed, accepted, rejected, superseded.
- **Validation:** unavailable, pending, passed, failed, stale.

Completing an analysis job does not mean the source is maintainable or validated. See
the [feature matrix](REAMON_FEATURE_MATRIX.md) for current implementation status.
