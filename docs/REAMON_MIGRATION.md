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
| Scanner results / findings | Pentest-oriented result paths | Generic observations, findings, and evidence | GENERALISING | New relational models establish generic persistence; legacy result paths remain during migration. |
| Agent execution | Existing agentic runtime and model settings | Capability-oriented investigation agents | GENERALISING | Preserve human control, provider settings, and streaming while decoupling roles from pentest phases. |
| MCP integration | Existing MCP servers and route | External RE tool and agent provider boundary | REPURPOSED | Keep MCP plumbing; add provider manifests and result normalisation. |
| WebSocket / SSE / activity | Existing live streams | Workspace timeline and live analysis activity | REPURPOSED | `WorkspaceActivity` provides durable events; existing streams remain available for projection. |
| PostgreSQL / Prisma | Existing durable application state | Workspace, target, artifact, task, evidence state | REPURPOSED | New schema is additive and keeps legacy records intact. |
| Authentication / access control | Existing auth and project access checks | Workspace access control | UNCHANGED | New APIs reuse the existing effective-user and project-access guards. |
| Docker orchestration | Existing self-hosted stack | Self-hosted REAmon stack | GENERALISING | Artifact persistence is added as a named volume; service boundaries remain reusable. |
| Target import and artifact storage | No generic target import boundary | Transactional single-file compatibility route plus folder-first import sessions | REPURPOSED | Folder imports inventory first, upload in bounded requests, hash/profile each artifact, and finalize an aggregate directory profile. |
| Artifact retrieval | No workspace-scoped artifact delivery | Authenticated project-scoped download route | GENERALISING | Download paths are confined to the configured artifact root and return no-store responses; analysis providers should consume metadata rather than assume storage paths. |
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
- The first profiler and providers are local, typed contracts. They do not require external analysis tools, making the UI and storage path testable in a minimal self-hosted deployment.
- Artifact bytes are stored under a dedicated configurable volume. The service must never commit uploaded target data.
- `REAMON_MAX_ARTIFACT_BYTES`, `REAMON_MAX_IMPORT_FILES`, and `REAMON_MAX_IMPORT_BYTES` are enforced before storage and are configurable per deployment; defaults are sized for real application investigations while remaining bounded.
- Target import writes the file before the relational transaction, then removes those bytes if persistence fails. Artifact downloads require project access and cannot escape the configured storage root.
- The current production image is validated through a compile/build smoke test and authenticated-route boundary checks; full legacy application migration remains tracked above rather than being hidden by the new workspace slice.

## Directory-workspace milestone

The current vertical slice is complete for browser snapshots: select a folder, create a
REAmon workspace, preview the manifest and latest refresh delta, upload in bounded
concurrent requests, cancel or retry an import, preserve relative paths, aggregate the
profile, resolve compatible capabilities, and view the workspace file tree. Derived-
artifact provenance, server-mounted sources, true background uploads, and replacing
older duplicate artifact rows during refresh remain follow-up work.
