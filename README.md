# REAmon

<p align="center">
  <img src="docs/assets/logo.png" alt="REAmon mark" width="120" />
</p>

<h1 align="center">Analyse anything. Connect the evidence. Understand the system.</h1>

<p align="center">
  REAmon is an AI-assisted reverse-engineering workspace and orchestration platform.
  It accepts arbitrary targets, profiles what it can, resolves compatible analysis
  capabilities, coordinates tools and agents, stores connected evidence, and presents
  the investigation through a live project workspace.
</p>

<p align="center">
  <a href="https://github.com/xdCloudy/REAmon"><img src="https://img.shields.io/badge/status-bootstrap-4169A1?style=for-the-badge" alt="Bootstrap status" /></a>
  <a href="docs/REAMON_ARCHITECTURE.md"><img src="https://img.shields.io/badge/architecture-documentation-4169A1?style=for-the-badge" alt="Architecture documentation" /></a>
  <img src="https://img.shields.io/badge/license-MIT-2E8B57?style=for-the-badge" alt="MIT License" />
</p>

> REAmon is for authorised reverse engineering, software analysis, education, and
> security research only. Analyse targets you own or are explicitly authorised to
> inspect. You are responsible for complying with applicable law, contracts, and
> third-party licences.

## What REAmon is becoming

REAmon is not an APK reverse-engineer or a Ghidra frontend. A workspace can contain
multiple related targets and artifacts:

```text
Workspace
├── Targets and artifacts
├── Environments and tools
├── Capabilities and agents
├── Tasks, findings, hypotheses, and evidence
├── Knowledge graph and timeline
└── Reports and live activity
```

Targets are intentionally open-ended: files, directories, repositories, processes,
devices, services, remote hosts, captures, filesystems, debug sessions, custom
targets, and unknown inputs. Platform-specific behavior belongs behind capabilities
and plugins rather than in the workspace core.

## Current bootstrap

The first REAmon milestone is implemented and running on the `reamon/bootstrap` branch:

- Create or reuse an existing RedAmon project as a REAmon workspace.
- Create a reverse-engineering workspace without inventing a domain or network scope.
- Import a complete browser-selected folder in bounded batches, preserving its relative
  directory tree as workspace context. Single-file import remains available.
- Compare a selected folder with the latest completed snapshot before upload, then store
  an authoritative SHA-256 refresh delta after finalization.
- Cancel an in-flight import safely, keep its partial state visible, and resume the
  remaining paths or select a replacement snapshot later.
- Persist a directory root target, logical artifact paths, and candidate analysis targets
  in PostgreSQL.
- Compute SHA-256 identity and a basic magic/extension/header profile.
- Keep unknown inputs valid instead of rejecting them.
- Resolve compatible built-in capabilities from typed plugin manifests.
- Queue a reviewed capability proposal as an idempotent analysis task without
  executing providers in the request path.
- Show targets, artifacts, detected metadata, capabilities, progress, findings,
  hypotheses, evidence, and activity in a real data-backed dashboard.
- Run bounded `strings` and `readelf` process providers against stored source and
  ELF artifacts, capture stable observations, and terminate the process on
  cancellation or timeout.
- Inspect generic file metadata and bounded JSON configuration documents through
  the same typed provider boundary, with stable observations and fail-closed size
  limits.
- Converge observations with explicit provider-independent identity hints before
  graph projection, including explicit relationship endpoint hints while retaining
  source-specific keys for provenance.
- Reconcile completed graph replays against the relational observation source,
  fencing overlapping project replays so stale nodes and relationships are removed
  without allowing concurrent workers to delete each other's writes.
- Persist worker dispatch health, show stale-worker status, and surface an operator
  alert when a worker is stale or reports a failed dispatch.
- Preserve the existing PostgreSQL, Neo4j, agent, MCP, authentication, and event
  infrastructure while migration proceeds incrementally.

The current profiler is deliberately conservative. The built-in provider set covers
profiling, source strings, ELF headers, generic file identification, and bounded JSON
configuration inspection; broader binary, MCP, and runtime integrations remain
optional follow-on capabilities rather than production prerequisites.

