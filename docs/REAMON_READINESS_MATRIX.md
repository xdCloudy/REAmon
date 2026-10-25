# REAmon production readiness matrix

This matrix tracks evidence required to operate REAmon reliably and securely. A
capability marked implemented describes code in the repository; it does not mean the
currently running installation has that change or that the whole product is ready for
production.

## Current gates

| Area | State | Evidence in this assessment | Remaining gate |
| --- | --- | --- | --- |
| Sensitive agent REST access | Implemented in the current source patch | 22 workspace, session, job, emergency-stop, and agent-session-stop routes require a configured master key. Missing or placeholder configuration returns 503; wrong and scanner-only keys return 401. The webapp server proxies use the shared authenticated agent client. | Rebuild/restart the deployed agent and webapp, then verify the authenticated proxy path on the LAN deployment. |
| MSF/Hydra progress and session sidecars | Implemented in the current source patch | Ports 8013/8014 require the shared `MCP_AUTH_TOKEN` on progress and session-control routes; only data-free health checks are public. Agent callers now send the bearer token. Standalone MCP compose publishes service ports on loopback. Focused handler tests pass (14 tests plus 3 subtests), and root, agent-standalone, and MCP-standalone compose configurations parse. | Rebuild/restart the Kali and agent services, then verify authenticated polling/control and rejected anonymous requests in the deployed stack. |
| Workspace project ownership | Implemented at the webapp boundary | Workspace API routes continue to call `guardProject`; direct agent REST access now also requires a service key. | Exercise owner and non-owner requests through the deployed webapp. |
| Session ownership and multi-user isolation | Admin-only interim guard; per-user isolation unverified | Webapp session listing, interaction, and kill routes plus job kill and emergency-stop routes require administrator access. Fourteen focused route tests cover unauthenticated, standard-user, and administrator behavior. The process-wide session manager still has no project ownership parameter. | Add and validate project/user ownership metadata before enabling these operations for non-admin users; define legacy-session behavior and test cross-user isolation. |
| Production dependency audit | Pass for production dependencies | Updated `webapp/package-lock.json` resolves the reported production advisories; isolated `npm audit --omit=dev` returned zero findings. | Re-run the audit against the committed lockfile in CI and review development-only advisories separately. |
| Security review coverage | Partial; repository-wide review in progress against `e124cc69` | The upload buffering findings are addressed in the current source patch: the workspace file browser streams through its guarded proxy to bounded-memory disk writes, direct multipart browser-artifact uploads are rejected in favor of resumable chunks, and the chunk endpoint enforces 16 MiB while reading without relying on `Content-Length`. Focused webapp and Docker Python tests pass. The current repository-wide scan has not produced findings or final coverage yet. | Rebuild and exercise the upload path in the deployed LAN stack; finish review of archive/parser, persistence/recovery, providers, CI/deployment, and supply-chain surfaces; address any remaining validated findings. |
| Agent Python auth tests | Pass, focused | Docker run: `tests/test_rest_auth.py` and `tests/test_graph_exec.py` passed (6 tests plus 5 subtests). Cases cover missing, placeholder, wrong, scanner-only, and valid master credentials, route dependency coverage, and a working session proxy response. | Keep the focused auth coverage in the release gate. |
| Webapp auth/proxy tests | Pass, focused | `agentFetch.test.ts`, `agentAuth.test.ts`, the purge ownership test, and conversation ownership tests passed (39 tests). The current-source session/job/emergency-stop guard suites and import-artifact route passed 22 tests; `npm run type-check` passed. | Keep the focused proxy coverage in the release gate and include the new admin-guard suites in CI. |
| Full agent unit suite | Pass, current source | The isolated Docker unit suite passed 3,736 tests across 179 files; one additional file contained no tests and was reported empty/skipped. | Keep the isolated full agent suite in the release gate and rerun after changes to agent code. |
| Full webapp suite | Pass, current working tree | On 2026-10-25, `npm run test` completed on the current webapp source: 597 files, 581 passed and 16 skipped; 9,475 tests passed, 2 expected failures, 138 skipped, and 0 failed. The run took 1,066 seconds on the Windows host. The two native `strings` process integration cases are explicitly skipped on Windows; they still require the Linux container gate. | Keep the full suite in CI and run the process-provider integration cases in the Linux webapp container. |
| Full repository verification | Partial | The current-source full agent unit suite previously passed 3,736 tests across 179 files. The full current-source webapp suite now passes. TypeScript build checking and ESLint passed for all changed webapp files. Shell and other service release sections were not run in this assessment. | Run the remaining Docker shell and service gates against the same committed source state; keep the agent and webapp gates in CI. |
| DEX analyzer scratch capacity | Source fix implemented; deployment unverified | DEX request scratch now uses a dedicated disk-backed Docker volume in source, avoiding the 1 GiB memory-backed `/tmp` competing with extracted input, Java output, and structured evidence. The analyzer's 10 focused Python tests pass in Docker and the root compose file parses with validation-only required secrets. | Rebuild and restart the analyzer after the current QA run, then verify large-request scratch placement, cleanup after cancellation/restart, and disk-space failure reporting. |
| Deployment, upgrade, and restore | Partial; local liveness verified | On 2026-10-25, `http://localhost:3001/api/health` returned `status: ok`; Docker reported the webapp and agent healthy and `reamon-worker` running. A read-only registry check found 1 fresh heartbeat, 9 stale registrations, and 47 historical registrations; the newest heartbeat was 2 seconds old. The agent's direct `/health` request returned 401 without its service key, consistent with the authenticated boundary. These checks describe the currently running stack; the upload changes in this branch have not been deployed. | Rebuild/restart the services and validate large-import recovery, worker execution, upgrade, backup, and restore on a clean installation. |

## Release blockers

1. Finish the security scan across the deferred surfaces and address validated P0
   findings.
2. Keep the webapp and agent unit gates green in CI, then run the remaining Docker shell and service checks against the same release candidate.
3. Add project/user ownership metadata for Metasploit sessions before enabling
   session and job controls for non-admin users.
4. Rebuild the services and verify authenticated REST proxy access and LAN WebSocket
   access together.
5. Run the release backup and restore procedure and verify a real worker lifecycle.

## How to read the weighted progress estimate

The README bar estimates progress across the product mission and production operations.
It is calculated from the workstream weights in [`REAMON_PROGRESS.json`](REAMON_PROGRESS.json).
The estimate is not a release decision: unresolved security coverage, failing full
tests, or unverified deployment gates can block release even when the weighted score
is high. The detailed capability state remains in the [feature matrix](REAMON_FEATURE_MATRIX.md)
and [language matrix](REAMON_LANGUAGE_MATRIX.md).
