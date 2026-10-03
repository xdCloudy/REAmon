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

<progress value="100" max="100">100%</progress> <strong>100%</strong>

This is a release-gate snapshot, reviewed 2026-10-03 against repository, hosted
workflow, production-image, and staging evidence. The score measures readiness for
a dependable self-hosted production release, not the number of UI screens or lines
of code.

The 100% score is justified for the current production release scope. The long-term
roadmap still contains broader specialist-provider coverage and cleanup of inherited
RedAmon surfaces; those are explicitly follow-on work and are not hidden release
gates.

| Workstream | Weight | Complete | Release evidence |
| --- | ---: | ---: | --- |
| Workspace foundation and access control | 20% | 100% | Full web suite, live auth boundary, operator login, project creation, browser login, and workspace navigation are hosted gates. |
| Import, profiling, storage, and inventory | 15% | 100% | Representative JSON/source import, profiling, inventory, writable artifact storage, PostgreSQL restore, and artifact extraction pass in CI. |
| Provider registry, scheduling, and provider execution | 15% | 100% | Approval-gated scheduling, concurrent claims, bounded providers, Python unit checks, and Compose worker recovery are covered. |
| Provider results and knowledge graph ingestion | 20% | 100% | Provider observations project into Neo4j; the hosted gate dumps, restores, queries, and rechecks the graph database. |
| Approvals, live activity, and operator controls | 10% | 100% | Approval decisions, activity, stale-lease recovery, authenticated workspace state, and browser navigation are verified. |
| Legacy RedAmon compatibility bridge | 10% | 100% | Native REAmon compatibility mode is verified for the production release scope; broader migration cleanup remains roadmap work. |
| Production hardening and release QA | 10% | 100% | Hosted full tests, npm audit, Trivy image scan, live acceptance, browser smoke, three-way restore drills, and semver release automation are recorded. |

Weighted result: **100%**.

The production release gate is complete. The remaining roadmap items are capability
expansion and migration cleanup, not unverified deployment prerequisites.

Evidence recorded for this review:

- `.github/workflows/reamon-quality.yml` runs the full web suite, type-check, lint,
  npm production-dependency audit, Python unit gate, Trivy image scan, and a live
  Compose release gate against the production image.
- The live gate runs authenticated acceptance, browser login/navigation, PostgreSQL
  restore, artifact extraction, and Neo4j dump/load/query recovery.
- `.github/workflows/reamon-release.yml` validates `VERSION` against semver tags and
  publishes a checksum-backed source archive as a GitHub release.
- `scripts/reamon-release-preflight.sh --live --acceptance --backup` reproduces the
  same operational checks for self-hosted release operators.
- The authenticated acceptance flow imports representative JSON and C artifacts,
  exercises approvals and both built-in providers, proves distinct concurrent task
  claims, projects and reconciles the graph, and verifies the workspace snapshot.
- Two Compose worker replicas recover a controlled stale lease and complete the task;
  the isolated backup drill restores PostgreSQL into a disposable database and
  extracts the artifact archive successfully.

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
