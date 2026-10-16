# REAmon upstream reuse notes

REAmon should reuse mature reverse-engineering engines and adapt their evidence,
validation, and collaboration workflows to its project database. Engine output,
AI drafts, accepted maintained source, and validation results must remain
separate so a plausible name is never treated as proof of behavior.

## Current direction

| Project | Useful contribution | REAmon direction | Constraints |
| --- | --- | --- | --- |
| [decomp.wtf](https://github.com/i12bp8/decomp.wtf) | Its MIT-licensed codebase is a useful donor for the local MCP workflow, function-sized jobs, shared naming, progress map, and guarded edit/validation loop. Its look-alike matcher prefilters by instruction-mnemonic frequency, then compares ordered instruction sequences. | REAmon's function map takes the selectable function-tile overview as a visual cue, restyled with REAmon design tokens, status colors, and database-backed state. It merges analyzer-emitted functions and persisted Tree-sitter member outlines as selectable, language-neutral entries linked to their containing source unit; code-unit totals and coverage remain based on analyzer units. Ghidra native functions, WABT WebAssembly functions, JADX Smali methods, and ILSpy CLR methods persist bounded mnemonic sequences. The similarity view and rewrite context compare deduplicated functions across completed project runs for the same provider. Ghidra cross-artifact matches require the same exact processor-language ID; all candidates remain tentative and are labeled with their sequence score. Continue adapting its workflow contracts where useful, keep REAmon's database authoritative, scope edits to a function/method, and attach concrete bytecode/call-graph evidence. When a target has a reproducible build, reject a change if it breaks earlier verified functions. | Archived on 2026-10-15: no upstream fixes or releases. Exact-byte judging depends on the original compiler/linker and build, so it cannot be assumed for arbitrary APKs. Similarity is a lead for inspection, not evidence that two functions share behavior. |
| [JADX](https://github.com/skylot/jadx) | APK/DEX to Java, Smali-adjacent analysis, built-in short-name cleanup, and mapping support. | Continue using the pinned analyzer. The existing Baksmali output now supplies direct method-call edges with descriptor identities for REAmon's generic function graph; method nodes link back to the containing Java or Smali class. Keep the Smali as evidence and treat generated names as provisional. | Apache-2.0. `--deobf` is off by default in the CLI; the installed 1.5.6 CLI supports it. |
| [ILSpy](https://github.com/icsharpcode/ILSpy) | .NET assembly decompilation and an IL disassembly mode (`--ilcode`) in the same pinned command-line engine. IL opcodes retain language-neutral method evidence when C# source is unavailable or misleading. | The isolated ILSpy analyzer now extracts bounded CLR opcode sequences and attaches function observations to their C# type. The project-wide matcher and same-artifact method-rewrite context use those persisted features, following the decomp.wtf frequency-plus-order approach. Keep decompiled C# as the editable source and IL as supporting evidence. | MIT. `ilspycmd` 11.1 exposes `--ilcode`; IL listing extraction is separately time- and size-bounded so it cannot invalidate successful C# decompilation. |
| [jadx-headless-mcp](https://github.com/1013503897/jadx-headless-mcp) | Direct `jadx-core` access for one-method source/Smali, class summaries, and method/field cross-references through MCP. | Strong next candidate for method-scoped source retrieval and exact xref evidence. Compare its lazy per-method path with the existing whole-run export before adding it; REA already uses this engine adapter. | Apache-2.0; pin its release and track its own bundled dependency notices. |
| [REA](https://github.com/morluto/rea) | One CLI/MCP workflow that returns evidence-bound findings across multiple engines and binary formats. | Study its adapter/result contracts when adding external RE tools. Keep REAmon's project persistence and review state authoritative; avoid duplicating analyzer engines REAmon already hosts. | MIT-authored code. Android analysis still requires its headless JADX/JDK setup; package runtime requires Node 22.19+, while REAmon's webapp currently supports Node 20+. |
| [Androguard](https://github.com/androguard/androguard) | Android manifest/DEX metadata, method-level disassembly and CFGs, cross-references, patching, optional method decompilation, and typed MCP tools. | Evaluate its method CFG and reference output as independent evidence against JADX/Smali. The upstream v5 README currently describes a checkout-based release with sibling Rust-backed packages and optional extras; wait for a reproducible, pinned package set before adding it to the analyzer image. If adopted, keep APK metadata parsing usable without native CFG/decompiler extras. | Apache-2.0 for the app; companion packages have their own licenses and runtime requirements. |
| [Androguard dex-decompiler](https://github.com/androguard/dex-decompiler) | Rust DEX-to-Java decompilation; the Python API exposes per-method bytecode and CFGs, string/method/field xrefs, callers, and explicit package/class/method/field/variable rename maps. Its fast `findrefs` and single-class paths can avoid decompiling an entire APK for one question. | Highest-priority Android engine comparison. Build a pinned, isolated prototype that runs beside JADX and records engine/version/input hash on every output. Compare a fixed set of methods for source readability, CFG and xref agreement, runtime/RSS, then expose the best provider output as an alternate decompilation while keeping JADX source intact. Treat AI-proposed renames as drafts; only reviewed project mappings should be passed to `decompile_with_renames`. Reuse its CFG and xref API for navigable method evidence before adopting its decompiler as a default. | Apache-2.0. The upstream Python bindings currently document source builds with Rust and maturin, not a published wheel or pinned release; resolve and pin a tested commit and its Cargo lockfile before bundling. |
| [Apktool](https://github.com/iBotPeaches/Apktool) | Decodes the binary manifest and Android resources into an editable project tree and can rebuild APKs after Smali/resource edits. | The JADX analyzer invokes pinned Apktool 3.0.3 for APKs, indexes decoded text resources beside JADX Java and Baksmali Smali, and preserves the full decoded project under the analysis run. The authenticated rebuild route applies saved Android resource and Smali edits from project memory, resolves Smali by its class descriptor across multidex folders, then stores the unsigned APK path, hash, and build record in REAmon observations. Saved maintained Java remains separate and is not compiled back into DEX. | Apache-2.0. Apktool 3.0.3 rebuilds unsigned APKs; some vendor-modified APKs cannot be rebuilt. |
| [Ghidra](https://github.com/NationalSecurityAgency/ghidra) | Mature multi-architecture disassembly, decompilation, graphing, and automation APIs. | Continue the existing isolated analyzer integration and prefer its structured function, caller/callee, and disassembly evidence over asking an LLM to infer those facts. | Apache-2.0 for the main project; standalone GPL support programs and module dependencies keep their own notices. |
| [pycdc](https://github.com/ejfkdev/pycdc) | Small MIT-licensed CLI for reconstructing Python source from `.pyc` and `.pyo` bytecode. | REAmon now has an isolated analyzer provider for Python bytecode. It stores source output in the run’s derived artifacts and indexes the module so source outlines and member-scoped maintenance can use it. Keep the original bytecode as evidence, retain engine version and warnings, and treat reconstructed source as a draft until reviewed. Validate it against representative fixtures before treating broad upstream version claims as REAmon support. | v0.6.0 advertises Python 2.0–3.15, while the release verification described upstream covers 2.6–3.14. REAmon has not yet validated this matrix. PyLingual remains a higher-resource alternative for comparison; its GPL-3.0 license and ML stack need separate distribution and runtime evaluation. |
| [capa](https://github.com/mandiant/capa) | Rule-based capability detection for executable files and sandbox reports; the v9.4.0 Ghidra backend can reuse Ghidra/PyGhidra function features. | Keep as an optional native-analysis candidate for function-level behavior labels in the map and AI context. REAmon's Ghidra integration already requires Ghidra 12+, but capa's backend would perform another analysis pass; prototype it as an explicit enrichment so it does not slow every decompilation. Keep each match linked to its rule, function address, and analyzer/rule versions; treat matches as hypotheses, never recovered identifiers or proof of behavior. | Apache-2.0 tool; rules are separately maintained and must retain their own notices. The Ghidra backend adds Python/JVM packaging and runtime cost. It applies to supported native executables, not decompiled Java source itself. |
| [Tree-sitter](https://github.com/tree-sitter/tree-sitter) | Error-tolerant concrete syntax trees and language grammars that can identify declarations without guessing from comments or string literals. | Maintained-source saves, repository navigation, and bounded unreviewed-draft context use syntax-aware symbol indexing. REAmon outlines and one-member rewrites use the pinned Tree-sitter Language Pack so grammar lookup can extend beyond the former 15-language allowlist. Original-source member outlines remain run-, parent-, and source-hash-bound observations and include the parser version. The user-selected function is still checked against the exact stored source range and declaration before AI rewriting; recognized node names alone never count as semantic validation. | The language pack is MIT-licensed and its parser binaries are cached on demand. Each downloaded grammar retains its own upstream license and notices; review those before redistributing cached parser binaries. |
| [angr](https://github.com/angr/angr) | Python framework for CFG recovery, data-dependency analysis, symbolic execution, and decompilation across native architectures. | Optional native-analysis provider for path and dataflow evidence when Ghidra’s static output leaves a concrete unanswered question; make expensive emulation opt-in and persist its constraints and limits. | BSD-2-Clause; broad dependency stack and symbolic-execution cost make this a targeted provider, not a default analyzer. |
| [Frida](https://github.com/frida/frida-core) | Dynamic instrumentation, process discovery, and two-way script communication across language bindings. | Future runtime-evidence adapter for a user-controlled device/emulator: tie traces to an exact artifact hash and target session, then persist observations alongside static evidence. | Package/component licenses vary; review the exact Frida component and pinned binary distribution before bundling. Requires a connected runtime/device, so it is separate from offline import. |
| [APKLab](https://github.com/APKLab/APKLab) | Practical APK edit/rebuild workflow assembled from Apktool, JADX, Smali language tooling, signing, and Git. | Use as a workflow reference for a future source-to-rebuild loop: export maintained source, rebuild where dependencies permit, preserve a diff, and report signing/build results separately. | Current project is AGPL-licensed; prefer workflow learning or an external integration unless REAmon deliberately adopts the license obligations. |
| [Rizin](https://github.com/rizinorg/rizin) | Additional native RE engine and scripting ecosystem. | Treat as an optional external provider behind REAmon's analyzer contract, not code to vendor into the core. | Mixed LGPL-3.0/GPL-3.0 components; check the specific component before reuse. |
| [Redress](https://github.com/goretk/redress) | Go-specific recovery of package, type, and symbol information from stripped Go executables, with standalone and radare2 modes. | Evaluate as an optional Go-binary enrichment adapter: store recovered symbols and package metadata as evidence linked to the exact binary hash, while leaving disassembly/decompilation to Ghidra. Its focused Go runtime metadata recovery can complement generic native analysis where stripped names leave poor function labels. | AGPL-3.0; prefer a documented external executable integration or user-supplied installation unless REAmon intentionally accepts the distribution obligations. |

## Additional engines evaluated

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
- [Reko](https://github.com/uxmal/reko) provides a .NET CLI for decompilation,
  disassembly, and executable inspection across architecture and file-format
  plugins. It is a GPL-2.0 candidate for an opt-in comparison on architectures or
  formats where REAmon has weak Ghidra coverage; validate exact fixture support and
  distribution requirements before bundling it.

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

## decomp.wtf source audit

The source was inspected at commit `575b4a30ed481ff5497dfb9ce4f599368a95a04a`.
It is valuable as a workflow and MCP-tool reference, but its execution and
persistence code is tightly coupled to ROM projects, local compiler toolchains,
and a SQLite coordinator. REAmon should adapt the contracts rather than replace
its PostgreSQL-backed project records with that store.

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
  JADX, and ILSpy, prefilters by length and mnemonic frequency, then compares
  matching instruction blocks across completed project runs for the same
  provider. Ghidra matches across artifacts require an exact processor-language
  ID. Keep the score as a navigation lead, never as behavioral validation.
- `compiler.py`, `scoring.py`, and the project adapters judge output with the
  target game's original compiler and byte comparison. That is excellent for
  reproducibly built targets but does not directly validate arbitrary Android
  Java or native artifacts.

## Source references

- [decomp.wtf workflow, license, and archive notice](https://github.com/i12bp8/decomp.wtf)
- [decomp.wtf audited source snapshot](https://github.com/i12bp8/decomp.wtf/tree/575b4a30ed481ff5497dfb9ce4f599368a95a04a/src/decompnet)
- [decomp.wtf instruction-sequence similarity implementation](https://github.com/i12bp8/decomp.wtf/blob/575b4a30ed481ff5497dfb9ce4f599368a95a04a/src/decompnet/similarity.py)
- [JADX 1.5.6 CLI options](https://github.com/skylot/jadx/blob/v1.5.6/jadx-cli/src/main/java/jadx/cli/JadxCLIArgs.java)
- [jadx-headless-mcp tools and license](https://github.com/1013503897/jadx-headless-mcp)
- [REA architecture and Android analysis](https://github.com/morluto/rea)
- [Androguard v5 overview](https://github.com/androguard/androguard)
- [Androguard dex-decompiler Python API and build requirements](https://github.com/androguard/dex-decompiler/blob/main/dex-decompiler-py/README.md)
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
- [Tree-sitter Language Pack](https://github.com/xberg-io/tree-sitter-language-pack)
- [APKLab license and workflow](https://github.com/APKLab/APKLab)
- [Rizin license information](https://github.com/rizinorg/rizin/blob/dev/DEVELOPERS.md)
