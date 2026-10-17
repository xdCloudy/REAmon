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

REAmon orchestrates reverse-engineering engines such as Ghidra, RetDec, JADX, Vineflower, CFR,
Androguard's Rust DEX decompiler, and ILSpy on the backend, then presents their output
in one investigation workspace. Android APKs use isolated JADX and an alternate isolated
Rust DEX decompiler; JVM `.class`/`.jar` artifacts can also use isolated Vineflower and CFR.
Vineflower's Kotlin plugin is experimental. Managed .NET PE assemblies use isolated ILSpy,
and native ELF, PE, and Mach-O files use isolated Ghidra headless analysis with an optional
RetDec C-like alternative. These providers publish
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
| Java bytecode (`.class`, `.jar`) and Android (`.dex`, `.apk`) | **Usable (JADX); early JVM alternates (Vineflower, CFR); early Android alternate (Androguard Rust DEX decompiler)** | JADX produces browsable Java source and class/method outlines. Vineflower 1.12.0 supplies a separate JVM output path, including experimental Kotlin output; CFR 0.152 supplies an independent Java reconstruction. The visualizer can compare matching saved JADX, Androguard DEX, Vineflower, and CFR outputs side by side when artifact, path, language, and output-hash provenance match. New decompile/disassemble runs also receive centrally calculated, bounded source hashes, allowing matching outputs from other providers to be compared when their paths and languages align; older runs require provider-supplied hashes. A same-language class from another provider can enter AI rewrite context only when its artifact, relative path, and input hash match; it is labeled provisional evidence. The pinned Androguard Rust engine stores separately attributed Java output, bounded Dalvik method observations, linked instruction-row artifacts for AI context, CFG summaries, direct method-call relationships, and field/string references as typed project evidence. JDK `javac` semantic symbols, constrained with `--release 17`, support reviewer-selected local-variable, lambda-parameter, and private method/constructor-parameter renames in single-file source. | Obfuscation, missing debug metadata, reflection, and native libraries can hide behavior or names. CFR is Java-only and neither JVM analyzer accepts DEX/APK. Android Kotlin apps are still rendered as Java-like output; Vineflower's Kotlin plugin is experimental. Public, protected, and package-private method parameters remain excluded; cross-file consistency and fixture-backed output comparison remain open. Instruction artifacts, CFGs, call edges, and references have explicit caps. |
| C# / managed .NET (`.dll`, `.exe`) | **Usable decompilation; early safe renaming and parsing** | ILSpy decompiles supported managed PE assemblies to C#; CLR IL instruction sequences are retained as supporting function evidence. Roslyn identifies local symbols for reviewer-selected single-file renames and parses accepted C# source. | Output is reconstructed source. Original comments, formatting, and some compiler-level distinctions are lost. Roslyn support has not had fixture-corpus validation or project/build checks. Visual Basic and F# assemblies are not reconstructed in their original source syntax. |
| Native binaries (ELF, PE, Mach-O; including C/C++ and other compiled languages) | **Partial; early obfuscated-string recovery and experimental RetDec alternative** | Ghidra provides address-aware functions, disassembly evidence, C-like pseudocode, persisted statement-to-instruction mappings, bounded basic-block/edge metrics, and a per-function basic-block graph in the visualizer. The graph identifies all displayed exit blocks; selecting any block navigates to its starting address in the matching disassembly. An MIT-licensed Ghidra p-code emulator now adds bounded, database-persisted control-flow-flattening recovery evidence and clickable recovered block transitions for selected functions. The pinned RetDec provider emits C-like module output, raw token JSON, disassembly, and bounded provider-attributed source-line/address links. FLOSS 3.1.1 adds bounded stack, tight-loop, and decoded string evidence attached to matching function addresses for AI context and the visualizer. | RetDec module output and address links, and the new control-flow-flattening recovery, have not yet been validated on REAmon fixtures or benchmarked against Ghidra. CFF transitions are confidence-labeled structural leads, not reconstructed source or proof of behavior. Pseudocode is not recovered C/C++ or the original language. Types, class structure, templates, symbols, and control flow can be incomplete or misleading, especially in optimized or stripped binaries. The displayed Ghidra graph is capped at 32 blocks and 48 edges; its topology is partial for larger functions and still needs fixture validation. FLOSS is a static-analysis lead, not proof of runtime string use; its bundled executable is currently amd64-only. Mapping availability is bounded and does not prove semantic equivalence. |
| WebAssembly (`.wasm`) | **Early decompilation bridge** | WABT provides WAT evidence and function navigation; pinned unwasm also produces bounded, function-sized Rust translation views linked to the same function addresses, with source-line links to raw Wasm byte ranges. | Rust is a generated bridge representation, not recovered original source or idiomatic Rust. Semantic equivalence and fixture coverage remain to be independently validated. |
| Source files with an available Tree-sitter grammar | **Source navigation only** | REAmon can build function/method outlines for supported grammars and use them to scope edits to a member. Syntax checks record the selected grammar and language-pack version against the exact source hash. | Parsing source is not decompilation. Grammar availability and language-specific validation vary. |
| Python bytecode (`.pyc`, `.pyo`) | **Early integration** | An isolated pycdc 0.6.0 provider stores reconstructed Python source and exposes it to the source outline and member-edit workflow. Accepted Python source receives a non-executing CPython compile check with the interpreter version and exact source hash recorded. LibCST can propose and apply reviewer-selected renames for function-local variables and parameters, preserving source formatting and recording the result as a database-backed draft. | This is not a source-equivalence guarantee, and the check may use a different Python version than the bytecode target. LibCST does not rename module-level definitions or imports in this first slice; dynamic lookup (for example `locals()` or `getattr`) can still affect semantics. The upstream release claims support through Python 3.15, while its published verification covers 2.6–3.14. PyInstaller extraction and bytecode rebuild are not integrated. |
| PHP source files | **Source navigation and early syntax validation** | Tree-sitter outlines and a versioned `php -l` lint check that does not execute source. | No PHP bytecode decompiler is integrated. Lint requires a PHP opening tag; the checker version may differ from the target runtime. |
| Ruby source files | **Source navigation and early syntax validation** | Tree-sitter outlines and a versioned `ruby -c` syntax check that does not execute source. | No Ruby bytecode decompiler is integrated; syntax acceptance does not establish behavior or target-version compatibility. |
| Lua and Luau bytecode (`.luac`, `.luau`, `.lbc`) | **Early integration** | Isolated providers reconstruct standard Lua 5.0–5.5, LuaJIT, and raw Luau chunks. Pinned unluac-rs adds separately attributed strict-output alternatives for Lua 5.1–5.5, LuaJIT, and Luau, with per-prototype metadata and bounded CFGs. Syntax outlines and project-symbol memory include Lua colon methods and unambiguous assigned function closures. Maintained Lua functions with an exact Lua 5.1–5.5 dialect are parsed by the matching checksum-pinned official `luac`; Luau source gets pinned compiler parse-only validation on amd64 agent images. | Alternate engine output is not proof of source fidelity; the unluac-rs upstream is still in a testing phase and REAmon has no fixture-backed comparison across the dialects yet. LuaJIT and dialect-less Lua retain generic grammar validation. Stripped chunks may lose local names; complex control flow, newer Roblox containers, and custom VM variants may need extra work. Syntax validation is not target-host compatibility or behavior proof. |
| Lua source safe renames | **Early integration** | Standard Lua locals, parameters, and local functions can receive evidence-grounded rename proposals. The pinned LuaLS adapter resolves selected bindings, applies only same-file edits, rejects names already present in the source, and records the attempt and hashes. Luau stays on its own language path. | Rename ranges need fixture comparison for shadowing, closures, loop variables, and method syntax. The adapter does not prove behavior. |
| Go native binaries and source | **Early metadata and source validation** | Ghidra supplies address-aware C-like pseudocode; GoReSym recovers Go function names, packages, runtime version, and type metadata where available. Bounded `unstrip` type records, address-matched method signatures, source locations, and interface-dispatch rows are stored with provider provenance for AI rewrite context, MCP dossiers, the selected-unit inspector, and Go-type search. Maintained Go source receives a versioned `gofmt -e` syntax check, and reviewer-selected local-variable/parameter renames use Go AST positions resolved through `go/types` object identity with hash-bound attempt history. | Neither GoReSym nor `unstrip` reconstructs maintainable Go source. The unstrip path still needs REAmon fixture comparison and release-build validation, and upstream scope is Go 1.18–1.25 on amd64/arm64. Rename capture behavior needs fixture coverage for nested closures and package interactions. Signatures and dispatch rows may be absent or incomplete; line metadata does not prove original source is available. The pinned Go 1.22.10 parser may differ from the target version. Optimizations and stripped metadata can still obscure names and types; the pseudocode remains an approximation. |
| Kotlin/JVM, Swift, Objective-C, and native C++ recovery | **Early Kotlin/JVM alternate; early Swift/Objective-C metadata and pseudocode alternate; partial native pseudocode** | JVM `.class`/`.jar` inputs can use Vineflower's experimental Kotlin plugin; JetBrains Kotlin metadata is a candidate for symbol enrichment. Android DEX still uses Java-like output. For supported Mach-O inputs, isolated ReIPA metadata is stored with the exact artifact/run; Ghidra names and ReIPA's experimental pseudocode alternatives are attached only to exact-address Swift/Objective-C matches, shown in provider comparison, and can ground same-run AI rewrites as provisional context. | Kotlin reconstruction has not been fixture-validated and the alternate does not accept DEX/APK. REAmon does not yet reconstruct Swift, Objective-C, or C++ source idioms or project structure; ReIPA output is early C-like pseudocode, not recovered source. See the [language matrix](docs/REAMON_LANGUAGE_MATRIX.md) and [upstream reuse audit](docs/REAMON_UPSTREAM_REUSE.md) for scope and limits. |
| Rust native binaries | **Early optional integration (Oxidizer)** | The isolated Oxidizer/angr provider stores per-function Rust-like pseudocode, address identities, same-run call edges, source hashes, and provider revision alongside Ghidra’s output. | Fixture comparisons with Ghidra have not been run. Oxidizer output is pseudocode, not guaranteed compilable or equivalent to the original Rust source. |
| JavaScript bundles (`.js`, `.jsx`, `.mjs`, `.cjs`) | **Early integration** | webcrack unminifies code, reverses some obfuscator.io patterns, and extracts webpack / Browserify modules into indexed source units. Accepted maintained source up to 512 KiB receives a hash-bound, versioned Babel syntax check. | Output is reconstructed source, not guaranteed original source or behavior. REAmon runs the string-array decoder in an isolated V8 runtime with resource limits; fixture validation is still needed. |
| TypeScript bundles and JavaScript runtime bytecode | **Not integrated; planned evaluation** | TypeScript source can be browsed and outlined when a grammar is available. Accepted TypeScript source up to 512 KiB receives Babel syntax validation using its TypeScript and JSX plugins. | webcrack does not currently accept TypeScript syntax as an input guarantee, and no JavaScript runtime-bytecode provider is integrated. Syntax validation does not prove behavior or target-version compatibility. |

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
validation. [PyLingual](https://github.com/syssec-utd/pylingual) remains an
alternative for comparison, with a GPL-3.0 license and a larger local ML runtime.
JavaScript bundles use the MIT-licensed [webcrack](https://github.com/j4k0xb/webcrack)
2.16.0 package in an isolated Node.js analyzer. Its AST-based transforms and
bundle extraction are a starting point for project-level source recovery, not a
claim that original names or behavior have been restored.
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

<progress value="38" max="100">38%</progress> <strong>38%</strong>

Weighted estimate: **38.1%** (rounded for the bar). Refreshed from the workstream weights at pushed commit `6e2dfc0`.

| Workstream | Weight | Completion estimate | Weighted points | Current evidence and remaining gap |
| --- | ---: | ---: | ---: | --- |
| Core analysis and visualizer workflow | 20% | 64% | 12.8% | Imports, provider execution, stored code units, source navigation, and review workflows exist. Native Mach-O analysis stores exact-address Swift/Objective-C metadata and exposes capped, hash-checked ReIPA pseudocode alternatives; the visualizer can compare native provider outputs by canonical function identity across differing saved paths and output-language labels. An isolated pinned Glaurung provider builds and persists bounded native C-like pseudocode. A read-only Ghidra p-code emulator now persists bounded, confidence-labeled control-flow-flattening transitions and exposes them as visualizer navigation evidence; fixture-backed behavior and provider comparison remain open. |
| Database-grounded project memory and provenance | 20% | 56% | 11.2% | Project-scoped observations, symbols, relationships, drafts, and review records ground AI context. Common native virtual-address spellings now canonicalize across Ghidra, Glaurung, and Oxidizer for same-artifact function identity; bounded same-binary, completed-run lookups bring accepted cross-provider names into rewrite, explanation, and MCP dossier contexts for selected units with canonical-key or normalized native-identity matches, exact input-hash checks, and review-receipt verification. Legacy native address aliases remain a fallback and are labeled separately because they can denote thunks. MCP provider outputs also require exact input and saved-output hashes; accepted project-memory lookup is bounded to 100 candidate provider observations and reports possible truncation. Exact-address ReIPA pseudocode alternatives for matched Swift/Objective-C methods enter rewrite context and MCP dossiers only after same-run provenance checks. Ghidra functions persist bounded basic-block/edge/entry/exit metrics and a bounded basic-block graph for the visualizer. Control-flow-flattening recovery now persists in function observation attributes and is available to the visualizer, rewrite/explanation, and MCP dossier as confidence-labeled structural evidence; it does not establish identity or behavior. Broader identity coverage and fixture validation remain open. |
| Major-language and format decompilation fluency | 30% | 22% | 6.6% | Several useful Java, .NET, Android, Python, WebAssembly, and native paths exist, and matched arm64 Mach-O methods can now show early ReIPA C-like pseudocode beside Ghidra output; the optional Glaurung provider adds bounded native pseudocode but still needs fixture validation. Many languages remain navigation-only, early, or represented by generic pseudocode. |
| Maintainable editing, review, and export | 15% | 35% | 5.3% | Hash-bound drafts, review receipts, syntax-aware edits for selected languages, and reproducible export exist; language breadth and project-level edits remain limited. |
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
