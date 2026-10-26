# REAmon product progress

Assessment date: 2026-10-26 · Source: pushed commit `854e294` · Weighted estimate: **51.4%**

This estimate covers the reverse-engineering product goal and secure production operations. It is not a release certification; unresolved security, test, or deployment gates can block release at any score. Workstream weights total 100%; each contribution is weight × completion.

Quality run [40247230850](https://github.com/xdCloudy/REAmon/actions/runs/40247230850) passed on commit `baa5634a`: all five jobs passed, including the canonical Docker unit gate and production-stack smoke with authenticated acceptance, browser login, worker recovery/load, and PostgreSQL/artifact plus Neo4j restore drills. On 2026-10-26, both local and LAN readiness endpoints returned ready with database and artifact checks ok. The running webapp image has no source revision label, and the healthy Kali container still runs as root with a read/write shared workspace mount. Source review also found that signed project context is not injected into every arbitrary-code tool, and Docker broker ownership is global rather than tenant-scoped. Four of five validated security findings have source mitigations; shared Kali shell and `/tmp` cross-project access remains open. The legacy unscoped agent file-download route has been removed, and terminal identity spoofing is fixed, but neither closes shared execution exposure. Weighted progress remains an evidence-based estimate, not release certification.

| Workstream | Goal weight | Estimated complete | Weighted points |
| --- | ---: | ---: | ---: |
| Core analysis and visualizer workflow | 16% | 76% | 12.16 pts |
| Database-grounded project memory and provenance | 16% | 73% | 11.68 pts |
| Major-language and format decompilation fluency | 24% | 35% | 8.40 pts |
| Maintainable editing, review, and export | 12% | 43% | 5.16 pts |
| Fixture-backed validation and fidelity evidence | 12% | 15% | 1.80 pts |
| Security, reliability, and production operations | 20% | 61% | 12.20 pts |

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

**Current evidence:** Four of five findings validated in the repository-wide source review have source mitigations. User-configured stdio MCP execution remains disabled at webapp and agent boundaries pending isolation; global tunnel credential access is restricted to the master key and returns a sanitized origin; shared artifact-volume exhaustion has dynamic free-space admission and active-import reservations; MCP deletion responses mask retained credential values. Shared Kali shell and `/tmp` cross-project disclosure remains open. Quality run [40247230850](https://github.com/xdCloudy/REAmon/actions/runs/40247230850) passed all five CI jobs, including the full Docker unit gate and production-stack acceptance. On 2026-10-26, local and LAN health checks passed but the webapp revision was unverified. The Kali container still runs as root with a read/write shared workspace mount. Signed project context is not injected into every arbitrary-code tool, and broker ownership is not tenant-scoped. The legacy agent `/files?path=/tmp/...` endpoint is removed and terminal identity spoofing is fixed, but neither change isolates the shared shell or temporary directory.

**Remaining:** Remediate cross-user Kali temporary-file disclosure; independently review storage admission; validate service rebuilds and controls on the LAN deployment; implement per-user process isolation before restoring user-configured MCP stdio; and complete broader security, upgrade, backup, and restore review on the deployed release candidate.

The machine-readable [`REAMON_PROGRESS.json`](REAMON_PROGRESS.json) feeds the README progress bar. The scope now includes the production hardening goal, so the total is not directly comparable with the previous product-only estimate. Update it with evidence when estimates change, then run `node tooling/reamon/update-product-progress.mjs <commit-sha>` to refresh this matrix and the README.