## Production readiness

<progress value="89" max="100">89%</progress> <strong>89%</strong>

This is a weighted engineering snapshot, reviewed 2026-10-03 against the current
default branch, hosted CI, release tooling, migration inventory, and production
deployment documentation. It measures readiness for a dependable self-hosted
production release rather than feature count.

The current REAmon path is a strong release candidate, but 100% is not yet supported
by repository-verifiable evidence. The latest hosted quality workflow is green and
the repository now includes staging acceptance, worker-contention, and
PostgreSQL/artifact restore drills. Those live release drills are not enforced by CI,
the restore drill does not restore Neo4j, the migration inventory still contains
GENERALISING and DEPRECATED core surfaces, and the production branch/release process
does not yet enforce protected/signed release controls.

| Workstream | Weight | Complete | What remains before production |
| --- | ---: | ---: | --- |
| Workspace foundation and access control | 20% | 95% | Core auth/project boundaries are covered, but add browser-level production-flow regression coverage and enforce release-branch protections. |
| Import, profiling, storage, and inventory | 15% | 95% | Representative imports and persistence are well covered; retain staging coverage for large/resumable imports, retention, and upgrade/restore interaction. |
| Provider registry, scheduling, and provider execution | 15% | 90% | Concurrency and bounded provider execution are implemented; make real multi-worker recovery a repeatable CI/release-environment gate rather than a manual deployment drill. |
| Provider results and knowledge graph ingestion | 20% | 90% | Projection and reconciliation are implemented and acceptance-tested; add an automated Neo4j backup/restore/recovery gate and broader failure-path validation. |
| Approvals, live activity, and operator controls | 10% | 90% | Approval and worker-health state are strong; add proactive external alerting for silent/stale workers and browser-level operator recovery tests. |
| Legacy RedAmon compatibility bridge | 10% | 75% | Native REAmon workspaces function, but the migration inventory still contains multiple GENERALISING and DEPRECATED project, pipeline, agent, finding, and security-tool surfaces. |
| Production hardening and release QA | 10% | 75% | CI builds/tests the REAmon web path and production image, but live acceptance/restore are not hosted gates; there is no formal GitHub release, the default branch is unprotected, and load/soak plus dependency/container/security gates are not part of the release workflow. |

Weighted result: **88.75%**, rounded to **89%**.

Before calling the project 100% production-ready, close the remaining operational
proof rather than redefining it out of scope:

- Add a hosted or otherwise machine-recorded release gate that runs the live staging
  acceptance, multi-worker recovery, and backup/restore flow against the production
  image.
- Extend backup/restore verification to Neo4j and verify a restored workspace end to
  end, not only PostgreSQL plus artifact extraction.
- Protect the release branch and require the quality/release checks before merge;
  publish versioned release artifacts/tags and preferably sign release commits/tags.
- Add dependency/container/secret scanning and run the relevant Python service tests
  alongside the REAmon web gate.
- Add browser E2E and basic load/soak coverage for import, scheduling, worker
  recovery, graph projection, and operator flows.
- Continue isolating or removing the remaining GENERALISING/DEPRECATED RedAmon
  surfaces so the production security model depends less on compatibility
  assumptions and deployment-only edge controls.

The current production deployment remains suitable for controlled self-hosted
evaluation and can be operated safely when the hardened single-host procedure is
followed. It should still be treated as a late release candidate until the remaining
release-engineering and migration gates above are reproducibly closed.

For production alerting, set `REAMON_WORKER_ALERT_WEBHOOK_URL` and optionally
`REAMON_WORKER_ALERT_WEBHOOK_TOKEN`. Failed provider dispatches send a bounded
`worker.degraded` JSON event with a five-second timeout; missing or failing alert
delivery never fails the dispatch request. The dashboard remains the source of
truth for stale workers, including workers that stop reporting entirely.

## Architecture

The target-to-workflow boundary is:

