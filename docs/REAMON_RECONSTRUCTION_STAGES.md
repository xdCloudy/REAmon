# REAmon reconstruction stage matrix

REAmon's target is a traceable path from imported artifact to reviewed, validated,
maintainable export. Stages may run in different orders or be unavailable for a given
format. A completed task means its provider finished; it does not mean every unit
passed through every stage.

| Stage | Current status | Evidence and current limit | Completion evidence to add |
| --- | --- | --- | --- |
| Artifact ingestion | Integrated | File and folder imports preserve artifact identity, hashes, and provenance. Browser uploads use resumable chunks or bounded streaming; storage capacity remains the practical limit. | Exercise recovery after interrupted large imports on a clean deployment and verify all bytes against the saved hash. |
| Analysis | Integrated, provider-dependent | Providers discover and profile units; saved coverage distinguishes discovered, returned, observed, indexed, omitted, and unvisited units where the engine reports them. | Extend explicit coverage reporting across providers and validate large, mixed-format projects. |
| Disassembly | Integrated for several formats | Ghidra, JADX, and format-specific providers store instructions or equivalent low-level evidence. | Compare address and instruction coverage against versioned fixtures across architectures and formats. |
| Decompilation | Integrated, uneven language coverage | Multiple providers emit source-like output for Android/Java, .NET, Python, WebAssembly, and native targets. Output fidelity and coverage vary; native C-like pseudocode is not recovered original source. | Measure unit coverage and source fidelity per toolchain, version, optimization level, and obfuscation class. |
| IR lifting | Early and experimental | Miasm simplified IR, Recurse function-scoped lifts, Ghidra p-code, and editable `.ud` views provide distinct intermediate evidence. These are not interchangeable and do not alone establish source semantics. | Report instruction and block coverage, unsupported operations, architecture/ABI, mappings, and fixture-backed behavior for each lifter. |
| Deobfuscation | Narrow experimental passes | Static or read-only passes target known patterns, including selected .NET cleanup and native control-flow transformations. Original artifacts and baseline outputs remain available. | Validate each pass against versioned obfuscated fixtures and confirm changes with a suitable compiler, differential check, or behavior test. |
| Type and symbol recovery | Partial | Providers and project memory retain names, types, references, relationships, and reviewed aliases with provenance and confidence. Recovery differs widely by format and stripped/debug state. | Measure symbol/type precision and recall against ground-truth fixtures; maintain stable project-wide identities. |
| Source reconstruction | Early, reviewable workflow | AI drafts use bounded project database evidence; drafts, attempts, hashes, diffs, and review receipts are persisted separately from provider output. | Demonstrate consistent naming and structure across representative whole projects and reject unsupported claims through evidence-aware review. |
| Transpilation | Limited bridges | An early C#-to-Visual-Basic bridge follows ILSpy reconstruction and passes small cross-file compile/runtime fixtures. WebAssembly also has a generated Rust-shaped view; it is a bridge representation. Neither recovers the original source language. | Test obfuscated and project-scale bridges, report mappings and omissions, and add bridges only with versioned compile and behavior fixtures. |
| Compilation | Early, format-specific | One accepted Java class can be rebuilt into a derived JAR; the VB bridge has small fixture checks; `.ud` views have compile-back checks. | Add project-level builds, dependency and target-version handling, reproducible recipes, and broader fixture coverage. |
| Validation | Partial, language-aware | Syntax validators cover multiple languages; a small set of translation and binary-view fixtures also checks compilation, runtime behavior, or byte identity. Syntax success is not behavior equivalence. | Tie every result to exact input/output hashes and expand compiler, differential, runtime, and malformed-input tests. |
| Iterative refinement | Integrated, still maturing | Function/file attempts, bounded parallel rewrites, cancellation, review, and saved project context support repeated improvement. | Add reliable per-language quality measures and a fixture-backed loop that can explain and reproduce each improvement. |
| Export | Integrated, incomplete coverage | Reproducible bundles separate provider output and maintained source and include manifests, hashes, lineage, and accepted-review checks. | Validate imports in target tools and add complete rebuild/validation recipes and mappings for supported providers. |

## How to use this matrix

Use the [language and format matrix](REAMON_LANGUAGE_MATRIX.md) for per-format
capability, the [feature matrix](REAMON_FEATURE_MATRIX.md) for product controls, and
the [readiness matrix](REAMON_READINESS_MATRIX.md) for release gates. The weighted
[progress matrix](REAMON_PROGRESS.md) estimates overall workstream completion; it does
not average these stages or certify a release.
