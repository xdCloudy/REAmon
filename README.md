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
3. Review available analysis capabilities and run compatible providers independently. Compare their hash-linked outputs and evidence; provider agreement alone does not prove correctness.
4. Browse decompiled code and related instructions, functions, relationships, provider alternatives, and saved analysis in the project visualizer.
5. Use the saved project evidence to guide explanations and proposed edits. Review and validate edits before accepting or exporting them.

Browser workspace imports transfer in resumable 8 MiB chunks, with no per-file or total-byte cap imposed by REAmon. Retries resume from the server's persisted byte offset, and progress reflects server-acknowledged data. Import size is limited by available storage; profiling samples a bounded prefix so large files do not need to fit in application memory.

The intended workflow and evidence model are described in the [reverse-engineering workflow](docs/REAMON_WORKFLOW.md), [stage matrix](docs/REAMON_RECONSTRUCTION_STAGES.md), and [architecture](docs/REAMON_ARCHITECTURE.md).

For licensed local IDA Pro batch analysis, see the [IDA Pro integration guide](docs/REAMON_IDA_PRO.md). The optional Linux install is brought by the operator; REAmon does not require an IDA API key.

## Analysis coverage

Coverage varies by input format, language, provider, and version. Java and Android, managed .NET, native binaries, and several interpreted or portable formats have integrated analysis paths at different maturity levels. The product goal is to reconcile independent provider evidence, investigate failed units when provider output is inadequate, recover project-wide names and types, assemble maintainable source projects, and validate them against the original where a safe oracle exists. These are not yet uniformly implemented or validated across languages. Protected-binary analysis is at an early stage: bounded static inspectors cover PE section/header evidence and ELF headers, program headers, and section names; conventional UPX markers and suspicious ELF segment/entry-point structure remain hypotheses, not confirmed protection. PE executable-section entropy is a generic indicator. Neither inspector executes or unpacks files, and neither establishes commercial-protector support or real-sample detection accuracy. Encrypted-region recovery and custom virtualized-code reconstruction remain planned, with separate milestones and acceptance gates. Some languages currently provide navigation or an alternate representation rather than maintainable source recovery. Check the [language and format matrix](docs/REAMON_LANGUAGE_MATRIX.md), [reconstruction milestones](docs/REAMON_RECONSTRUCTION_MILESTONES.md), [protected-binary milestone](docs/REAMON_PROTECTED_BINARY_RECOVERY.md), [encrypted-binary milestone](docs/REAMON_ENCRYPTED_BINARY_RECOVERY.md), and [virtualized-code milestone](docs/REAMON_VIRTUALIZED_CODE_RECOVERY.md) before choosing a workflow; they record current evidence, known limits, and planned support.

REAmon's goal is language-universal recovery of maintainable code. The language matrix also defines criteria for evaluating source transpilers and native binary lifters. Decompilers and related projects are audited in the [reference portfolio](docs/REAMON_REFERENCE_PORTFOLIO.md) and [upstream reuse notes](docs/REAMON_UPSTREAM_REUSE.md), including licensing and validation requirements.

## Upstream evaluation and selective reuse

