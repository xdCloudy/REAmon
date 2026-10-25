# REAmon product progress

Assessment date: 2026-10-25 · Source: pushed commit `389ed57` · Weighted estimate: **49.0%**

This is an estimate of progress toward the long-term product goal, not a release-readiness score. Workstream weights total 100%; each contribution is weight × completion.

| Workstream | Goal weight | Estimated complete | Weighted points |
| --- | ---: | ---: | ---: |
| Core analysis and visualizer workflow | 20% | 76% | 15.20 pts |
| Database-grounded project memory and provenance | 20% | 73% | 14.60 pts |
| Major-language and format decompilation fluency | 30% | 35% | 10.50 pts |
| Maintainable editing, review, and export | 15% | 43% | 6.45 pts |
| Fixture-backed validation and fidelity evidence | 15% | 15% | 2.25 pts |

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

The machine-readable [`REAMON_PROGRESS.json`](REAMON_PROGRESS.json) feeds the README progress bar. Update it with evidence when the estimates change, then run `node tooling/reamon/update-product-progress.mjs <commit-sha>` to refresh both this matrix and the README.
