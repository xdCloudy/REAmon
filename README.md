# REAmon

<p align="center">
  <img src="docs/assets/logo.png" alt="REAmon mark" width="120" />
</p>

<h1 align="center">Analyse anything. Connect the evidence. Understand the system.</h1>

<p align="center">
  REAmon is an AI-assisted reverse-engineering workspace and orchestration platform.
  It accepts arbitrary targets, profiles what it can, resolves compatible analysis
  capabilities, coordinates tools and agents, stores connected evidence, and presents
  the investigation through a live project workspace.
</p>

<p align="center">
  <a href="https://github.com/xdCloudy/REAmon"><img src="https://img.shields.io/badge/status-bootstrap-4169A1?style=for-the-badge" alt="Bootstrap status" /></a>
  <a href="docs/REAMON_ARCHITECTURE.md"><img src="https://img.shields.io/badge/architecture-documentation-4169A1?style=for-the-badge" alt="Architecture documentation" /></a>
  <img src="https://img.shields.io/badge/license-MIT-2E8B57?style=for-the-badge" alt="MIT License" />
</p>

> REAmon is for authorised reverse engineering, software analysis, education, and
> security research only. Analyse targets you own or are explicitly authorised to
> inspect. You are responsible for complying with applicable law, contracts, and
> third-party licences.

## What REAmon is becoming

REAmon orchestrates reverse-engineering engines such as Ghidra, Fission, Kuna, RetDec,
JADX, Arlecchino, Vineflower, CFR, Androguard's Rust DEX decompiler, and ILSpy on the backend, then presents their output
in one investigation workspace. Android APKs use isolated JADX and an alternate isolated
Rust DEX decompiler; JVM `.class`/`.jar` artifacts can also use isolated Arlecchino, Vineflower, and CFR.
Vineflower's Kotlin plugin is experimental. Managed .NET PE assemblies use isolated ILSpy,
and native ELF, PE, and Mach-O files use isolated Ghidra headless analysis with optional
RetDec, Glaurung, and Kuna C-like alternatives. These providers publish
bounded function or code-unit indexes in the code visualizer. Other formats and
dynamic analysis still need matching engines. A workspace can contain multiple
related targets and artifacts:

```text
Workspace
├── Targets and artifacts
├── Environments and tools
├── Capabilities and agents
├── Tasks, findings, hypotheses, and evidence
├── Knowledge graph and timeline
└── Reports and live activity
```

Targets are intentionally open-ended: files, directories, repositories, processes,
devices, services, remote hosts, captures, filesystems, debug sessions, custom
targets, and unknown inputs. Platform-specific behavior belongs behind capabilities
and plugins rather than in the workspace core.

## Product direction and documentation

REAmon's central job is to turn compiled or obfuscated artifacts into evidence-backed,
decompiled code that can be understood, edited, reviewed, and maintained. Explanations
support that work; they do not replace source recovery. The roadmap prioritizes
decomp.wtf's bounded, evidence-led process—unit-sized work, shared project knowledge,
recorded attempts, meaningful validation, and explicit acceptance—then extends it to
languages and formats without a reliable byte-for-byte compiler loop.

The decomp.wtf repository was archived on 2026-10-15 and is now a fixed workflow and
code reference, not an active upstream. The maintainer cited community opposition to
AI-assisted decompilation; REAmon must follow each target project's rules and never
assume that generated contributions are welcome. The reference portfolio also tracks
independent analysis, graph, validation, and syntax-aware editing projects, with
license and integration constraints documented before adoption.

| Document | Purpose |
| --- | --- |
| [Product vision](docs/REAMON_PRODUCT_VISION.md) | Motivation, product promise, principles, and why decomp.wtf is a core process reference. |
| [Goals and roadmap](docs/REAMON_GOALS.md) | Outcomes, priorities, and completion checks. |
| [Feature matrix](docs/REAMON_FEATURE_MATRIX.md) | Current product capabilities and gaps across the workflow. |
| [Reverse-engineering workflow](docs/REAMON_WORKFLOW.md) | Intended artifact-to-maintained-source lifecycle, including review and validation. |
| [Language and format matrix](docs/REAMON_LANGUAGE_MATRIX.md) | Detailed WIP support levels, integrated providers, and known gaps. |
| [Ruby recovery plan](docs/REAMON_RUBY_RECOVERY.md) | MRI/YARV bytecode inspection boundary, staged source-recovery plan, validation evidence, and reuse decisions. |
| [Reference portfolio](docs/REAMON_REFERENCE_PORTFOLIO.md) | Reusable projects, why they matter, what REAmon should adapt, priorities, and constraints. |
| [Architecture](docs/REAMON_ARCHITECTURE.md) | Workspace model, system boundaries, and persistence design. |
| [Upstream reuse](docs/REAMON_UPSTREAM_REUSE.md) | Audited reuse candidates, licenses, and integration decisions. |
| [ToCode export adapter](docs/REAMON_TOCODE_ADAPTER.md) | Source-audited design and current status for indexing ToCode exports into REAmon's database and visualizer. |
| [Migration](docs/REAMON_MIGRATION.md) | Migration status and compatibility approach from RedAmon. |
| [Release runbook](docs/REAMON_RELEASE_RUNBOOK.md) | Release and operational procedures. |

## WIP: language and format support

Language support is still in development and depends on the input format and the
available analysis engine. A generated C-like listing or assembly representation is
not the original source language, and “supported” does not mean that names, types,
control flow, or behavior have been recovered exactly. Treat every decompilation as
a starting point for review.

