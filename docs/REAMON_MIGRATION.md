# RedAmon → REAmon migration

REAmon is an incremental fork of RedAmon. This table records the current boundary so migration work stays reviewable and existing infrastructure is not removed accidentally.

| RedAmon subsystem | Current status | REAmon replacement | Migration state | Notes |
| --- | --- | --- | --- | --- |
| Project / engagement root | Existing `Project` model and routes | Workspace-compatible project root | GENERALISING | Existing ownership, settings, and URLs are preserved. New REAmon records reference the project. |
| Project kind / creation | Project creation required target-domain and recon settings | `REVERSE_ENGINEERING` workspace kind alongside `LEGACY_SECURITY` | GENERALISING | New REAmon creation skips domain guardrails and graph Domain nodes; legacy creation remains compatible. |
| Folder workspace source | Single-file multipart target route | `WorkspaceImport` manifest, directory root target, bounded artifact uploads, cancel/resume lifecycle | REPURPOSED | Browser directory selection is a snapshot; preflight manifest deltas and post-upload SHA-256 deltas are persisted without exposing local absolute paths. |
| Artifact path identity | Flat original filename | `relativePath` + `parentPath` under an import root | GENERALISING | Paths are normalised and kept distinct even when SHA-256 content matches. Opaque storage paths remain internal; refresh comparison reports changed paths rather than collapsing them. |
| Reconnaissance pipeline | Existing recon services and orchestrators | Analysis pipeline and capability-driven plan | GENERALISING | Keep event and execution infrastructure; move target assumptions behind providers. |
| Attack-surface graph | Neo4j graph and graph UI | Universal knowledge graph | REPURPOSED | Graph relationships will represent code, data, runtime, and evidence entities, not only network scope. |
| Scanner results / findings | Pentest-oriented result paths | Generic observations, findings, and evidence | GENERALISING | Typed, bounded `ReamonObservation` persistence now accompanies successful provider tasks; legacy result paths remain during migration. |
| Agent execution | Existing agentic runtime and model settings | Capability-oriented investigation agents | GENERALISING | Preserve human control, provider settings, and streaming while decoupling roles from pentest phases. |
| MCP integration | Existing MCP servers and route | External RE tool and agent provider boundary | REPURPOSED | Keep MCP plumbing; expose logical inventory, provider-manifest compatibility, and proposal-only analysis planning without executing heavyweight tools from reads. |
| WebSocket / SSE / activity | Existing live streams | Workspace timeline and live analysis activity | REPURPOSED | `WorkspaceActivity` provides durable events; existing streams remain available for projection. |
| PostgreSQL / Prisma | Existing durable application state | Workspace, target, artifact, task, evidence state | REPURPOSED | New schema is additive and keeps legacy records intact. |
| Authentication / access control | Existing auth and project access checks | Workspace access control | UNCHANGED | New APIs reuse the existing effective-user and project-access guards. |
| Docker orchestration | Existing self-hosted stack | Self-hosted REAmon stack | GENERALISING | Artifact persistence is added as a named volume; service boundaries remain reusable. |
| Target import and artifact storage | No generic target import boundary | Transactional single-file compatibility route plus folder-first import sessions | REPURPOSED | Folder imports inventory first, upload in bounded requests, hash/profile each artifact, and finalize an aggregate directory profile. |
| Artifact retrieval | No workspace-scoped artifact delivery | Authenticated project-scoped download route | GENERALISING | Download paths are confined to the configured artifact root and return no-store responses; analysis providers should consume metadata rather than assume storage paths. |
| Workspace inventory | Flat/implicit artifact access | Active-snapshot file listing, artifact details, deterministic workspace summary, proposal planning, and explicit task scheduling | GENERALISING | Bounded search/filter/pagination, related task/finding/evidence context, profile aggregates, progress, provider counts, capability-based PROPOSED steps, and idempotent QUEUED tasks are available to the UI and authenticated project routes without exposing storage paths or executing heavyweight providers. |
| Domain/IP scope forms | Pentest-specific scope concepts | Target and artifact import | DEPRECATED | Existing screens are retained while workspace flows replace them. |
| Vulnerability-centric project flow | Pentest workflow | Findings, hypotheses, tasks, and evidence | DEPRECATED | Generic models are present; old flows still require migration. |
| CVE / exploit workflow | Offensive-security-specific paths | Validation and research tasks | DEPRECATED | Do not remove until callers are isolated and an authorised research replacement exists. |
| Nmap / Nuclei / Metasploit / GVM integrations | Offensive-only tools | Optional capability providers | DEPRECATED | They may become plugins later; they must not define the core model. |
| RedAmon branding | User-facing product identity | REAmon | REPURPOSED | Primary app chrome, metadata, README, and dashboard are rebranded; internal identifiers migrate progressively. |
| Original licence and attribution | Upstream MIT and notices | Retained in fork | UNCHANGED | REAmon does not remove upstream legal information. |

