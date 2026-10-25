# REAmon product progress

Assessment date: 2026-10-25 · Source: pushed commit `c02e525` · Weighted estimate: **50.4%**

This estimate covers the reverse-engineering product goal and secure production operations. It is not a release certification; unresolved security, test, or deployment gates can block release at any score. Workstream weights total 100%; each contribution is weight × completion.

Quality run [40215508683](https://github.com/xdCloudy/REAmon/actions/runs/40215508683) checked source commit b8359c7d, before the PostgreSQL advisory-lock scalar fix, and its authenticated acceptance log confirms Prisma could not deserialize the lock function void return. Commit a3ebcda9 contains the materialized-CTE scalar fix and scanner-signature/Java rewrite fixture fixes; intermediate run [40216395830](https://github.com/xdCloudy/REAmon/actions/runs/40216395830) was cancelled after a newer push. The corrected source and lightweight orchestrator/broker test-import fixes are pushed; the current [quality workflow](https://github.com/xdCloudy/REAmon/actions/workflows/reamon-quality.yml) is pending. The full canonical unit gate for 40215508683 has not completed. Focused Docker suites pass for import admission (12), generated file scoping (4 agent and 4 webapp), architecture-aware Go setup (4), scanner scope HMACs (26), Java member rewrite (30), supply-chain refresh (19), GVM settings (80 plus 34 subtests), tunnel settings (21 plus six expected failures), AI lab fixture (25), and orchestrator settings defaults (41). The broker parity test change awaits CI. Shared Kali shell and /tmp still permit cross-user reads, so that medium finding remains open. Weighted progress is evidence-based, not release certification. The lock CTE returned integer 1 in a rolled-back local PostgreSQL transaction. Acceptance on the fixed source and full CI gates remain unresolved.

| Workstream | Goal weight | Estimated complete | Weighted points |
| --- | ---: | ---: | ---: |
| Core analysis and visualizer workflow | 16% | 76% | 12.16 pts |
| Database-grounded project memory and provenance | 16% | 73% | 11.68 pts |
| Major-language and format decompilation fluency | 24% | 35% | 8.40 pts |
| Maintainable editing, review, and export | 12% | 43% | 5.16 pts |
| Fixture-backed validation and fidelity evidence | 12% | 15% | 1.80 pts |
| Security, reliability, and production operations | 20% | 56% | 11.20 pts |

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

**Current evidence:** The focused Standard review against e124cc69 produced eight distinct findings after one duplicate was reconciled, with source mitigations implemented. A repository-wide source-only review validated five current findings. The high finding (user-controlled stdio MCP execution in the shared root agent) is blocked at webapp and agent boundaries, with legacy saved entries skipped and clearly marked unavailable; focused Docker tests pass (44 webapp and 50 agent), and an independent read-only review found no bypass. One medium finding (global tunnel credential disclosure) is mitigated: only the master internal key can read the endpoint, and its response contains a sanitized Chisel origin without ngrok or Chisel credentials, URL userinfo, path, or query; 90 focused webapp tests pass and independent review found no bypass. Shared artifact-volume exhaustion is mitigated in source with dynamic admission against statfs free space plus active-import reservations; browser upload acknowledgements release reserved bytes and finalization atomically renames staging files to avoid transient duplicate storage. Focused Docker tests pass (24 tests across import admission, chunk accounting, and storage capacity); independent review and deployment verification are pending. The low finding in MCP settings DELETE is mitigated in source: retained auth tokens, custom header values, and environment values are masked in the response, while storage and agent reload retain raw configuration. Its focused Docker regression test passes. One medium finding (cross-user Kali temporary-file disclosure) remains open. Review coverage is partial; CodeFix host-gateway reachability and scanner Neo4j credential isolation remain deferred. The latest quality run 40207938439 is pending; the prior run passed webapp checks, Compose configuration, dependency audit, production image build, readiness, and authenticated acceptance, but its browser login smoke failed and its canonical Docker unit gate was still running at last check. The available full webapp type-check reports existing Prisma-client and test-fixture errors. Deployment and service rebuild checks remain open.

**Remaining:** Remediate the remaining cross-user Kali temporary-file disclosure; independently review and deploy-verify storage admission while preserving unlimited import sizing; complete repository and deployment review; diagnose and pass the browser login smoke and canonical Docker unit gate; rebuild the broker and affected analysis services; implement per-user isolation before restoring user-configured MCP stdio; and verify recovery, load, backup, and restore on the release candidate.

The machine-readable [`REAMON_PROGRESS.json`](REAMON_PROGRESS.json) feeds the README progress bar. The scope now includes the production hardening goal, so the total is not directly comparable with the previous product-only estimate. Update it with evidence when estimates change, then run `node tooling/reamon/update-product-progress.mjs <commit-sha>` to refresh this matrix and the README.
