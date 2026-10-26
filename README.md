# REAmon

<p align="center">
  <img src="docs/assets/logo.png" alt="REAmon" width="104" />
</p>

<p align="center">
  <strong>Turn compiled software into code you can understand, review, and maintain.</strong>
</p>

<p align="center">
  <a href="https://github.com/xdCloudy/REAmon/actions/workflows/reamon-quality.yml"><img src="https://github.com/xdCloudy/REAmon/actions/workflows/reamon-quality.yml/badge.svg" alt="Quality workflow" /></a>
  <a href="https://github.com/xdCloudy/REAmon/blob/main/LICENSE"><img src="https://img.shields.io/github/license/xdCloudy/REAmon" alt="MIT license" /></a>
</p>

REAmon is a self-hosted reverse-engineering workspace. It runs analysis providers against imported artifacts, keeps their results and provenance in project databases, and gives you one place to inspect code, compare evidence, and make reviewed edits. AI assistance is grounded in saved project evidence so names and conclusions can stay consistent across a project.

Decompilation is a starting point. Recovered names, types, behavior, and source fidelity need review; generated output is not automatically equivalent to the original program.

## Get started

### Requirements

- Docker Engine with Docker Compose v2 (or Docker Desktop with WSL 2 on Windows)
- Git and Bash; on Windows, use WSL or Git Bash
- Enough memory and disk space for the services and analyzers you plan to run

### Install and start

```bash
git clone https://github.com/xdCloudy/REAmon.git
cd REAmon
./reamon.sh install
```

The installer creates local configuration and secrets, builds the services, starts the stack, and guides you through creating the first administrator. When the webapp is healthy, open <http://localhost:3000>.

Useful lifecycle commands:

```bash
./reamon.sh status       # Show service health
./reamon.sh logs webapp  # Follow webapp logs
./reamon.sh up           # Start the installed stack
./reamon.sh down         # Stop services and keep stored data
```

For LAN access, upgrades, backups, and internet-facing deployments, see the [deployment guide](tooling/deploy/single-host/README.md) and [release runbook](docs/REAMON_RELEASE_RUNBOOK.md). Back up PostgreSQL, Neo4j, and the artifact volume together.

## Use REAmon

1. Sign in and create a project.
2. Import files or a project folder. REAmon profiles the inputs and records their paths and hashes.
3. Review available analysis capabilities and run the providers that fit your target.
4. Browse decompiled code and related instructions, functions, relationships, and saved analysis in the project visualizer.
5. Use the saved project evidence to guide explanations and proposed edits. Review and validate edits before accepting or exporting them.

Browser workspace imports transfer in resumable 8 MiB chunks, with no per-file or total-byte cap imposed by REAmon. Retries resume from the server's persisted byte offset, and progress reflects server-acknowledged data. Import size is limited by available storage; profiling samples a bounded prefix so large files do not need to fit in application memory.

The intended workflow and evidence model are described in the [reverse-engineering workflow](docs/REAMON_WORKFLOW.md), [stage matrix](docs/REAMON_RECONSTRUCTION_STAGES.md), and [architecture](docs/REAMON_ARCHITECTURE.md).

For licensed local IDA Pro batch analysis, see the [IDA Pro integration guide](docs/REAMON_IDA_PRO.md). The optional Linux install is brought by the operator; REAmon does not require an IDA API key.

## Analysis coverage

Coverage varies by input format, language, provider, and version. Java and Android, managed .NET, native binaries, and several interpreted or portable formats have integrated analysis paths at different maturity levels. Some languages currently provide navigation or an alternate representation rather than maintainable source recovery. Check the [language and format matrix](docs/REAMON_LANGUAGE_MATRIX.md) before choosing a workflow; it records what works, known limits, and planned support.

REAmon's goal is language-universal recovery of maintainable code. The language matrix also defines criteria for evaluating source transpilers and native binary lifters. Decompilers and related projects are audited in the [reference portfolio](docs/REAMON_REFERENCE_PORTFOLIO.md) and [upstream reuse notes](docs/REAMON_UPSTREAM_REUSE.md), including licensing and validation requirements.

## Project status

<!-- REAMON_PRODUCT_PROGRESS_START -->
<progress value="64" max="100">64%</progress> <strong>64%</strong> — weighted estimate **63.7%**.
Refreshed from pushed commit `7091a82`. This estimate includes product work and production security/reliability; it is not a release certification. See the [readiness matrix](docs/REAMON_READINESS_MATRIX.md) for release gates and the [progress matrix](docs/REAMON_PROGRESS.md) for workstream evidence.
<!-- REAMON_PRODUCT_PROGRESS_END -->

[Goals and roadmap](docs/REAMON_GOALS.md) · [Feature matrix](docs/REAMON_FEATURE_MATRIX.md)
· [Production readiness matrix](docs/REAMON_READINESS_MATRIX.md) · [Weighted progress details](docs/REAMON_PROGRESS.md)

## Development

REAmon is a Docker-based monorepo. The webapp uses Next.js, TypeScript, and Prisma; analysis providers and supporting services run in containers.

```bash
docker compose config --quiet
docker compose build webapp
docker compose up -d postgres neo4j webapp
```

See the [developer guide](docs/readmes/README.DEV.md) for the development environment and the [testing guide](docs/readmes/README.TESTING.md) for repository checks.

## Documentation

- [Full documentation index](docs/README.md)
- [Product vision and principles](docs/REAMON_PRODUCT_VISION.md)
- [Goals and roadmap](docs/REAMON_GOALS.md)
- [Weighted product progress](docs/REAMON_PROGRESS.md) · [Progress data](docs/REAMON_PROGRESS.json)
- [Production readiness matrix](docs/REAMON_READINESS_MATRIX.md)
- [Kali execution isolation decision](docs/REAMON_KALI_ISOLATION.md)
- [Feature matrix](docs/REAMON_FEATURE_MATRIX.md)
- [End-to-end reconstruction stage matrix](docs/REAMON_RECONSTRUCTION_STAGES.md)
- [Language and format support](docs/REAMON_LANGUAGE_MATRIX.md)
- [IDA Pro integration](docs/REAMON_IDA_PRO.md)
- [Ruby recovery plan](docs/REAMON_RUBY_RECOVERY.md)
- [Workflow](docs/REAMON_WORKFLOW.md)
- [Architecture and persistence](docs/REAMON_ARCHITECTURE.md)
- [Migration from RedAmon](docs/REAMON_MIGRATION.md)
- [Reference portfolio](docs/REAMON_REFERENCE_PORTFOLIO.md)
- [Upstream reuse and licensing decisions](docs/REAMON_UPSTREAM_REUSE.md)
- [Native cross-version function matching ADR](docs/REAMON_NATIVE_FUNCTION_MATCHING_ADR.md)
- [ToCode export adapter](docs/REAMON_TOCODE_ADAPTER.md)
- [Release, backup, and recovery](docs/REAMON_RELEASE_RUNBOOK.md)

## Security and licensing

Use REAmon only on software you own or are authorized to analyze. Do not put real target data in issues, pull requests, or shared development environments. Report vulnerabilities using [SECURITY.md](SECURITY.md).

REAmon is distributed under the [MIT License](LICENSE). Bundled components have their own terms; see [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