```text
Target import
    ↓
Target Profiler → TargetProfile / ArtifactProfile
    ↓
Capability Resolver
    ↓
Native plugins · MCP servers · generic process adapters
    ↓
Tasks and analysis plans
    ↓
Evidence, findings, hypotheses, activity, and knowledge graph
```

The initial typed contracts live in [`webapp/src/lib/reamon`](webapp/src/lib/reamon):

- `TargetProfile` describes observable target facts.
- `ToolPluginManifest` describes accepted inputs, capabilities, requirements, and
  produced entities.
- `ToolPlugin` provides the execution boundary without naming a specific platform.
- `resolveCapabilities()` chooses compatible providers from installed manifests.
- `buildProgressModel()` derives progress from persisted lifecycle state.

Read the full design in [`docs/REAMON_ARCHITECTURE.md`](docs/REAMON_ARCHITECTURE.md)
and the migration inventory in [`docs/REAMON_MIGRATION.md`](docs/REAMON_MIGRATION.md).

## Quick start

### Prerequisites

- Docker Engine or Docker Desktop
- Docker Compose v2
- At least 4 GB RAM for the lightweight stack; more for the inherited scanners
- A local checkout of this repository

Node.js, Python, and reverse-engineering tools run inside containers for the normal
workflow. Do not commit `.env` or real target data.

### Local install

```bash
git clone https://github.com/xdCloudy/REAmon.git
cd REAmon

# Compatibility wrapper around the inherited control plane.
./reamon.sh install

# Or use the original script name directly during migration.
# ./redamon.sh install
```

The installer creates the local `.env`, generates deployment secrets, builds the
configured services, starts PostgreSQL/Neo4j/the webapp and supporting workers, and
offers to create the first administrator. Open <http://localhost:3000> after the
webapp is healthy.

For an existing installation:

```bash
./reamon.sh up
./reamon.sh status
./reamon.sh logs webapp
./reamon.sh down
```

The legacy `redamon.sh` name remains intentionally supported while the control plane
is migrated. Compose service and volume identifiers also remain compatible with
existing installations; that compatibility is tracked in the migration document.

### First REAmon workflow

1. Sign in and choose **New Project**.
2. Enter a workspace name or choose a project folder; the folder name is used as the
   default workspace name.
3. Review the preflight inventory, then choose **Create and import workspace**.
4. REAmon creates one `DIRECTORY` root target, uploads files through bounded requests,
   hashes and profiles each artifact, and retains paths such as `bin/x64/app.dll`.
5. Review the workspace inventory, file tree, detected logical targets, capabilities,
   deterministic progress, and activity timeline.

Browser folder selection is a snapshot: the server never receives the absolute local
filesystem path and cannot watch the directory after the browser selection ends. The
import includes everything selected by default; refresh comparisons use manifest facts
before upload and authoritative hashes after upload.

Artifacts are stored in the named `reamon_artifacts` volume. The default per-file
limit is 512 MiB and the default import limit is 50,000 files / 8 GiB. Process
providers are bounded to a 60-second execution window and 2 MiB of captured output
by default. Set
`REAMON_MAX_ARTIFACT_BYTES`, `REAMON_MAX_IMPORT_FILES`, or `REAMON_MAX_IMPORT_BYTES`
in `.env` before starting the webapp to change import limits; use
`REAMON_PROCESS_TIMEOUT_MS` and `REAMON_MAX_PROCESS_OUTPUT_BYTES` to tune provider
limits. Keep the artifact volume backed up
with the PostgreSQL and Neo4j data volumes.

## Production deployment

The default Compose file is suitable for a trusted local network and development
environments. For an internet-facing deployment, use the hardened single-host
deployment under [`tooling/deploy/single-host`](tooling/deploy/single-host), which
adds TLS termination, firewall/SSH hardening, and keeps internal services private.

Before exposing a deployment:

- Set unique, high-entropy values for `POSTGRES_PASSWORD`, `NEO4J_PASSWORD`,
  `AUTH_SECRET`, `INTERNAL_API_KEY`, and `ORCHESTRATOR_API_KEY`.
- Keep `MCP_SERVER_ENABLED=false` until inbound MCP access is deliberately
  configured and reviewed.
