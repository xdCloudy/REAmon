# Ruby recovery plan

This document defines REAmon's Ruby bytecode recovery direction. It separates
instruction evidence from reconstructed source so a disassembly is never presented
as a decompilation result.

## Current state

REAmon supports Ruby source outlines and a version-reported `ruby -c` syntax check.
The isolated CRuby 3.4.11 provider now recognizes `YARB` ISeq artifacts, records a
bounded YARV disassembly as hash-attributed project evidence, and keeps that artifact
explicitly separate from source. It does not reconstruct Ruby source from bytecode.
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
| 3. Recover control/data flow | Build version-specific basic blocks, stack effects, expression data flow, and structured branches/loops. | Persist intermediate representation and confidence per recovered construct; do not invent locals or types. |
| 4. Emit Ruby | Render readable Ruby source and attach each output span to its ISeq/instruction origins. | Label inferred names and constructs. Preserve unresolved instructions as diagnostics rather than plausible-looking Ruby. |
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
current limit is 16 MiB input, 512 KiB output, one concurrent analysis, 25 CPU
seconds in the child, and 384 MiB child address space. The analyzer image builds,
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

This first stage is useful evidence, but it is not a source decompiler and must not
raise Ruby's source-recovery status by itself. The source emitter becomes an
integration only after versioned fixtures cover methods, blocks, closures, keyword
arguments, exceptions, pattern matching, and compiler-optimized control flow.

## Reuse decisions

- Use the MIT-licensed [ruby-syntax-tree/yarv](https://github.com/ruby-syntax-tree/yarv)
  as an opcode-semantics and emulator reference. It is archived and educational; it
  does not reconstruct source and is not a drop-in decompiler.
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

## Completion evidence

Do not describe Ruby bytecode as decompiled until REAmon has a reproducible,
redistributable fixture set spanning supported MRI versions and optimization levels,
and reports function/sequence coverage, unresolved instructions, syntax acceptance,
and semantic comparison separately. The long-term goal is maintainable Ruby output;
perfect recovery of names, comments, or formatting erased before compilation is not
possible in general.