| Language or input | Status | What works now | Main gaps |
| --- | --- | --- | --- |
| Java bytecode (`.class`, `.jar`) and Android (`.dex`, `.apk`) | **Usable (JADX); early JVM alternates (Arlecchino, Vineflower, CFR); early Android alternate (Androguard Rust DEX decompiler)** | JADX produces browsable Java source and class/method outlines. Vineflower 1.12.0 supplies a separate JVM output path, including experimental Kotlin output; CFR 0.152 supplies an independent Java reconstruction. The pinned Arlecchino adapter combines Vineflower, CFR, and JADX per class using compile-error ranking, records bounded round-trip coverage, and stores generated canonical-name mappings separately. The visualizer can compare matching saved JADX, Arlecchino, Androguard DEX, Vineflower, and CFR outputs side by side when artifact, path, language, and output-hash provenance match. New decompile/disassemble runs also receive centrally calculated, bounded source hashes, allowing matching outputs from other providers to be compared when their paths and languages align; older runs require provider-supplied hashes. A same-language class from another provider can enter AI rewrite context only when its artifact, relative path, and input hash match; it is labeled provisional evidence. The pinned Androguard Rust engine stores separately attributed Java output, bounded Dalvik method observations, linked instruction-row artifacts for AI context, CFG summaries, direct method-call relationships, and field/string references as typed project evidence. JDK `javac` semantic symbols, constrained with `--release 17`, support reviewer-selected local-variable, lambda-parameter, and private method/constructor-parameter renames in single-file source. | Obfuscation, missing debug metadata, reflection, and native libraries can hide behavior or names. CFR is Java-only and neither JVM analyzer accepts DEX/APK. Android Kotlin apps are still rendered as Java-like output; Vineflower's Kotlin plugin is experimental. A reviewed Java class can be compiled against its original JAR and written into a separate derived JAR; Kotlin rebuilds, signed and multi-release JARs, cross-file edits, and external dependency classpaths remain unsupported. Arlecchino is an early integrated multi-decompiler path for obfuscated JARs. It applies bytecode-level canonical renames only when needed and labels those names as generated; compiler-error ranking and round-trip coverage are structural evidence, not recovered original names or behavior proof. The adapter is pinned to an audited upstream commit and its image builds; runtime and fixture comparison remain open. Public, protected, and package-private method parameters remain excluded; cross-file consistency and fixture-backed output comparison remain open. Instruction artifacts, CFGs, call edges, and references have explicit caps. |
| C# / managed .NET (`.dll`, `.exe`) | **Usable C# decompilation; early Visual Basic-shaped bridge; early safe renaming and parsing; experimental ConfuserEx cleanup** | ILSpy decompiles supported managed PE assemblies to C# and retains CLR IL instruction sequences as function evidence. A pinned NoFuserEx stage applies static proxy-call, anti-debug, and anti-dump cleanup before ILSpy; changed assemblies and SHA-256 provenance are stored separately. A bounded, pinned MIT CodeConverter step emits parseable VB-shaped views from ILSpy's C# reconstruction, saving exact C# and VB hashes and labeling the result as translated bridge output. Roslyn identifies local symbols for reviewer-selected single-file renames and parses accepted C# source. | The VB view is not recovered original Visual Basic; C#-to-VB conversion is less accurate upstream and REAmon has not checked compilation or runtime equivalence on fixtures. F# recovery, NoFuserEx fixture validation, cross-file rename consistency, and project/build checks remain open. |
| Native binaries (ELF, PE, Mach-O; including C/C++ and other compiled languages) | **Partial; Fission, Kuna, and RetDec alternatives; native source recovery remains experimental** | Ghidra provides address-aware functions, disassembly evidence, C-like pseudocode, persisted statement-to-instruction mappings, bounded basic-block/edge metrics, and a per-function basic-block graph in the visualizer. The pinned Fission v0.2.3 analyzer adds bounded per-function C-like output with exact input/output hashes and canonical address identity; same-function Ghidra, Kuna, and Fission outputs can ground AI context only after matching the exact binary, identity, completed provider run, and saved-output hash. Kuna also persists assembly, selected call/jump/reference edges, and bounded opcode sequences. An MIT-licensed Ghidra p-code emulator adds bounded, database-persisted control-flow-flattening evidence and clickable recovered blocks. Ghidra decompilation has separate opt-in OLLVM bogus-control-flow and CFF cleanup passes from pinned `BcfClean` and `CffDeflatten`; each caps analysis at 32 function candidates, emulation-checks changes with mismatch reversion, stores its patch audit and cleaner pseudocode separately, and exposes only hash-checked verified functions to comparison and rewrite context. The pinned RetDec provider emits module C-like output, raw token JSON, disassembly, and bounded source-line/address links. FLOSS 3.1.1 adds bounded stack, tight-loop, and decoded-string evidence for matched function addresses. | Fission v0.2.3, RetDec output, address mappings, CFF recovery, and both cleanup passes still need REAmon fixture comparisons. Fission reports a remaining loop-latch case that can omit writes; its C-like output is not recovered C/C++ or another original language. CFF transitions and cleanup outputs are structural evidence, not source or behavior proof. Native types, class structure, templates, symbols, and control flow can be incomplete, especially in optimized or stripped binaries. The Ghidra graph is capped at 32 blocks and 48 edges. `BcfClean` and `CffDeflatten` target known obfuscation patterns, not arbitrary obfuscation. FLOSS strings are static-analysis leads, and its bundled executable is amd64-only. |
| WebAssembly (`.wasm`) | **Early decompilation bridge** | WABT provides WAT evidence and function navigation; pinned unwasm also produces bounded, function-sized Rust translation views linked to the same function addresses, with source-line links to raw Wasm byte ranges. | Rust is a generated bridge representation, not recovered original source or idiomatic Rust. Semantic equivalence and fixture coverage remain to be independently validated. |
| Source files with an available Tree-sitter grammar | **Source navigation only** | REAmon can build function/method outlines for supported grammars and use them to scope edits to a member. Syntax checks record the selected grammar and language-pack version against the exact source hash. | Parsing source is not decompilation. Grammar availability and language-specific validation vary. |
| Python bytecode (`.pyc`, `.pyo`) and PyInstaller executables | **Early integration** | An isolated pycdc 0.6.0 provider stores reconstructed Python source with a recorded SHA-256, plus bounded, independently hash-attributed bytecode disassembly linked to the visualizer. The visualizer and MCP dossier verify saved artifact hashes before serving recovered source or disassembly. AI module-level rewrite context may include the bounded disassembly after an exact-hash check; selected-function context uses a unique matching code-object listing and omits it when names are ambiguous or a match is unavailable. Accepted Python source receives a non-executing CPython compile check. A pinned, isolated PyInstaller extractor now passes bounded `.pyc` members through pycdc and records executable/archive/bytecode/source provenance. | PyInstaller extraction is newly integrated and has image-build and type-check evidence only; representative archive execution and source fidelity checks remain. Standalone bytecode is not guaranteed equivalent, and the syntax check may use a different Python version than the target. LibCST renaming currently excludes module-level definitions/imports, while dynamic lookup can affect semantics. |
| PHP source files | **Early source refactoring integration** | Tree-sitter outlines, a hash-pinned Phpactor LSP adapter for local variable and parameter renames, and versioned `php -l` validation that does not execute source. | No PHP bytecode decompiler is integrated. Phpactor renames only function-local variables and parameters in the selected file; dynamic lookups, project-wide symbols, fixture coverage, and behavior remain open. Lint requires a PHP opening tag; the checker version may differ from the target runtime. |
| Ruby source and CRuby/YARV bytecode | **Source navigation, early syntax validation, and early bytecode inspection** | A constrained CRuby 3.4.11 provider recognizes `YARB` ISeq files and stores bounded YARV disassembly, runtime identity, and exact hashes as project evidence. | This is bytecode inspection, not Ruby source decompilation. Other ISeq versions, CFG/data-flow recovery, source emission, and fixture-based fidelity evidence remain open. See the [Ruby recovery plan](docs/REAMON_RUBY_RECOVERY.md). |
| Lua and Luau bytecode (`.luac`, `.luau`, `.lbc`) | **Early integration** | Isolated providers reconstruct standard Lua 5.0–5.5, LuaJIT, and raw Luau chunks. Pinned unluac-rs adds separately attributed strict-output alternatives for Lua 5.1–5.5, LuaJIT, and Luau, with per-prototype metadata and bounded CFGs. Syntax outlines and project-symbol memory include Lua colon methods and unambiguous assigned function closures. Maintained Lua functions with an exact Lua 5.1–5.5 dialect are parsed by the matching checksum-pinned official `luac`; Luau source gets pinned compiler parse-only validation on amd64 agent images. | Alternate engine output is not proof of source fidelity; the unluac-rs upstream is still in a testing phase and REAmon has no fixture-backed comparison across the dialects yet. LuaJIT and dialect-less Lua retain generic grammar validation. Stripped chunks may lose local names; complex control flow, newer Roblox containers, and custom VM variants may need extra work. Syntax validation is not target-host compatibility or behavior proof. |
| Lua source safe renames | **Early integration** | Standard Lua locals, parameters, and local functions can receive evidence-grounded rename proposals. The pinned LuaLS adapter resolves selected bindings, applies only same-file edits, rejects names already present in the source, and records the attempt and hashes. Luau stays on its own language path. | Rename ranges need fixture comparison for shadowing, closures, loop variables, and method syntax. The adapter does not prove behavior. |
| Go native binaries and source | **Early metadata and source validation** | Ghidra supplies address-aware C-like pseudocode; GoReSym recovers Go function names, packages, runtime version, and type metadata where available. Bounded `unstrip` type records, address-matched method signatures, source locations, and interface-dispatch rows are stored with provider provenance for AI rewrite context, MCP dossiers, the selected-unit inspector, and Go-type search. Maintained Go source receives a versioned `gofmt -e` syntax check, and reviewer-selected local-variable/parameter renames use Go AST positions resolved through `go/types` object identity with hash-bound attempt history. | Neither GoReSym nor `unstrip` reconstructs maintainable Go source. The unstrip path still needs REAmon fixture comparison and release-build validation, and upstream scope is Go 1.18–1.25 on amd64/arm64. Rename capture behavior needs fixture coverage for nested closures and package interactions. Signatures and dispatch rows may be absent or incomplete; line metadata does not prove original source is available. The pinned Go 1.22.10 parser may differ from the target version. Optimizations and stripped metadata can still obscure names and types; the pseudocode remains an approximation. |
| Kotlin/JVM, Swift, Objective-C, and native C++ recovery | **Early Kotlin/JVM alternate; early Swift/Objective-C metadata and pseudocode alternate; partial native pseudocode** | JVM `.class`/`.jar` inputs can use Vineflower's experimental Kotlin plugin; JetBrains Kotlin metadata is a candidate for symbol enrichment. Android DEX still uses Java-like output. For supported Mach-O inputs, isolated ReIPA metadata is stored with the exact artifact/run; Ghidra names and ReIPA's experimental pseudocode alternatives are attached only to exact-address Swift/Objective-C matches, shown in provider comparison, and can ground same-run AI rewrites as provisional context. | Kotlin reconstruction has not been fixture-validated and the alternate does not accept DEX/APK. REAmon does not yet reconstruct Swift, Objective-C, or C++ source idioms or project structure; ReIPA output is early C-like pseudocode, not recovered source. See the [language matrix](docs/REAMON_LANGUAGE_MATRIX.md) and [upstream reuse audit](docs/REAMON_UPSTREAM_REUSE.md) for scope and limits. |
| Rust native binaries | **Early optional integration (Oxidizer)** | The isolated Oxidizer/angr provider stores per-function Rust-like pseudocode, address identities, same-run call edges, source hashes, and provider revision alongside Ghidra’s output. | Fixture comparisons with Ghidra have not been run. Oxidizer output is pseudocode, not guaranteed compilable or equivalent to the original Rust source. |
| JavaScript bundles (`.js`, `.jsx`, `.mjs`, `.cjs`) | **Early integration** | webcrack unminifies code, reverses some obfuscator.io patterns, and extracts webpack / Browserify modules into indexed source units. When a bundle references a bounded local version 3 source map, REAmon also stores embedded JavaScript and TypeScript `sourcesContent`—including inline and relative-local indexed-map sections—as separate source candidates with bundle, map, and source hashes. Accepted maintained source up to 512 KiB receives a hash-bound, versioned Babel syntax check. | webcrack output is reconstructed source, not guaranteed original source or behavior. Embedded source-map content may be stale or unrelated to the bundle; referenced section maps must resolve inside the imported bundle directory and are subject to aggregate size and map-count limits. REAmon runs the string-array decoder in an isolated V8 runtime with resource limits; fixture validation is still needed. |
| TypeScript bundles and JavaScript runtime bytecode | **Early source-map recovery; bytecode planned** | TypeScript source embedded in a referenced local source map is recovered and indexed when `sourcesContent` is present; the visualizer preserves map provenance and AI context verifies the saved map and source hashes. Accepted TypeScript source up to 512 KiB receives Babel syntax validation using its TypeScript and JSX plugins. | No dedicated TypeScript bundle deobfuscator or JavaScript runtime-bytecode provider is integrated. Source maps can be missing or stale; syntax validation does not prove behavior or target-version compatibility. |

