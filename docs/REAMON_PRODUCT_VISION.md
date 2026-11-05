# REAmon product vision

## Motivation

Compiled programs are difficult to maintain when their source is missing, stripped,
minified, or obfuscated. A disassembler can expose instructions, and a decompiler can
produce plausible source, but neither alone gives an engineer a consistent project
that can be understood, edited, reviewed, and checked.

An LLM can help recover intent and improve names, but it must work from the actual
program and the evidence collected for the whole project. A name inferred from one
function must not silently contradict a caller, another class, or a later analysis
run. The database and source artifacts need to provide the shared record that keeps
that work grounded.

## Vision

REAmon turns unfamiliar compiled software into an evidence-backed reverse-engineering
workspace: original artifacts stay intact; engine output is preserved with its source
and version; recovered units can be explored across a whole project; and reviewed,
validated reconstructions can be maintained and exported.

The product is successful when a maintainer can move from an unknown artifact to a
coherent, editable representation with clear links back to the bytes, functions,
relationships, and analysis that support it.

The target is a coherent project, not a collection of plausible files: project
relationships, types, dependencies, resources, build requirements, unresolved evidence,
and applicable behavior checks should travel with reconstructed source. REAmon must
distinguish provider output, supported inference, generated scaffolding, validated
observations, and unknown or irrecoverable source information.

REAmon's long-term ambition is practical, language-aware fluency across all major
programming-language families and the compiled formats they target. “100% fluency” is
the aspiration for breadth and depth of useful analysis, not a claim that a tool can
restore information a build discarded. A decompiler cannot recreate missing comments,
original formatting, removed identifiers, or a unique source program when multiple
programs compile to equivalent output. REAmon should aim for complete capability
coverage across its declared language portfolio, while publishing measured fidelity,
known gaps, and confidence for each language, compiler/runtime version, and input
class. The [language matrix](REAMON_LANGUAGE_MATRIX.md) defines how to track that work.

## Product principles

- **Recover source, not only descriptions.** Explanations help people understand code,
  while decompilation and reconstruction create code that can be edited and maintained.
- **Preserve evidence.** Keep the original artifact, engine output, disassembly, and
  derived source as distinct records with hashes, versions, paths, and lineage.
- **Make project memory authoritative.** Store symbols, aliases, types, relationships,
  decisions, drafts, reviews, and validation results in the workspace database so each
  task uses the same project vocabulary.
- **Work in bounded units.** Functions, methods, classes, modules, and resources are
  traceable units that can be analyzed independently and assembled into a project view.
- **Keep uncertainty visible.** Decompiled, inferred, AI-proposed, reviewed, and
  validated results are different states. Similarity is a lead, not proof.
- **Use the right validator.** Exact binary comparison is valuable when the original
  compiler and link context are available. Other formats need their own checks; no
  universal exact-equivalence claim is implied.
- **Keep humans in control.** AI proposes source changes and explanations. Review and
  explicit acceptance govern promotion into the maintained project representation.
- **Stay engine- and language-independent.** Providers can be replaced or combined;
  the investigation model should not be tied to a single format, UI, or decompiler.

## Fidelity-first delivery criterion

Autonomous progress should be demonstrated with a replayable, known-source
import-to-maintainable-project workflow, not a provider count or a superficially
runnable clone. The [delivery plan](REAMON_AUTONOMOUS_RECONSTRUCTION_DELIVERY.md)
defines full-system held-out benchmarks, project-wide semantic consistency,
multi-provider reconciliation, build and behavior oracles, bounded repair and
a documentation regression gate. Optional external web/application behavior
observations contribute scoped evidence only; visual resemblance is not source
or functional equivalence. All new capabilities are planned until REAmon itself
passes their acceptance fixtures.

## Why decomp.wtf is a product reference

[decomp.wtf](https://github.com/i12bp8/decomp.wtf) makes a strong workflow concrete:
it assigns one function at a time, gives the agent the target instructions and relevant
context, records attempts, runs a project-specific compiler and comparison, explains
misses, and preserves successful matches. It also prevents simultaneous agents from
colliding and shares accepted symbols and knowledge. Those choices make the work
observable and cumulative instead of asking a model to perform an unbounded rewrite.

REAmon should adopt that discipline while broadening it beyond projects with a known
compiler and a byte-for-byte matching target. The matching loop is a high-confidence
validation path where available. Other providers need language-aware parsing, builds,
tests, structural comparisons, or explicit human review, each reported at its actual
confidence level. See [the workflow](REAMON_WORKFLOW.md) and
[the feature matrix](REAMON_FEATURE_MATRIX.md).

## Product boundary

The distinction from software **recreation** is deliberate. A system can study an original and generate an app or game that resembles it without recovering the original's data structures, source units, semantics or dependencies. Craft Anything is a useful [workflow and engine reference](REAMON_CRAFT_ANYTHING_ADOPTION.md), but REAmon must label synthesized approximations as such and independently validate any claimed behavior. Tool interoperability and analysis UX are reusable concepts; replacing REAmon's source-reconstruction objective is not.

REAmon is an investigation and maintenance workspace around reverse-engineering
engines. It should reuse mature parsers, decompilers, disassemblers, debuggers, and
visualization techniques where practical, while keeping project identity, evidence,
memory, review, and provenance in REAmon. An upstream tool is not a substitute for the
project database or the end-to-end workflow.

The [architecture](REAMON_ARCHITECTURE.md) describes current system boundaries. The
[language support matrix](REAMON_LANGUAGE_MATRIX.md) states what works and what remains
experimental or planned. The [reference portfolio](REAMON_REFERENCE_PORTFOLIO.md)
records which upstream projects can accelerate the roadmap and what REAmon should
adapt from each.
