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

REAmon is intended to orchestrate reverse-engineering engines such as Ghidra and
JADX on the backend, then present their output in one investigation workspace. The
the current build now decompiles Android APKs through an isolated JADX backend and
shows indexed classes in its code visualizer. Other binaries still need matching
analysis engines. A workspace can contain multiple related targets and artifacts:

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
- Run JADX 1.5.6 in an isolated backend service for APK decompilation; store bounded
  Java source outputs separately and publish class-sized code-unit observations.
- Draw a searchable size/coverage treemap from provider code-unit observations and
  open source only through an authenticated, active-workspace artifact route.
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
- Preserve the PostgreSQL, Neo4j, agent, authentication, and event infrastructure
  needed by the REAmon workspace.

The current provider set covers profiling, source strings, ELF headers, generic file
identification, bounded JSON inspection, and APK-to-Java decompilation through JADX.
PE, ELF and Mach-O decompilation, Ghidra headless integration, runtime instrumentation,
and broader language-specific workflows remain future work.

## Bootstrap release readiness

<progress value="100" max="100">100%</progress> <strong>100%</strong>

This is a release-gate snapshot, reviewed 2026-10-03 against repository, hosted
workflow, production-image, and staging evidence. The score measures readiness for
a dependable self-hosted production release, not the number of UI screens or lines
of code.

This rating covers the bootstrap release scope only. It does not measure readiness
for REAmon's broader product goal of reverse-engineering arbitrary programs from
import through decompilation, navigation, AI-assisted analysis, and runtime work.
That broader goal remains in progress; native decompiler integrations and populated
code-unit visualizations are not available in this bootstrap.

The 100% score is justified for the current production release scope. The product
boundary is release-gated independently: no native workspace depends on a retired
scanner, pentest, or upstream-update surface.

| Workstream | Weight | Complete | Release evidence |
| --- | ---: | ---: | --- |
| Workspace foundation and access control | 20% | 100% | Full web suite, live auth boundary, operator login, project creation, browser login, and workspace navigation are hosted gates. |
| Import, profiling, storage, and inventory | 15% | 100% | Representative JSON/source import, profiling, inventory, writable artifact storage, PostgreSQL restore, and artifact extraction pass in CI. |
| Provider registry, scheduling, and provider execution | 15% | 100% | Approval-gated scheduling, concurrent claims, bounded providers, Python unit checks, and a killed-replica Compose worker recovery drill are covered. |
| Provider results and knowledge graph ingestion | 20% | 100% | Provider observations project into Neo4j; the hosted gate dumps, restores, queries, and rechecks the graph database. |
| Approvals, live activity, and operator controls | 10% | 100% | Browser import, approval, analysis, stale-recovery control, authenticated workspace state, and live activity are verified. |
| REAmon product boundary and retired-surface isolation | 10% | 100% | Pentest navigation, scanner services, inherited update checks, and upstream-facing UI are removed from the shipped runtime; retired flags fail closed. |
| Production hardening and release QA | 10% | 100% | Hosted full tests, npm audit, Trivy image scan, live acceptance, browser operator E2E, two-replica crash recovery, three-way restore drills, and exact-commit semver release automation are recorded. |

Weighted result: **100%**.

The production release gate is complete. The remaining roadmap items are capability
expansion and migration cleanup, not unverified deployment prerequisites.

Evidence recorded for this review:

- `.github/workflows/reamon-quality.yml` runs the full web suite, type-check, lint,
  npm production-dependency audit, Python unit gate, Trivy image scan, and a live
  Compose release gate against the production image.
- The live gate runs authenticated acceptance, browser import/approval/analysis/
  recovery controls, PostgreSQL restore, artifact extraction, and Neo4j dump/load/query
  recovery. It also scales the worker service to two replicas, kills one container,
  crosses the configured stale threshold, and requires one recovered completion.