- Set `TRUST_PROXY=true` only when every request reaches the app through a trusted
  proxy that overwrites forwarding headers.
- Set `MCP_ALLOWED_ORIGIN` and `AGENT_WS_PUBLIC_URL` to the deployment origin when
  using a reverse proxy.
- Back up `postgres_data`, `neo4j_data`, and `reamon_artifacts` before upgrades.
- Review [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) before redistribution.
- Do not upload real target data to a development or shared environment.

The webapp entrypoint synchronises the Prisma schema on startup to preserve the
upstream self-hosting workflow. Take a database backup and inspect schema changes
before upgrading a production instance. Startup refuses destructive Prisma schema
drift by default; set `REAMON_DB_PUSH_ACCEPT_DATA_LOSS=true` only for a planned,
backed-up upgrade after reviewing the schema change. `/api/health` is a lightweight
liveness check; `/api/health/ready` verifies both the PostgreSQL connection and
writable REAmon artifact storage, and is the endpoint used by the Compose healthcheck.
Follow [`docs/REAMON_RELEASE_RUNBOOK.md`](docs/REAMON_RELEASE_RUNBOOK.md) for
backup, upgrade, smoke-test, rollback, and restore procedures.

## Development

The repository is a Docker-orchestrated monorepo. The webapp is Next.js 16, React 19,
TypeScript, Prisma, and Vitest; the agent, recon, MCP, and orchestration services are
Python-based.

```bash
# Validate the Compose model without starting services.
docker compose config --quiet

# Build the webapp image.
docker compose build webapp

# Start the lightweight development stack.
docker compose up -d postgres neo4j webapp

# Validate the REAmon foundation inside the webapp environment.
docker compose exec webapp npm run test -- src/lib/reamon
docker compose exec webapp npm run type-check
```

The repository test policy is documented in [`docs/readmes/README.TESTING.md`](docs/readmes/README.TESTING.md)
and [`skills/redamon-testing/SKILL.md`](skills/redamon-testing/SKILL.md). The normal
gate is containerized; do not run host Python tests against the service code.

Useful top-level commands remain available through the compatibility wrapper:

```text
./reamon.sh install       Build and start the stack
./reamon.sh update        Pull/rebuild the configured deployment
./reamon.sh up            Start already-built services
./reamon.sh status        Show service status
./reamon.sh test unit     Run the unit gate
./reamon.sh create-admin  Create or reset an administrator
./reamon.sh down          Stop services without deleting data
```

## Repository map

```text
webapp/src/lib/reamon/     Generic REAmon domain, profiler, capabilities, progress
webapp/src/app/projects/   Workspace dashboard and project flows
webapp/prisma/             PostgreSQL schema and REAmon foundation migration
agentic/                   Reusable agent infrastructure being generalised
graph_db/                  Neo4j access and knowledge graph infrastructure
mcp/                       MCP servers and integration plumbing
recon/                     Legacy reconnaissance subsystem under migration
recon_orchestrator/        Legacy orchestration subsystem under migration
docs/REAMON_*.md           Current architecture and migration decisions
```

## Roadmap

1. Add specialist MCP/process providers and run the staging multi-worker drill
   around the existing ownership, retry, and process-cancellation path. The generic
   provider and contention scripts are already available for extension and validation.
2. Ingest universal code/data/runtime entities and relationships into Neo4j.
3. Extend approval policy reporting and richer recovery UX for target-agnostic analysis workflows.
4. Migrate the inherited project, agent, report, and settings surfaces away from
   engagement/recon terminology without breaking existing data.
5. Add capability-specific dashboards and reports while retaining one workspace
   framework for every target type.

## Provenance and licence

REAmon originated as a fork of [RedAmon](https://github.com/samugit83/redamon).
Original attribution, copyright notices, and the MIT licence are retained. The
current repository is maintained at <https://github.com/xdCloudy/REAmon>.

RedAmon-specific systems are being isolated or generalised rather than silently
represented as complete REAmon functionality. See the migration table for the
 status of each subsystem. Third-party tools remain subject to their own licences.
