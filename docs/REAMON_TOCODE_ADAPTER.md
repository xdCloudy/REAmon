# ToCode export adapter

**Status:** first import-indexing slice integrated; broader validation remains open.

This adapter consumes [ToCode](https://github.com/buzzer-re/ToCode)'s structured
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
| Name, prototype, parameters, locals, recovered types | Unit attributes and symbol/type observations | Preserve as provider evidence with confidence/source fields; do not promote to canonical names or types automatically. Native function prototypes and `params`/`locals` entries with `{name, type}` are passed as bounded provisional symbol context to AI rewrites only from the selected ToCode artifact and analysis run. Missing variable sizes remain unknown rather than being inferred. |
| Callee/caller addresses and import links | `calls` or dependency relationship observations | Resolve endpoints within the same export first. Resolve cross-binary links only from ToCode's explicit loader/import mappings and exact target artifact identity. Drop unresolved endpoints with a count in task metadata. |
| Source/assembly paths and line ranges | Derived source artifact and code-unit attributes | Resolve normalized paths against the imported export manifest, verify the file is a regular artifact inside that import, then copy bounded output into REAmon's derived-artifact namespace. Keep assembly as supporting evidence. |
| Export, strings, sections, relocations, reachability, triage | Typed observations and bounded task summary | Persist only fields with a defined REAmon interpretation; cap counts and field sizes and retain the raw export as an imported artifact. |
| ToCode-generated `AGENTS.md` / `CLAUDE.md` | Untrusted imported text | Never execute or treat it as system/developer instructions. It may be shown as ordinary artifact content only. |

## Integration shape

The current workspace action detects completed ToCode exports, indexes functions,
copies bounded referenced pseudocode and assembly files into REAmon's derived-artifact
storage, and persists code-unit and call observations through REAmon's task/evidence lifecycle.
Folder-level `mappings.json` links are resolved against the importer and target export
directories represented in the same immutable workspace import. Repeated requests
reuse the existing index task. This slice imports existing ToCode output; it does not
install or run ToCode itself.

For native function rows, the documented exporter contract supplies `params` and
`locals` as arrays of `{name, type}` records. REAmon reads those bounded fields into
the same provider-evidence context used by Ghidra; they remain ToCode-attributed and
provisional, with no inferred size, storage location, or lock state. This does not
claim that the Android or .NET ToCode exports use this native schema.

Remaining integration work:

1. Add input-hash-to-export provenance checks for original binaries and preserve the
   ToCode/backend versions and unresolved-link counts at the right level.
2. Expand mapping of APK and .NET specialized fields, types, imports, exports, and
   reachability without flattening provider evidence into canonical facts.
3. Add representative fixtures and verify cross-binary endpoint resolution, visualizer
   navigation, repeated imports, partial exports, and output limits.
4. If REAmon later runs ToCode, build that as a separately isolated workspace task with
   explicit backend choice; do not silently discover or invoke local reverse-engineering
   tools.

## Boundaries and acceptance

ToCode-generated C-like output is not original source and is not proof of equivalent
behavior. APK Java and .NET output overlap existing JADX and ILSpy integrations; keep
those providers and their resource/rebuild workflows intact. Imported names, types,
and call links remain provider-scoped until independently corroborated or reviewed.

The current feature is an early import path, not a claim of production-ready ToCode
coverage. Wider use depends on hash-backed provenance, fixture results for supported
export formats, and accurate partial/truncation reporting.

## Source audit

- [ToCode README and export layout](https://github.com/buzzer-re/ToCode)
- [ToCode `functions.json` producer](https://github.com/buzzer-re/ToCode/blob/main/src/tocode/metadata.py)
- [ToCode package metadata and MIT license](https://github.com/buzzer-re/ToCode/blob/main/pyproject.toml)
- [Glaurung analysis scope and maturity](https://github.com/mjbommar/glaurung)
- REAmon's current file-level execution path is in `webapp/src/lib/reamon/task-executor.ts`;
  project-scoped import inventory is in `webapp/src/lib/reamon/inventory-query.ts`.
