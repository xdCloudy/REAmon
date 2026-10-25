# REAmon production readiness matrix

This matrix tracks evidence required to operate REAmon reliably and securely. A
capability marked implemented describes code in the repository; it does not mean the
currently running installation has that change or that the whole product is ready for
production.

## Current gates

| Area | State | Evidence in this assessment | Remaining gate |
| --- | --- | --- | --- |
| Sensitive agent REST access | Implemented in the current source patch | 22 workspace, session, job, emergency-stop, and agent-session-stop routes require a configured master key. Missing or placeholder configuration returns 503; wrong and scanner-only keys return 401. The webapp server proxies use the shared authenticated agent client. | Rebuild/restart the deployed agent and webapp, then verify the authenticated proxy path on the LAN deployment. |
| Workspace project ownership | Implemented at the webapp boundary | Workspace API routes continue to call `guardProject`; direct agent REST access now also requires a service key. | Exercise owner and non-owner requests through the deployed webapp. |
| Session ownership and multi-user isolation | Unverified | Session manager requests pass through login-gated webapp handlers and the agent REST boundary. | The session manager API has no project ownership parameter for list/interact/kill; define and validate the intended shared-session policy before claiming per-user isolation. |
| Security review coverage | Partial | A source-only repository scan found an unauthenticated agent REST boundary and the current patch addresses that path. The scan report explicitly marks coverage partial. | Scan deferred project authorization, upload/archive handling, process/container isolation, persistence/recovery, deployment/CI, providers, and supply-chain surfaces. Re-scan those paths. |
| Agent Python auth tests | Pass, focused | Docker run: `tests/test_rest_auth.py` and `tests/test_graph_exec.py` passed (6 tests plus 5 subtests). Cases cover missing, placeholder, wrong, scanner-only, and valid master credentials, route dependency coverage, and a working session proxy response. | Complete the full agent unit gate and record its final result. |
| Webapp auth/proxy tests | Pass, focused | `agentFetch.test.ts`, `agentAuth.test.ts`, the purge ownership test, and conversation ownership tests passed (39 tests). `npm run type-check` passed. | Complete the full webapp suite and resolve its current unrelated failures. |
| Full repository verification | Incomplete | The full webapp suite currently reports failures in MCP tool catalog, task execution, visualizer, imports, and other areas. The agent's 179-file isolated unit gate is still running and has not returned a summary. | Obtain clean, repeatable unit-gate results across the agent, webapp, shell, and service sections. |
| Deployment, upgrade, and restore | Not verified here | Docker Compose and a single-host deployment runbook exist. LAN WebSocket routes were not changed by the REST auth patch. | Validate the documented deployment, worker check-in, large-import recovery, upgrade, backup, and restore flows on a clean installation. |

## Release blockers

1. Finish the security scan across the deferred surfaces and address validated P0
   findings.
2. Resolve full unit-gate failures and make the repository's Docker checks repeatable.
3. Decide how Metasploit sessions are scoped when multiple signed-in users share one
   installation.
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
