# REAmon product progress

Assessment date: 2026-10-26 · Source: pushed commit `9d07e0f` · Weighted estimate: **57.4%**

This estimate covers the reverse-engineering product goal and secure production operations. It is not a release certification; unresolved security, test, or deployment gates can block release at any score. Workstream weights total 100%; each contribution is weight × completion.

Quality run [40247230850](https://github.com/xdCloudy/REAmon/actions/runs/40247230850) passed the full Docker unit gate and production-stack acceptance on commit `baa5634a`; local and LAN readiness endpoints returned ready with database and artifact checks ok, but the deployed webapp revision remains unverified. On 2026-10-26, kali_shell, execute_code, proxy_brain, and execute_playwright gained verified signed project scope, user/mount/PID namespaces, project-only workspaces, and per-project /tmp scratch. /var/tmp, /dev/shm, and /opt/output remain per-run private mounts. Generated files are canonicalized under project scratch and moved to a unique project tool-outputs path without a second full-size copy. The project root is read-only to the sandbox UID; only scratch and tool-outputs are writable. Focused Docker suites passed 46 MCP execution/capture/Playwright tests plus 5 subtests and 15 agent identity/generated-file tests. Live Kali smokes verified read-only project roots, writable project scratch and tool-outputs, canonical same-mount generated-file transfer, compiled C output, and sibling workspace/scratch/process isolation. The rebuilt active Kali image launches Chromium version 156.0.8078.4. Terminal shells retain ticket-derived project scope and cleanup behavior. Legacy graph routes reject scanner-only auth and the agent rejects identical master and scanner keys. Broker-managed workers now route kali_shell, execute_code, execute_playwright, and proxy_brain through signed-scope verification, a four-container admission cap, project-only mounts, resource limits, capped output, and per-run cleanup. Thirteen focused broker worker tests and 14 MCP execution tests pass in Docker; the 27-case capture-routing suite also passes. A live Docker Engine smoke verified read-only workspace, writable project scratch, separate stdout/stderr, and worker/network cleanup. The rebuilt local agent, Kali, and broker containers are healthy. A valid agent-signed kali_shell request completed through the broker and disposable worker with exit code 0; worker container and network cleanup were confirmed. Chromium launched in the active Kali container at version 156.0.8078.4. Terminal execution, worker storage quotas, scoped broker ownership, egress policy, generated-file transfer, and upgrade/backup/restore validation remain open. This weighted estimate is evidence-backed progress, not release certification. The active Kali execution wrapper now applies RLIMIT_NOFILE=256 and RLIMIT_CORE=0 through util-linux prlimit to each arbitrary-code child; focused Docker coverage and a live-image probe verified both limits. This does not replace the remaining worker-level CPU, memory, disk, and lifetime controls. The interactive terminal now inherits the same `RLIMIT_NOFILE=256` and `RLIMIT_CORE=0` through its PTY launcher; the focused terminal plus arbitrary-execution Docker suites pass. The interactive terminal now enters a private PID namespace as well as user and mount namespaces. Docker unit coverage passes (7 tests plus 4 subtests), and a live Kali smoke confirmed the shell is PID 1 with only itself and `ps` visible in `/proc`. The Docker broker now fails closed when the configured active broker-container cap cannot be verified; focused Docker broker plumbing, ownership, and policy suites pass 88 checks, including proof that an unverified count denies creation without contacting Docker. The rebuilt active Kali image passes `pip check` with no broken requirements; legacy GraphQL-Cop, SSTImap, and AD dependencies are isolated from the MCP runtime, and their commands passed live startup smokes.

| Workstream | Goal weight | Estimated complete | Weighted points |
| --- | ---: | ---: | ---: |
| Core analysis and visualizer workflow | 16% | 76% | 12.16 pts |
| Database-grounded project memory and provenance | 16% | 73% | 11.68 pts |
| Major-language and format decompilation fluency | 24% | 35% | 8.40 pts |
| Maintainable editing, review, and export | 12% | 43% | 5.16 pts |
| Fixture-backed validation and fidelity evidence | 12% | 15% | 1.80 pts |
| Security, reliability, and production operations | 20% | 91% | 18.20 pts |

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

**Current evidence:** Broker-managed project workers route the four non-terminal execution tools through signed project context and disposable containers. The rebuilt local agent, Kali, and broker are healthy; signed dispatch and Chromium launch pass. The Kali shared Python environment now passes pip check after isolating legacy CLI dependencies.

**Remaining:** Route terminal execution through long-lived project workers; validate complete MCP-to-worker tool calls, generated-file transfer, cancellation, cleanup, egress, disk and idle-lifetime limits, tenant-scoped broker ownership, upgrades, backup, and restore.

The machine-readable [`REAMON_PROGRESS.json`](REAMON_PROGRESS.json) feeds the README progress bar. The scope now includes the production hardening goal, so the total is not directly comparable with the previous product-only estimate. Update it with evidence when estimates change, then run `node tooling/reamon/update-product-progress.mjs <commit-sha>` to refresh this matrix and the README.
