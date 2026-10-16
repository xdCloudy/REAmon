# REAmon language and format support matrix

This is the detailed, current-state ledger. The README keeps a shorter WIP summary and
links here. Status describes REAmon integration, not everything an upstream tool can
do. “Planned” means an area to evaluate; it has no delivery date.

## Long-term fluency target

REAmon aims for high practical fluency across all major language families. That means
language-aware unit recovery, readable editable output, consistent project-wide
symbols, and validation appropriate to each toolchain—not merely emitting C-like
pseudocode. The portfolio should include at least native C/C++, Java, Kotlin, C#,
Visual Basic and F#, Python, JavaScript, TypeScript, Go, Rust, Swift, Objective-C,
PHP, Ruby, Lua, WebAssembly toolchains, and assembly across the architectures REAmon
declares supported. Coverage can grow in phases; the matrix must show its actual
state for every family and relevant input format.

“100% fluency” is a product ambition, not a promise of exact original-source
reconstruction. Compilation, optimization, stripping, and obfuscation can erase
comments, local names, formatting, types, or other information, and some behaviors
cannot be distinguished from a static artifact alone. REAmon should make its ambition
measurable along these dimensions:

| Dimension | Evidence required before claiming strong support |
| --- | --- |
| Input coverage | Explicit compiler/runtime versions, bytecode or binary formats, architectures, and known unsupported cases. |
| Unit and symbol recovery | Fixture-backed function/class/module coverage, stable identities, and confidence for names, types, and relationships. |
| Source quality | Language-specific readable output with preserved semantics where evidence permits; generated bridge languages are labeled as such. |
| Safe maintenance | Syntax-aware member edits, project-wide rename consistency, and preserved provenance/diffs. |
| Validation | The strongest available compiler, parser, tests, differential check, or runtime evidence, with limits recorded. |
| Reliability | Versioned clean, optimized, stripped, obfuscated, and malformed fixtures where legally distributable. |

See the [reference portfolio](REAMON_REFERENCE_PORTFOLIO.md) for projects to compare
and the [upstream reuse audit](REAMON_UPSTREAM_REUSE.md) for integration status.