REAmon tracks complementary reverse-engineering projects as **references and potential implementation sources**, not as integrated capabilities. [Craft Anything](https://github.com/storytold/craft-anything) is being evaluated for its unified tool contracts, paged evidence, pluggable checks and iterative agent workflows. Its primary recreation workflow differs from REAmon's evidence-linked source recovery; upstream demos and tool counts do not imply that REAmon supports those features.

The [Craft Anything adoption bootstrap](docs/REAMON_CRAFT_ANYTHING_ADOPTION.md) records candidate components, architecture mapping, reuse/licensing gates, measurable acceptance tests and staged work packages. **No code from that project is incorporated by this documentation update.** Existing [capability](docs/REAMON_FEATURE_MATRIX.md), [reconstruction](docs/REAMON_RECONSTRUCTION_STAGES.md), [language](docs/REAMON_LANGUAGE_MATRIX.md) and [production-readiness](docs/REAMON_READINESS_MATRIX.md) claims remain unchanged.

The [autonomous reconstruction and fidelity delivery plan](docs/REAMON_AUTONOMOUS_RECONSTRUCTION_DELIVERY.md) now defines integration, benchmarking and optional web/app behavioral-evidence acceptance. These are **new roadmap gates, not implemented features**; the README's weighted progress reflects their extra scope without changing existing implementation evidence.

## Project status

<!-- REAMON_PRODUCT_PROGRESS_START -->

<progress value="33.79" max="100">33.79%</progress> <strong>33.79%</strong> — weighted estimate **33.79%**.

Latest evidence-based score change (2026-11-10): **+0.08 points** (33.71% → 33.79%). One partial point raises Agentic project-wide semantic renaming from 32% to 33%, moving the weighted estimate from 33.71% to 33.79% (+0.08 points). A hash-pinned held-out corpus reports 108 TP, 0 FP, and 0 FN for package-level declaration identity across two Go modules and three target contexts using an independent Go AST census. Broader declaration scopes and languages remain unmeasured.

**Work completed (2026-11-10):**

- Go inventory and semantic package checks now support target GOOS and GOARCH values from the installed Go toolchain, with target-specific architecture defaults and matching standard-library export data.
- Go itself selects files for target OS, architecture, and declared tags. Cgo source remains explicitly unsupported and cross-target cgo defaults off. External imports now resolve only through hash-verified module receipts and verified offline caches.
- The Docker agent unit gate passed 188 files and 3,806 tests with zero failures; one file collected no tests. Go regressions type-check a Windows-only syscall on Linux and a Linux/ARM64 syscall using ARM64 exports.
- The Go inventory route now reads hash-verified go.mod and matching go.sum bytes for the active module root, sends their exact hashes to the helper, and binds go.sum into saved inventory/proposal scope.
- The Go helper stages manifests in an isolated temporary module root, rejects local path replacements, verifies the offline cache, and resolves imports with read-only module mode and network-backed proxy, checksum, and VCS access disabled.
- A hermetic Go fixture seeds an isolated module cache from a local file proxy and successfully inventories a source file importing that dependency. The full Docker agent gate passed 188 files / 3,806 tests (one file collected no tests); the Go helper suite passed after the final negative controls. Safe-renames route tests passed 9/9, TypeScript type-check and targeted ESLint passed; PostgreSQL acceptance was skipped without DATABASE_URL.
- A versioned Go inventory corpus now hash-verifies selected upstream pkg/errors v0.9.1 and google/uuid v1.6.0 sources, asserting exact package/file/symbol classifications and entry counts for Linux/amd64, Windows/amd64, and Linux/arm64. The full Go refactor package suite passed; the full Docker agent unit gate passed 188 files / 3,806 tests with zero failures (one file collected no tests).
- A hash-pinned build-context corpus now checks end-to-end Go inventory selection and exact symbol totals for Linux/amd64, Windows/amd64, Linux/arm64, and an explicit custom tag. A cgo-enabled source fixture is explicitly rejected as unsupported. The Go refactor package suite and full Docker agent unit gate passed (188 files / 3,806 tests; zero failures; one file collected no tests).
- The opt-in Go package-rename PostgreSQL acceptance now runs against a disposable PostgreSQL 16 database and passes 1/1: stale go.mod/go.sum and sibling-source receipts are rejected, injected draft-write failure rolls back, and successful apply persists two reloadable drafts. A fixture-scope bug in the integration test was fixed. Focused safe-renames route tests passed 9/9; Docker TypeScript type-check and targeted ESLint passed. The test uses a controlled helper response, so real helper/database/browser end-to-end acceptance remains open.
- Real-helper Go package-rename PostgreSQL acceptance passes 1/1 using a freshly built current-source agent image and disposable PostgreSQL 16: project bindings and inventory are persisted against the real helper, stale manifests and sibling receipts are rejected, injected transaction failure rolls back, and successful apply reloads both drafts. The integration exposed and fixed a hash-contract mismatch: source_set_sha256 now represents the source snapshot expected by the web route, while inventory_scope_sha256 separately binds the selected Go build context. Docker Go helper tests pass; the fixture includes go.mod/go.sum but no external module import, and browser acceptance remains open.
- Source commit 98ebf848 fixes Go rename-output validation dropping the verified module/build context. Disposable PostgreSQL 16 acceptance passed 1/1 through the rebuilt real helper with selected source importing example.test/dep from hash-verified go.mod/go.sum and an offline cache; stale-manifest rejection, transaction rollback, successful apply, and draft reload all pass. Go helper package tests pass; focused route/access tests pass 10/10 and targeted ESLint passes. Full webapp tsc --noEmit reports unrelated existing test-file type errors, so this broad check is not claimed.
- A Chromium browser test against a freshly built current-source webapp passes 1/1 with a disposable PostgreSQL container and synthetic project API responses. It exercises Go unit selection, same-package scope opt-in, whole-project inventory display, selected rename submission, renamed editor content, and draft receipts for both files; no page or console errors were observed. Because the safe-renames API is stubbed in this browser test, it adds UI regression evidence only and receives no weighted progress credit; the real-helper browser/API acceptance remains open.
- Progress note: the weighted score previously rose from 33.55% to 33.63% (+0.08 points) after the real-helper PostgreSQL acceptance. The later Chromium UI test passes 1/1 but stubs project APIs, so it adds UI evidence without changing the weighted score.
- Real-helper Go package rename now passes isolated Chromium acceptance 1/1 with disposable PostgreSQL 16 and an external module in a hash-verified offline cache. The browser calls real safe-renames and draft routes; the real helper performs project inventory and rename, and both persisted drafts reload after a page refresh. Only the LLM suggestion endpoint is deterministic; no page or console errors occurred.
- A versioned held-out Go inventory evaluation covers gorilla/mux v1.8.1 on Linux/amd64 and Windows/amd64 plus go-isatty v0.0.20 on JS/wasm. Independent Go AST declaration census: 108 TP, 0 FP, 0 FN (100% precision/recall) for package-level declaration identity; local/file-scope accuracy remains unmeasured. The full Docker Go refactor package suite passes.

**Score decision:** Award one partial point to the 8%-weight Agentic project-wide semantic-renaming workstream (32% to 33%). The held-out package-level declaration identity check records 108 true positives, 0 false positives, and 0 misses across two pinned modules and three build contexts, moving weighted progress from 33.71% to 33.79% (+0.08 points). Broader local/file-scope accuracy, reference resolution, import renaming, and general autonomy remain open.

**Next measurable gate:** Extend held-out precision/recall from package-level declarations to file-scope and local symbols plus resolved references; add more Go repositories, external imports, build contexts, and additional languages, and report false-positive/false-negative and scale limits.

Refreshed from pushed commit `c44cfd7`. This estimate includes product work and production security/reliability; it is not a release certification. See the [readiness matrix](docs/REAMON_READINESS_MATRIX.md) for release gates and the [progress matrix](docs/REAMON_PROGRESS.md) for workstream evidence.

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
- [Agentic Semantic Symbol Recovery milestone](docs/REAMON_SEMANTIC_SYMBOL_RECOVERY.md)
- [Agentic reconstruction milestones](docs/REAMON_RECONSTRUCTION_MILESTONES.md)
- [Protected-binary analysis and recovery milestone](docs/REAMON_PROTECTED_BINARY_RECOVERY.md)
- [Encrypted-binary recovery milestone](docs/REAMON_ENCRYPTED_BINARY_RECOVERY.md)
- [Virtualized-code reconstruction milestone](docs/REAMON_VIRTUALIZED_CODE_RECOVERY.md)
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
- [Craft Anything adoption bootstrap and acceptance gates](docs/REAMON_CRAFT_ANYTHING_ADOPTION.md)
- [Autonomous reconstruction, fidelity benchmarks and application evidence delivery plan](docs/REAMON_AUTONOMOUS_RECONSTRUCTION_DELIVERY.md)
- [Native cross-version function matching ADR](docs/REAMON_NATIVE_FUNCTION_MATCHING_ADR.md)
- [ToCode export adapter](docs/REAMON_TOCODE_ADAPTER.md)
- [Release, backup, and recovery](docs/REAMON_RELEASE_RUNBOOK.md)

## Security and licensing

Use REAmon only on software you own or are authorized to analyze. Do not put real target data in issues, pull requests, or shared development environments. Report vulnerabilities using [SECURITY.md](SECURITY.md).

REAmon is distributed under the [MIT License](LICENSE). Bundled components have their own terms; see [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
