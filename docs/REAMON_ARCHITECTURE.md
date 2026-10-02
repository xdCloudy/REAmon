# REAmon architecture

REAmon is an AI-assisted reverse-engineering workspace and orchestration platform.

> Analyse anything. Connect the evidence. Understand the system.

REAmon originated as a fork of [RedAmon](https://github.com/samugit83/redamon). The fork retains the original attribution, copyright notices, and MIT licence. The migration is intentionally incremental: working web, authentication, PostgreSQL, Neo4j, agents, MCP, and event-streaming infrastructure remain available while pentest-specific assumptions are moved behind replaceable boundaries.

## Product goal

An operator creates a workspace and adds one or more related targets. REAmon profiles each target, discovers compatible capabilities, proposes or runs analysis tasks, stores observations and evidence, and exposes the resulting investigation as a live workspace and knowledge graph.

The core must not assume Android, APK, PE, Ghidra, JADX, Frida, a particular operating system, or a fixed reverse-engineering workflow. Unknown inputs are valid targets and remain available for later capabilities.

## Design principles

- Targets are plural, heterogeneous, and not necessarily files.
- Capabilities are advertised by providers; orchestration chooses providers from contracts rather than platform conditionals.
- Durable state is deterministic and inspectable. LLMs may interpret or propose work, but they do not invent progress percentages.
- Tool-specific data enters through typed results and evidence, then becomes generic workspace knowledge where possible.
- Human operators retain visibility and control over agent actions.
- Platform-specific integrations live in plugins or adapters.
- Existing data and infrastructure are migrated in place where that is safer than a rewrite.

## Workspace model

The current RedAmon `Project` record is the first REAmon `Workspace` boundary. It remains the foreign-key root so existing authentication, ownership, settings, and project URLs continue to work.

A workspace contains:

```text
Workspace
├── Targets
├── Artifacts
├── Environments
├── Tools / Capabilities
├── Agents
├── Tasks
├── Findings / Hypotheses
├── Evidence / Notes
├── Knowledge Graph
├── Timeline / Activity
└── Reports
```

The first database slice adds `Target`, `Artifact`, `Task`, `Finding`, `Hypothesis`, `Evidence`, and `WorkspaceActivity`. Environments, notes, reports, and provider installations are intentionally left for later migrations rather than being modelled prematurely.

### Workspace sources and folder imports

A workspace is an investigation, not a single uploaded file. A source/root can be a
browser folder snapshot today and a server-mounted directory, Git repository, archive,
device, runtime, remote source, or custom provider later:

```text
Project / Workspace
  └── Workspace source / root (DIRECTORY target)
        ├── directories and relative paths
        ├── original artifacts
        ├── derived artifacts (future)
        └── logical analysis targets
```

`WorkspaceImport` is a resumable import session. Its manifest records inventory facts
(`relativePath`, size, and client modification time), while the server calculates the
authoritative hash from uploaded bytes. Uploads are bounded per request and can be
retried against the same import ID. A failed import remains visible instead of silently
becoming a partial workspace. `relativePath` is normalised at one boundary and is
always relative to the imported root; backend storage remains opaque and is never
derived from user-controlled paths.

The browser workflow is deliberately a snapshot. `webkitdirectory` is the portable
baseline, with no dependency on Chromium's File System Access API. The browser sends
logical paths only, not the user's absolute filesystem path. A later refresh can submit
another manifest and compare its path/size/mtime during preflight. After upload,
finalization compares authoritative `relativePath + SHA-256` identity with the latest
completed snapshot of the same root and stores the deterministic delta in import
metadata. In-flight snapshots can be cancelled; partial artifacts remain visible and
the import can be resumed or replaced by a later snapshot.

## Targets and artifacts

`Target` describes the thing under investigation and can be a `FILE`, `DIRECTORY`, `REPOSITORY`, `PROCESS`, `DEVICE`, `SERVICE`, `REMOTE_HOST`, `CAPTURE`, `FILESYSTEM`, `DEBUG_SESSION`, `CUSTOM`, or `UNKNOWN`. A target can have multiple related artifacts.

`Artifact` is a durable observation or uploaded representation associated with a target.
It stores original/display names, `relativePath`, `parentPath`, content hash, size,
opaque storage path, MIME type, import provenance, lifecycle status, profiler output,
and resolved capabilities. Path identity is deliberately independent of content
identity: two files with equal SHA-256 values at different workspace paths remain two
artifacts. A directory root is one target; only interesting executable/library
artifacts become child logical targets, so a workspace is not inflated with a target
for every icon or configuration file.

The storage path is deliberately opaque to analysis providers. Providers receive target/artifact metadata and a controlled execution context rather than depending on a particular upload directory.

### Workspace inventory boundary

`webapp/src/lib/reamon/inventory-query.ts` is the DB-backed inventory boundary for
the dashboard, agents, and future MCP tools. `listWorkspaceFiles` supports bounded
search, format/category filters, and offset pagination, while `getWorkspaceArtifact` returns one active
artifact with its profile, resolved capabilities, logical target/import context, and
bounded related work and evidence. Both queries apply the active import snapshot
selection, so refresh history is retained for audit without duplicating paths in the
current workspace view. These APIs return logical IDs and relative paths only; an
agent never needs to know the host storage path.

The workspace snapshot sends a 500-artifact preview and deterministic total counts;
the tree searches and loads more pages through the inventory endpoint. Progress and
workspace capability reducers still operate over the full active metadata set on the
server, so bounding the UI payload does not turn the displayed progress into an
estimate.

### Agent and MCP inventory boundary

The authenticated inbound MCP server exposes the same logical inventory through two
read-only tools: `workspace_list_files` supports bounded path/name search, detected
format and executable/source filters, offset pagination, and per-artifact compatible
capabilities; `workspace_get_artifact` returns one artifact's profile, capabilities,
logical target/import relationship, and bounded related investigation records. Both
tools require the existing `recon:read` scope, verify the token owner's project before
querying, and apply the active-snapshot selector. This gives future agents a stable
workspace API such as `find_executables()` without granting them host paths or making
them understand the upload layout. Heavy analysis is still proposed or scheduled by
later orchestration work rather than automatically run by inventory reads.

`workspace_get_summary` provides the planning-level view: active roots, deterministic
counts, top profile dimensions, sampled logical targets, compatible provider counts, and
the stored lifecycle progress model. Its response is bounded and contains no per-file
payload, so agents can decide which inventory pages or capabilities to inspect next.

`workspace_plan_analysis` is the next read-only boundary. It expands a bounded inventory
page into deterministic `PROPOSED` steps for each compatible provider capability, optionally
filtered to one capability. It is intentionally not a scheduler or executor: a proposal
does not run a tool, create evidence, or change project state. Agents must review the
artifact details and provider requirements before a future task/execution boundary is used.
Both artifact pagination and the proposal step count are bounded, and the response signals
when the proposal is partial.

## Target profiler

The initial profiler is intentionally conservative. It combines filename extension, MIME hints, magic bytes, basic header inspection, and byte entropy. It currently recognises representative ELF, PE, Mach-O, ZIP/APK/JAR, PDF, SQLite, PCAP, and source-code inputs. Everything else produces a valid `UNKNOWN` profile.

```text
Target
  ↓
Target Profiler → TargetProfile
  ↓
Capability Resolver → compatible ToolPlugin manifests
  ↓
Analysis Plan / Tasks
```

`TargetProfile` is an extensible typed object. Better format detectors can be added without changing the target model or dashboard contract.

## Capability and plugin system

The first provider contract is in `webapp/src/lib/reamon/types.ts`:

- `ToolPluginManifest`: provider identity, category, accepted target/artifact profiles, capabilities, requirements, and produced entity types.
- `Capability`: a stable verb such as `identify`, `extract_metadata`, `disassemble`, `decompile`, or `runtime_observation`.
- `ToolRequirement`: runtime, target, environment, or configuration requirements.
- `ToolResult`: a typed execution boundary for status, produced entities, relationships, evidence, and provider metadata.
- `ToolPlugin`: a manifest plus an execution function.

The resolver currently registers two built-in providers: the profiler provider and a source-inspector placeholder. They demonstrate registration and matching without making Ghidra, JADX, or any other tool a core dependency. Future providers can connect through three equivalent boundaries:

1. Native REAmon plugins for deep integrations.
2. MCP clients for external RE tools and agent servers.
3. Generic command adapters for manifest-described CLI tools.

The command adapter boundary should validate arguments, constrain execution, capture stdout/stderr, and convert declared output formats into `ToolResult`; it is not implemented in this bootstrap.

Capability resolution is available at both artifact and workspace level. Artifact
matches identify which providers can operate on a particular profile. Workspace
summaries identify each installed provider and the compatible artifact IDs without
automatically scheduling heavyweight analysis across every match. Inventory and
profiling happen first; task planning remains an explicit next stage.

## Universal knowledge model

The relational models provide durable project state and provenance. The graph model is intended for connected entities and relationships such as:

```text
Target / Artifact
  → Module → Function → BasicBlock → Instruction
  → String / Constant / Structure / MemoryRegion
  → Process / Thread / Invocation / NetworkEvent
  → Finding / Hypothesis / Evidence / Task
```

Candidate relationship types include `CONTAINS`, `CALLS`, `REFERENCES`, `READS`, `WRITES`, `IMPORTS`, `EXPORTS`, `LOADS`, `SPAWNS`, `CONNECTS_TO`, `OBSERVED_AS`, `DERIVED_FROM`, `SUPPORTS`, `CONTRADICTS`, `DEPENDS_ON`, and `RELATED_TO`.

PostgreSQL owns workspace identity, permissions, lifecycle state, provider/task records, hashes, evidence metadata, and audit-friendly activity. Neo4j owns high-connectivity entity and relationship traversal. A graph write should retain source and workspace provenance in PostgreSQL so graph data can be rebuilt or audited.

## Agents and orchestration

The existing agent runtime and model/provider configuration are retained. Their next boundary is capability-oriented roles such as project manager, static analysis, dynamic analysis, binary analysis, source analysis, protocol analysis, runtime, research, validation, and documentation.

Agents should query the workspace’s installed and compatible capabilities before proposing work. Platform-specific agents may exist as optional specialisations, but target type must not select a hard-coded tool pipeline in core orchestration.

Existing SSE, WebSocket, MCP, and activity infrastructure is reusable for live events. REAmon activity records provide a durable timeline; streaming can later project the same events to connected clients.

## Deterministic progress

Progress is derived from stored lifecycle state. The initial shared stages are `DISCOVERED`, `IDENTIFIED`, `CLASSIFIED`, `ANALYSED`, and `VERIFIED`. The progress model calculates metrics for targets, artifacts, tasks, findings, and hypotheses only when that entity type exists, and averages those metrics for the workspace percentage.

This supports target-specific dashboards without asking an LLM to estimate completion. New domain metrics can be added as deterministic reducers over stored entities.

## Current vertical slice

The first working path is:

```text
Create REVERSE_ENGINEERING workspace
  → choose browser folder or individual files
  → preview a manifest and refresh delta without uploading bytes
  → POST import session + bounded multipart artifact batches
  → hash + profile each artifact
  → persist DIRECTORY root, Artifact paths, logical candidate targets, Evidence, Activity
  → finalize with hash-based refresh comparison (or cancel and resume)
  → aggregate workspace inventory and resolve capabilities
  → expose bounded inventory and artifact-detail APIs to the UI/agent boundary
  → render searchable tree, artifact details, progress, work, hypotheses, activity
```

The dashboard is intentionally honest: empty tasks, findings, hypotheses, and activity
sections show empty states until real records exist. No synthetic statistics are
inserted. Existing legacy security projects still load through their original flow
while the REAmon project creation path avoids domain guardrails and Neo4j domain nodes.

## Migration from RedAmon

The migration is tracked in [REAMON_MIGRATION.md](REAMON_MIGRATION.md). The broad strategy is:

- keep reusable web, auth, database, graph, agent, MCP, provider, settings, and event infrastructure;
- repurpose engagement/project, attack graph, recon orchestration, findings, and agent execution around workspace analysis;
- isolate pentest-only scopes, phases, exploit flows, and scanner integrations behind legacy boundaries;
- remove offensive-only components only after replacement paths and data migration exist.

## Future integrations

The architecture leaves room for Ghidra, JADX, Rizin, Binwalk, Apktool, Frida, GDB, LLDB, x64dbg, WinDbg, QEMU, ADB, custom MCP servers, and arbitrary command-line tools. Each integration should declare what it accepts, what it requires, what capabilities it provides, and what generic entities or evidence it produces.

The next high-value work is a persisted provider registry and task executor, followed by graph ingestion for provider results and real event projection into the dashboard.
