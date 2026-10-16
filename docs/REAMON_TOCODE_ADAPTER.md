# ToCode export adapter proposal

**Status:** design evaluated; not integrated.

This proposal adapts [ToCode](https://github.com/buzzer-re/ToCode)'s structured
binary export into REAmon's existing project database. ToCode's MIT-licensed CLI
produces native C-like pseudocode and assembly, Java for APKs, C# and IL for .NET,
per-unit summaries, and structured metadata. Its folder mode also links binaries
through loader/import relationships. REAmon should reuse that evidence where it
fills a gap, rather than copying ToCode's UI or creating a competing project store.

## Upstream contract observed

The inspected ToCode source currently writes `functions.json` as an object with a
`functions` array. Native function records can include:

- `address`, `name`, `c_name`, `prototype`, `size`, argument/local counts, stack
  frame size, and recovered parameter/local types;
- `callers`, `callees`, `callee_names`, imported callees, and reachability state;
- `source_file` and source line bounds, plus corresponding assembly file/line bounds.

ToCode also emits function indexes, source and assembly files, types, strings, imports,
exports, sections, relocations, reachability, triage, and project/export manifests.
The current source tree contains specialized metadata formats for APK and .NET exports,
so REAmon must select and validate the schema using export type/version instead of
assuming every `functions.json` is the native shape.

## REAmon mapping

| ToCode evidence | REAmon record | Mapping rule |
| --- | --- | --- |
| Binary inventory and input hash | Artifact / artifact provenance | Match only by verified SHA-256. Use a project-scoped synthetic artifact when the original input is absent; never guess from filename. |
| Function address and backend identity | `code_unit` observation | Stable key includes export identity, binary hash, and normalized address/token. Keep provider name/version and language/representation in attributes. |
| Name, prototype, parameters, locals, recovered types | Unit attributes and symbol/type observations | Preserve as provider evidence with confidence/source fields; do not promote to canonical names or types automatically. |
| Callee/caller addresses and import links | `calls` or dependency relationship observations | Resolve endpoints within the same export first. Resolve cross-binary links only from ToCode's explicit loader/import mappings and exact target artifact identity. Drop unresolved endpoints with a count in task metadata. |
| Source/assembly paths and line ranges | Derived source artifact and code-unit attributes | Resolve normalized paths against the imported export manifest, verify the file is a regular artifact inside that import, then copy bounded output into REAmon's derived-artifact namespace. Keep assembly as supporting evidence. |
| Export, strings, sections, relocations, reachability, triage | Typed observations and bounded task summary | Persist only fields with a defined REAmon interpretation; cap counts and field sizes and retain the raw export as an imported artifact. |
| ToCode-generated `AGENTS.md` / `CLAUDE.md` | Untrusted imported text | Never execute or treat it as system/developer instructions. It may be shown as ordinary artifact content only. |

## Integration shape

1. Add a workspace-import capability, because ToCode's folder mode consumes a set of
   binaries and emits cross-file relationships. A normal file provider receives one
   artifact path; do not disguise a multi-binary export as a single-binary analysis.
2. Scope the run to one completed `WorkspaceImport`. The worker receives only that
   import's immutable artifact IDs, relative paths, hashes, and storage paths. The
   analyzer validates every resolved path under the read-only artifact volume, builds
   a bounded temporary directory, and runs the pinned ToCode release in isolation.
3. Persist results through the existing task and observation ingestion lifecycle. Keep
   ToCode and selected backend versions, input hashes, warnings, truncation, and
   unresolved relationship counts with the task. Store source files as derived output
   with provenance to the exact imported artifacts.
4. Make backend choice explicit. Start with the permissive angr fallback; do not
   silently discover or use IDA, Binary Ninja, or radare2 installations. Audit the
   pinned ToCode dependency lock and each backend's license/availability before
   packaging.
5. Compare a native multi-binary fixture with Ghidra plus REAmon's ELF dependency
   analysis. Confirm exact input-to-export hash mapping, call/import endpoint
   resolution, code-unit navigation, cancellation, restart behavior, and output caps
   before enabling it by default.

## Boundaries and acceptance

ToCode-generated C-like output is not original source and is not proof of equivalent
behavior. APK Java and .NET output overlap existing JADX and ILSpy integrations; keep
those providers and their resource/rebuild workflows intact. Imported names, types,
and call links remain provider-scoped until independently corroborated or reviewed.

The adapter is ready for wider use only when it imports one complete ToCode folder
export without relying on path names alone, records every resolved input hash and
provider version, retains imported originals, exposes per-unit source and relationships
in the visualizer, reports partial/truncated exports accurately, and has fixture
results for the supported ToCode release and backend.

## Source audit

- [ToCode README and export layout](https://github.com/buzzer-re/ToCode)
- [ToCode `functions.json` producer](https://github.com/buzzer-re/ToCode/blob/main/src/tocode/metadata.py)
- [ToCode package metadata and MIT license](https://github.com/buzzer-re/ToCode/blob/main/pyproject.toml)
- [Glaurung analysis scope and maturity](https://github.com/mjbommar/glaurung)
- REAmon's current file-level execution path is in `webapp/src/lib/reamon/task-executor.ts`;
  project-scoped import inventory is in `webapp/src/lib/reamon/inventory-query.ts`.
