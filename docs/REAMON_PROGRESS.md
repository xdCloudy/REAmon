# REAmon product progress

Assessment date: 2026-10-25 · Source: pushed commit `1977449` · Weighted estimate: **50.2%**

This estimate covers the reverse-engineering product goal and secure production operations. It is not a release certification; unresolved security, test, or deployment gates can block release at any score. Workstream weights total 100%; each contribution is weight × completion.

The repository-wide source-only security review validated five findings: one high, three medium, and one low. The user-controlled MCP stdio process-execution finding is blocked at webapp draft-test/reload and agent test/reload boundaries; saved user stdio entries are skipped and the settings UI marks them unavailable. The global tunnel credential finding is mitigated by requiring the master internal key and returning only a sanitized Chisel origin. Focused Docker tests pass (44 webapp and 50 agent tests for stdio; 90 webapp route and middleware tests for tunnel access), and independent read-only reviews found no bypass. Two findings remain open; shared artifact-volume exhaustion now has capacity-aware admission in source, with focused Docker tests passing and deployment verification pending. Review coverage is partial; exhaustive source discovery and deployment/runtime validation remain open. CodeFix host-gateway reachability and scanner Neo4j credential isolation remain deferred pending deployment and execution-path evidence. Preserve unlimited import sizing; the new admission check reserves live free capacity across active imports and tracks acknowledged browser chunks. The focused review against e124cc69 identified eight distinct issues after one duplicate was reconciled, with source mitigations implemented. Latest quality run 40204560134 passed webapp checks, Compose configuration, dependency audit, production image build, readiness, and authenticated acceptance; its browser login smoke failed, and its canonical Docker unit gate was still running at the latest check. The focused import-capacity, chunk, and storage tests pass (24 tests across three Docker-run files); the full webapp type-check remains blocked by existing stale generated-Prisma-client and test-fixture errors. The prior webapp build from 0eb199f9 was healthy on localhost and LAN; broker and analysis service rebuilds and broader LAN validation remain open.

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

**Current evidence:** The focused Standard review against e124cc69 produced eight distinct findings after one duplicate was reconciled, with source mitigations implemented. A repository-wide source-only review validated five current findings. The high finding (user-controlled stdio MCP execution in the shared root agent) is blocked at webapp and agent boundaries, with legacy saved entries skipped and clearly marked unavailable; focused Docker tests pass (44 webapp and 50 agent), and an independent read-only review found no bypass. One medium finding (global tunnel credential disclosure) is mitigated: only the master internal key can read the endpoint, and its response contains a sanitized Chisel origin without ngrok or Chisel credentials, URL userinfo, path, or query; 90 focused webapp tests pass and independent review found no bypass. Shared artifact-volume exhaustion is mitigated in source with dynamic admission against statfs free space plus active-import reservations; browser upload acknowledgements release reserved bytes and finalization atomically renames staging files to avoid transient duplicate storage. Focused Docker tests pass (23 tests across import admission, chunk accounting, and storage capacity); independent review and deployment verification are pending. One medium finding (cross-user Kali temporary-file disclosure) and one low finding (nested MCP secret masking bypass in admin settings) remain open. Review coverage is partial; CodeFix host-gateway reachability and scanner Neo4j credential isolation remain deferred. The latest quality run 40204560134 passed webapp checks, Compose configuration, dependency audit, production image build, readiness, and authenticated acceptance; browser login smoke failed and the canonical Docker unit gate was still running at last check. The available full webapp type-check reports existing Prisma-client and test-fixture errors. Deployment and service rebuild checks remain open.

**Remaining:** Remediate the two remaining findings; independently review and deploy-verify storage admission while preserving unlimited import sizing; complete repository and deployment review; diagnose and pass the browser login smoke and canonical Docker unit gate; rebuild the broker and affected analysis services; implement per-user isolation before restoring user-configured MCP stdio; and verify recovery, load, backup, and restore on the release candidate.

The machine-readable [`REAMON_PROGRESS.json`](REAMON_PROGRESS.json) feeds the README progress bar. The scope now includes the production hardening goal, so the total is not directly comparable with the previous product-only estimate. Update it with evidence when estimates change, then run `node tooling/reamon/update-product-progress.mjs <commit-sha>` to refresh this matrix and the README.
