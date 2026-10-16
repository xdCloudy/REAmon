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
| Android DEX / APK, including Kotlin bytecode | Usable through JADX | Java-like output, Smali evidence, method/call relationships, resources, and selected APK rebuild paths. | Kotlin idioms are not reconstructed as Kotlin. Android CFG/xref alternate providers are under evaluation. |
| C# / managed .NET (`.dll`, `.exe`) | Usable | ILSpy C# output and IL-derived method evidence. | Original comments/formatting; original Visual Basic or F# syntax; full behavioral equivalence. |
| Native ELF / PE / Mach-O | Partial | Ghidra functions, disassembly, call relationships, and C-like pseudocode for supported architectures. GoReSym adds Go metadata where found. | Pseudocode is not recovered original source. Optimized/stripped code, type recovery, templates, and language idioms remain difficult. |
| WebAssembly (`.wasm`) | Low-level | WABT WAT/disassembly and function navigation. | High-level source reconstruction and original names may be unavailable. |
| Python bytecode (`.pyc`, `.pyo`) | Early | Isolated pycdc output indexed for source browsing and member-scoped maintenance. | Version and control-flow fidelity need fixture validation; PyInstaller extraction and bytecode rebuild are not integrated. |
| Standard Lua bytecode (`.luac`) | Early | Isolated unluac provider for Lua 5.0–5.4. | Local names can be stripped; custom VMs and complex control flow need validation. |
| LuaJIT bytecode | Early | Separate isolated LuaJIT decompiler provider. | Version/variant coverage and recovered-name fidelity need representative fixtures. |
| Lua 5.5 bytecode | Early | Isolated unluac-rs 1.3.1 analyzer, selected by the Lua 5.5 bytecode header and configured for strict source generation. | The upstream project describes itself as still in a testing phase. Versioned fixtures and independent source validation are still required; diagnostic pseudocode is rejected. |
| Luau bytecode | Planned evaluation | No integrated REAmon provider currently claims this dialect. | The [unluac-rs](https://github.com/x3zvawq/unluac-rs) WASM/JS API advertises Luau, but REAmon has not validated its bytecode detection or output. Keep Luau source navigation separate from compiled-chunk recovery. |
| JavaScript bundles (`.js`, `.jsx`, `.mjs`, `.cjs`) | Early | webcrack unminification, selected obfuscator reversal, and bundle-module extraction. | Not guaranteed original source/behavior; fixture coverage and edge-case sandbox validation remain. |
| TypeScript bundles / JavaScript runtime bytecode | Planned evaluation | Existing source navigation can outline TypeScript when a grammar is available. | No dedicated TypeScript bundle deobfuscator or JavaScript bytecode decompiler is integrated. |
| Go source reconstruction | Planned | Go binaries can receive generic Ghidra pseudocode and GoReSym names, package/version/type metadata. | GoReSym metadata does not reconstruct maintainable Go source. |
| Rust | Planned / partial native pseudocode | Ghidra can process supported native targets. | Rust demangling, metadata, type/ownership recovery, and Rust-idiomatic source reconstruction. [Oxidizer](https://github.com/sefcom/oxidizer) reports Rust-aware pseudocode techniques and says it has merged into angr; evaluate it against pinned Rust fixtures before treating it as support. |
| Swift / Objective-C | Planned / partial native pseudocode | Ghidra can process supported native targets. | Runtime metadata, class/protocol recovery, idiomatic source, and framework-specific analysis. |
| Native C and C++ | Partial native pseudocode | Ghidra decompilation and address-aware function evidence. | Original project structure, macros, templates, types, and source-level semantics; toolchain matching is format/project-specific. |
| Other source languages | Source navigation only where grammar support exists | Tree-sitter outlines and bounded member-scoped source edits. | Parsing an existing source file is not decompiling its compiled form; validators vary by language. |

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
and [upstream reuse](REAMON_UPSTREAM_REUSE.md) for engine decisions. The current
Rust and Lua projects linked above are evaluation candidates, not integrated REAmon
providers; their upstream feature claims require fixture-backed validation here.
