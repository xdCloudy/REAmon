# REAmon product progress

Assessment date: 2026-10-25 · Source: pushed commit `5713fbc` · Weighted estimate: **51.2%**

This estimate covers the reverse-engineering product goal and secure production operations. It is not a release certification; unresolved security, test, or deployment gates can block release at any score. Workstream weights total 100%; each contribution is weight × completion.

The weighted score remains 51.2%; no workstream estimate changed because release and fidelity gates remain open. The focused Standard security review against e124cc69 identified eight distinct issues after one duplicate was reconciled, and source mitigations were implemented for those findings. A new repository-wide Standard review against 82259110 is still in threat modeling; discovery is incomplete and no current whole-repository results are validated. Abandoned browser-import staging expires after a configurable inactivity window (30 days by default), active chunks refresh the timestamp, cleanup claims expired rows conditionally, and only that import staging directory is removed. The project import panel reports shared artifact-volume total, used, and available bytes from filesystem statistics without walking stored files or enforcing a quota. Six focused import/capacity files pass 40 tests, webapp type-check passes, and the Docker broker policy suite passes 57 checks. The webapp image built from 0eb199f9 is healthy, with database and artifact readiness checks passing on localhost and the LAN. Quality run 40200537024 exposed a retired multipart upload route (HTTP 415), a stale Go-download architecture expectation, and four Linux webapp test failures. In corrected run 40202795405, image build, readiness, authenticated artifact acceptance, webapp checks, Compose configuration, and dependency audits passed, but the browser login smoke failed; its canonical Docker unit gate was still in progress at assessment time. Quality run 40203162164 for 82a7e745 was queued. The broker and analysis services have not been rebuilt, and broader LAN validation remains open.

| Workstream | Goal weight | Estimated complete | Weighted points |
| --- | ---: | ---: | ---: |
| Core analysis and visualizer workflow | 16% | 76% | 12.16 pts |
| Database-grounded project memory and provenance | 16% | 73% | 11.68 pts |
| Major-language and format decompilation fluency | 24% | 35% | 8.40 pts |
| Maintainable editing, review, and export | 12% | 43% | 5.16 pts |
| Fixture-backed validation and fidelity evidence | 12% | 15% | 1.80 pts |
| Security, reliability, and production operations | 20% | 60% | 12.00 pts |

## Evidence and remaining work

### Core analysis and visualizer workflow

**Current evidence:** Imports, provider execution, database-backed code units, source navigation, and a multi-provider visualizer are established across several language and binary workflows. A worker-run SLB2 inspection of the 1.26 GB PS5 QA artifact completed and persisted two bounded container facts; wider fixture validation remains open.

**Remaining:** Provider runtime and fidelity vary by format. Broad real-world fixture comparison, remaining provider validation, and consistent recovery across large projects are still open.

### Database-grounded project memory and provenance

**Current evidence:** Project observations, symbols, relationships, source drafts, review receipts, hashes, provider versions, and run evidence ground AI context and cross-provider name reuse. Analyst-reviewed cross-artifact function matches now persist exact pair evidence and supply bounded naming context to explanations and rewrites for exact matched functions, with duplicate pair records resolved by their latest analyst review. Their matcher includes a separately stored, low-weight exact string-reference overlap when both providers supply complete lists. A bounded REA Evidence v2 bundle importer validates canonical identities and manifests, stores complete provider-attributed records idempotently, links only exact artifact hashes, and supplies a bounded untrusted subset to rewrite context.

**Remaining:** Coverage and consistency still need validation across all formats, providers, and long-running project histories.

### Major-language and format decompilation fluency

**Current evidence:** Useful Java, Android, .NET, Python, WebAssembly, native, and additional format paths exist at different maturity levels.

**Remaining:** Major languages need idiomatic source recovery, broader project-level coverage, and versioned validation; several formats remain alternate views or early experiments.

### Maintainable editing, review, and export

**Current evidence:** Hash-bound drafts and immutable review receipts preserve lineage, with syntax validation, an early Java rebuild, and language-specific rename workflows now extending to C/C++ local bindings.

**Remaining:** Project-wide edits, cross-file builds, more target-format rebuilds, and runtime or behavior validation remain limited; representative C/C++ projects and compiler-version coverage still need evaluation.

### Fixture-backed validation and fidelity evidence

**Current evidence:** Provider smoke checks, structural validators, and a small number of synthetic round-trip cases provide early evidence.

**Remaining:** Build a broad, versioned fixture suite for clean, optimized, stripped, and obfuscated inputs and compare recovered behavior and fidelity.

### Security, reliability, and production operations

**Current evidence:** Source mitigations address all eight distinct issues from the focused Standard security review. A new repository-wide Standard review is in threat modeling, with discovery and validation still outstanding. Six focused import/capacity files pass 40 tests, webapp type-check passes, and the Docker broker policy suite passes 57 checks. The webapp image is rebuilt and localhost/LAN readiness checks pass; CI has an active canonical unit gate and a failed browser login smoke, while broker and analysis-service validation and broader security coverage remain open.

**Remaining:** Complete and validate the current repository-wide security review. Rebuild and validate the broker and affected analysis services, then exercise authenticated import, capacity reporting, worker execution, and authorization flows against the LAN deployment. Clear the canonical CI and browser login smoke failures, then complete worker lifecycle and backup/restore gates.

The machine-readable [`REAMON_PROGRESS.json`](REAMON_PROGRESS.json) feeds the README progress bar. The scope now includes the production hardening goal, so the total is not directly comparable with the previous product-only estimate. Update it with evidence when estimates change, then run `node tooling/reamon/update-product-progress.mjs <commit-sha>` to refresh this matrix and the README.
