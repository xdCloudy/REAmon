# Ruby recovery plan

This document defines REAmon's Ruby bytecode recovery direction. It separates
instruction evidence from reconstructed source so a disassembly is never presented
as a decompilation result.

## Current state

REAmon supports Ruby source outlines and a version-reported `ruby -c` syntax check.
The isolated CRuby 3.4.11 provider recognizes `YARB` ISeq artifacts, records a
bounded YARV disassembly as hash-attributed project evidence, and keeps that artifact
explicitly separate from source. It also runs a bounded, experimental source candidate
reconstructor adapted from a Ruby 2.7-focused BSD-2-Clause upstream. Only candidates
accepted by CRuby 3.4.11's syntax parser are indexed as executable source artifacts;
syntax acceptance does not establish behavior equivalence. This is not native Ruby
2.7 binary support: the current input gate and disassembler still require YARB accepted
by the integrated CRuby 3.4.11 runtime.
See the [language matrix](REAMON_LANGUAGE_MATRIX.md) for current support status and
the [upstream reuse audit](REAMON_UPSTREAM_REUSE.md) for project and license notes.

CRuby's `RubyVM::InstructionSequence` API can load and disassemble compiled
instruction sequences, and `to_a` exposes a structured but explicitly unstable
representation containing locals, parameters, catch entries, and opcode operands.
Both are MRI-specific and may change between Ruby versions. A matching MRI runtime
is part of the artifact identity. Any disassembly, structured evidence, or recovered
source must retain the exact input SHA-256, observed MRI version, ISeq header version,
provider build, and output SHA-256.

## Recovery stages

| Stage | Required result | Evidence and limits |
| --- | --- | --- |
| 1. Detect and inspect | Recognize candidate CRuby ISeq binaries without treating an extension as proof; report header and compatible runtime. | Do not load unsupported or malformed versions. Never call `eval` or execute target instructions. |
| 2. Decode | Produce a structured, bounded instruction-sequence tree with opcode, operands, source location, local table, nested sequences, and exception/catch metadata. | Implemented as bounded MRI `to_a` evidence for CRuby 3.4.11 and shown in the visualizer/MCP. This is a version-specific inspection format, not a normalized IR; retain raw disassembly and mark capped records. |
| 3. Recover control/data flow | Build version-specific basic blocks, stack effects, expression data flow, and structured branches/loops. | Early structural step: explicit YARV label markers and known branch opcodes form a bounded navigation CFG with unresolved edges marked. Stack effects, expression data flow, and loop/branch structuring remain open. |
| 4. Emit Ruby | Render a provisional source candidate and attach the provider revision, exact input/output hashes, sequence counts, and explicit warnings. | The current pattern-based upstream adapter has no per-span instruction mapping. It is experimental, Ruby 2.7-focused, and may omit or approximate unsupported instructions. |
| 5. Validate | Parse with the matching Ruby family/version and compare fixture behavior against the original artifact in an isolated harness when executable fixtures are authorized. | Syntax acceptance is not semantic equivalence. Record validator runtime, input/output hashes, fixtures, and comparison result. |

## First implementation boundary

The initial isolated MRI ISeq inspection provider is implemented. It runs CRuby
3.4.11 in a constrained analyzer, loads the ISeq only for disassembly and `to_a`
inspection, enforces input, output, memory, sequence, instruction, nesting, and CPU
limits, writes a separate derived disassembly artifact, and stores bounded structured
sequence/opcode evidence, instruction counts, exact hashes, and runtime identity in
the project observation. The visualizer, MCP dossier, and AI explanation context expose
both views as bytecode evidence with separate integrity checks; maintenance rewrites
reject it. The
current limit is 16 MiB input, 512 KiB raw disassembly, 192 KiB structured evidence,
96 sequences, 1,200 instructions, 400 CFG blocks per sequence, one concurrent analysis,
25 CPU seconds in the child, and 384 MiB child address space. The analyzer image builds,
both Ruby files pass `ruby -c`, Compose configuration validates, and the webapp passes
its production TypeScript check. Runtime artifact inspection and fixture fidelity
evidence remain open. Add source recovery only after the structured instruction model
is validated.