This is a work-in-progress capability matrix, not a compatibility guarantee. The
planned rows identify areas to evaluate; they do not promise a release date. Detailed
per-language scope is in the [language matrix](docs/REAMON_LANGUAGE_MATRIX.md), and
cross-workflow status is in the [feature matrix](docs/REAMON_FEATURE_MATRIX.md).
Current engines include [JADX](https://github.com/skylot/jadx),
[Vineflower](https://github.com/Vineflower/vineflower) and [CFR](https://github.com/leibnitz27/cfr)
for isolated JVM `.class`/`.jar` alternatives,
[Androguard's Rust DEX decompiler](https://github.com/androguard/dex-decompiler),
[ILSpy](https://github.com/icsharpcode/ILSpy),
[Oxidizer](https://github.com/sefcom/oxidizer) through an optional analyzer pinned to angr 10.0.4,
[Ghidra](https://github.com/NationalSecurityAgency/ghidra), and
[WABT](https://github.com/WebAssembly/wabt). Python bytecode uses the MIT-licensed
[pycdc](https://github.com/ejfkdev/pycdc) 0.6.0 CLI in an isolated analyzer;
its broad version support and reconstruction quality still need REAmon fixture
validation. [PyLingual](https://github.com/syssec-utd/pylingual) is a planned
Python comparison path: upstream currently advertises CPython 3.6–3.15, but its
GPL-3.0-only license, Python 3.12+ runtime, model downloads, and floating model
revisions need deliberate packaging and provenance work first.
JavaScript bundles use the MIT-licensed [webcrack](https://github.com/j4k0xb/webcrack)
2.16.0 package in an isolated Node.js analyzer. Its AST-based transforms and
bundle extraction are a starting point for project-level source recovery, not a
claim that original names or behavior have been restored. The analyzer also reads
only referenced local source maps within configured size bounds and stores their
embedded JavaScript/TypeScript sources separately with hash-checked provenance;
these build-provided contents remain candidates to compare against generated code.
Standard Lua 5.0–5.4 bytecode uses the MIT-licensed [unluac fork](https://github.com/Jeong-Min-Cho/unluac)
in an isolated JVM analyzer. The MIT-licensed [unluac-rs](https://github.com/x3zvawq/unluac-rs)
1.4.4 JavaScript/WASM API runs in an isolated worker and adds strict alternate output
for Lua 5.1–5.5, LuaJIT, and raw Luau. It returns `.lua` or `.luau` source with
dialect-specific metadata and bounded prototype/CFG evidence. Luau vector constants use `vector.create`
with three components by default; set `REAMON_LUAU_VECTOR_SIZE=4` for four-wide
targets, or set `REAMON_LUAU_VECTOR_LIBRARY` and
`REAMON_LUAU_VECTOR_CONSTRUCTOR` for a host-specific constructor. The target host
must expose that constructor. The official
[Luau compiler](https://github.com/luau-lang/luau) 0.742, distributed under MIT,
checks saved Luau source in parse-only mode on amd64 agent images; Tree-sitter is the
fallback elsewhere. This confirms syntax, not target-host API compatibility or
behavior. Versioned decompilation fixture validation remains open.
LuaJIT bytecode also uses the MIT-licensed
[LuaJIT Decompiler v2](https://github.com/marsinator358/luajit-decompiler-v2),
built for Linux from its pinned [Linux port](https://github.com/PackageInstaller/luajit-decompiler).
REAmon stores each engine's output separately so it can be reviewed against the same
input. Alternate output needs review and has no source-equivalence guarantee. Luau integration is
early and only covers raw chunks identified by the profiler; Roblox-wrapped
containers and fixture-backed fidelity validation remain future work.
Android APK/DEX analysis also has an alternate Java reconstruction and bounded
method-level evidence from the
Apache-2.0 Androguard [dex-decompiler](https://github.com/androguard/dex-decompiler),
pinned at commit [`d458efd`](https://github.com/androguard/dex-decompiler/tree/d458efd15d74351e83f4e8968c75ef17c71f3c65).
It runs in a separate bounded container; source artifacts retain the engine commit
and input hash. Structured Dalvik method observations retain instruction-mnemonic
samples, bounded CFG summaries for the function visualizer, and linked per-method
instruction artifacts that the AI can use as project evidence. This is an early
comparison path, not a replacement for JADX; field reads/writes and direct string
literal references are persisted as typed project evidence with capped previews.
The visualizer also compares stored Dalvik instruction sequences across completed
analyses and opens a matching method in its containing Java source class; similarity
is a navigation lead, not proof of equivalent behavior. Fixture-backed accuracy
comparisons remain open.

## Current bootstrap

The REAmon workspace foundation is implemented and running:

- Create a reverse-engineering workspace without inventing a domain or network scope.
- Import a complete browser-selected folder in bounded batches, preserving its relative
  directory tree as workspace context. Single-file import remains available.
- Compare a selected folder with the latest completed snapshot before upload, then store
  an authoritative SHA-256 refresh delta after finalization.
- Cancel an in-flight import safely, keep its partial state visible, and resume the
  remaining paths or select a replacement snapshot later.
- Persist a directory root target, logical artifact paths, and candidate analysis targets
  in PostgreSQL.
- Compute SHA-256 identity and a basic magic/extension/header profile.
- Keep unknown inputs valid instead of rejecting them.
- Resolve compatible built-in capabilities from typed plugin manifests.
- Queue a reviewed capability proposal as an idempotent analysis task without
  executing providers in the request path.
- Show targets, artifacts, detected metadata, capabilities, progress, findings,
  hypotheses, evidence, and activity in a real data-backed dashboard.
- Run JADX 1.5.6 in an isolated backend service for APK decompilation; store bounded
  Java source outputs separately and publish class-sized code-unit observations.
- Detect managed PE assemblies from their CLR data directory and run pinned ILSpyCmd
  in an isolated backend service; store bounded C# type outputs and publish browsable
  code-unit observations without routing native PE files through the managed provider.
- Run Ghidra 12.1.4 headless in an isolated backend service for ELF, PE, and Mach-O
  decompilation; store bounded C-like function outputs separately and publish
  address-aware code-unit observations.
- Run pycdc for Python bytecode and webcrack for JavaScript bundles in isolated
  analyzers; store reconstructed source as derived artifacts and index module units.
- Draw a searchable size/coverage treemap from provider code-unit observations and
  open source only through an authenticated, active-workspace artifact route.
- Run bounded `strings` and `readelf` process providers against stored source and
  ELF artifacts, capture stable observations, and terminate the process on
  cancellation or timeout.
- Inspect generic file metadata and bounded JSON configuration documents through
  the same typed provider boundary, with stable observations and fail-closed size
  limits.
- Converge observations with explicit provider-independent identity hints before
  graph projection, including explicit relationship endpoint hints while retaining
  source-specific keys for provenance.
- Reconcile completed graph replays against the relational observation source,
  fencing overlapping project replays so stale nodes and relationships are removed
  without allowing concurrent workers to delete each other's writes.
- Persist worker dispatch health, show stale-worker status, and surface an operator
  alert when a worker is stale or reports a failed dispatch.
- Preserve the PostgreSQL, Neo4j, agent, authentication, and event infrastructure
  needed by the REAmon workspace.

The current provider set covers profiling, source strings, ELF headers, generic file
identification, bounded JSON inspection, APK-to-Java decompilation through JADX,
managed .NET PE decompilation through ILSpy, and native ELF, PE, and Mach-O
decompilation through Ghidra. Runtime instrumentation, additional executable formats,
resource extraction, and broader language-specific workflows remain future work.

<!-- REAMON_PRODUCT_PROGRESS_START -->
## Long-term product progress

<progress value="46" max="100">46%</progress> <strong>46%</strong>

Weighted estimate: **46.0%** (rounded for the bar). Refreshed from the workstream weights at pushed commit `b469471`.

| Workstream | Weight | Completion estimate | Weighted points | Current evidence and remaining gap |
| --- | ---: | ---: | ---: | --- |
| Core analysis and visualizer workflow | 20% | 74% | 14.8% | Imports, provider execution, stored code units, source navigation, and review workflows exist. The profiler recognizes structurally plausible PyInstaller CArchive cookies in native executables and records package/runtime metadata. A pinned, MIT-licensed pyinstxtractor-go snapshot now runs in a bounded isolated service, extracts capped Python bytecode children, persists each accepted child as a task-scoped derived artifact and database code unit, and feeds up to four not-yet-decompiled modules per run to pycdc while skipping exact-hash modules already completed in prior project runs; child records retain executable, archive-path, extractor-revision, bytecode-hash, and recovered-source provenance. The Go image builds and webapp type-checks; representative archive execution and fidelity validation remain open. The Python bytecode workflow pairs hash-verified recovered source with bounded bytecode in the visualizer and MCP dossier, keeps module-wide evidence out of selected-function context, and carries the raw bytecode magic without inferring a runtime version. Native Mach-O analysis stores exact-address Swift/Objective-C metadata and exposes capped, hash-checked ReIPA pseudocode alternatives; the visualizer can compare native provider outputs by canonical function identity across differing saved paths and output-language labels. Isolated pinned Glaurung, Kuna, and Fission providers persist bounded native C-like pseudocode; Fission's exact-hash per-function outputs are included as same-function AI context only after binary-hash, identity, completed-run, and output-hash checks. Kuna also stores assembly, selected call/jump/reference edges, and bounded opcode sequences. A pinned isolated Recurse MCP adapter stores bounded per-function VTIL-style lift evidence and optimizer counters, displayed with its semantic limits; container build, runtime, and fixture comparison remain open. The visualizer and rewrite context compare Ghidra/Kuna instruction sequences across providers only when normalized architecture groups agree, exclude same-function cross-provider self-matches, and keep provider, analysis-run, artifact-hash, identity, and similarity provenance with reused names. Kuna's v1.878 analyzer image and end-to-end worker have been exercised against a system ELF binary. A read-only Ghidra p-code emulator also persists bounded, confidence-labeled control-flow-flattening transitions as visualizer navigation evidence. Ghidra now offers separate opt-in pinned BcfClean and CffDeflatten passes with bounded scans, emulation audits, and hash-checked alternatives in the visualizer and rewrite context; runtime and representative fixture comparisons remain open. The new Fission adapter still needs image-build, runtime, and fixture comparison. |
| Database-grounded project memory and provenance | 20% | 68% | 13.6% | Project-scoped observations, symbols, relationships, drafts, and review records ground AI context. Common native virtual-address spellings now canonicalize across Ghidra, Glaurung, and Oxidizer for same-artifact function identity; bounded same-binary, completed-run lookups bring accepted cross-provider names into rewrite, explanation, and MCP dossier contexts for selected units with canonical-key or normalized native-identity matches, exact input-hash checks, and review-receipt verification. Ghidra/Kuna lookalike context now retains the producing provider, analysis task, artifact identity and hash, normalized architecture, native function identity, and similarity score; opening an older match resolves its exact completed run only within the active project artifact selection. Fission, Ghidra, and Kuna same-function native reconstructions can now enter selected-unit rewrite context only when the input artifact hash, canonical address identity, completed provider run, and saved output hash all match; each is labeled provisional provider evidence. Recurse VTIL-style lift artifacts persist exact input/output hashes, provider revision, native function identity, and optimizer counters; rewrite context reads a same-function lift only from a completed run with exact input, identity, run-path, and output-hash checks, while labeling the lift as provisional structural evidence. Legacy native address aliases remain a fallback and are labeled separately because they can denote thunks. MCP provider outputs also require exact input and saved-output hashes; accepted project-memory lookup is bounded to 100 candidate provider observations and reports possible truncation. Exact-address ReIPA pseudocode alternatives for matched Swift/Objective-C methods enter rewrite context and MCP dossiers only after same-run provenance checks. Ghidra functions persist bounded basic-block/edge/entry/exit metrics and a bounded basic-block graph for the visualizer. Control-flow-flattening recovery now persists in function observation attributes and is available to the visualizer, rewrite/explanation, and MCP dossier as confidence-labeled structural evidence; it does not establish identity or behavior. Opt-in BcfClean and CffDeflatten pseudocode enters rewrite context only after the pinned provider version, same-artifact hash, exact address, saved-output hash, and successful emulation audit all match. The MCP code dossier now recomputes maintained-source and saved-draft hashes before exposing their code or validator results; Python bytecode units now retain hashes for both reconstructed source and disassembly, and the visualizer, MCP dossier, and module-level rewrite context verify those hashes; module-wide bytecode evidence is withheld from selected-function context unless a unique same-module code-object name match exists; maintained code also requires an accepted receipt matching the exact source bytes. Rewrite context now reads accepted symbols from immutable receipt snapshots and rehashes maintained callee source before using it. The visualizer and Ghidra export use the accepted receipt’s same symbol snapshot for historical rename names, lineage, and address annotations. Broader identity coverage and fixture validation remain open. PyInstaller bytecode children now persist as task-scoped derived artifacts with database code-unit records linking each module to the executable hash, archive member, extractor revision, and bytecode hash; up to four selected modules gain hash-verified pycdc source provenance, while remaining modules retain bytecode evidence for later review. PyInstaller selection now queries prior project observations using the exact executable hash and stable module code-unit key, so repeated runs continue through pending modules instead of restarting the same four-module batch. |
| Major-language and format decompilation fluency | 30% | 31% | 9.3% | Several useful Java, .NET, Android, Python, WebAssembly, and native paths exist, and matched arm64 Mach-O methods can now show early ReIPA C-like pseudocode beside Ghidra output; optional Glaurung and Kuna providers add bounded native C-like pseudocode, with Kuna also saving assembly and selected graph edges. Kuna's analyzer has built and completed an end-to-end system-ELF smoke run, but both native alternates still need representative fixture comparison and fidelity validation. Many languages remain navigation-only, early, or represented by generic pseudocode. The new isolated Arlecchino provider builds from its audited upstream revision, combines Vineflower, CFR, and JADX per class using compiler-error ranking, and stores canonical rename provenance, round-trip coverage, and hash-attributed output. Runtime and fixture fidelity remain unverified, so this adds a limited early JVM capability only. The pycdc provider stores a hash-attributed recovered Python source artifact and bounded bytecode disassembly, both linked to Python source units and verified by the visualizer. Selected-function context can include an exact-run code-object section when one matching name exists in the module, while ambiguous matches are omitted; module context retains the bounded full listing. A bounded isolated PyInstaller extractor now sends recovered `.pyc` members through that provider and preserves executable, archive-member, bytecode, and source hashes; only image-build and type-check evidence exist so far, so execution and source fidelity remain unvalidated. The ILSpy provider now applies a pinned NoFuserEx static ConfuserEx cleanup subset before decompilation, stores transformed assemblies separately with exact input/output hashes and pass provenance, and labels the output as intermediate; the image builds, while fixture-backed fidelity remains open. The webcrack analyzer also recovers embedded JavaScript/TypeScript from bounded local version 3 source maps, storing exact map and content provenance; maps are optional build evidence and may be stale, so broad TypeScript bundle reconstruction remains open. The isolated ILSpy analyzer now emits bounded, syntax-parsed Visual Basic-shaped translations from its C# reconstruction with exact source/output hashes and pinned CodeConverter provenance; this is an early bridge only, not recovered original VB, and fixture compilation and behavior checks remain open. A constrained CRuby 3.4.11 provider recognizes YARB ISeq artifacts and stores bounded raw disassembly plus a hash-verified structured sequence/opcode tree with locals, parameters, catch entries, and operands; these are version-specific bytecode evidence, not Ruby source recovery. The analyzer image, Ruby syntax checks, Compose configuration, and webapp type-check pass; runtime artifact inspection and fixture fidelity remain open. |
| Maintainable editing, review, and export | 15% | 40% | 6.0% | Hash-bound drafts and review receipts preserve exact source lineage. New accepted reviews snapshot the exact source and symbol index; the visualizer can restore a verified prior source into a new review using that revision's saved rename context. Accepted-source promotion rejects failed or unavailable validation and prevents a previously accepted language-specific syntax check from silently downgrading to generic Tree-sitter evidence. An initial JVM rebuild path compiles one receipt-verified accepted Java class against the original JAR in the isolated JDK analyzer, patches matching class entries into a separate unsigned derived JAR, removes stale nested class files, and records the input/source/output hashes and compiler version in project observations. This is single-class build evidence only: signed and multi-release JARs, external dependency classpaths, cross-file builds, and runtime/fixture validation remain open. Syntax-aware edits cover selected languages, with reproducible export; the visualizer now exposes hash-pinned Phpactor LSP local-variable and parameter renames for PHP, validates rewritten source with PHP lint, and records the rename engine, mappings, and hashes in the existing reviewable attempt flow. This first integration is single-file and has container image-build, compile, and type-check evidence; runtime rename smoke checks, fixture coverage, project-wide PHP symbols, and behavior checks remain open. Broad language coverage and project-level edits remain limited. |
| Fixture-backed validation and fidelity evidence | 15% | 15% | 2.3% | Provider smoke checks and structural validators exist, but broad versioned clean, optimized, stripped, and obfuscated fixture comparisons are still missing. |

The weights describe REAmon’s full reverse-engineering goal, not the narrower bootstrap release. Each push to `main` regenerates this block from [the progress ledger](docs/REAMON_PROGRESS.json). Update a workstream estimate only when committed implementation or fixture evidence changes its basis; the score is a roadmap estimate, not a line-count or test-count metric.
<!-- REAMON_PRODUCT_PROGRESS_END -->

## Bootstrap release readiness

<progress value="100" max="100">100%</progress> <strong>100%</strong>

This is a release-gate snapshot, reviewed 2026-10-03 against repository, hosted
workflow, production-image, and staging evidence. The score measures readiness for
a dependable self-hosted production release, not the number of UI screens or lines
of code.

This rating covers the bootstrap release scope only. It does not measure readiness
for REAmon's broader product goal of reverse-engineering arbitrary programs from
import through decompilation, navigation, AI-assisted analysis, and runtime work.
That broader goal remains in progress. The WIP support matrix above describes
capability additions that are outside this historical bootstrap release score.

The 100% score is justified for the current production release scope. The product
boundary is release-gated independently: no native workspace depends on a retired
scanner, pentest, or upstream-update surface.

| Workstream | Weight | Complete | Release evidence |
| --- | ---: | ---: | --- |
| Workspace foundation and access control | 20% | 100% | Full web suite, live auth boundary, operator login, project creation, browser login, and workspace navigation are hosted gates. |
| Import, profiling, storage, and inventory | 15% | 100% | Representative JSON/source import, profiling, inventory, writable artifact storage, PostgreSQL restore, and artifact extraction pass in CI. |
| Provider registry, scheduling, and provider execution | 15% | 100% | Approval-gated scheduling, concurrent claims, bounded providers, Python unit checks, and a killed-replica Compose worker recovery drill are covered. |
| Provider results and knowledge graph ingestion | 20% | 100% | Provider observations project into Neo4j; the hosted gate dumps, restores, queries, and rechecks the graph database. |
| Approvals, live activity, and operator controls | 10% | 100% | Browser import, approval, analysis, stale-recovery control, authenticated workspace state, and live activity are verified. |
| REAmon product boundary and retired-surface isolation | 10% | 100% | Pentest navigation, scanner services, inherited update checks, and upstream-facing UI are removed from the shipped runtime; retired flags fail closed. |
| Production hardening and release QA | 10% | 100% | Hosted full tests, npm audit, Trivy image scan, live acceptance, browser operator E2E, two-replica crash recovery, three-way restore drills, and exact-commit semver release automation are recorded. |

Weighted result: **100%**.

The production release gate is complete. The remaining roadmap items are capability
expansion and migration cleanup, not unverified deployment prerequisites. String extraction
is now available through the shared provider for every imported file format. ELF artifacts
also expose dynamic dependencies and imported/exported symbols as graph observations.

Evidence recorded for this review:

- `.github/workflows/reamon-quality.yml` runs the full web suite, type-check, lint,
  npm production-dependency audit, Python unit gate, Trivy image scan, and a live
  Compose release gate against the production image.
- The live gate runs authenticated acceptance, browser import/approval/analysis/
  recovery controls, PostgreSQL restore, artifact extraction, and Neo4j dump/load/query
  recovery. It also scales the worker service to two replicas, kills one container,
  crosses the configured stale threshold, and requires one recovered completion.
- `.github/workflows/reamon-release.yml` validates `VERSION` against semver tags,
  requires a green quality workflow for the exact tagged commit, and publishes a
  checksum-backed source archive as a GitHub release. The reviewed release is
  [v6.23.0](https://github.com/xdCloudy/REAmon/releases/tag/v6.23.0).
- `tooling/scripts/reamon-release-preflight.sh --live --acceptance --backup` reproduces the
  same operational checks for self-hosted release operators.
- The authenticated acceptance flow imports representative JSON and C artifacts,
  exercises approvals and both built-in providers, proves distinct concurrent task
  claims, projects and reconciles the graph, and verifies the workspace snapshot.
- Two Compose worker replicas recover a controlled stale lease and complete the task
  exactly once; the isolated backup drill restores PostgreSQL into a disposable
  database and extracts the artifact archive successfully. A bounded four-task,
  two-replica load/soak run then verifies stable containers without restart churn.

For production alerting, set `REAMON_WORKER_ALERT_WEBHOOK_URL` and optionally
`REAMON_WORKER_ALERT_WEBHOOK_TOKEN`. Failed provider dispatches send a bounded
`worker.degraded` JSON event with a five-second timeout; missing or failing alert
delivery never fails the dispatch request. The dashboard remains the source of
truth for stale workers, including workers that stop reporting entirely.

## Architecture

The target-to-workflow boundary is:

```text
Target import
    ↓
Target Profiler → TargetProfile / ArtifactProfile
    ↓
Capability Resolver
    ↓
Native analysis providers · generic process adapters
    ↓
Tasks and analysis plans
    ↓
Evidence, findings, hypotheses, activity, and knowledge graph
```

The initial typed contracts live in [`webapp/src/lib/reamon`](webapp/src/lib/reamon):

- `TargetProfile` describes observable target facts.
- `ToolPluginManifest` describes accepted inputs, capabilities, requirements, and
  produced entities.
- `ToolPlugin` provides the execution boundary without naming a specific platform.
- `resolveCapabilities()` chooses compatible providers from installed manifests.
- `buildProgressModel()` derives progress from persisted lifecycle state.

Read the full design in [`docs/REAMON_ARCHITECTURE.md`](docs/REAMON_ARCHITECTURE.md)
and the migration inventory in [`docs/REAMON_MIGRATION.md`](docs/REAMON_MIGRATION.md).

## Quick start

### Prerequisites

- Docker Engine or Docker Desktop
- Docker Compose v2
- At least 4 GB RAM for the REAmon stack
- A local checkout of this repository

Node.js, Python, and reverse-engineering tools run inside containers for the normal
workflow. Do not commit `.env` or real target data.

### Local install

```bash
git clone https://github.com/xdCloudy/REAmon.git
cd REAmon

./reamon.sh install
```

The installer creates the local `.env`, generates deployment secrets, builds the
configured services, starts PostgreSQL/Neo4j/the webapp and supporting workers, and
offers to create the first administrator. Open <http://localhost:3000> after the
webapp is healthy.

For an existing installation:

```bash
./reamon.sh up
./reamon.sh status
./reamon.sh logs webapp
./reamon.sh down
```

Existing PostgreSQL/Neo4j data and stable Compose volume identifiers can be retained
when upgrading an installation; retired scanner services are not started.

### First REAmon workflow

1. Sign in and choose **New Project**.
2. Enter a workspace name or choose a project folder; the folder name is used as the
   default workspace name.
3. Review the preflight inventory, then choose **Create and import workspace**.
4. REAmon creates one `DIRECTORY` root target, uploads files through bounded requests,
   hashes and profiles each artifact, and retains paths such as `bin/x64/app.dll`.
5. Review the workspace inventory, file tree, detected logical targets, capabilities,
   deterministic progress, and activity timeline.

Browser folder selection is a snapshot: the server never receives the absolute local
filesystem path and cannot watch the directory after the browser selection ends. The
import includes everything selected by default; refresh comparisons use manifest facts
before upload and authoritative hashes after upload.

Artifacts are stored in the named `reamon_artifacts` volume. The default per-file
limit is 512 MiB and the default import limit is 50,000 files / 8 GiB. Process
providers are bounded to a 60-second execution window and 2 MiB of captured output
by default. Set
`REAMON_MAX_ARTIFACT_BYTES`, `REAMON_MAX_IMPORT_FILES`, or `REAMON_MAX_IMPORT_BYTES`
in `.env` before starting the webapp to change import limits; use
`REAMON_PROCESS_TIMEOUT_MS` and `REAMON_MAX_PROCESS_OUTPUT_BYTES` to tune provider
limits. Keep the artifact volume backed up
with the PostgreSQL and Neo4j data volumes.

## Production deployment

The default Compose file is suitable for a trusted local network and development
environments. For an internet-facing deployment, use the hardened single-host
deployment under [`tooling/deploy/single-host`](tooling/deploy/single-host), which
adds TLS termination, firewall/SSH hardening, and keeps internal services private.

Before exposing a deployment:

- Set unique, high-entropy values for `POSTGRES_PASSWORD`, `NEO4J_PASSWORD`,
  `AUTH_SECRET`, and `INTERNAL_API_KEY`.
- Set `TRUST_PROXY=true` only when every request reaches the app through a trusted
  proxy that overwrites forwarding headers.
- Set `AGENT_WS_PUBLIC_URL` to the deployment origin when using a reverse proxy.
- Back up `postgres_data`, `neo4j_data`, and `reamon_artifacts` before upgrades.
- Review [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) before redistribution.
- Do not upload real target data to a development or shared environment.

The webapp entrypoint synchronises the Prisma schema on startup. Take a database
backup and inspect schema changes
before upgrading a production instance. Startup refuses destructive Prisma schema
drift by default; set `REAMON_DB_PUSH_ACCEPT_DATA_LOSS=true` only for a planned,
backed-up upgrade after reviewing the schema change. `/api/health` is a lightweight
liveness check; `/api/health/ready` verifies both the PostgreSQL connection and
writable REAmon artifact storage, and is the endpoint used by the Compose healthcheck.
Follow [`docs/REAMON_RELEASE_RUNBOOK.md`](docs/REAMON_RELEASE_RUNBOOK.md) for
backup, upgrade, smoke-test, rollback, and restore procedures.

## Development

The repository is a Docker-orchestrated monorepo. The webapp is Next.js 16, React 19,
TypeScript, Prisma, and Vitest; the analysis agent, worker, and supporting services
are containerized.

```bash
# Validate the Compose model without starting services.
docker compose config --quiet

# Build the webapp image.
docker compose build webapp

# Start the lightweight development stack.
docker compose up -d postgres neo4j webapp

# Validate the REAmon foundation inside the webapp environment.
docker compose exec webapp npm run test -- src/lib/reamon
docker compose exec webapp npm run type-check
```

The repository test policy is documented in [`docs/readmes/README.TESTING.md`](docs/readmes/README.TESTING.md)
and [`skills/redamon-testing/SKILL.md`](skills/redamon-testing/SKILL.md). The normal
gate is containerized; do not run host Python tests against the service code.

Useful top-level commands:

```text
./reamon.sh install       Build and start the stack
./reamon.sh update        Disabled; install reviewed REAmon releases explicitly
./reamon.sh up            Start already-built services
./reamon.sh status        Show service status
./reamon.sh test unit     Run the unit gate
./reamon.sh create-admin  Create or reset an administrator
./reamon.sh down          Stop services without deleting data
```

## Repository map

```text
webapp/src/lib/reamon/     REAmon domain, profiler, capabilities, and progress
webapp/src/app/projects/   Workspace dashboard, import, and project flows
webapp/prisma/             PostgreSQL schema and REAmon foundation migration
agentic/                   Analysis agent and bounded provider runtime
graph_db/                  Neo4j access and knowledge graph infrastructure
services/reamon_worker/    Durable queued-task worker
docs/REAMON_*.md           Current architecture and product-boundary decisions
```

## Roadmap

1. Expand specialist binary/process providers beyond shared string extraction and run
   the staging multi-worker drill around the existing ownership, retry, and
   process-cancellation path. The generic provider and contention scripts are already
   available for extension and validation.
2. Ingest universal code/data/runtime entities and relationships into Neo4j.
3. Extend approval policy reporting and richer recovery UX for target-agnostic analysis workflows.
4. Add specialist binary, runtime, and data providers behind the capability boundary.
5. Add capability-specific dashboards and reports while retaining one workspace
   framework for every target type.

## Provenance and licence

REAmon was derived from an MIT-licensed upstream codebase. Required attribution,
copyright notices, and third-party licences are retained. The maintained product
is the REAmon workspace at <https://github.com/xdCloudy/REAmon>; retired upstream
features are not part of its runtime contract. The bundled component inventory is
documented in [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