| Language / input | Status | Integrated path | Missing or uncertain |
| --- | --- | --- | --- |
| Java bytecode (`.class`, `.jar`) | Usable | JADX decompilation, class/method outlines, and source browsing. | Obfuscation, reflection, missing debug data, exact original formatting and comments. |
| Android DEX / APK, including Kotlin bytecode | Usable through JADX; early alternate through Androguard dex-decompiler | JADX supplies Java-like output, Smali evidence, method/call relationships, resources, and selected APK rebuild paths. The pinned Rust DEX decompiler supplies separately stored Java output, database-backed Dalvik method observations, linked bounded instruction-row artifacts for AI context, CFG summaries in the function map, capped direct call relationships, and typed field/string references in the member-reference view and AI context. | Kotlin idioms are not reconstructed as Kotlin. Instruction artifacts, CFG summaries, call edges, and references have size caps; string previews are bounded. Output quality and coverage still need fixture comparison. |
| C# / managed .NET (`.dll`, `.exe`) | Usable | ILSpy C# output and IL-derived method evidence. | Original comments/formatting; original Visual Basic or F# syntax; full behavioral equivalence. |
| Native ELF / PE / Mach-O | Partial | Ghidra functions, disassembly, call relationships, and C-like pseudocode for supported architectures. GoReSym adds Go metadata where found. | Pseudocode is not recovered original source. Optimized/stripped code, type recovery, templates, and language idioms remain difficult. |
| WebAssembly (`.wasm`) | Early decompilation bridge | WABT WAT/function navigation remains the evidence view. A pinned unwasm provider also emits bounded function-sized Rust level-0 translations, indexed to the same Wasm function addresses and stored as derived code artifacts. Source lines link to bounded raw Wasm byte ranges in the visualizer and function dossier. | Rust is a generated bridge representation, not recovered original source or idiomatic Rust. Functions are separate view snippets and may depend on module context. unwasm can reject unsupported modules; generated output is capped at 64 MiB and 90 CPU seconds, with a 512 MiB address-space limit. Byte listings are capped at 8 MiB; mapping rows are bounded. REAmon has not independently established semantic equivalence; fixture comparison and validation remain open. |
| Python bytecode (`.pyc`, `.pyo`) | Early | Isolated pycdc output indexed for source browsing and member-scoped maintenance. Long provider runs stream elapsed-time/output-size progress and enforce the output cap while the source is generated. Accepted Python source receives a non-executing CPython compile check; its validator method and source hash are stored with the review, and the running interpreter version is reported. The visualizer uses LibCST 1.9.0 scope metadata and `RenameCommand` for reviewer-selected local-variable and parameter renames, saving hash-bound output and mapping lineage. | The check only proves syntax under the running CPython version, which may differ from the bytecode target. Module-level definitions/imports are excluded from safe renaming; dynamic lookup and reflection can still affect behavior. Version and control-flow fidelity need fixture validation; PyInstaller extraction and bytecode rebuild are not integrated. |
| PHP source files | Source navigation + early syntax validation | Tree-sitter outlines and versioned `php -l` syntax checks in the agent image. | No PHP bytecode decompiler is integrated. Lint requires a PHP opening tag, and the checker version may differ from the target runtime. |
| Ruby source files | Source navigation + early syntax validation | Tree-sitter outlines and versioned `ruby -c` syntax checks in the agent image. | No Ruby bytecode decompiler is integrated; syntax acceptance does not prove behavior or match the target Ruby version. |
| Go source files | Source navigation + early syntax validation | Tree-sitter outlines and versioned `gofmt -e` parsing; the formatter output is discarded. Selected local variables and parameters can receive evidence-grounded rename proposals; reviewer-selected mappings are applied by Go AST positions resolved through `go/types` object identity, with collision checks, input/output hashes, parser version, and attempt history persisted. | The Go 1.22.10 parser may differ from the source target version. The standalone refactor currently analyzes one file, conservatively skips bindings without references, and needs fixture coverage for nested closures and package-level interactions. GoReSym recovers native binary metadata but does not decompile Go; syntax acceptance does not compile dependencies or prove behavior. |
| Standard Lua bytecode (`.luac`) | Early | Isolated unluac provider covers Lua 5.0–5.4. The separate unluac-rs output path accepts Lua 5.1–5.5 and records its detected dialect, prototype metadata, bounded per-prototype CFG summaries, and up to 800 operand-free opcode labels per prototype for same-dialect project similarity navigation and AI member context. Generated `proto#ID` comments link syntax-outlined source functions to stored prototype identities. When a maintained function carries an exact `lua5.1`–`lua5.5` dialect, its saved source is parsed by the matching checksum-pinned official `luac -p` compiler; dialect-less Lua output (including the legacy unluac provider) retains the Tree-sitter check. | Similarity is a navigation and context hint, not function identity. AI context requires a unique `proto#ID` mapping for the selected source function and a syntax outline for each candidate. Names and source structure can differ by engine; compare outputs on versioned fixtures before preferring one. Syntax acceptance proves only that the matching compiler parses the source; it does not prove behavioral equivalence. Stripped local names, custom VMs, and complex control flow need validation. |
| LuaJIT bytecode | Early | Existing isolated LuaJIT provider remains available. unluac-rs 1.4.4 emits a separately attributed strict-source alternative with dialect identity, prototype/CFG evidence, and bounded opcode sequences used only to find same-dialect candidates in the same project for visualizer navigation and AI member context. Generated `proto#ID` comments map source excerpts to persisted prototypes even if function names are stripped or duplicated. | Version/variant coverage and recovered-name fidelity need representative fixtures; output from either provider is reconstructed source, not proof of equivalence. Similarity is not identity evidence, and AI context is included only when the proto marker and syntax outline map uniquely. |
| Lua 5.5 bytecode | Early | Isolated unluac-rs 1.4.4 analyzer, selected by dialect detection and configured for strict source generation. Prototype metadata, child-prototype relationships, bounded per-prototype CFG summaries, and up to 800 operand-free opcode labels are persisted alongside the module observation and source artifact; selecting a prototype loads its CFG diagram and same-dialect function candidates, which can inform member-level AI context through generated `proto#ID` markers. | Metadata is capped at 100 prototypes and 32 blocks / 48 edges per CFG summary; CFG excerpts retain one 100-character instruction from each representation for the first six blocks, while similarity uses a separate 800-opcode cap. Larger graphs and omitted instruction excerpts are marked. The upstream project describes itself as still in a testing phase. Versioned fixtures and independent source validation are still required; diagnostic pseudocode is rejected. |
| Luau bytecode | Early integration | The same isolated unluac-rs 1.4.4 provider detects raw Luau chunks, requires strict source generation, emits `.luau` output, and persists the dialect, function prototypes, and bounded CFG summaries. Generated `proto#ID` comments map syntax-outlined functions back to stored prototypes. The Luau Tree-sitter grammar supports source outlines and member-scoped edits. On amd64 agent images, the pinned official Luau 0.742 `luau-compile --only-parse` checks saved source without executing it; other architectures fall back to Tree-sitter. Vector constants render through `vector.create` by default with three components. Set `REAMON_LUAU_VECTOR_SIZE=4` for four-component targets, or configure `REAMON_LUAU_VECTOR_LIBRARY` and `REAMON_LUAU_VECTOR_CONSTRUCTOR` for the host's constructor. The chosen constructor and width are stored with the provider observations. | Luau-specific fixture coverage and semantic fidelity are pending. Parsing does not validate target-host APIs or behavior, and the configured vector constructor must exist in the target runtime. The unluac-rs upstream describes itself as still in a testing phase. Newer or Roblox-wrapped containers are not identified as raw Luau chunks. |
| JavaScript bundles (`.js`, `.jsx`, `.mjs`, `.cjs`) | Early | webcrack unminification, selected obfuscator reversal, and bundle-module extraction. Accepted maintained source up to 512 KiB is parsed with the versioned Babel parser used for safe renames, falling back to Tree-sitter if the analyzer is unavailable. | Not guaranteed original source/behavior; fixture coverage and edge-case sandbox validation remain. |
| TypeScript bundles / JavaScript runtime bytecode | Planned evaluation | Existing source navigation can outline TypeScript; accepted TypeScript source up to 512 KiB is parsed with Babel's TypeScript and JSX grammar plugins. | No dedicated TypeScript bundle deobfuscator or JavaScript bytecode decompiler is integrated. Syntax acceptance does not establish target-version compatibility or behavior. |
| Go source reconstruction from binaries | Metadata augmentation integrated; source reconstruction planned | Go binaries can receive generic Ghidra pseudocode, GoReSym names/package/version/type metadata, bounded unstrip type details, address-matched method signatures/source locations, and itab interface-dispatch rows stored with provider provenance and exposed to rewrite context, MCP, and the selected-unit inspector. The pattern-based `godecompose` project remains an external candidate for recognized Go compiler patterns. | Neither GoReSym nor unstrip reconstructs maintainable Go source. The unstrip path is an early optional integration with no REAmon fixture comparison yet; signatures and dispatch records may be absent or incomplete, and its upstream scope is Go 1.18–1.25 on amd64/arm64. `godecompose` is experimental, amd64-only, needs symbols for high-level patterns, and is AGPL-3.0. No Go source-recovery provider is integrated or fixture-validated in REAmon. |
| Rust | Early optional integration; fixture validation pending | Ghidra can process supported native targets. The isolated Oxidizer provider adds Rust-like per-function pseudocode, code-unit addresses, and same-run call edges. Its environment pins the maintained angr package at `10.0.4`. | Compare with Ghidra across compiler versions, optimization levels, architectures, and stripped/debug fixtures. Oxidizer output is pseudocode, not verified original or behaviorally equivalent Rust. Rust-style structure may still be incomplete or incorrectly typed. |
| Swift / Objective-C | Planned / partial native pseudocode | Ghidra can process supported native targets. | Runtime metadata, class/protocol recovery, idiomatic source, and framework-specific analysis. |
| Native C and C++ | Partial native pseudocode | Ghidra decompilation and address-aware function evidence. | Original project structure, macros, templates, types, and source-level semantics; toolchain matching is format/project-specific. |
| Other source languages | Source navigation only where grammar support exists | Tree-sitter outlines and bounded member-scoped source edits. Syntax validation records the selected grammar and Tree-sitter Language Pack version with the exact source hash. | Parsing an existing source file is not decompiling its compiled form; grammar availability and syntax support do not establish behavior or target-version compatibility. |

## Status definitions

- **Usable:** a supported provider is wired into the workspace for the stated input
  class; users still need to review reconstructed output.
- **Partial / low-level:** useful navigation or an intermediate representation exists,
  but high-level maintainable source is absent or incomplete.
- **Early:** the provider is integrated but its accuracy and supported input range need
  further fixture-based validation.
- **Planned:** no integrated REAmon path currently claims the capability.

## How status should improve

Promote a row only after recording tested input versions, provider version, expected
coverage, failure modes, and applicable validators. Maintain fixtures for clean,
obfuscated, stripped, and malformed samples where licensing and distribution allow.
Do not upgrade a language from “partial” because a generic decompiler emits syntax
that resembles that language.

See [the feature matrix](REAMON_FEATURE_MATRIX.md) for cross-language product status
and [upstream reuse](REAMON_UPSTREAM_REUSE.md) for engine decisions. The Rust DEX
engine is integrated as an early alternate provider; its upstream CFG/xref features
remain evaluation targets and all accuracy claims require fixture-backed validation.