The implemented inspection boundary must continue to:

- accept only recognized ISeq binary inputs and enforce byte, memory, CPU, and output
  limits;
- use a pinned MRI runtime selected by the input's compatible header, with the exact
  runtime build recorded;
- load the ISeq only to inspect/disassemble it, never evaluate it;
- save bounded raw disassembly and summary metadata as separate, hash-attributed
  project observations;
- reject a runtime/header mismatch explicitly instead of silently trying another
  Ruby version;
- keep raw instructions, intermediate representations, generated Ruby, and accepted
  maintained source as distinct artifacts in the project database.

The integrated source candidate is an early experimental adapter and does not establish
reliable Ruby source recovery. Raise its support status only after versioned fixtures
cover methods, blocks, closures, keyword arguments, exceptions, pattern matching, and
compiler-optimized control flow, with semantic comparisons and instruction coverage.

## Reuse decisions

- Use the MIT-licensed [ruby-syntax-tree/yarv](https://github.com/ruby-syntax-tree/yarv)
  as an opcode-semantics and emulator reference. It is archived and educational; it
  does not reconstruct source and is not a drop-in decompiler.
- The audited [Shopify Ruby LSP](https://github.com/Shopify/ruby-lsp) 0.26.10 release
  is not suitable for local-variable or parameter renames: its prepare-rename and
  references handlers do not expose those bindings. Keep it as a semantic-token and
  LSP design reference only. The MIT-licensed [Solargraph](https://github.com/castwide/solargraph)
  0.60.4 release now supplies same-file local-variable and positional-parameter
  binding resolution. REAmon cross-checks resolved references against Ripper's local
  token ranges, caps candidate probes, and runs `ruby -c` on the output. Keyword labels
  and cross-file references remain outside this first slice. Its upstream rename
  examples do not replace REAmon fixture coverage for shadowing, closures, block
  parameters, Unicode columns, or recovery-produced Ruby.
- Keep [cout/ruby-decompiler](https://github.com/cout/ruby-decompiler) as an
  unintegrated research lead until licensing is clarified. Its example starts from a
  live method and does not establish arbitrary binary import or modern version
  coverage.
- Do not reuse code from [Disrobe](https://github.com/1-3-7/disrobe). Its current
  license prohibits use to build a competing product. Its public Ruby evidence is a
  useful gap signal only: it reports opcode-name recall after recompilation for
  Ruby 3.4.9, which does not establish recovered-source fidelity.
- Use the official
  [RubyVM::InstructionSequence documentation](https://ruby-doc.org/3.4/RubyVM/InstructionSequence.html)
  and version-matched CRuby `insns.def` as primary format and opcode references.
- The bounded source candidate adapter reuses the static parser/translator core from
  [DECOMPILER-RUBY-FOR-SKETCHUP-RUBY-2.7](https://github.com/trancuong2806/DECOMPILER-RUBY-FOR-SKETCHUP-RUBY-2.7)
  at `8296afafb099110f944135f32f59e789567dd1a4` under BSD-2-Clause. Only its parser,
  translator, and required core modules are vendored with the upstream license. Its
  dumper/runtime hook is excluded. Upstream targets Ruby 2.7 YARV disassembly and
  reports SketchUp RubyEncoder plugin use; REAmon currently supplies CRuby 3.4.11
  disassembly, so the adapter is explicitly experimental and version-mismatched.

## Completion evidence

Do not describe Ruby bytecode as decompiled until REAmon has a reproducible,
redistributable fixture set spanning supported MRI versions and optimization levels,
and reports function/sequence coverage, unresolved instructions, syntax acceptance,
and semantic comparison separately. The long-term goal is maintainable Ruby output;
perfect recovery of names, comments, or formatting erased before compilation is not
possible in general.