- `.github/workflows/reamon-release.yml` validates `VERSION` against semver tags,
  requires a green quality workflow for the exact tagged commit, and publishes a
  checksum-backed source archive as a GitHub release. The reviewed release is
  [v6.23.0](https://github.com/xdCloudy/REAmon/releases/tag/v6.23.0).
- `tooling/scripts/reamon-release-preflight.sh --live --acceptance --backup` reproduces the
  same operational checks for self-hosted release operators.
- The authenticated acceptance flow imports representative JSON and C artifacts,
  exercises approvals and both built-in providers, proves distinct concurrent task
  claims, projects and reconciles the graph, and verifies the workspace snapshot.
- Two Compose worker replicas recover a controlled stale lease and complete the task
  exactly once; the isolated backup drill restores PostgreSQL into a disposable
  database and extracts the artifact archive successfully. A bounded four-task,
  two-replica load/soak run then verifies stable containers without restart churn.

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
Native analysis providers · generic process adapters
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
- At least 4 GB RAM for the REAmon stack
- A local checkout of this repository

Node.js, Python, and reverse-engineering tools run inside containers for the normal
workflow. Do not commit `.env` or real target data.

### Local install

```bash
git clone https://github.com/xdCloudy/REAmon.git
cd REAmon

./reamon.sh install
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

Existing PostgreSQL/Neo4j data and stable Compose volume identifiers can be retained
when upgrading an installation; retired scanner services are not started.

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
  `AUTH_SECRET`, and `INTERNAL_API_KEY`.
- Set `TRUST_PROXY=true` only when every request reaches the app through a trusted
  proxy that overwrites forwarding headers.
- Set `AGENT_WS_PUBLIC_URL` to the deployment origin when using a reverse proxy.
- Back up `postgres_data`, `neo4j_data`, and `reamon_artifacts` before upgrades.
- Review [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) before redistribution.
- Do not upload real target data to a development or shared environment.

The webapp entrypoint synchronises the Prisma schema on startup. Take a database
backup and inspect schema changes
before upgrading a production instance. Startup refuses destructive Prisma schema
drift by default; set `REAMON_DB_PUSH_ACCEPT_DATA_LOSS=true` only for a planned,
backed-up upgrade after reviewing the schema change. `/api/health` is a lightweight
liveness check; `/api/health/ready` verifies both the PostgreSQL connection and
writable REAmon artifact storage, and is the endpoint used by the Compose healthcheck.
Follow [`docs/REAMON_RELEASE_RUNBOOK.md`](docs/REAMON_RELEASE_RUNBOOK.md) for
backup, upgrade, smoke-test, rollback, and restore procedures.

## Development

The repository is a Docker-orchestrated monorepo. The webapp is Next.js 16, React 19,
TypeScript, Prisma, and Vitest; the analysis agent, worker, and supporting services
are containerized.

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

Useful top-level commands:

```text
./reamon.sh install       Build and start the stack
./reamon.sh update        Disabled; install reviewed REAmon releases explicitly
./reamon.sh up            Start already-built services
./reamon.sh status        Show service status
./reamon.sh test unit     Run the unit gate
./reamon.sh create-admin  Create or reset an administrator
./reamon.sh down          Stop services without deleting data
```

## Repository map

```text
webapp/src/lib/reamon/     REAmon domain, profiler, capabilities, and progress
webapp/src/app/projects/   Workspace dashboard, import, and project flows
webapp/prisma/             PostgreSQL schema and REAmon foundation migration
agentic/                   Analysis agent and bounded provider runtime
graph_db/                  Neo4j access and knowledge graph infrastructure
services/reamon_worker/    Durable queued-task worker
docs/REAMON_*.md           Current architecture and product-boundary decisions
```

## Roadmap

1. Add specialist binary/process providers and run the staging multi-worker drill
   around the existing ownership, retry, and process-cancellation path. The generic
   provider and contention scripts are already available for extension and validation.
2. Ingest universal code/data/runtime entities and relationships into Neo4j.
3. Extend approval policy reporting and richer recovery UX for target-agnostic analysis workflows.
4. Add specialist binary, runtime, and data providers behind the capability boundary.
5. Add capability-specific dashboards and reports while retaining one workspace
   framework for every target type.

## Provenance and licence

REAmon was derived from an MIT-licensed upstream codebase. Required attribution,
copyright notices, and third-party licences are retained. The maintained product
is the REAmon workspace at <https://github.com/xdCloudy/REAmon>; retired upstream
features are not part of its runtime contract.
