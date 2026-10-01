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

## Targets and artifacts

`Target` describes the thing under investigation and can be a `FILE`, `DIRECTORY`, `REPOSITORY`, `PROCESS`, `DEVICE`, `SERVICE`, `REMOTE_HOST`, `CAPTURE`, `FILESYSTEM`, `DEBUG_SESSION`, `CUSTOM`, or `UNKNOWN`. A target can have multiple related artifacts.

`Artifact` is a durable observation or uploaded representation associated with a target. It stores the original name, content hash, size, storage path, MIME type, lifecycle status, profiler output, and resolved capabilities. The first import path accepts an arbitrary file up to the configured size limit, stores it in the configured artifact volume, creates a target when needed, and records profile evidence plus a timeline event.

The storage path is deliberately opaque to analysis providers. Providers receive target/artifact metadata and a controlled execution context rather than depending on a particular upload directory.

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
Create existing Project
  → open /projects/:id
  → choose arbitrary file
  → POST multipart target import
  → hash + profile + resolve capabilities
  → persist Target, Artifact, Evidence, Activity
  → render targets, artifacts, profile, capabilities, progress, work, hypotheses, activity
```

The dashboard is intentionally honest: empty tasks, findings, hypotheses, and activity sections show empty states until real records exist. No synthetic statistics are inserted.

## Migration from RedAmon

The migration is tracked in [REAMON_MIGRATION.md](REAMON_MIGRATION.md). The broad strategy is:

- keep reusable web, auth, database, graph, agent, MCP, provider, settings, and event infrastructure;
- repurpose engagement/project, attack graph, recon orchestration, findings, and agent execution around workspace analysis;
- isolate pentest-only scopes, phases, exploit flows, and scanner integrations behind legacy boundaries;
- remove offensive-only components only after replacement paths and data migration exist.

## Future integrations

The architecture leaves room for Ghidra, JADX, Rizin, Binwalk, Apktool, Frida, GDB, LLDB, x64dbg, WinDbg, QEMU, ADB, custom MCP servers, and arbitrary command-line tools. Each integration should declare what it accepts, what it requires, what capabilities it provides, and what generic entities or evidence it produces.

The next high-value work is a persisted provider registry and task executor, followed by graph ingestion for provider results and real event projection into the dashboard.
