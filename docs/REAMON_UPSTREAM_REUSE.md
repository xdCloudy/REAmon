# REAmon upstream reuse notes

REAmon should reuse mature reverse-engineering engines and adapt their evidence,
validation, and collaboration workflows to its project database. Engine output,
AI drafts, accepted maintained source, and validation results must remain
separate so a plausible name is never treated as proof of behavior.

## Current direction

| Project | Useful contribution | REAmon direction | Constraints |
| --- | --- | --- | --- |
| [decomp.wtf](https://github.com/i12bp8/decomp.wtf) | Its MIT-licensed codebase is the primary process reference: atomic function claims, bounded agent tools, shared names and notes, attempt history, machine drafts, exact compiler/diff feedback, accepted-match protection, and progress derived from verified units. Its look-alike matcher prefilters by instruction-mnemonic frequency, then compares ordered instruction sequences. | **Highest product-workflow priority.** Adapt the full unit lifecycle—not only its function map—into REAmon's database-backed investigation: claim one unit, assemble evidence from project memory, record a source draft and attempt, run the strongest available validator, return specific diagnostics, review/promote accepted work, and guard prior validated units. Preserve the existing function map as one entry point: it merges analyzer functions and Tree-sitter member outlines, links entries to containing source units, and keeps coverage totals based on analyzer units. Ghidra, WABT, JADX Smali, and ILSpy persist bounded mnemonic sequences; similarity stays a navigation lead with provider/architecture constraints. Exact-source rewrite leases now prevent overlapping model calls for the same code unit/version. Ghidra's bounded recovered symbol inventory is now included in rewrite context from the exact artifact/run, explicitly labeled provisional and distinct from accepted project names. Keep the database authoritative and adapt the lifecycle to Java, .NET, bytecode, native code, resources, and source projects. | The repository was archived on 2026-10-15, so its inspected snapshot is a fixed reference rather than an upstream expected to receive fixes. Its maintainer cited community opposition to AI-assisted decompilation; respect each target project's contribution rules. Exact-byte judging depends on the original compiler, linker, and layout; other formats need validators with clearly stated confidence. Similarity is not behavioral proof. |
| [BinSync](https://github.com/binsync/binsync) + [DecLib](https://github.com/binsync/declib) | BinSync's reverse-engineering artifacts cover function headers, stack variables, structs, enums, and comments across multiple decompilers; DecLib provides a shared decompiler API and a headless/agent CLI. Both list BSD-2-Clause licenses. | This is a direct reference for keeping names and types consistent across engine outputs and resolving competing edits. | Compare artifact identity, contributor history, and merge/conflict handling with REAmon's database-backed accepted symbols, source-hash-bound rename aliases, and review receipts. Adopt portable schema/identity ideas where they improve cross-provider matching; retain REAmon's reviewer, evidence, confidence, and source-hash lineage. | Ghidra support is explicitly early and operation coverage differs by backend. These projects focus on native decompiler artifacts; they do not supply REAmon's universal language coverage, APK/.NET workflows, or review lifecycle. Treat DecLib as an optional adapter reference rather than a required provider dependency. |
| [FunctionSimSearch](https://github.com/googleprojectzero/functionsimsearch) | Apache-2.0 C++ example for CFG/mnemonic n-gram fingerprints using SimHash and approximate-nearest-neighbor search. Its paper discusses feature-weight learning and precision/recall evaluation. | REAmon's current bounded matcher uses mnemonic-frequency cosine prefiltering followed by ordered instruction matching. FunctionSimSearch offers a separate path to test against compiler and optimization changes and larger persisted histories. | Build a fixture benchmark with known same-source pairs across compiler/optimization variants and known-different pairs before adopting fingerprints. If it improves recall without unacceptable false positives, persist derived fingerprints/indexes keyed by provider, architecture, artifact hash, and analysis run; retain exact instruction/CFG evidence for inspection. | Archived April 19, 2026 and built around an old C++/Dyninst stack. The paper itself reports false positives and false negatives; do not treat approximate matches as symbol identity or semantic evidence. |
| [DecBench](https://github.com/Noelo-Lab/decbench) | Experimental multi-decompiler benchmark with separate CFG structural, type-recovery, and recompiled-byte-similarity metrics. | It reinforces that source readability, control-flow structure, recovered types, and re-compilability need separate measures rather than one completeness score. | Adapt its per-function/multi-metric reporting and reproducible compile/decompile/evaluate stages for REAmon's fixture corpus; persist tool versions, build flags, hashes, and metric limitations. | No repository license was confirmed in this review, and the benchmark is experimental. Reference the methodology only; do not copy code or datasets until the license and dataset terms are checked. |
| [JADX](https://github.com/skylot/jadx) | APK/DEX to Java, Smali-adjacent analysis, built-in short-name cleanup, and mapping support. | Continue using the pinned analyzer. The existing Baksmali output now supplies direct method-call edges with descriptor identities for REAmon's generic function graph; method nodes link back to the containing Java or Smali class. Keep the Smali as evidence and treat generated names as provisional. | Apache-2.0. `--deobf` is off by default in the CLI; the installed 1.5.6 CLI supports it. |
| [ILSpy](https://github.com/icsharpcode/ILSpy) | .NET assembly decompilation and an IL disassembly mode (`--ilcode`) in the same pinned command-line engine. IL opcodes retain language-neutral method evidence when C# source is unavailable or misleading. | The isolated ILSpy analyzer now extracts bounded CLR opcode sequences and attaches function observations to their C# type. The project-wide matcher and same-artifact method-rewrite context use those persisted features, following the decomp.wtf frequency-plus-order approach. Keep decompiled C# as the editable source and IL as supporting evidence. | MIT. `ilspycmd` 11.1 exposes `--ilcode`; IL listing extraction is separately time- and size-bounded so it cannot invalidate successful C# decompilation. |
| [jadx-headless-mcp](https://github.com/1013503897/jadx-headless-mcp) | Direct `jadx-core` access for one-method source/Smali, class summaries, and method/field cross-references through MCP. | Strong next candidate for method-scoped source retrieval and exact xref evidence. Compare its lazy per-method path with the existing whole-run export before adding it; REA already uses this engine adapter. | Apache-2.0; pin its release and track its own bundled dependency notices. |
| [REA](https://github.com/morluto/rea) | An evidence-first MCP workflow across many analyzers. Its function dossiers combine pseudocode, assembly, CFG, comments, callers/callees, references, and strings; tool results preserve provider and evidence limits. | REAmon now exposes `workspace_list_code_units` and `workspace_get_code_unit` over its persisted observation store. The get tool returns bounded source/disassembly, same-task call edges, task/provider identity, and artifact hash without rerunning analysis. Keep REAmon's active-import selection and database authoritative; compare REA's exact-object adapters when adding missing engine capabilities. | MIT-authored code. REA's breadth is a capability catalog, not evidence that every provider is available in REAmon. Android analysis needs a headless JADX/JDK setup; REA's current package runtime requires Node 22.19+, while REAmon's webapp supports Node 20+. |
| [Androguard](https://github.com/androguard/androguard) | Android manifest/DEX metadata, method-level disassembly and CFGs, cross-references, patching, optional method decompilation, and typed MCP tools. | Evaluate its method CFG and reference output as independent evidence against JADX/Smali. Keep APK metadata parsing usable without native CFG/decompiler extras. | Apache-2.0 for the app; companion packages have their own licenses and runtime requirements. The v5 line is not the published PyPI package, so prefer a pinned isolated prototype over adding its checkout-based Python package to the webapp image. |
| [Androguard dex-decompiler](https://github.com/androguard/dex-decompiler) | Rust DEX-to-Java decompilation; upstream exposes method bytecode and CFGs, string/method/field xrefs, callers, and rename maps. | Integrated at pinned commit `d458efd15d74351e83f4e8968c75ef17c71f3c65` as a separate APK/DEX alternate beside JADX. The adapter publishes bounded Dalvik method observations, summarized CFGs, capped direct call relationships, and typed field read/write and string-literal reference observations. The visualizer exposes method-call and member-reference graphs; explanation context loads references scoped to the selected class. Bounded per-method instruction artifacts remain linked from observations and passed into AI context. Java outputs remain separate derived artifacts with provider commit and input SHA-256 provenance. JADX remains intact as resource/Smali/rebuild provider. Next compare representative method outputs and runtime/RSS. | Apache-2.0. The Rust CLI and adapter build in the isolated analyzer image; the corrected Cargo.lock pins `dex-parser` at `a26a4217d1397abe7865d345594873df7418578d` because the upstream lock omits its Git source. No native toolchain is added to the webapp image. The alternate is early and has no fixture-backed accuracy claim. |
| [Apktool](https://github.com/iBotPeaches/Apktool) | Decodes the binary manifest and Android resources into an editable project tree and can rebuild APKs after Smali/resource edits. | The JADX analyzer invokes pinned Apktool 3.0.3 for APKs, indexes decoded text resources beside JADX Java and Baksmali Smali, and preserves the full decoded project under the analysis run. The authenticated rebuild route applies saved Android resource and Smali edits from project memory, resolves Smali by its class descriptor across multidex folders, then stores the unsigned APK path, hash, and build record in REAmon observations. Saved maintained Java remains separate and is not compiled back into DEX. | Apache-2.0. Apktool 3.0.3 rebuilds unsigned APKs; some vendor-modified APKs cannot be rebuilt. |
| [Ghidra](https://github.com/NationalSecurityAgency/ghidra) | Mature multi-architecture disassembly, decompilation, graphing, and automation APIs. Its marked-up C exposes statement nodes associated with p-code operations and source line groupings; `DecompiledFunction` separately provides the decompiler's signature/prototype; `HighFunction` and its symbol map expose recovered parameter/local names and types plus name/type lock state. | Continue the existing isolated analyzer integration and prefer its structured function, signature, caller/callee, disassembly, recovered variable, and persisted statement-to-instruction address evidence over asking an LLM to infer those facts. REAmon stores bounded prototypes, variable symbol evidence, and Ghidra line/p-code target mappings with each function dossier. Recovered names remain provider evidence, not reviewed canonical names; lock flags mean only that Ghidra constrained its own decompiler model, not that names or types came from original source. | Apache-2.0 for the main project; standalone GPL support programs and module dependencies keep their own notices. See the [Ghidra decompiler result API](https://ghidra.re/ghidra_docs/api/ghidra/app/decompiler/DecompileResults.html), [decompiled function API](https://ghidra.re/ghidra_docs/api/ghidra/app/decompiler/DecompiledFunction.html), [statement API](https://ghidra.re/ghidra_docs/api/ghidra/app/decompiler/ClangStatement.html), [high function API](https://ghidra.re/ghidra_docs/api/ghidra/program/model/pcode/HighFunction.html), and [high symbol API](https://ghidra.re/ghidra_docs/api/ghidra/program/model/pcode/HighSymbol.html). |
| [RetDec](https://github.com/avast/retdec) | LLVM-based native decompiler with C, disassembly, LLVM IR, configuration JSON, and an optional machine-readable token stream that can connect generated source tokens to original disassembly. | Evaluate its token-to-instruction mapping as a way to make REAmon's native visualizer evidence more precise and to compare a second native decompiler against Ghidra on the same fixture binaries. It is a candidate adapter, not integrated. | The upstream README says the project is in limited maintenance. Its C-like output does not meet the language-universal source-recovery goal by itself. Build/toolchain footprint is substantial; the project is MIT but modified PeLib and third-party dependencies carry separate notices. Prototype only in an isolated analyzer and preserve its config, token mapping, tool version, and input hash. |
| [GoReSym](https://github.com/mandiant/GoReSym) | MIT-licensed Go runtime metadata parser that recovers function addresses/names, packages, compiler version, and types from stripped and malformed binaries. | REAmon builds pinned v3.4.1 into the isolated Ghidra analyzer. It joins recovered names to Ghidra functions and call edges by address and stores package, runtime, type, and tool provenance with the run. Same-function GoReSym package identity reaches rewrite context, MCP dossiers, and the selected-unit inspector as provisional namespace evidence. The exact-run artifact-wide type catalog is searchable through MCP; rewrite context includes reconstructed type records only when their exact names occur in the selected Go function source/signature. Ghidra remains responsible for the C-like pseudocode; these records do not claim Go source reconstruction or prove behavior. | MIT. GoReSym's pinned Go module also includes dependencies with their own notices; retain the upstream `go.sum` and inspect the dependency license inventory when updating the pin. |
| [pycdc](https://github.com/ejfkdev/pycdc) | Small MIT-licensed CLI for reconstructing Python source from `.pyc` and `.pyo` bytecode. | REAmon now has an isolated analyzer provider for Python bytecode. It stores source output in the run’s derived artifacts and indexes the module so source outlines and member-scoped maintenance can use it. Keep the original bytecode as evidence, retain engine version and warnings, and treat reconstructed source as a draft until reviewed. Validate it against representative fixtures before treating broad upstream version claims as REAmon support. | v0.6.0 advertises Python 2.0–3.15, while the release verification described upstream covers 2.6–3.14. REAmon has not yet validated this matrix. PyLingual remains a higher-resource alternative for comparison; its GPL-3.0 license and ML stack need separate distribution and runtime evaluation. |
| [LuaJIT Decompiler v2](https://github.com/marsinator358/luajit-decompiler-v2) | MIT-licensed LuaJIT bytecode to Lua reconstruction, including stripped bytecode and goto-aware output; the upstream itself is Windows-oriented. | REAmon builds the MIT-licensed [Linux port](https://github.com/PackageInstaller/luajit-decompiler) at a pinned commit and runs it in an isolated analyzer. Keep LuaJIT and standard Lua provider identities separate, retain the original bytecode, and expose the reconstruction caveats. | LuaJIT only. The Linux port requires C++23 and documents unresolved limitations for complex conditional assignments. It cannot restore local names removed from stripped chunks. |
| [unluac](https://github.com/Jeong-Min-Cho/unluac) | MIT-licensed Lua 5.0–5.4 bytecode decompiler with Java CLI; this fork carries bug fixes beyond the SourceForge project. | REAmon compiles a pinned revision into a small JAR and runs it in a bounded JVM service for standard Lua chunks, separate from LuaJIT handling. Keep each output tied to the source artifact hash and report that stripped debug data and complex gotos can degrade recovery. | Requires chunk version 5.0–5.4; stripped bytecode may not preserve useful names, and modified VMs may need opcode/type maps. Upstream's version support has not yet been independently validated with REAmon fixtures. |
| [unluac-rs](https://github.com/x3zvawq/unluac-rs) | MIT-licensed Rust decompiler with a JavaScript/WASM wrapper. Upstream advertises Lua 5.1–5.5, LuaJIT 2.1, and Luau support; `decompileRich` also exposes prototype metadata and per-prototype CFGs. | REAmon runs pinned 1.3.1 in an isolated worker for Lua 5.5 and raw Luau chunks. It detects the dialect, requires strict source output, rejects diagnostic pseudocode, and stores reconstructed source, dialect, function prototypes, bounded CFGs, and engine/input provenance. The provider keeps Luau source separate with a `.luau` extension and Luau language identity. For vector constants it defaults to `vector.create` with three components and records the selected constructor and width; deployments can configure a host-specific constructor or four-wide vector mode. | Upstream describes the project as still in a testing phase. REAmon has no Luau fixture-backed fidelity claim; the target host must expose the configured vector constructor, and Roblox-wrapped containers are outside this raw-bytecode path. The published JS/WASM API defaults generation to permissive mode, so keep strict mode explicit. |
| [Luau compiler](https://github.com/luau-lang/luau) | Official MIT-licensed compiler CLI; `luau-compile --only-parse` parses source without running it. | REAmon pins the official 0.742 Ubuntu binary on amd64 agent images and records parse-only validation against the exact maintained-source hash. Other architectures retain the Tree-sitter fallback. | Parsing is structural evidence only; it cannot verify target-host globals, API availability, type correctness under project configuration, or behavior. The Ubuntu release asset is x86_64-only, so verify architecture before enabling it in other images. |
| [capa](https://github.com/mandiant/capa) | Rule-based capability detection for executable files and sandbox reports; the v9.4.0 Ghidra backend can reuse Ghidra/PyGhidra function features. | Keep as an optional native-analysis candidate for function-level behavior labels in the map and AI context. REAmon's Ghidra integration already requires Ghidra 12+, but capa's backend would perform another analysis pass; prototype it as an explicit enrichment so it does not slow every decompilation. Keep each match linked to its rule, function address, and analyzer/rule versions; treat matches as hypotheses, never recovered identifiers or proof of behavior. | Apache-2.0 tool; rules are separately maintained and must retain their own notices. The Ghidra backend adds Python/JVM packaging and runtime cost. It applies to supported native executables, not decompiled Java source itself. |
| [Tree-sitter](https://github.com/tree-sitter/tree-sitter) | Error-tolerant concrete syntax trees and language grammars that can identify declarations without guessing from comments or string literals. | Maintained-source saves, repository navigation, and bounded unreviewed-draft context use syntax-aware symbol indexing. REAmon outlines and one-member rewrites use the pinned Tree-sitter Language Pack so grammar lookup can extend beyond the former 15-language allowlist, including Luau output from the unluac-rs provider. Original-source member outlines remain run-, parent-, and source-hash-bound observations and include the parser version; maintained-source syntax receipts now record the selected grammar and language-pack version as well. The user-selected function is still checked against the exact stored source range and declaration before AI rewriting; recognized node names alone never count as semantic validation. | The language pack is MIT-licensed and its parser binaries are cached on demand. Each downloaded grammar retains its own upstream license and notices; review those before redistributing cached parser binaries. |
| [angr](https://github.com/angr/angr) | Python framework for CFG recovery, data-dependency analysis, symbolic execution, and decompilation across native architectures. | Optional native-analysis provider for path and dataflow evidence when Ghidra’s static output leaves a concrete unanswered question; make expensive emulation opt-in and persist its constraints and limits. | BSD-2-Clause; broad dependency stack and symbolic-execution cost make this a targeted provider, not a default analyzer. |
| [Frida](https://github.com/frida/frida-core) | Dynamic instrumentation, process discovery, and two-way script communication across language bindings. | Future runtime-evidence adapter for a user-controlled device/emulator: tie traces to an exact artifact hash and target session, then persist observations alongside static evidence. | Package/component licenses vary; review the exact Frida component and pinned binary distribution before bundling. Requires a connected runtime/device, so it is separate from offline import. |
| [APKLab](https://github.com/APKLab/APKLab) | Practical APK edit/rebuild workflow assembled from Apktool, JADX, Smali language tooling, signing, and Git. | Use as a workflow reference for a future source-to-rebuild loop: export maintained source, rebuild where dependencies permit, preserve a diff, and report signing/build results separately. | Current project is AGPL-licensed; prefer workflow learning or an external integration unless REAmon deliberately adopts the license obligations. |
| [Rizin](https://github.com/rizinorg/rizin) | Additional native RE engine and scripting ecosystem. | Treat as an optional external provider behind REAmon's analyzer contract, not code to vendor into the core. | Mixed LGPL-3.0/GPL-3.0 components; check the specific component before reuse. |
| [ToCode](https://github.com/buzzer-re/ToCode) | MIT-licensed exporter for native binaries, APKs, .NET assemblies, and multi-binary application folders. It emits source-like trees plus structured function, type, string, import/export, call-graph, reachability, and project metadata. | The importer indexes function/source artifacts, bounded native `params` and `locals`, imported-call names, Android field-reference signatures (without inventing read/write direction), address-matched string cross-references, and export-scoped type catalogs from native/.NET `types.json` or APK `classes.json`, each linked to its source artifact hash. APK field references are also persisted as bounded `references_field` relationships to project-scoped field symbols and exposed in the member-reference graph and MCP dossiers; their access direction stays unknown. Type summaries preserve namespace/assembly and bounded members, method signatures, bases, and interfaces where ToCode provides them. Function evidence appears in the inspector/MCP dossier and rewrite context; type declarations enter rewrite context only when exact or unambiguous simple identifiers occur in the selected function source or signature. Continue importing additional APK/.NET schemas with exact artifact hashes and provider identities. Keep ToCode-generated `AGENTS.md` / `CLAUDE.md` files as untrusted sample-derived data, never system instructions. | Do not replace current isolated JADX, ILSpy, Ghidra, or angr providers until output and performance are compared. ToCode's optional IDA/Binary Ninja/radare2/angr backends and dependencies have separate runtime/licensing requirements; MIT covers ToCode's own code, not every backend. Pin a release and inspect its dependency notices before packaging. |
| [Glaurung](https://github.com/mjbommar/glaurung) | Apache-2.0 Rust/Python framework with native triage and analysis, persistent SQLite projects, and optional LLM workflows. It recovers native functions, CFGs, call graphs, xrefs, types, and experimental C-like pseudocode. | Compare its project identity, symbol/type persistence, xref evidence, and agent context patterns with REAmon. If a measured gap remains, add its output through the existing provider/observation contract; do not make `.glaurung` a second REAmon source of truth. | Upstream describes the project as pre-1.0 and decompiler output as experimental. Current native decompilation is limited to x86/x86-64 and ARM/ARM64; RISC-V is disassembly-only. Building requires Rust and C toolchains; sample fixtures use Git LFS. |
| [Redress](https://github.com/goretk/redress) | Go-specific recovery of package, type, and symbol information from stripped Go executables, with standalone and radare2 modes. | Evaluate as an optional Go-binary enrichment adapter: store recovered symbols and package metadata as evidence linked to the exact binary hash, while leaving disassembly/decompilation to Ghidra. Its focused Go runtime metadata recovery can complement generic native analysis where stripped names leave poor function labels. | AGPL-3.0; prefer a documented external executable integration or user-supplied installation unless REAmon intentionally accepts the distribution obligations. |

## Additional engines evaluated

- [Humanify](https://github.com/jehna/humanify) v3.1.1 is MIT-licensed and uses
  OXC's JavaScript AST and semantic model to apply model-suggested renames across
  lexical scopes, with identifier validity and collision checks. Its important
  design is the separation between uncertain name proposals and deterministic
  source edits. REAmon should adapt that contract for its JavaScript/TypeScript
  maintenance path: request evidence-linked mappings through the user's saved
  provider, keep the exact project/run symbol index in context, apply mappings
  against an exact source hash, show the resulting diff, and persist proposal,
  edit, and validation records in REAmon. Do not invoke Humanify's built-in
  per-identifier provider loop: its README describes one LLM request per
  identifier, and that flow does not use REAmon's database context or attempt
  history. REAmon's first slice follows this design with the analyzer's pinned
  Babel parser/traverse/generator: it lists scope bindings, accepts selected
  evidence-grounded mappings, rejects identifier/collision hazards, applies the
  AST rename, protects ES-module exports, reparses the result, and saves full input,
  mapping rationales, output, hashes, and the exact Babel parser version in its
  attempt database. If that exact output is later accepted, REAmon carries its
  old-to-new mappings forward as reviewed project-memory aliases. The source hash
  is checked again when applying proposals.
  Babel is an initial adapter, not code copied
  from Humanify; compare it with OXC before deciding whether to build an OXC
  sidecar. The current [OXC Node parser binding](https://github.com/oxc-project/oxc/issues/22985)
  does not yet return its semantic scope data, which Humanify uses in Rust. Both
  approaches prove syntax/scope editability, not behavior. See the upstream
  [README](https://github.com/jehna/humanify) and [dependency manifest](https://github.com/jehna/humanify/blob/main/Cargo.toml).
- [webcrack](https://github.com/j4k0xb/webcrack) is MIT-licensed and targets
  JavaScript specifically: obfuscator.io transforms, unminification, JSX, and
  webpack/Browserify module extraction. REAmon now uses v2.16.0 in a Node 22
  analyzer, indexes the extracted modules, and runs decoder snippets inside a
  memory-limited `isolated-vm` context. It does not promise source equivalence or
  TypeScript support.
- [RetDec](https://github.com/avast/retdec) is worth a pinned comparison as a
  second native decompiler. Its v5.0 release moved the decompiler toward a library
  and the project README warns that development is in limited maintenance; compare
  packaging, supported architectures, function boundaries, and output quality
  against Ghidra before adding a redundant default provider. The core is MIT, with
  a separate third-party notice inventory.
- [Rizin](https://github.com/rizinorg/rizin) has an active command-line framework
  and structured JSON output. [rz-ghidra](https://github.com/rizinorg/rz-ghidra)
  adds Ghidra's decompiler through a plugin and can emit function JSON and offsets.
  Its strongest REAmon case would be structured cross-reference evidence that the
  current Ghidra provider does not expose; otherwise it duplicates the decompiler
  and brings LGPL/GPL components.
- [ToCode](https://github.com/buzzer-re/ToCode) is an MIT-licensed export layer
  over several reverse-engineering engines. Its `functions.json`, function index,
  type/string/import/export metadata, and APK/.NET/native exports are a useful
  interchange candidate. Its strongest addition for REAmon is linking a directory
  of binaries through actual loader and import relationships, with per-file
  checkpoints so one failure does not discard other exports. Prototype consuming
  its bounded metadata and code artifacts into REAmon's existing project database;
  do not trust generated agent instruction files or create parallel project memory.
  The CLI and backend dependencies need version pinning and separate license review.
- [Glaurung](https://github.com/mjbommar/glaurung) offers an Apache-2.0 Rust/Python
  binary-analysis core and persistent SQLite project state, which make it a useful
  comparison for REAmon's native evidence contract. Its own README labels the
  project pre-1.0 and its decompiler experimental; treat it as a fixture-backed
  alternate-provider evaluation, not a replacement for Ghidra or REAmon's store.
- [Kong](https://github.com/amruth-sn/kong) is an Apache-2.0 Ghidra/PyGhidra
  agent pipeline that schedules functions bottom-up from the call graph, feeds
  callers bounded cross-reference, string, data-flow, and resolved-callee context,
  then runs a synthesis pass to reconcile names and types across the binary. This
  is a strong reference for making REAmon's project-wide symbol consistency
  operational: order work using persisted dependencies, keep each prompt grounded
  in exact-run evidence, and save global consistency proposals as reviewable
  attempts. Reuse the workflow pattern only; the provider and Ghidra project state
  should remain separate from REAmon's database. Its C/C++ focus and recovery
  claims still need fixture comparison.
- [delamain](https://github.com/xjoker/delamain) is an Apache-2.0 headless MCP
  layer around JADX. Its bounded graph traversals, explicit truncation and
  decompilation-quality signals, xref/data-flow queries, and rename/ProGuard
  workflows are useful comparisons for Android MCP ergonomics. REAmon already
  integrates JADX, so compare these evidence contracts before considering another
  service; avoid duplicate JADX execution without a measured gap.
- [Reko](https://github.com/uxmal/reko) provides a .NET CLI for decompilation,
  disassembly, and executable inspection across architecture and file-format
  plugins. It is a GPL-2.0 candidate for an opt-in comparison on architectures or
  formats where REAmon has weak Ghidra coverage; validate exact fixture support and
  distribution requirements before bundling it.
- [decomp.me](https://github.com/decompme/decomp.me) is a collaborative exact-build
  function-matching application. Its MIT-licensed code and compiler configuration
  model are useful references for a future validator contract, but its web product is
  not a universal binary-to-source engine. Target builds must run in a separate,
  resource-limited worker with explicit user configuration.
- [objdiff](https://github.com/encounter/objdiff) is a local object-file diff tool
  with function/data views, project configuration, build-on-edit, and progress
  reporting. Its Rust core exposes a possible comparison component for exact-build
  workflows; evaluate its CLI/WASM boundary and dependencies before integration. It
  supports selected console and desktop architectures, not arbitrary source recovery.
- [ast-grep](https://github.com/ast-grep/ast-grep) offers structural search and
  rewrite over Tree-sitter syntax trees, including visible diffs and interactive
  application. It is a candidate for deterministic, grammar-backed source edits, not
  a replacement for semantic symbol resolution or Humanify-style scope-aware rename
  handling. Prototype only against exact source hashes and verify the resulting
  references with language-specific tooling.
- [Joern](https://github.com/joernio/joern) models code as a queryable Code Property
  Graph across source, bytecode, and selected binary formats. Compare its graph schema
  and query vocabulary with REAmon's observation contracts. Do not add a second
  authoritative graph store; import evidence through an adapter, preserve provider
  provenance, and independently validate exact language/format coverage and licenses.
- [angr](https://github.com/angr/angr) is a BSD-2-Clause binary-analysis framework
  for CFG recovery, symbolic execution, and data-dependency questions. It is a strong
  optional analysis provider for bounded queries, not an always-on decompiler; path
  explosion, dependency size, initial-state assumptions, and timeout limits must be
  part of each stored result.
- [Oxidizer](https://github.com/sefcom/oxidizer) is a Rust-aware decompiler built on
  angr; its README says the work has merged into angr. The documented pipeline runs
  CFG and calling-convention recovery, Rust compiler/library recovery, versioned type
  database loading, type-aware simplification, then structured Rust pseudocode
  generation. It targets Rust cleanup, type inference, enums, `Option`/`Result`,
  macros, and `match` / `if let` / `?` structure. This is the leading Rust-specific
  comparison candidate. REAmon wires it as an optional isolated provider that
  stores per-function output separately from Ghidra. The analyzer pins the maintained
  angr release at `10.0.4` in its own `uv.lock` and uses the published binary wheels,
  avoiding the archived snapshot's source build of PyVEX. Compare with Ghidra on compiler-versioned,
  optimization-level, architecture, stripped/debug, and real-world Rust fixtures.
  Persist recovered constructs and run provenance, and retain the raw binary and
  alternate output because pseudocode is not proof of compilable or equivalent Rust.
  The upstream [Oxidizer evaluation framework](https://github.com/sefcom/oxidizer-eval)
  is a useful source of comparison metrics for conciseness, fidelity, and type
  recovery; REAmon still needs its own reproducible fixture results.
- [unluac-rs](https://github.com/x3zvawq/unluac-rs) is an MIT-licensed Rust
  library/CLI that advertises Lua 5.1–5.5, LuaJIT 2.1, and Luau support. REAmon now
  uses its pinned JS/WASM package for Lua 5.5 and raw Luau, with strict generation,
  function/CFG evidence, dialect identity, and configurable Luau vector constructors.
  The advertised matrix remains unverified by REAmon fixtures; compare per-dialect
  recovery and malformed-input behavior before extending it to more dialects or
  replacing the existing LuaJIT provider.
- [Disrobe](https://github.com/1-3-7/disrobe) publishes a useful breadth catalog of
  bytecode formats, packers, obfuscators, and static recovery passes, and exposes an
  MCP investigation workflow. Its current source-available license requires a paid
  license for company use, so REAmon must not copy, bundle, or depend on it. Use the
  catalog only to discover gaps, then research and license each underlying engine
  independently.

The portfolio prioritizes upstream reuse by gap closure, not code volume. Prefer an
isolated CLI/library adapter when its license and operational boundary fit. Copying
source requires file-level license review, retained notices, and dependency checks;
for large frameworks, evaluate maintenance, binary size, parser/decompiler fidelity,
and fixture results before adoption.

## Reuse rules for REAmon

- Prefer calling a mature engine through a narrow adapter over copying its
  parser, decompiler, or disassembler into REAmon.
- Store engine identity, version, input artifact hash, output references, and
  warnings with each run so later AI work can cite the evidence it used.
- Keep the function graph analyzer-neutral: emit stable code-unit entities and
  explicit `calls` relationships into the project store. Scope graph and AI
  neighbor lookups to the same task, provider, and imported artifact; render
  only relationships the analyzer actually resolved. Indirect or unresolved
  targets should remain explicit unknowns instead of guessed edges.
- Treat decompiler output, engine-generated renames, AI drafts, and reviewed
  maintained source as distinct states. Only reviewed maintained source should
  become trusted project-wide naming evidence.
- Scope symbol evidence to the exact imported artifact hash. When a project
  contains multiple versions, show the active binary's evidence first and keep
  older hashes distinct instead of merging same-named units.
- Keep AI rewrites small enough to compare with the original source and bytecode.
  Where a project can be rebuilt, run its actual compiler/checker and preserve
  earlier successful matches when evaluating a new change.
- Before copying source, confirm the exact file's license and retain its notices.
  Prefer subprocess/MCP boundaries when a useful engine has a license that does
  not fit REAmon's distribution model.

## REA MCP workflow audit

REA's current README describes MCP findings as evidence-bearing objects and its
function dossiers combine provider-produced pseudocode and assembly with CFG, calls,
references, strings, and limitations. REAmon's first database-backed counterpart is
`workspace_list_code_units` plus `workspace_get_code_unit`: it reads only the active
workspace and same-task observations, returning bounded source/disassembly, provider
identity, artifact hash, warnings, and saved call edges. Source, names, and prototypes
remain attributed to the producing provider. No missing relationship or symbol is
filled by model inference. Add exact xrefs and CFG context to this surface only when a
provider has persisted those facts.

## decomp.wtf source audit

The source was inspected at commit `575b4a30ed481ff5497dfb9ce4f599368a95a04a`,
the repository's final commit before it was archived on 2026-10-15. Its README
describes the end-to-end loop: agents take distinct functions, receive assembly,
related data, callers, machine drafts, and earlier notes; every attempt is built
with the target compiler and judged; misses return an instruction diff; matches
are saved and shared; and regression guards protect previous matches. This process
is the highest-priority reference for REAmon's next workflow work, ahead of adding
more isolated engines. Its execution and persistence code is tightly coupled to ROM
projects, local compiler toolchains, and a SQLite coordinator. REAmon should adapt
the contracts rather than replace its PostgreSQL-backed project records with that
store.

- `src/decompnet/server.py` shows small MCP operations for claiming one function,
  reporting attempts, shared notes, and live status. Map that lifecycle to
  REAmon tasks, evidence, drafts, approvals, and activity rather than transplanting
  its room server.
- `src/decompnet/store.py` persists function claims, attempts, context versions,
  symbols, and events in SQLite. These entities clarify useful project memory,
  but REAmon already has corresponding Prisma/PostgreSQL models and must keep one
  authoritative record set.
- `src/decompnet/similarity.py` ranks MIPS/Thumb code by normalized mnemonic
  frequency, then uses Python's `SequenceMatcher` to compare instruction order.
  REAmon stores bounded operand-free mnemonic signatures for Ghidra, WABT,
  JADX, ILSpy, and Androguard DEX methods, prefilters by length and mnemonic
  frequency, then compares
  matching instruction blocks across completed project runs for the same
  provider. Ghidra matches across artifacts require an exact processor-language
  ID. DEX matches retain their owning class and analysis task; method-level
  Android rewrites map matched method observations back to class records before
  loading reviewed-source and naming context. Syntax-aware method outlines are
  cached against the exact source hash so matching excerpts can be supplied
  without repeating whole class files. Keep the score as a navigation lead,
  never as behavioral validation.
- `compiler.py`, `scoring.py`, and the project adapters judge output with the
  target game's original compiler and byte comparison. That is excellent for
  reproducibly built targets but does not directly validate arbitrary Android
  Java or native artifacts.

## Source references

- [decomp.wtf workflow, license, and archive notice](https://github.com/i12bp8/decomp.wtf)
- [decomp.wtf README workflow and guardrails](https://github.com/i12bp8/decomp.wtf/blob/575b4a30ed481ff5497dfb9ce4f599368a95a04a/README.md)
- [decomp.wtf audited source snapshot](https://github.com/i12bp8/decomp.wtf/tree/575b4a30ed481ff5497dfb9ce4f599368a95a04a/src/decompnet)
- [decomp.wtf instruction-sequence similarity implementation](https://github.com/i12bp8/decomp.wtf/blob/575b4a30ed481ff5497dfb9ce4f599368a95a04a/src/decompnet/similarity.py)
- [FunctionSimSearch design and precision/recall discussion](https://github.com/googleprojectzero/functionsimsearch/blob/master/doc/01-motivation-and-overview.md)
- [FunctionSimSearch license and archived repository](https://github.com/googleprojectzero/functionsimsearch)
- [DecBench metrics and evaluation pipeline](https://github.com/Noelo-Lab/decbench)
- [JADX 1.5.6 CLI options](https://github.com/skylot/jadx/blob/v1.5.6/jadx-cli/src/main/java/jadx/cli/JadxCLIArgs.java)
- [jadx-headless-mcp tools and license](https://github.com/1013503897/jadx-headless-mcp)
- [REA architecture and Android analysis](https://github.com/morluto/rea)
- [REA native analysis surface and function dossier workflow](https://github.com/morluto/rea#what-you-can-analyze)
- [REA project workflow, evidence and limitations](https://github.com/morluto/rea#how-rea-works)
- [Androguard v5 overview](https://github.com/androguard/androguard)
- [Androguard dex-decompiler Python API and build requirements](https://github.com/androguard/dex-decompiler/blob/d458efd15d74351e83f4e8968c75ef17c71f3c65/dex-decompiler-py/README.md)
- [Androguard dex-decompiler pinned source and Cargo.lock](https://github.com/androguard/dex-decompiler/tree/d458efd15d74351e83f4e8968c75ef17c71f3c65)
- [Androguard dex-parser dependency pinned by REAmon's corrected lock](https://github.com/androguard/dex-parser/tree/a26a4217d1397abe7865d345594873df7418578d)
- [Androguard dex-decompiler engine, CFG, xref, rename API, and Apache license](https://github.com/androguard/dex-decompiler)
- [Redress stripped-Go analysis and license](https://github.com/goretk/redress)
- [Apktool 3.0.3 release and checksum](https://apktool.org/blog/2026/2026-07-19-release-303.md)
- [angr](https://github.com/angr/angr)
- [Frida core](https://github.com/frida/frida-core)
- [Ghidra developer guide](https://github.com/NationalSecurityAgency/ghidra/blob/master/DevGuide.md)
- [capa capability extraction and Ghidra integration](https://github.com/mandiant/capa)
- [capa v9.4.0 installation and Ghidra backend requirements](https://github.com/mandiant/capa/blob/v9.4.0/doc/installation.md)
- [capa v9.4.0 function-restricted analysis](https://github.com/mandiant/capa/blob/v9.4.0/doc/usage.md)
- [capa license](https://github.com/mandiant/capa/blob/master/LICENSE.txt)
- [decomp.wtf archive notice and maintainer explanation](https://github.com/i12bp8/decomp.wtf)
- [decomp.me compiler matching application and MIT license](https://github.com/decompme/decomp.me)
- [objdiff object comparison tool, supported architectures, and dual license](https://github.com/encounter/objdiff)
- [ast-grep structural search/rewrite project](https://github.com/ast-grep/ast-grep)
- [ast-grep rewrite documentation](https://github.com/ast-grep/ast-grep.github.io/blob/main/website/guide/rewrite-code.md)
- [Joern code property graph project](https://github.com/joernio/joern)
- [angr analysis framework and BSD-2-Clause license](https://github.com/angr/angr)
- [Oxidizer Rust decompilation project, angr merge notice, and BSD-2-Clause license](https://github.com/sefcom/oxidizer)
- [angr repository where Oxidizer is maintained](https://github.com/angr/angr)
- [unluac-rs multi-dialect Lua decompiler and MIT license](https://github.com/x3zvawq/unluac-rs)
- [Disrobe recovery catalog and current source-available license](https://github.com/1-3-7/disrobe)
- [RetDec maintenance status](https://github.com/avast/retdec)
- [Rizin-powered Cutter UI and GPL-3.0 license](https://github.com/rizinorg/cutter)
- [rev.ng repository and component licenses](https://github.com/revng/revng)
- [Reko repository and GPL-2.0 license](https://github.com/uxmal/reko)
- [Tree-sitter Language Pack](https://github.com/xberg-io/tree-sitter-language-pack)
- [APKLab license and workflow](https://github.com/APKLab/APKLab)
- [Rizin license information](https://github.com/rizinorg/rizin/blob/dev/DEVELOPERS.md)
- [ToCode export format, folder linking, backends, and MIT license](https://github.com/buzzer-re/ToCode)
- [Glaurung project, supported analyses, experimental decompiler, and Apache-2.0 license](https://github.com/mjbommar/glaurung)
