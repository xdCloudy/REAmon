# REAmon product progress

Assessment date: 2026-10-25 · Source: pushed commit `049fa13` · Weighted estimate: **50.2%**

This estimate covers the reverse-engineering product goal and secure production operations. It is not a release certification; unresolved security, test, or deployment gates can block release at any score. Workstream weights total 100%; each contribution is weight × completion.

The weighted estimate is 50.2% after reducing the security and reliability workstream to reflect three validated issues in the repository-wide source review: high-severity stdio MCP command execution in the shared root agent, medium-severity cross-user exposure of global tunnel credentials, and medium-severity shared storage exhaustion through repeated workspace imports. The review remains in discovery; broad repository coverage, deployment configuration, and runtime validation are incomplete. A conditional CodeFix host-network reachability candidate is deferred because runtime routing is unverified and the production overlay loopback-binds published services. The import finding does not call for a fixed product upload cap; capacity-aware admission can protect the shared volume while preserving large imports when storage is available. The focused security review against e124cc69 identified eight distinct issues after one duplicate was reconciled, and source mitigations were implemented. Current quality run 40203489236 is pending. In run 40202795405, image build, readiness, authenticated artifact acceptance, webapp checks, Compose configuration, and dependency audits passed; the browser login smoke failed and the canonical Docker unit gate remained in progress. The webapp from 0eb199f9 is healthy with database and artifact readiness on localhost and the LAN. Broker and analysis service rebuilds and broader LAN validation remain open.

| Workstream | Goal weight | Estimated complete | Weighted points |
| --- | ---: | ---: | ---: |
| Core analysis and visualizer workflow | 16% | 76% | 12.16 pts |
| Database-grounded project memory and provenance | 16% | 73% | 11.68 pts |
| Major-language and format decompilation fluency | 24% | 35% | 8.40 pts |
| Maintainable editing, review, and export | 12% | 43% | 5.16 pts |
| Fixture-backed validation and fidelity evidence | 12% | 15% | 1.80 pts |
| Security, reliability, and production operations | 20% | 55% | 11.00 pts |

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

**Current evidence:** The focused Standard security review against e124cc69 produced eight distinct findings after one duplicate was reconciled, with source mitigations implemented. A new repository-wide source review has validated one high-severity issue (user-controlled stdio MCP command execution in the shared root agent) and two medium-severity issues (cross-user tunnel credential disclosure and unbounded shared-storage use through repeated workspace imports). Discovery remains incomplete; a CodeFix host-network reachability candidate is deferred pending deployment evidence. The canonical Docker gate remains in progress and the browser login smoke failed; deployment and service rebuild checks remain open.

**Remaining:** Close the three validated findings while preserving the requested no-fixed-upload-cap behavior through capacity-aware storage admission; complete repository-wide source discovery and deployment review; resolve canonical CI and browser login smoke failures; rebuild the broker and affected analysis services; and verify recovery, load, backup, and restore on the release candidate.

The machine-readable [`REAMON_PROGRESS.json`](REAMON_PROGRESS.json) feeds the README progress bar. The scope now includes the production hardening goal, so the total is not directly comparable with the previous product-only estimate. Update it with evidence when estimates change, then run `node tooling/reamon/update-product-progress.mjs <commit-sha>` to refresh this matrix and the README.
