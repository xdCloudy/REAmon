# REAmon reference portfolio

This portfolio records external projects that can speed up REAmon. Each reference
has a specific job: reuse an engine through an adapter, learn a workflow, or compare
outputs. It does not mean REAmon has integrated or validated that project. Before
shipping copied code or binaries, confirm the exact version, component license,
dependencies, and notices.

The detailed source audit, current integration notes, and license constraints are in
[upstream reuse](REAMON_UPSTREAM_REUSE.md). The portfolio below is the short list for
product and engineering planning.

## Priority references

| Priority and reference | What it contributes | Why REAmon references it | What REAmon should adapt | Limits and status |
| --- | --- | --- | --- | --- |
| **P0 workflow: [decomp.wtf](https://github.com/i12bp8/decomp.wtf)** | Bounded function claims, assembly and neighbor context, saved attempts, target-compiler feedback, match promotion, and regression protection. | It demonstrates a disciplined path from machine code to maintainable source, with evidence and measurable acceptance. | Make each function/method/class a persisted work unit; provide scoped evidence and project memory; retain every attempt; validate with the strongest available language-specific method; promote reviewed results without overwriting provider output. | Archived project specialized for reproducibly rebuilt targets. Adapt its workflow, not its game-specific compiler, SQLite store, or whole application. Highest workflow priority. |
| **P0 coordination: [decomp-agents](https://github.com/swstegall/decomp-agents)** | Isolated worktrees, atomic per-function claims, bounded workers, audit logs, and human escalation for merge conflicts. | It shows how parallel work can avoid duplicate or conflicting changes when the target has a reliable grader. | Later, add leases over REAmon unit IDs, attempt caps, conflict-aware source promotion, resumable workers, and auditable merge/escalation records. | Coupled to meteor-decomp, Claude SDK, and a specific legacy toolchain. Reuse coordination ideas only after REAmon's unit lifecycle and validator contracts are stable. |
| **P0 safe source edits: [Humanify](https://github.com/jehna/humanify)** | LLM-suggested JavaScript identifier names applied through scope-aware AST transforms. | It separates uncertain AI suggestions from deterministic source edits, reducing accidental syntax and reference damage. | Have models propose symbol mappings with evidence and confidence; apply accepted renames through language-aware AST/refactor APIs; retain diffs and undo history. Extend the pattern across language providers. | JavaScript-focused and identifier-renaming-focused. Its output is not semantic proof and should not be copied as a universal source transformer. |
| **P0 universal parsing: [Tree-sitter](https://github.com/tree-sitter/tree-sitter)** | Error-tolerant syntax trees and a broad set of language grammars. | Shared syntax tooling can support navigation, unit boundaries, safe edit scopes, and syntax checks across many source languages. | Use syntax trees to identify declarations and validate structure; add language-specific symbol resolution and compiler checks where available. | Grammar availability is not decompiler support. Parser and grammar licenses/notices vary; a parseable tree does not establish behavior or idiomatic recovery. |
| **P1 Python comparison: [PyLingual](https://github.com/syssec-utd/pylingual)** | A CPython bytecode decompiler with cross-version reconstruction techniques and a local CLI. | Compare reconstruction quality with the currently integrated pycdc path on a versioned, reproducible fixture set. | Build a provider comparison harness; record Python bytecode version, structural recovery, parse/compile results, warnings, and resource use; make alternate provider output reviewable. | GPL-3.0 and model/runtime requirements need distribution review. Upstream notes local control-flow accuracy may differ from its hosted service. Candidate for comparison, not a default replacement. |
| **P1 WebAssembly bridge: [WABT `wasm2c`](https://github.com/WebAssembly/wabt/tree/main/wasm2c)** | Converts a WebAssembly module into equivalent C source and a header, plus a runtime interface. | It can give the current WAT-level view a useful higher-level, compilable representation for analysis and navigation. | Offer generated C as a clearly labeled semantic bridge; preserve the original Wasm, names, module structure, and runtime dependency; test equivalence against the Wasm engine. | Generated C represents Wasm semantics and runtime mechanics, not the original C/C++/Rust/AssemblyScript source. REAmon currently uses WABT for low-level WAT/function navigation. |
| **P1 native comparison: [rev.ng](https://github.com/revng/revng) and [Reko](https://github.com/uxmal/reko)** | Alternative native decompilation approaches, architecture coverage, structured models, and C-like output. | Independent engines can expose Ghidra blind spots and help compare function boundaries and source quality across native fixtures. | Prototype isolated, optional adapters for selected architectures; compare normalized output, function coverage, type recovery, buildability, runtime, and provenance against Ghidra. | Both have GPL-family distribution considerations and substantial toolchain/runtime footprints. Evaluate exact components and licenses before bundling; avoid redundant default analysis. |
| **P1 language-specific engines: [JADX](https://github.com/skylot/jadx), [ILSpy](https://github.com/icsharpcode/ILSpy), [webcrack](https://github.com/j4k0xb/webcrack), [pycdc](https://github.com/ejfkdev/pycdc), [unluac](https://github.com/Jeong-Min-Cho/unluac), and [LuaJIT Decompiler](https://github.com/marsinator358/luajit-decompiler-v2)** | Mature format-specific decompilers, deobfuscators, and source reconstruction. | Language-specific tools generally recover more useful structure than one generic native pseudocode engine. | Keep REAmon's existing isolated providers; record source hash, engine/version, warnings, output lineage, and validator evidence; compare alternate providers on fixtures before promoting support. | These are distinct input families and maturity levels, not one shared guarantee. Current integration and caveats are recorded in the [language matrix](REAMON_LANGUAGE_MATRIX.md). |
| **P2 runtime evidence: [Frida](https://github.com/frida/frida-core) and [Qiling](https://github.com/qilingframework/qiling)** | Instrumentation or emulation for observing behavior in a controlled runtime. | Dynamic traces can answer questions static output cannot, such as runtime-selected paths, resolved calls, or data transformations. | Add opt-in session adapters that attach traces to exact artifact hashes, environment details, and reproducible test inputs; link observations back to functions and hypotheses. | Runtime behavior is sample- and environment-dependent. These tools provide evidence, not source recovery; isolation and component licenses need review. |

## Adoption order

1. Finish the decomp.wtf-inspired per-unit lifecycle in REAmon's own project database:
   claim/ownership, bounded context, attempt history, validator outcomes, review, and
   promotion. Keep engine output and maintained source separate.
2. Establish a language/provider fixture harness and source-edit contracts. Apply
   Humanify's model-suggests / AST-applies pattern where a grammar and refactor engine
   exist.
3. Compare language engines where REAmon has a material fidelity gap, beginning with
   Python bytecode and WebAssembly, then architecture-specific native comparisons.
4. Add dynamic evidence once static work units, evidence identity, and provenance are
   stable enough to join runtime traces reliably.

Do not prioritize a reference because it is popular alone. A proposed reuse should
close a named language, workflow, validation, or usability gap and pass a fixture-based
comparison. Track decisions and revisions in the [upstream reuse audit](REAMON_UPSTREAM_REUSE.md).