## Status definitions

- `UNCHANGED`: retained as-is because it is reusable or legally required.
- `GENERALISING`: actively moving behind a target-agnostic contract.
- `REPURPOSED`: retained infrastructure now serves the REAmon domain.
- `DEPRECATED`: no longer a core direction; isolate before removal.
- `REMOVED`: deleted only after a safe replacement or migration exists.

## Bootstrap decisions

- A separate `Workspace` database table is deferred. The existing `Project` record already supplies identity, ownership, and settings, so duplicating it would create avoidable migration risk.
- Unknown input is persisted as a valid target profile rather than rejected.
- The first profiler is local and the source/ELF/file/JSON inspectors are typed, bounded providers. The production image includes the process-provider executables; providers remain optional at scheduling time and fail closed when a controlled artifact path or executable is unavailable.
- Artifact bytes are stored under a dedicated configurable volume. The service must never commit uploaded target data.
- `REAMON_MAX_ARTIFACT_BYTES`, `REAMON_MAX_IMPORT_FILES`, and `REAMON_MAX_IMPORT_BYTES` are enforced before storage and are configurable per deployment; defaults are sized for real application investigations while remaining bounded.
- Target import writes the file before the relational transaction, then removes those bytes if persistence fails. Artifact downloads require project access and cannot escape the configured storage root.
- The current production image is validated through a compile/build smoke test, authenticated-route boundary checks, an explicit compatibility report, and release drill wrappers. Full legacy application migration remains additive roadmap work rather than an unsafe destructive cutover; the workspace exposes whether a project is native REAmon or operating through the legacy bridge.

## Directory-workspace milestone

The current vertical slice is complete for browser snapshots and allowlisted server
directories: select a folder or inventory a read-only configured mount, create a REAmon
workspace, preview the manifest and latest refresh delta, upload or import in bounded
requests, cancel or retry an import, preserve relative paths, aggregate the profile,
resolve compatible capabilities, request approval for a reviewed analysis proposal, review
provider findings, and run the bounded reference providers with lease-protected task/evidence/activity state.
Stale-task recovery, retry, and cancellation controls are now available to operators,
and an internal worker trigger can dispatch bounded queued batches. The production
Compose stack now runs a private restartable poller, and successful provider results
persist retry-safe typed observations that appear in the workspace. Active provider
leases now record an owner and refresh a guarded heartbeat, while stale recovery remains
safe for older rows without one. Providers receive a cooperative cancellation signal
when operators cancel running work. Durable multi-input derived-artifact lineage is now
stored transactionally with source hashes, logical paths, and optional producing task IDs;
only project-scoped source IDs are accepted and no host storage paths are exposed. Same-import
retries now serialize on the import row, converge on one logical artifact, reject a concurrent
finalize/cancel race, and remove replaced bytes only after commit. Historical snapshots remain
intentionally available for audit and hash comparison. A bounded retention job now
preserves the newest completed snapshot and referenced artifacts, defaults to dry-run,
and removes database rows before post-commit byte cleanup. Provider results also promote
bounded findings with task/source provenance, while analysis proposals default to durable
operator approval before worker execution. A JSON configuration provider, project-scoped
finding review controls, approval summaries, and an executable worker contention drill
now close the production baseline. True background uploads and additional specialist
MCP/process adapters remain optional follow-up work. The
workspace task panel now refreshes active work automatically and labels the current
worker plus heartbeat freshness. The internal projection route can replay the
normalized observation store into Neo4j,
and the worker invokes it for projects with completed tasks, continuing through
bounded projection pages. The private worker now periodically sweeps projects with
normalized observations through a bounded, round-robin historical backfill page.
Each paginated replay carries one durable
projection-run record and correlation id across its pages. Projection runs now
write durable workspace activity for started, completed, and failed graph writes so
operators can see recovery context without reading worker logs.
Worker dispatches now persist last-seen and bounded outcome telemetry, and the
workspace marks silent workers as stale. Failed dispatches optionally emit a bounded
webhook alert configured through `REAMON_WORKER_ALERT_WEBHOOK_URL` (with an optional
bearer token); delivery is best-effort and does not fail task dispatch. The worker
also invokes the bounded import-retention route on a configurable interval, dry-run
unless explicitly enabled. The repository supplies a concurrent worker contention
drill and an explicit PostgreSQL/artifact backup-restore drill wrapper for staging.
Completed graph replays now
mark every projected record with one run identity and remove stale graph records
only after the final page; a short-lived PostgreSQL project lease prevents
concurrent backfill workers from reconciling the same project. The workspace shows
the removed node and relationship counts.
