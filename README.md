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

<progress value="35.84" max="100">35.84%</progress> <strong>35.84%</strong> — weighted estimate **35.84%**.

Latest evidence-based score change (2026-11-11): **+0.07 points** (35.77% → 35.84%). A Windows-only downstream consumer guarded by `windows && downstream_extra` now blocks a Linux-requested Do-to-Serve rename when the request includes that custom tag. Successful receipts retain the tag across Linux/amd64, Windows/amd64, and Linux/arm64. Focused custom-tag/context tests pass, and the full Docker Go helper suite passes under Go 1.25 (91.383s). Cross-file semantic rename propagation rises from 23% to 24%, moving weighted progress from 35.77% to 35.84% (+0.07 points). Other target/tag combinations, broader consumer discovery, and coordinated multi-target edits remain open.

**Work completed (2026-11-11):**

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
- The held-out Go census found 22 false-positive blank range identifiers. The helper now omits `_`; a targeted regression and exact pinned-corpus counts confirm the correction. Re-measurement gives 100% all-scope precision, with gorilla/mux recall at 78.9% (419 TP, 0 FP, 112 FN) and go-isatty at 100% (4/4); missing receiver methods and type members remain open.
- Go project inventory now includes receiver methods, interface methods, fields, and type parameters as explicit unsupported member rows. Independent go/types census matches all 531 declarations with zero false positives or misses for gorilla/mux v1.8.1 on Linux/amd64 and Windows/amd64; go-isatty remains 4/4 on JS/wasm. Pinned upstream corpora assert the new member totals, the API validates member scope and counts, and the visualizer renders unsupported member rows.
- Expanded the independent all-scope declaration census to hash-pinned selected source from pkg/errors v0.9.1 and google/uuid v1.6.0. It matches 120/120 and 161/161 declarations respectively, with zero false positives or misses for Linux/amd64, Windows/amd64, and Linux/arm64. The complete Go helper package suite passes.
- Private same-package Go receiver methods can now be selected for semantic rename through go/types object identity. The implementation updates declarations, selectors, and method expressions across package files; rejects receiver method collisions and local interface contract changes; re-type-checks output; and tests behavior before and after on a pinned fixture. Full Go helper tests pass, focused safe-renames/UI tests pass 44/44, and targeted ESLint passes.
- A method-specific stale-source regression now changes a type-correct sibling file after catalog creation and proves apply rejects the old source-set receipt; the complete Go helper package suite passes.
- An embedded-field collision fixture now confirms that a promoted receiver method blocks a conflicting rename; the focused regression and full Go helper package suite pass.
- A module-snapshot Go helper prototype now catalogs exported receiver methods across a supplied module source set, applies exact declaration/selector/method-expression edits across packages, re-type-checks output, and rejects a rename that breaks imported io.Writer. Three focused Docker tests pass, covering behavior before/after, exact per-file byte edits, and stale source-set rejection; the full Go helper package suite passes. This is not wired into the web route or UI, so it receives no weighted credit yet.
- Module-wide Go receiver-method renaming is integrated through the safe-renames API and visualizer. Proposals bind the complete accepted source set plus verified go.mod/go.sum and helper inventory scope; apply reloads those receipts, type-checks whole-module edits, and saves every changed file as a separate draft. Exported method suggestions are restricted to explicit module scope and preserve exported capitalization. Focused Docker API tests pass 7/7, safe-renames route plus visualizer tests pass 46/46, TypeScript build type-check passes, and the Go helper package suite passes under Go 1.25. The route helper is fixture-controlled in these tests; real-helper PostgreSQL/Chromium acceptance and compatibility for consumers outside the module remain unverified.
- Isolated Chromium acceptance passed 1/1 using a freshly built webapp and agent, disposable PostgreSQL 16, real Go module helper, and an external dependency seeded into a verified offline cache. The browser generated a module-scoped exported Do→Serve proposal with three references across pkg/a.go, pkg/b.go, and cmd/main.go; tampering with the verified go.sum returned 409 and left all three draft lookups empty. After restoring the receipt and regenerating the proposal, apply saved three separate drafts and all three reloaded after a browser refresh. No unexpected browser errors remained. This verifies one synthetic module, not compatibility with consumers outside the supplied module.
- A downstream Go module negative-control fixture compiles an unchanged consumer against the original exported Do method and confirms compilation fails against the helper-produced Do-to-Serve output. The existing visualizer test confirms the public API warning says downstream consumers are not checked. The focused helper regression, full Go refactor package suite, and UI warning test pass. This verifies disclosure for one synthetic breaking change; REAmon still does not automatically analyze external consumers, so weighted progress remains 34.33%.
- A versioned held-out gorilla/mux v1.8.1 module rename fixture passes under Linux/amd64 and Windows/amd64. Hash-pinned Router.NewRoute has 12 resolved in-module references; the helper produces exactly 13 byte-exact edits in mux.go with no unrelated-file edits. Original and renamed modules pass the same route matching behavior oracle, and the full Go refactor package suite passes. This adds one partial point to cross-file propagation (15% to 16%; 34.33% to 34.40%); broader held-out accuracy and automatic external-consumer checks remain open.
- A versioned held-out google/uuid v1.6.0 module negative control catalogs exported UUID.String with three resolved in-module references and rejects String-to-Text because it breaks imported fmt.Stringer. The rejection passes under Linux/amd64, Windows/amd64, and Linux/arm64; the full Go refactor package suite passes. This adds one partial point to cross-file propagation (16% to 17%; 34.40% to 34.47%), while broader interface compatibility and external-consumer analysis remain open.
- A second pinned google/uuid v1.6.0 module negative case now rejects UUID.UnmarshalBinary-to-DecodeBinary because it implements encoding.BinaryUnmarshaler even though encoding appears only in a doc comment. The helper loads standard encoding interfaces into contract checks and includes Go’s predeclared error interface; focused UUID rejection tests pass on Linux/amd64, Windows/amd64, and Linux/arm64, and a built-in Error() regression passes. The complete Go refactor package suite passes under Go 1.25 (43.474s).
- Expanded the hash-pinned gorilla/mux v1.8.1 held-out module rename corpus with Route.Path on a distinct receiver type: 3 resolved references produce exact declaration/call edits across route.go and mux.go under Linux/amd64 and Windows/amd64, and the same route-matching oracle passes on original and renamed sources. Full Go refactor package suite passes under Go 1.25 (48.874s).
- A synthetic cross-package module rename regression now covers method expressions and bound method values as well as direct selectors. It verifies four resolved references, exact edits in four files, and the same runtime behavior before and after rename. The focused test and complete Go refactor package suite pass under Go 1.25 (48.611s). This strengthens the existing reference-correctness gate without separate weighted credit.
- The gorilla/mux v1.8.1 positive Router.NewRoute and Route.Path rename cases now cover Linux/amd64, Windows/amd64, and Linux/arm64. On Linux/arm64, target-specific module binding/rename checks pass and the independent held-out symbol census remains 531/531 with zero false positives or misses. Runtime route behavior was checked on the host platform only; target-specific runtime behavior remains unverified. Complete Go refactor package suite passes under Go 1.25 (50.208s).
- Documentation audit corrected stale Go rename status in the reconstruction-stage and readiness matrices: module-scoped exported receiver renames are experimental and integrated for supplied snapshots; external consumers/import renaming, broader accuracy, and autonomous acceptance remain open. No weighted score change.
- Held-out httprouter v1.3.0 adds an independent upstream module: Router.Handle → Register resolves eight references and emits exactly nine byte-span edits with no unrelated changes; binding/output checks pass on Linux/amd64, Windows/amd64, and Linux/arm64, and the host HTTP route behavior oracle matches before and after. Its selected-source inventory matches 20/20 package and 238/238 all-scope declarations with zero false positives or misses on all three targets. The full Docker Go refactor package suite passes under Go 1.25 (50.665s).
- Held-out chi v5.2.1 adds a third independent upstream module and new Context receiver: Reset → Clear resolves one cross-file reference and emits exactly two byte-span edits in context.go/mux.go. Binding/output checks pass on Linux/amd64, Windows/amd64, and Linux/arm64; original and renamed route variants preserve host HTTP path-parameter behavior. The local-interface Mux.Method rename is rejected because it would break chi.Router. A separate downstream consumer compiles against original Reset and fails against renamed output. Selected-source census is exact at 53/53 package and 596/596 all-scope declarations, zero FP/FN, on all three targets. Full Docker Go refactor suite passes under Go 1.25 (58.811s).
- Strengthened the httprouter v1.3.0 false-edit gate: all nine Handle → Register edits must be in router.go, other files must have none, and output must equal a byte-for-byte reconstruction from only the reported spans. The focused three-target test and full Docker Go refactor package suite pass under Go 1.25 (61.142s). This adds no weighted capability point.
- Source commit 4c4bf839 adds explicit Go import-alias rename support to the reviewed same-directory project flow. The Go helper edits each explicit alias declaration and its resolved same-file references, re-type-checks output, and rejects a type-correct rename when a local binding would capture a selector. The API and visualizer accept and disclose this binding type. Full Docker Go helper suite passes (51.912s); focused safe-renames route tests pass 10/10; visualizer tests pass 36/36; Docker TypeScript type-check and targeted ESLint pass. Commit 73347e35 updates the visualizer assertion.
- Source commit 6f7c90bf extends explicit Go import-alias renames to the verified module-snapshot proposal path. The module binding catalog returns the selected file alias with resolved references; the route accepts it as a file-scope candidate, and the helper edits exactly the declaration and same-file use while re-type-checking the supplied module and preserving a before/after behavior oracle. A type-correct local-capture case is rejected by binding-identity verification. The full Docker Go helper suite passes under Go 1.25 (59.064s); route and visualizer tests pass 47/47, Docker TypeScript type-check and targeted ESLint pass. The route test controls the helper response; real helper/module transformation behavior is covered by the Go tests.
- Source commit 4aa4c26e adds module-scope import-alias collision regressions: renaming onto an existing alias and assigning one new name to two aliases both reject. The three focused module alias tests pass, and the full Docker Go refactor package suite passes under Go 1.25 (53.944s). This adds safety evidence for the capability already credited; weighted progress remains 34.98%.
- A verified project-snapshot source limit now allows up to 2 MiB per file while retaining the 8 MiB project cap; single-file operations remain at 512 KiB. A SHA-256-pinned golang.org/x/sys v0.6.0 Windows/amd64 fixture verifies both explicit errorspkg aliases and all three resolved uses, exact byte-span output, and successful builds before and after rename. The full Docker Go refactor package suite passes under Go 1.25 (55.935s).
- Expanded the hash-pinned x/sys v0.6.0 import-alias holdout to Windows/arm64. Both Windows/amd64 and Windows/arm64 match 2/2 alias declarations and 3/3 references, reconstruct exact byte-span edits, and build the complete package before and after rename. The full Docker Go refactor package suite passes under Go 1.25 (63.917s). This adds cross-architecture validation for the credited alias capability, not another weighted capability point; overall progress remains 35.06%.
- The Go whole-project safe-renames route now accepts and forwards an accepted, hash-verified source file larger than 512 KiB and up to 2 MiB under the existing 8 MiB aggregate limit; package-scope and single-file limits remain 512 KiB. A route regression proves a 512 KiB+ unmodified sibling reaches the module helper and stays out of changed-file drafts. Focused route tests pass 11/11, Docker TypeScript type-check and targeted ESLint pass. No weighted point is added because this completes the route integration for the already-scored project-snapshot capability.
- Module-snapshot Go safe renames now coordinate explicit import aliases from multiple files; helper binding, exact edits, unchanged-selected-file behavior, and before/after module behavior are covered. Full Docker Go package suite passes (62.855s); route/UI tests pass 48/48; TypeScript type-check and targeted ESLint pass. Database-backed acceptance remains unverified.
- Opt-in PostgreSQL acceptance now saves and reloads a Go module alias batch across two files and confirms rollback leaves no drafts after an injected transaction failure. The database integration suite passes 2/2; helper responses are mocked in this suite and real helper semantics are covered by the Docker Go package tests. Focused web tests pass 50/50, with TypeScript type-check and targeted ESLint passing.
- A second independent upstream explicit-alias holdout adds a partial rename-accuracy increment. Hash-pinned github.com/pkg/errors v0.9.1 source confirms stderrors declaration/reference census 1/3 with zero false or missed bindings; the helper emits exactly four byte-exact edits, and original/renamed behavior matches. Linux/amd64, Windows/amd64, and Linux/arm64 builds pass. The full Go refactor package suite passes under Go 1.25. This raises Agentic project-wide semantic renaming from 42% to 43%, adding 0.08 weighted points overall (35.14% to 35.22%). Two upstream alias modules are now covered; broader held-out accuracy and downstream-consumer compatibility remain open.
- A hash-pinned negative control extends the pkg/errors v0.9.1 explicit-alias holdout: a separate file contains a same-spelled local variable, selector, and string literal. The semantic rename changes only the pinned import file, leaving the local selector and string unchanged. Fixture paths are pinned to LF so their byte hashes survive Windows and Linux checkouts. The focused holdout and full Go refactor package suite pass under Go 1.25 (63.700s). This strengthens the existing alias-accuracy evidence and adds no separate weighted point; overall progress remains 35.22%.
- A third independent upstream explicit-alias holdout adds a partial rename-accuracy increment: hash-pinned github.com/buger/jsonparser v1.1.1 source confirms the bio declaration and its one resolved use across Linux/amd64, Windows/amd64, Linux/arm64, and Linux/amd64 with the upstream appengine build tag. The helper emits exactly two byte-exact edits; original and renamed behavior both pass the int64-minimum, ordinary integer, and positive-overflow oracles. The full Go refactor package suite passes under Go 1.25. This raises semantic renaming from 43% to 44%, adding 0.08 weighted points overall (35.22% to 35.30%); three upstream modules are now covered, while multi-alias modules and broad accuracy remain open.
- A pinned x/sys v0.6.0 regression now renames both file-scoped errorspkg aliases in one request across exec_windows.go and syscall_windows.go. The independent AST census is 2 declarations / 3 references; output is exactly five byte-span edits across two files, and Windows/amd64 and Windows/arm64 builds pass. The full Go refactor package suite passes under Go 1.25 (71.667s). This extends held-out batch evidence without adding a distinct upstream module, so it earns no separate weighted point; overall progress remains 35.30%.
- A hash-pinned github.com/yuin/goldmark v1.7.8 holdout now renames 14 distinct explicit aliases across 14 files in one module batch. An independent AST census confirms 176 references and the helper emits exactly 190 byte-span edits; original and renamed modules build on Linux/amd64, Windows/amd64, and Linux/arm64, and a Markdown rendering behavior oracle matches before and after. The focused holdout and full Go refactor package suite pass under Go 1.25 (89.836s). This is a fourth independent upstream alias module and a distinct multi-alias batch slice; semantic renaming rises from 44% to 45%, moving weighted progress from 35.30% to 35.38%. External-consumer compatibility and broad accuracy remain open.
- Automatic downstream compatibility now type-checks each discovered, hash-verified Go consumer module against both original and proposed APIs. A consumer still calling exported Do blocks Do-to-Serve; a compatible consumer receives a checked receipt. Full Go helper suite passes under Go 1.25 (98.630s); focused safe-renames route tests pass 11/11 and visualizer tests pass 37/37. The complete webapp run reports 9,922 passing, 193 skipped, and one unrelated stale generated-settings test failure.
- Downstream exported-method compatibility checks now run end-to-end against build-specific consumer sources on Linux/amd64, Windows/amd64, and Linux/arm64. For each target the test generates a fresh context-bound proposal; the negative consumer is rejected after Do-to-Serve, while a compatible consumer returns a checked receipt naming that target. The full Docker Go helper suite passes under Go 1.25 (110.892s). The language, reconstruction-stage, and readiness matrices now document the bounded current-target behavior and its limits.
- Module-wide exported Go method renaming now detects an inactive Go source file in the same package that declares another build-specific variant of the selected receiver method. The helper rejects the single-target rename and names the inactive file instead of leaving that public API variant unchanged. A focused Linux/Windows source fixture passes; the complete Go helper suite passes under Go 1.25 (90.220s). The language, reconstruction-stage, and readiness matrices document the guard and its limits.
- Exported Go method rename now inspects inactive module files for matching selector spellings, then re-type-checks applicable alternate contexts and compares the resolved Go method identity. A Windows-only cross-package Worker.Do use blocks a Linux-targeted Do-to-Serve rename, while an unrelated Other.Do in the same inactive package does not. The focused regression and full Docker Go helper suite pass under Go 1.25 (90.773s). Language, reconstruction-stage, and readiness matrices now document this fail-closed guard.
- Discovered downstream Go consumer snapshots are now checked against original and renamed APIs across the applicable bounded target-context matrix, with checked GOOS/GOARCH/tags returned in the compatibility receipt. Positive consumer fixtures pass on Linux/amd64, Windows/amd64, and Linux/arm64; a Windows-only consumer reference blocks Do-to-Serve. The full Go helper suite passes under Go 1.25 (92.009s); safe-renames route tests pass 11/11, Docker TypeScript type-check and targeted ESLint pass.
- A Windows-only downstream Go consumer file guarded by `windows && downstream_extra` blocks a Linux-requested Do-to-Serve rename when that custom tag is selected; successful receipts preserve the tag across Linux/amd64, Windows/amd64, and Linux/arm64. Focused custom-tag/context tests pass, and the full Docker Go helper suite passes under Go 1.25 (91.383s). The language, reconstruction-stage, and readiness matrices now document the tested tag and remaining scope.

**Score decision:** Award one partial point to cross-file semantic rename propagation for verifying that a custom build tag remains active during alternate-target downstream checks: a Windows-only consumer guarded by `windows && downstream_extra` blocks the Linux-requested rename, and successful receipts preserve that tag across the checked Linux/amd64, Windows/amd64, and Linux/arm64 contexts. Focused tests and the full Docker Go helper suite pass under Go 1.25 (91.383s). Cross-file propagation moves from 23% to 24%, raising weighted progress from 35.77% to 35.84% (+0.07 points). Other target/tag combinations, broader consumer discovery, and coordinated multi-target edits remain unverified.

**Next measurable gate:** Add consumer fixtures for more target-specific and compound build-tag combinations, then implement coordinated multi-target edits only where binding identity remains verified.

Refreshed from pushed commit `299a4ec`. This estimate includes product work and production security/reliability; it is not a release certification. See the [readiness matrix](docs/REAMON_READINESS_MATRIX.md) for release gates and the [progress matrix](docs/REAMON_PROGRESS.md) for workstream evidence.

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
