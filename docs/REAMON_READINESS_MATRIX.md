## Current PC deployment evidence (2026-10-29)

The latest LAN webapp runs `redamon-webapp:latest` from source revision
`d1182c73`; its image label and readiness response match. The local image ID is
`sha256:826a383bca4b3f29f7088f25627603e0e2b33285aa4c7ac2ca2a1a5cf3dc7490` and
the build manifest-list digest is
`sha256:cf5257d7e1448ee630a8b5c223d9459d1c4c525ad48af55d826909d37aef7564`.
Its `REAMON_BUILD_DIRTY` flag is true because the local checkout contains the
user-owned untracked `work/` directory. Local and LAN readiness at `localhost:3001` and
`192.168.0.53:3001` return `ready`; database, Neo4j, and artifact checks are
`ok`.

Protection inspection now distinguishes direct marker evidence (`detected`),
structural indicators (`suspected`), and no recognized evidence (`unknown`). A
direct marker does not confirm a protector family. Focused Docker protection
tests passed: 61 passed, 1 skipped. The production image was built from
`d1182c73` and deployed. The deployed
visualizer retrieves compatible provider outputs across all completed tasks for
the selected artifact/input hash, rather than dropping candidates after the
newest 500 tasks. Each request scans up to 100 matching observations and returns
up to 32 alternatives; cursor paging continues beyond those response bounds.
The focused Docker route and component tests pass 35/35; webapp TypeScript,
targeted ESLint, and the production build pass. Large-history database
pagination acceptance, disagreement adjudication, behavioral equivalence,
protected-layer extraction, and commercial-protector recovery remain open.

Preceding deployment `567236f3` used image manifest
`sha256:af0003b127f868dae8c18131074b90592d69a818c96467b7216d41ab83747258`.

Focused Docker/Vitest checks pass 33/33 tests across the investigation GET route,
dispatch route, and workspace task list; TypeScript and targeted ESLint pass, and
the production image builds and is healthy on LAN. GitHub quality run
[40830972729](https://github.com/xdCloudy/REAmon/actions/runs/40830972729) is
running for `c0cf3197`; its product-progress workflow passed. These focused checks
do not replace the full repository gate.

The latest complete local canonical `bash ./redamon.sh test unit` gate passed from
checkout `8c098dfc`: agent (3,788), root-agent (3,400), root-recon (570), recon
(4,151), recon-orchestrator (597), AI attack-surface (209), capture proxy (138),
and Docker broker (69), for 12,922 Docker-isolated tests total. All 25 shell suites
passed. Those root-gate counts predate the current commit; only the webapp suite has
been rerun completely on the current source so far.

Rechecked 2026-10-29: the REAmon Compose configuration validates, all active
services report running/healthy, and local plus LAN readiness return HTTP 200.
The webapp and worker remain on image
`sha256:1ec882b475ed8a4ceda014c49d60b7c6fe3142855ba8ced92ebe5ab46213bf12`
at revision `859655f199af`. A separate legacy `redamon` Greenbone stack had
stopped its PostgreSQL and OpenVAS scanner containers after a clean shutdown.
Starting the existing PostgreSQL container with its existing named volumes
restored PostgreSQL and `gvmd` health; starting the existing `ospd` container
restored `/run/ospd/ospd-openvas.sock` and loaded VT cache version
`202610070608`. Running `gvmd --get-scanners` as the `gvmd` user lists the
OpenVAS scanner at that socket. No containers were recreated and no volumes or
database contents were removed. The `ospd` container has no Docker healthcheck,
so its process/socket and GVMD scanner listing are the available readiness
evidence.

The broker now resolves the workspace agent by configured Compose project and
service labels when the configured container name is absent, and rejects
ambiguous or mismatched agents. Its isolated Docker unit section passes 60
tests at the earlier checkpoint. The current broker suite passes 69 tests.
Broker image `sha256:e01b4d9119128c344f3765e7313197fcd0925a8a479bdb5ec929c3bdaf805af1`
is healthy. A live worker-network probe attached the Compose agent, then used
the verified cleanup path to detach it and remove the network. A live broker
acceptance used agent-signed scopes for two disposable
projects: Project A wrote distinct `/tmp` and `tool-outputs` canaries; Project B
could not read either through its scratch path, direct workspace path, or a
parent traversal path. Both workspaces and all per-run worker containers and
networks were removed. This exercised `execute_code` only against the deployed
agent image revision `818efc164b68`; it does not prove the browser flow,
Playwright, Kali shell, generated-file download, or recovery of a live
authenticated terminal session. A separate broker-restart probe removed one
disposable orphan terminal worker and its network, including the agent endpoint.

A second live broker probe exercised the `execute_code`, `kali_shell`,
`execute_playwright`, and `proxy_brain` worker profiles with agent-signed scopes
for two disposable projects. Project A wrote unique canaries to `/tmp`, project
scratch, and `tool-outputs`; Project B could not read them through those paths,
a direct Project A workspace path, or parent traversal. The workers lacked the
tested service-credential environment variables, and the two temporary
workspaces plus all worker containers and networks were removed. The
Playwright and proxy-brain checks ran a Python isolation probe in each selected
worker image; they did not exercise the MCP adapters or real browser
automation. A direct signed-context terminal broker acceptance also returned
HTTP 200 and confirmed UID 65534, `/workspace` as its working directory, and
absence of the tested service credentials. Session exit removed its worker and
network; terminal exit, failed startup, broker restart recovery, and project
deletion now detach only a verified trusted-agent endpoint before deleting the
network. This did not exercise ticket authentication through the agent WebSocket.
Generated-file download, browser/MCP flow, restart recovery, and cross-user
acceptance remain open. See the [Kali isolation decision](REAMON_KALI_ISOLATION.md).

Latest verified checkpoint: commit `859655f1` is deployed on the PC as image
`sha256:1ec882b475ed8a4ceda014c49d60b7c6fe3142855ba8ced92ebe5ab46213bf12`.
The webapp and REAmon task worker containers are healthy; both
`localhost:3001/api/health/ready` and `192.168.0.53:3001/api/health/ready`
return HTTP 200 with database, Neo4j, and artifact checks `ok`, reporting
revision `859655f199af` and a clean source tree. Both containers use the same image
digest. Docker Desktop's
Linux engine had stopped; restarting Docker Desktop restored the existing
containers and volumes. The webapp and worker were then rebuilt and are healthy
without a data reset. All active Compose services and their health checks pass.
Removing the empty stale `redamon-orchestrator-net` resolved the Compose
network-label warning; the active `reamon-orchestrator-net` remains attached to
the webapp and Neo4j. The worker's authenticated Docker health check matches the
runtime worker ID and checks its persisted heartbeat; this surfaces a stale
worker as unhealthy but does not restart a still-running unhealthy process.
The full Docker webapp suite passed on the initial worker-health commit with
9,669 passed tests, 2 expected failures, and 147 skips; the follow-up identity
and allowlist changes passed 74 focused tests, type-check, ESLint, and Compose
configuration. The worker's normal task dispatch, rewrite dispatch, heartbeat,
graph projection, and backfill requests are now covered by exact internal-key
allowlist entries; wrong methods and neighboring routes remain denied. The
focused allowlist suite passes 56 tests, and the deployed webapp logs no
off-allowlist requests over a two-minute observation window. The full suite was
not rerun after this change.
The visualizer returns up to 32 hash-verified compatible provider outputs per
request, searching up to 100 matching observations across all completed tasks
for the same artifact/input hash. A stable cursor and “Load more provider
outputs” control continue beyond a page, with the newest verified result per
provider retained in the comparison. Task provenance is retrieved with each
observation instead of limiting the lookup to the newest 500 tasks. The focused
Docker route and visualizer suites pass; see the current deployment evidence
above for exact counts, image revision, and LAN readiness. Large-history
database pagination acceptance remains open.
At this 2026-10-28 checkpoint, the legacy `redamon-gvm-gvmd` container was
unhealthy because its PostgreSQL companion was stopped. The 2026-10-29 recheck
above records recovery of the existing database and scanner containers. The
PostgreSQL-backed workspace-import capacity
integration passed 3/3 in Docker against a dedicated 128 MiB tmpfs. It verified
serialized concurrent reservations, a manifest one byte over real tmpfs
capacity, and a real `ENOSPC` chunk write followed by successful same-offset
retry after freeing space. The disposable `CapacityProbe-*` project count was
zero after cleanup. Authorization was mocked inside the route test; this does
not establish authenticated HTTP or multi-broker LAN acceptance.
An opt-in archive-import integration also passed against the running PostgreSQL
database: the real API route recreated a fresh inert task, connected the
observation to it, preserved unavailable target/artifact IDs as provenance, and
omitted the source result and run token. The disposable project count was zero
after teardown. This database check uses route-auth mocks and is not
authenticated browser acceptance.
Project archive export now includes bounded task-history snapshots referenced
by REAmon observations. Import gives each snapshot a new ID and inert
`IMPORTED` status, omits execution payloads and credentials, and remaps
observations to the new task IDs. Original task IDs and unavailable target or
artifact references remain provenance; target/artifact rows and bytes are not
recreated. Focused Docker webapp tests passed 16/16, the dedicated TypeScript
check passed, and targeted ESLint had zero errors with three pre-existing
unused-disable warnings. The [GitHub quality workflow](https://github.com/xdCloudy/REAmon/actions/workflows/reamon-quality.yml)
has not completed its canonical Docker unit gate for this code snapshot; earlier
runs were canceled as new commits advanced `main`. No full-gate result is
claimed for `aa76fc5a3d74`. The pre-existing
`redamon-orchestrator-net` Compose label mismatch warning remains, but the
network is left untouched and readiness is unaffected.

Rechecked 2026-10-28: the webapp container is healthy; local and LAN readiness
return HTTP 200 with Postgres, Neo4j connectivity/authentication, and artifact
checks `ok`. Readiness now fails closed if any of those dependencies is
unavailable. The webapp was rebuilt from checkout `30a59655978d` with
`dirty=true`, image `sha256:4194d665b5589dffaeded625bde6a716e1d47e06cc3feedc0b029d8c5bd30c37`;
other edited service images have not been rolled out. A local gitignored Compose
override maps to existing networks, and the launcher derives a stable default
project name from the Git remote to avoid the transient WSL mount-path name. The
repository `./redamon.sh up` path now completes and reports ready. On this pass,
commit `c535a69f` was rebuilt and only the webapp container was replaced; the
new image is
`sha256:abf2479f81dbf4641283dbb8a8e37c4b9f405f3f825a30471cd7836807d15bb2` and
reports healthy with local and LAN readiness passing. Its revision label is
`c535a69f` and the webapp build reports clean source. Compose created
three absent optional-feature volumes and did not remove existing volumes. It initially
hit a container-name collision with an exited `redamon-agent` from a separate
legacy checkout; only that stopped container record was removed, and all volumes
were preserved. Compose still reports a stale `redamon-orchestrator-net` label
mismatch and leaves that unrelated network untouched. The
`recon-orchestrator` remains in the opt-in `legacy-pentest` profile and is not
running, so the graph-ingest source change below still lacks live deployment
acceptance.

The project overview now displays protection observations for loaded PE/ELF
artifacts, including suspected family, evidence, inspection scope, and explicit
unknown/not-inspected states. If the artifact inventory is paginated, the UI
states that additional files are outside the current summary. This is a static
evidence view only; it does not provide layer recovery, blocked-region mapping,
agent investigation controls, or complete-project export reporting. PE/ELF
assessment and PE-region observation keys now include the analysis task ID, so
separate runs of the same artifact retain separate results. The maintained-source
bundle exports a bounded protection-evidence manifest with task/source identity,
evidence, scope, and claim status; the README explicitly says this is not
independent confirmation. The project-wide archive exports persisted REAmon
observations, including canonical/source identities, pending-review state,
timestamps, and evidence attributes, in `analysis/observations.json`. It also
exports a bounded allowlist of history fields for tasks referenced by those
observations in `analysis/tasks.json`; task options, results, execution tokens,
and leases are excluded. Import re-owns observations and recreates task history
as inert rows, remapping observation task links to the new rows. Original task
IDs and target/artifact references remain provenance; target/artifact records
and bytes are still not part of this archive round trip.

Docker validation on this Windows PC now passes through the repository runner:
all Python sections passed (12,907 tests) and all 25 shell suites passed in the
unit gate. After correcting the host build-context conversion, the full webapp
section passed separately through the same runner: 607 files / 9,659 tests (2
expected failures, 146 skipped). Git Bash path conversion is disabled only for
Docker container-side arguments; host build-context paths retain normal Windows
conversion. The webapp ESLint check passed with three existing unused-disable
warnings.

Local and LAN readiness return ready with Postgres, Neo4j, and artifact checks ok. An isolated HTTP acceptance through 192.168.0.53:3001 used short-lived signed session cookies and a disposable owner project: the owner received 200 for workspace job/session lists, another identity received generic 404 bodies for both, and anonymous access received 401. The temporary project was removed and a post-run database count confirmed zero acceptance fixtures remain. Interactive browser sign-in acceptance and live master/scanner-key checks against the LAN agent remain open.

Earlier checkpoint (2026-10-27): the local webapp image `sha256:375686f71d58711855d3451ac4f1ca6c459bae5c68c8f59d19f061c6da680a3c` was rebuilt from checkout revision `b7c1bbba2aaf`. Docker health is `healthy`; both `localhost:3001/api/health/ready` and `192.168.0.53:3001/api/health/ready` return `status=ready` with database and artifact checks `ok`. Build metadata reports `dirty=true` because the repository contains the user-owned untracked `work/` directory, which is outside the webapp build context. The task worker briefly lost its webapp connection during recreation, then recovered without a restart: its latest database heartbeat and dispatch are current, with zero reported failures. Before rollout, the existing artifact volume was checked for symlink entries; the shared resolver rejects symlinked staging directories, stored-artifact parent directories, and leaf files. The isolated Docker integration demonstrates real ENOSPC handling and same-offset upload recovery on a bounded tmpfs. Authenticated concurrent imports and LAN pressure-recovery acceptance remain open.

## Scanner graph credential boundary (2026-10-27)

GitHub Secret Hunt, Supply Chain, GVM, and AI Attack Surface now hand results
to the trusted orchestrator instead of connecting directly to Neo4j. The
orchestrator validates tenant, project, and run identity before graph ingest.
These worker spawns omit Neo4j credentials and the graph database mount; the
Supply Chain and GVM scanner images also omit the Neo4j driver and graph module.
Their handoffs are atomically published and run-bound, so stale artifacts are
rejected. AI Attack Surface targets are resolved by the orchestrator and placed
in a private per-run worker directory; finding artifacts are validated and
ingested by the trusted normalizer. Repository scans retain their
`GithubRepository` anchor; uploaded SBOM scans retain their `SbomDocument`
anchor. GVM ingests partial results without pruning. It prunes stale findings
only after every target succeeds without graph-write errors, while preserving
targets excluded by an IP-only or hostname-only scan.

Focused Docker tests passed for GitHub Hunt and Supply Chain: 30 orchestrator
boundary/ingest checks and 12 Supply Chain scanner tests. GVM boundary tests pass
in Docker: 7 run-bound ingest tests, 17 graph-mount tests, 8 GVM knob-plumbing
tests, and 83 scanner tests. Transient graph failures retry with exponential
backoff, and completed run-bound artifacts are restored for ingestion after an
orchestrator restart. The AI Attack Surface change passes 3 artifact ingest
tests, 24 lifecycle tests, 18 graph-boundary tests, 13 scanner-entrypoint tests,
and 32 scanner-spine tests in Docker. The GVM image builds, `pip check`
and Python compilation pass, and runtime inspection confirms that image has
neither the Neo4j driver nor `graph_db`. `docker compose config --quiet` passes.
No live GVM scan, AI Attack Surface run, or deployment of the rebuilt GVM image
has been performed. Full recon and partial-recon workers still receive direct
graph credentials; their isolation remains a production gate.

On 2026-10-28, the partial SubdomainDiscovery worker was moved to a dedicated
HMAC-signed ingest capability. The token binds tenant, project, run, and allowed
roots; the route also checks the active run and uses only the trusted scope for
Neo4j writes. That worker receives no Neo4j credentials or graph database mount.
Per-root graph errors return a partial receipt, avoiding retries of non-transient
partial writes. Focused Docker tests pass 11 orchestrator security cases and 2
worker handoff cases; the orchestrator unit section passed 597 tests after the
partial-receipt refinement. This is source-level progress only: the legacy
orchestrator profile is inactive, so this path has not been exercised live.
Full recon and every other partial-recon worker remain direct graph clients.

## PyInstaller module paging and source recovery (2026-10-27)

A generated, runnable Linux PyInstaller executable with 70 hidden-import modules produced its expected runtime value. The isolated extractor indexed 180 bytecode modules over three pages (0–63, 64–127, and 128–179). The live provider and pycdc ran for 17 continuations; each result was saved through REAmon's production Prisma/PostgreSQL observation-ingestion routine. The next provider invocation resumed from persisted attempt rows at module 64, saved the inventory through index 127, and retained readable recovered source.

The first synthetic queued task exposed a production permission defect: the webapp UID could not write to the provider-owned derived volume. The image now adds the provider group, and a restricted one-shot Compose initializer sets the existing volume root to group 10001 with mode 2770. A subsequent queued PyInstaller task completed through the live worker from saved index 68 and stored readable source. The opt-in database integration now covers both direct-provider persistence and ordinary queued-worker execution; it cleans its fixture, project, and derived outputs after each run.

The acceptance validates one generated executable and one live task-worker run; AI retrieval, user-imported executable behavior, and broad Python fidelity remain open. The webapp health endpoint reports ready with PostgreSQL and artifact checks ok after the deployment was restored using the active WSL Compose override.
## Current gates

| Area | State | Evidence in this assessment | Remaining gate |
| --- | --- | --- | --- |
| Cross-provider accepted identity memory | Historical lookup no longer stops at the newest 100 decompile tasks | Explanation lookup pages completed observations by project/artifact, exact input hash, and canonical/native function identity; it validates accepted review receipts and source hashes before applying its 4,097 accepted-source cap. Pages contain 256 rows and use a scan-start creation-time cutoff with immutable createdAt/id cursor ordering; scanning stops at 65,536 exact-identity observations and adds a partial-memory warning if more remain. Regression coverage skips 256 unreviewed exact matches and includes the older accepted symbols. The focused route suite passes 16 tests in an isolated Node 22 Docker container; targeted ESLint and TypeScript pass. Very large histories and configured-model APK retrieval remain open. | Exercise histories beyond 4,097 accepted exact-function matches and 65,536 exact-identity observations; validate real APK retrieval with a configured model. AI context remains capped at 3.5 KB. |
| Sensitive agent REST access | Strict owner enforcement is deployed for workspace job listing/cancellation and session controls; database-backed owner/non-owner proxy acceptance passes even with ACCESS_ENFORCE=0 | Workspace jobs, job cancellation, and sessions require strict project ownership at the webapp boundary; agent endpoints require configured master-key auth. Missing/placeholder master keys return 503, while wrong/scanner-only keys return 401 in existing local agent checks. On 2026-10-27, an opt-in PostgreSQL integration created a disposable owner project and verified the real project ownership query: the owner reaches job/session proxies; a non-owner receives anti-enumeration 404s for listing, cancellation, and sessions, with no agent proxy call, even when log-only enforcement is disabled. The 18-case proxy suite and 2-case database integration pass; targeted ESLint and webapp TypeScript pass. On 2026-10-27, an isolated HTTP acceptance through 192.168.0.53:3001 verified owner job/session access (200), generic outsider denials (404), anonymous denial (401), and fixture cleanup. The fix is deployed in LAN webapp image sha256:8250b7406b1e6f36600993c8817bbdc0ae5a4e81ba05ac1ad337914859504986; readiness is healthy. | Verify owner and non-owner through interactive browser sign-in sessions on LAN; verify valid master-key and scanner-key rejection against the LAN agent. |
| Project workspace worker telemetry | Cross-project registry disclosure removed in source and deployed; project task alerts are scoped to the authorized workspace | The workspace snapshot no longer reads global worker-health records, and the API drops any top-level worker registry field before serialization. Project UI status now derives only from that project's queued/running task lease timestamps, including mixed stale/fresh tasks and queued work. Route regressions verify worker IDs and private error sentinels do not appear in the response; task-attention tests cover the mixed-lease edge case. Focused tests pass (15), targeted ESLint passes, the standalone TypeScript check passes, and the production Docker build passes. The local and LAN webapp report healthy readiness on revision `a976f716814b`. | Keep the route response boundary and project filtering covered by the standard webapp suite. |
| Failed-run reconstruction lifecycle | Bounded per-unit candidate queue and durable case budgets deployed; authenticated workspace acceptance remains open | Failed/cancelled decompile and disassemble cases preserve bounded, hash-linked provider evidence. A saved provider can queue up to five instruction-evidence units into the durable attempt worker for 12 source languages with matching Tree-sitter grammars. Per-unit attempts persist evidence/source hashes, uncertainty, cancellation, recovery, and retry history; candidates remain separate from canonical source and behavioral validation remains unavailable. Dispatches serialize on the case row and enforce at most 24 persisted attempts and 30 minutes of reserved provider runtime per case; used attempts and reserved runtime reload from persisted history and appear in the task UI. Focused Docker/Vitest checks pass (33/33), TypeScript and targeted lint pass; the deployed local/LAN webapp is healthy on `c0cf3197`. | Verify the authenticated workspace flow and budget display on LAN, and add targeted provider follow-ups, review receipts, safe behavioral validation, and multi-session resume acceptance. |
| Project-scoped tool-output writes | Traversal, symlink, and overwrite protections implemented and deployed in the agent | Offload identifiers are restricted to single safe path components. Directory traversal uses directory file descriptors with no-follow opens, and outputs are created exclusively, preserving an earlier result when a job ID collides. Docker regressions cover traversal identifiers, symlinked project/output directories, duplicate job output, and write-failure fallback. The focused output and umask suites pass (47 tests plus 3 subtests, 1 root-only skip). A production-image smoke verified confined paths and retained both outputs; the local agent reports healthy on revision `818efc164b68`. | Keep output-path confinement covered in the agent unit gate and verify writable output behavior after agent image upgrades. |
| User-configured MCP stdio execution | High finding mitigated in source; user stdio remains disabled pending isolation | The webapp rejects stdio draft tests and reload requests; the agent independently rejects stdio before constructing an MCP client and skips saved user stdio entries during reload. The settings UI marks stdio presets and legacy entries unavailable. HTTP/SSE user plugins and trusted built-in servers remain supported. Focused Docker checks pass (44 webapp tests and 50 agent tests); an independent read-only review found no bypass. A full webapp type-check remains red on existing unrelated Prisma-client and test-fixture errors in the available image. | Add per-user process isolation before restoring user-configured stdio. Rebuild and exercise the webapp and agent in the LAN deployment. |
| Global tunnel credential access | Medium finding mitigated in source; deployment verification pending | The route requires the master internal key before reading settings and returns only a sanitized Chisel origin, omitting ngrok and Chisel credentials plus URL userinfo, path, query, and fragment. Focused Docker route and middleware tests pass (90 tests); independent review found no browser or scanner-key bypass. The agent continues to receive the hostname and optional port it needs. | Rebuild the webapp and agent and verify Chisel host discovery and denied browser/scanner access on the LAN deployment. |
| MCP credential masking in settings deletion | Low finding mitigated in source; deployment verification pending | Deleting one server now masks auth tokens, custom header values, and environment values for retained servers in the API response. The database write and agent reload still receive the raw configuration. A focused Docker regression test verifies both properties. | Rebuild the webapp and verify an administrator can delete a server without exposing retained credentials in the response. |
| Shared artifact-volume exhaustion | Deployed admission and symlink-aware guards; source now has durable retry for failed artifact cleanup; live pressure recovery and independent review remain pending | Import creation checks actual statfs free bytes against remaining bytes reserved by active imports under a PostgreSQL advisory lock. Browser chunk writes count only newly persisted bytes under a path-scoped lock; committed-path retries are idempotent, and failed DB counter updates restore the staged file. Finalization renames same-volume staging data to permanent storage, avoiding a transient second full-size copy. When Content-Length is available, chunk ingestion fills one bounded buffer directly. Filesystem ENOSPC and EDQUOT errors return HTTP 507. Cancellation removes its confined staging directory immediately, and the completion/cancellation race cleans staged bytes after rollback. A real-route PostgreSQL integration probe serialized concurrent 60-byte imports against synthetic 100-byte capacity: one returned 201 and the competing reservation returned 507. A second probe used the real statfs check on a 1 MiB Docker tmpfs and rejected a manifest one byte above available capacity with 507 and no extra import row. All three opt-in integration cases pass; temporary test rows were fully cleaned. Chunk-write and per-file finalization routes now map direct or wrapped ENOSPC/EDQUOT errors to HTTP 507 with a clear storage-capacity message; focused chunk, finalization, and browser-import tests pass (15), and webapp TypeScript plus targeted ESLint pass. A 4 MiB tmpfs probe forced real ENOSPC during a 2 MiB chunk write: the API returned 507, truncated the partial staged file, and left uploadedBytes at zero. Once filler storage was removed, retrying offset zero succeeded and both the staged size and DB byte counter matched. The temporary project and rows were cleaned up. An authenticated 1.0156 GiB upload through the deployed API completed in 65 chunks, matched the independently computed SHA-256, persisted the exact byte count and completed state, and was fully cleaned up. A separate authenticated 32 MiB transfer from the Windows host over LAN completed in four chunks with matching SHA-256 and verified cleanup. Retention now commits an artifact-cleanup outbox row before deleting metadata, retries failed unlinks on later runs, and clears the row only after unlink succeeds. Focused retention tests pass (9), including injected EBUSY and successful retry; webapp type-check passes. Browser-native file-picker uploads, concurrent large imports, and live LAN pressure/retry acceptance remain open. | Independently review capacity admission; validate authenticated concurrent large imports and recovery under storage pressure on the LAN deployment; validate the retention outbox retry and storage-pressure recovery on the LAN deployment. |
| Kali terminal ticket identity | Ticket-derived identity and interim project filesystem isolation implemented; broker terminal path smoke-tested, browser ticket flow remains open | The agent verifies the WebSocket ticket and sends its signed user/project/session claims plus a two-hour, graph-only signed context. Browser-supplied `init` frames are discarded, so a client cannot replace ticket identity or context. PTY shells drop to UID/GID 65534 and receive no service or scanner credentials. Terminal graph reads and `redagraph ask` derive tenant IDs from the signed context. The PTY enters unprivileged user, mount, and PID namespaces; `/proc` and `/workspace` expose only the session and ticket-bound project, while `/tmp`, `/var/tmp`, and `/opt/output` use private tmpfs mounts. A live signed-context broker terminal run returned HTTP 200 and confirmed UID 65534, `/workspace`, and absence of tested service credentials. Normal exit removed its worker and network. A separate live broker restart probe removed one disposable orphan worker and network, including the trusted-agent endpoint. Broker tests cover generated Compose names, ambiguous matches, terminal exit, startup recovery, and project cleanup. On 2026-10-29, the in-container live probe passed 9/9 checks across `/ws/kali-terminal` and both cypherfix sockets: no-ticket and cross-site-origin connections were rejected, while locally signed test tickets from the same host were accepted. The terminal probe closed its socket; afterward Docker reported no containers or networks labeled as terminal workers, and the agent and broker remained healthy. This exercised the agent gate and terminal worker cleanup with a locally generated ticket, not webapp ticket minting or the browser UI; browser-to-agent acceptance remains open. | Verify the ticket and terminal boundary through the deployed browser WebSocket in a multi-user test, including cross-project shell, process, filesystem, and generated-file behavior; exercise recovery of a live authenticated terminal session. |
| REAmon terminal and source worker lifecycle | Project-delete worker cleanup implemented in source; scoped broker and route regressions pass; live acceptance pending | The normal core builds the dedicated language/compiler worker image and starts the filtered broker; the agent and broker share the trusted workspace bind. Source and ticket-authenticated terminal jobs use project-only mounts, an immutable worker image ID, read-only root, UID/GID 65534, and project-scoped writable scratch/output. Worker networking is internal by default; only Kali tools that require egress request it. Both images built, Compose configuration parsed with default and optional profiles, all 36 broker worker tests passed, including startup cleanup guards, and a no-network constrained smoke passed for Python, C, Java, Go, Node/TypeScript, Ruby, Perl, Rust, and .NET. Project deletion now asks the broker to stop only workers and networks carrying the verified project scope before deleting the project row; broker HMAC and Docker-label checks include pre-upgrade unlabeled worker networks, and other project workers remain untouched. A fsynced project-scope tombstone on the shared admission volume fences queued one-shot and terminal requests across broker processes and restarts. The full 52-case broker worker suite and 10-case project-delete route suite pass in Linux Docker; webapp TypeScript passes. | Rebuild and deploy the webapp/broker, then verify deleting a project with active terminal and execution workers removes its workers/networks while preserving another project and fences queued tasks; complete browser-to-agent-to-broker jobs, admission, intended egress, and restart recovery on LAN.
| Graph tenant authorization | Scanner-only body-identity access rejected in source | `/graph/exec`, `/text-to-cypher`, and `/graph/nl-query` require the configured master key; identical master/scanner keys fail closed. Terminal graph reads instead derive identity from a signed two-hour WebSocket context. The webapp is the only body-identity caller and must resolve project ownership first. Focused Docker auth suite passes 130 tests plus 65 subchecks, including scanner-key rejection on the live ASGI route. | Rebuild the agent and webapp, then verify a project owner can query their graph and scanner-only or cross-project requests are rejected on the LAN deployment. |
| Kali execution scope propagation | All four non-terminal arbitrary-code tools use signed-scope project workers; live cancellation through the deployed async Kali tool function now stops and cleans up the worker | `PhaseAwareToolExecutor` injects signed scope for `proxy_brain`, `kali_shell`, `execute_code`, and `execute_playwright`; Playwright capture remains a separate project opt-in. The agent verifies exact tool, HMAC, expiry, and project ID through its scanner-authenticated endpoint. Workers run as UID/GID 65534 in user, mount, and PID namespaces with a project-only workspace, per-project scratch, per-run private tmpfs mounts, and resource limits. The async MCP functions use a cancellable broker client; the broker treats disconnect as cancellation and cleans the worker and network. After correcting the live broker workspace mount, Kali image tag, and Docker Desktop host-path mapping, a signed call to the deployed `kali_shell` function started a real `sleep` worker; cancelling the task propagated through the socket, and the broker removed both the worker and network. The disposable project directory was cleaned. FastMCP 3.2.4 registers all four tools as async. The 51-test MCP execution/capture Docker suite and the 42-test broker Docker suite pass. The rebuilt agent is healthy; its deployed API cancellation suite passes all 31 cases, and a signed live kali_shell call through the deployed async tool function was cancelled with worker and network cleanup confirmed. The direct smoke still does not exercise the agent MCP ainvoke or browser UI. This smoke called the deployed function directly, not through the agent's MCP `ainvoke` or browser UI. Earlier live tests verified sibling workspace, scratch, and process isolation; generated-file transfer; and Chromium launch. See the [Kali isolation decision](REAMON_KALI_ISOLATION.md). | Verify cancellation through the agent MCP client and browser; coordinate admission across replicas; add worker storage and destination-aware egress quotas; complete LAN and multi-user acceptance. |
| Generated file download ownership | Legacy unscoped endpoint removed; non-terminal shared Kali filesystem disclosure remains open | The unused agent `/files?path=/tmp/...` endpoint has been removed. The focused Docker regression passes (2 tests). Browser downloads require project ownership and use only the project workspace download endpoint; generated file events carry the connection's project ID and are canonicalized under project scratch and moved to a unique project workspace path without a second full-size copy. Terminal sessions now have private temporary storage and a project-only workspace, while all four code tools now use project-scoped scratch and a read-only project root with writable scratch/output directories, though the shared worker model remains. | Isolate remaining Kali execution and temporary storage per user/project, then verify cross-project shell, generated-file, and download attempts fail in a deployed multi-user test. |
| Docker broker inspection boundary | Implemented in the current source patch | GET container inspection uses the broker-owned label check before forwarding metadata; the ownership tests deny infrastructure-container inspection and permit owned-container inspection. When its configured container-count cap cannot be verified, the broker now rejects creates without contacting Docker. Broker Docker-image suites pass 88 policy, ownership, and plumbing checks, including concurrent-create serialization. | Rebuild the broker and validate the rule against the deployed Docker Engine and each enabled broker profile. |
| Project worker admission and ownership | Cross-process cap decision is integration-tested against a fake Docker Engine; multi-container live acceptance remains open | Project workers use a dedicated hashed project-scope label and remain isolated from generic Docker APIs. Host capacity is fail-closed and serialized across generic and worker creation; configured worker limits default to 4 global and 2 per project; source also clamps per-worker memory/CPU/PID limits and reduces concurrency to respect aggregate budgets of 8 GiB memory, 16 CPU cores, and 4,096 PIDs. A shared named volume and POSIX `flock` serialize capacity checks and creates across broker processes sharing one Docker Engine, covering generic, one-shot project, and terminal workers. On 2026-10-29, broker source commit `93d4686c` was rebuilt and deployed to the PC as image `sha256:5fa5bb60cfaf3dc69d7b99f80cdb038242df465fe2a6a4808bf3fd9734f180c9`; it is healthy and reports the expected defaults (1 GiB memory, 2 CPU cores, 512 PIDs, four global and two per-project workers). Startup cleanup confirmed there were zero orphaned workers/networks, and the broker retains its admission-lock volume. Local webapp readiness remains healthy with database, Neo4j, and artifact checks all `ok`. The full Docker broker unit section passes 76 tests across six files. Worker container and network deletes now validate Docker status codes, retry transient failures up to three times, and run independently so one failure does not skip the other. Startup reaping, project deletion, create-cancellation compensation, terminal shutdown, and normal execution use the same checked cleanup path; failures are logged without Docker response bodies, and cancellation remains cancellation when cleanup fails. A new test launches two independent broker processes against one fake Docker Engine with a global cap of one: exactly one worker/network is created and the competing request receives 429. Another test confirms lock-wait cancellation does not leak the lock, and a live smoke against the mounted named volume confirms separate-process serialization. A signed `kali_shell` request through the deployed async tool function started a disposable worker; task cancellation closed its broker connection, and live checks confirmed the container and network were removed. A live authenticated `/kali/exec` request exercised the agent MCP `ainvoke` path; the client sent `notifications/cancelled`, and the worker container and network disappeared after cancellation. | Exercise worker and host caps through concurrent requests to multiple live broker containers; verify browser cancellation and complete browser-to-agent-to-broker source and terminal acceptance; add disk and destination-aware egress quotas; complete LAN multi-user and backup/restore acceptance. |
| Project worker file-write ceiling | Per-file writes are bounded; stale scratch cleanup is implemented, but shared project scratch and outputs have no aggregate quota | The broker applies Linux `RLIMIT_FSIZE` through `prlimit` before running worker commands. `REAMON_WORKER_MAX_FILE_BYTES` defaults to 1 GiB and is clamped to 16 MiB–8 GiB; the inherited hard limit also applies to child processes writing scratch and output paths. Ordinary `/tmp` remains bound to project `.reamon-tmp` so generated files survive long enough for the follow-up transfer into `tool-outputs`; `/var/tmp`, `/dev/shm`, and `/opt/output` remain per-run private tmpfs mounts. Under the shared admission lock, one-shot and terminal worker admission, plus a broker maintenance task every 15 minutes, remove regular scratch files older than 24 hours only when Docker reports no active worker for that project. The periodic task skips cleanup if Docker inventory is unavailable; symlinks and symlinked directories are not followed, and cleanup failure does not block admission. This reduces stale scratch accumulation but does not impose aggregate storage quotas. The Docker broker unit section passes 83 isolated tests, including age filtering, symlink handling, idle-only collection, and periodic maintenance behavior. A live broker smoke created a disposable project with a 48-hour-old scratch file, invoked the collector, verified removal, and removed the fixture. On 2026-10-29, the active broker was rebuilt and recreated as image `sha256:f245d610a2de6291cf8aae09f57ff77404520675a552fa9454a70908321141e5`; it reports healthy, and `http://localhost:3001/api/health/ready` returns `ready` with database, Neo4j, and artifact checks `ok`. | Add aggregate per-project/per-run storage accounting and quotas for persistent scratch and outputs; workers can still create many files below the individual-file limit. Validate ENOSPC behavior and recovery under concurrent workers, and verify generated-file transfer in a live project-worker flow. |
| Large project graph projection recovery | Bounded-page, stable-order, composite-index, and renewable-lease safeguards are implemented; end-to-end large-project throughput and recovery remain open | `REAMON_WORKER_PROJECTION_PAGE_SIZE` defaults to 1,000 observations and is bounded from 100 to 10,000; the API defaults omitted limits to 1,000 for older workers. The worker retains the persisted monotonic offset/run identity and scales its page safety cap to the server's one-million-observation maximum offset. Observation queries order by `updatedAt` and then stable row ID, with a matching `(projectId, updatedAt, id)` database index to avoid repeated full-table scans and sorts. The route renews its five-minute project lease every minute while the owning request is active; renewal cannot revive an expired or replaced lease. A live multi-page run has advanced through repeated page checkpoints, but worker timeout errors have also occurred; this is not a passing throughput or recovery acceptance. Focused worker/projector and lease tests pass. | Validate a large synthetic multi-page fixture in Docker and a representative large project in the deployed stack; confirm requests finish within bounds, stale pages recover safely, no observations are skipped, and final reconciliation completes. |
| Imported report storage isolation | Implemented in the current source patch | Imported report bytes use a server-generated project directory and per-row unique filename while report metadata retains the archive basename. Focused import tests, type-check, and lint pass; an independent patch review found no concrete bypass or regression. | Rebuild the webapp and verify report import, download, delete, and export in the deployed stack. |
| MSF/Hydra progress and session sidecars | Implemented in the current source patch | Ports 8013/8014 require the shared `MCP_AUTH_TOKEN` on progress and session-control routes; only data-free health checks are public. Agent callers now send the bearer token. Standalone MCP compose publishes service ports on loopback. Focused handler tests pass (14 tests plus 3 subtests), and root, agent-standalone, and MCP-standalone compose configurations parse. | Rebuild/restart the Kali and agent services, then verify authenticated polling/control and rejected anonymous requests in the deployed stack. |
| Persistent agent checkpoints | Fail-closed startup and graceful pool cleanup implemented; a live deterministic conversation restart acceptance passes and CI coverage is wired | Compose enables `PERSISTENT_CHECKPOINTER=true` and supplies PostgreSQL. If `DATABASE_URL` is missing or PostgreSQL checkpoint initialization fails, the agent closes any partial pool and refuses startup instead of serving with volatile `MemorySaver`. Shutdown closes the checkpoint pool. Explicitly disabled persistence still selects memory mode. Four focused Docker unit tests pass. The opt-in Docker integration `agentic/tests/test_checkpointer_restart_live.py` uses the production LangGraph wiring and PostgreSQL saver with deterministic node stubs: it writes one turn, closes the first pool, constructs a new orchestrator and graph, recovers prior messages, appends a second turn, and deletes its unique checkpoint thread. This validates persistence and graph recreation without an external model or target. The production-stack CI smoke now runs this integration against its PostgreSQL service; the new CI result is pending. | Confirm the CI restart acceptance passes and exercise recovery with the real configured-model conversation path on LAN; deterministic node stubs do not validate provider/model continuation behavior. |
| Workspace project ownership | Strict ownership enforced in source and exercised through the LAN webapp | Workspace API routes verify database project ownership, and direct agent REST access requires a service key. An isolated LAN HTTP acceptance verified owner job/session list access (200), non-owner generic 404s, anonymous 401, and cleanup of its disposable project. | Verify interactive browser owner/non-owner sessions and authenticated cancellation paths through the deployed webapp. |
| Session ownership and multi-user isolation | Project-scoped session and job controls implemented and covered by isolated Docker route tests; live multi-user acceptance open | Metasploit session-open events record trusted user, project, and chat IDs. Project session list/interact/kill and job list/kill routes require strict webapp project ownership; the agent forwards project scope and the sidecar filters jobs to trusted mappings, confirms jobs are live before registration, preserves first project ownership, and rejects kills for unknown or foreign-project jobs. On 2026-10-26, isolated Docker tests passed for agent REST auth (10 tests, 20 subtests), graph auth (1), session filtering (2), Metasploit HTTP handlers and job ownership (24 tests, 11 subtests), and webapp project-session routes (8). The LAN webapp reports `35fd1aff`, agent `4b91518e`, and Kali is healthy. Ownership mappings remain process-local; a Metasploit restart ends its live jobs, and unknown or legacy jobs stay hidden. | Verify the end-to-end session/job flow on LAN with owner and non-owner accounts; confirm actual Metasploit job start events are recognized and foreign/unowned jobs remain inaccessible. |
| Production dependency audit | Pass locally and in CI | Updated `webapp/package-lock.json` resolves the reported production advisories; isolated `npm audit --omit=dev` returned zero findings. The webapp checks and agent dependency audit jobs passed in quality run [40200537024](https://github.com/xdCloudy/REAmon/actions/runs/40200537024). | Keep the lockfile audit in the release workflow and review development-only advisories separately. |
| Kali shared Python dependency integrity | Pass in rebuilt active container | `python3 -m pip check` reports no broken requirements. The MCP environment retains requests 2.34.2, urllib3 2.8.0, and OpenTelemetry API 1.37.0. Legacy GraphQL-Cop, SSTImap, and AD command dependencies are isolated; BloodHound, Certipy, BloodyAD, bhgraph, gMSADumper, GraphQL-Cop, and SSTImap startup smokes passed. The `redamon-kali` service was recreated and is healthy. | Keep the dependency check in image acceptance and monitor tool venv compatibility when updating pinned upstream snapshots. |
| CI production-stack acceptance | CI passes; current PC webapp deployed; remote LAN and full current-stack acceptance remain open | Quality run [40242498764](https://github.com/xdCloudy/REAmon/actions/runs/40242498764) passed authenticated live-stack acceptance and browser login on commit `398d32ae`; it also passed two-replica worker recovery, bounded load/soak, PostgreSQL/artifact restore, and Neo4j dump/restore. On 2026-10-26, the local PC webapp built from `main` (`82a1c0a5`), passed TypeScript, started with the database already in sync, and became healthy; `localhost:3001/api/health` returns 200 and the anonymous session proxy returns 401. The local agent was rebuilt from source commit `387b8e7` on 2026-10-26 and now reports healthy with 28 tools and persistent checkpoints enabled; valid master-key and invalid scanner/missing-key LAN checks passed. | Exercise the C# receipt build/export on the updated webapp and complete authenticated large-import, real-worker, and owner/non-owner multi-user acceptance.
| Go accepted-source project compilation | Implemented and deployed to the PC; PostgreSQL receipt verification passes; real imported-project browser acceptance pending | Up to 64 accepted `.go` files (8 MiB total) compile together across packages. The compiler cross-checks every accepted source against Go's selected package files, so ignored tests, platform files, and build-tagged sources cannot silently receive a passing receipt. Exact accepted source hashes, review IDs, Go compiler version, package-output digest, and imported `go.mod`/`go.sum` hashes are saved in a database receipt. Module downloads and CGO are disabled; compiled output is never executed. The source bundle exports current verified build metadata and omits stale receipts. Focused agent Docker tests pass (8), webapp route/export/component tests pass (25), targeted lint passes, and an opt-in Docker integration test passed against the live PostgreSQL database: a synthetic isolated project built, reloaded its receipt, and hid the receipt after source or imported manifest hashes changed; cleanup left zero test projects. The local agent and webapp were rebuilt from `main` revision `0fc93ef1`; both containers are healthy and localhost plus `192.168.0.53:3001` report ready. A live agent-container Go 1.24.4 compile smoke passed. | Validate the receipt path in the browser with a real imported multi-package Go module, including receipt reload and stale-manifest/source invalidation; exercise other source-validation receipts and exports in a database-backed project.
| Scanner project ownership | Implemented in current source | Each scan receives a short-lived HMAC scope bound to the database-resolved project and owner. Settings, project, and traffic-ingest routes verify the signature, requested tenant, and current database ownership before returning secrets or writing data. The shared scanner key is rejected as an internal master credential if both configured keys are identical. Scope verification rejects non-canonical base64url HMAC signatures. Focused scanner-scope Docker tests pass (26); focused webapp tests (99), type-check, lint, and 560 isolated orchestrator unit tests pass; recon traffic-capture (19) and node-filter (25) tests pass. | Rebuild/restart the orchestrator and webapp, then verify project-owned settings reads and traffic ingestion in the LAN deployment. |
| Security review coverage | Five findings mitigated at source; deployment and independent review coverage remain incomplete | The repository-wide source-only review validated five findings: one high (user-controlled stdio MCP execution in the shared root agent), three medium (global tunnel credential disclosure, shared storage exhaustion, and shared Kali temporary-file disclosure), and one low (nested MCP secret masking bypass). Stdio remains disabled at webapp and agent boundaries; the tunnel-config endpoint requires the master key and returns a sanitized origin; import capacity admission reserves active bytes; MCP deletion responses mask retained credentials. Model-authored children run as UID/GID 65534 with credential-free environments. All four arbitrary-code tools verify agent-signed project scope and run in user, mount, and PID namespaces with a project-only workspace. Project-scoped scratch supports generated-file handoff; focused Docker suites and runtime smokes cover sibling workspace, scratch, and process isolation. Broker-managed workers serve `kali_shell`, `execute_code`, `execute_playwright`, and `proxy_brain`; signed worker dispatch and cleanup pass, while full browser-to-broker acceptance remains open. The [Kali isolation decision](REAMON_KALI_ISOLATION.md) records remaining gates. Quality run [40247230850](https://github.com/xdCloudy/REAmon/actions/workflows/reamon-quality.yml) passed all five CI jobs on commit `baa5634a`. The LAN webapp reports `35fd1aff`, the agent reports `4b91518e`, and both are healthy; Kali is healthy. Focused auth, session, and Metasploit job ownership Docker checks now pass. CodeFix host-gateway reachability, full-recon and partial-recon Neo4j credential isolation, independent capacity review, authenticated multi-user acceptance, and recovery validation remain open. | Validate project-worker browser flows on LAN; independently review capacity admission; coordinate broker admission across replicas; and verify isolation and recovery. |
| Agent Python auth tests | Pass, focused, current source | Isolated Docker runs: `test_rest_auth.py` passed 10 tests plus 20 subtests; `test_graph_exec.py` passed 1 test. Cases cover missing, placeholder, wrong, scanner-only, and valid master credentials, route dependency coverage, and the session proxy response. | Keep the focused auth coverage in the release gate. |
| Webapp auth/proxy tests | Pass, focused, current source | In the Node 22 Docker container, `shared-session-admin.test.ts` passed all 8 project ownership cases. The current webapp production image built successfully, including its TypeScript check. | Exercise authenticated session/job controls through the browser with owner and non-owner accounts. |
| Full agent unit suite | Pass, current source | The full Docker unit gate passed 3,784 agent tests across 185 files; one additional file was reported empty/skipped. | Keep the isolated full agent suite in the release gate and rerun after changes to agent code. |
| Full webapp suite | Pass in current canonical local Docker gate; current-commit CI remains pending | On 2026-10-29 at `a490e8cc`, Docker/Vitest passed 611 files with 24 skipped; 9,682 tests passed, 2 were expected failures, and 147 were skipped. Earlier Windows host path-expectation failures are a separate platform-specific result and do not invalidate this Docker run. | Keep the complete suite in the required CI gate; assess platform-neutral path expectations if Windows host runs remain supported. |
| Full repository verification | Full local Docker unit gate passed before the latest broker-only cleanup follow-up; CI and deployment validation remain partial | Quality run [40247230850](https://github.com/xdCloudy/REAmon/actions/runs/40247230850) passed all five jobs on commit `baa5634a`: webapp checks, canonical Docker unit gate, agent dependency audit, Compose configuration, and production image smoke. On 2026-10-29, the full `redamon.sh test unit` gate passed before the final broker cleanup addition: all Docker sections and 25 shell suites passed; webapp Vitest passed 611 files with 24 skipped (9,682 passed, 2 expected failures, 147 skipped); the Docker broker section passed 66 tests. The final full Docker broker suite now passes 69 tests. Live terminal broker and broker-restart orphan cleanup probes passed after rebuilding the broker; local and LAN web readiness returned HTTP 200. CI on the resulting commit remains to be verified. | Keep all five CI jobs required; verify the Docker unit gate in CI after the broker fix, then validate authenticated browser terminal behavior, large imports, and remaining worker routes on the LAN deployment. |
| DEX analyzer scratch capacity | Source fix implemented; analyzer rebuilt and healthy on the LAN deployment; workload behavior unverified | DEX request scratch now uses a dedicated disk-backed Docker volume in source, avoiding the 1 GiB memory-backed `/tmp` competing with extracted input, Java output, and structured evidence. The analyzer's focused Python tests pass in Docker, the root Compose file parses, and on 2026-10-26 the rebuilt analyzer reported healthy with the expected pinned source revision. | Verify large-request scratch placement, cleanup after cancellation/restart, and disk-space failure reporting under real workload. |
| DEX alternate output throughput and coverage reporting | Real provider-to-database task and MCP retrieval verified; explanation and rewrite context use exact function relationships | A Cross Stitch Joy APK task completed through the current Rust DEX provider in 405 seconds, promoting 11,176 functions, 1,560 symbols, 4,000 calls, and 4,000 references with no pending observations. MCP code and relationship queries retrieved stored output; isolated PostgreSQL integration passes atomic promotion checks. Visualizer diagnostics report relationship caps. Selected-function explanations query bounded calls and references by exact function key. Member rewrites resolve selected method keys before fetching direct neighbors, avoiding a run-wide edge prefix that can omit the method. Focused explanation/rewrite route tests pass (15). The provider returns up to 4,000 calls and references, so complete relationship coverage is not established. | Validate real-run explanation/rewrite behavior with a configured model; compare reconstructed output with bytecode; exercise truncation and cleanup on larger workloads. |
| Deployment, upgrade, and restore | Webapp deployed at current product revision; full-stack lifecycle gates remain open | On 2026-10-29, the local/LAN webapp was rebuilt from `main` revision `c0cf3197e033b6256531a89b67b5933b244a7c45` (image manifest `sha256:8ad791c1a2e7edd1335ce63782343bc52c609852727cf755418791d1cacbcd0b`) and recreated with `--no-deps`. `localhost:3001/api/health/ready` and `192.168.0.53:3001/api/health/ready` both report ready with PostgreSQL, Neo4j, and artifact checks `ok`; webapp, agent, Docker broker, and Kali containers report healthy. The agent, broker, and Kali source revisions were not verified in this deployment check. Worker exit/restart recovery, authenticated imports, Metasploit owner/non-owner controls, clean upgrade, backup/restore, and browser-to-broker acceptance remain open. | Verify the authenticated budget reload flow; verify full-stack worker crash/recovery, authenticated imports, Metasploit owner/non-owner controls, clean upgrade, and backup/restore on a clean installation. Verify authenticated REST and LAN WebSocket behavior. |
| REAmon task-worker Docker health | Supervisor recovery implemented; isolated production-image restart drill passes; CI and deployed-worker acceptance pending | The persisted remote heartbeat still drives Docker health through the internal-key-protected endpoint and exact worker identity. A separate, unprivileged PID 1 supervisor watches local IPC heartbeats from the task-worker child; after the configured 60–600 second liveness deadline (120 seconds by default), it sends SIGTERM, escalates to SIGKILL after 10 seconds, then exits non-zero so Compose `unless-stopped` restarts the container. It does not use the Docker socket or restart a responsive worker when only the webapp is unavailable. Docker-focused unit tests pass 14/14, type-check and changed-file lint pass, and the production image builds. An isolated, network-disabled production-image drill paused the worker child, observed the liveness deadline and SIGKILL escalation, and confirmed Docker restarted the container (restart count 0→1). Repo-wide `lint:all` remains red on pre-existing errors in unrelated files; current-tip CI and live deployed-worker re-registration are unverified. | Complete the CI restart/health drill and verify the deployed worker re-registers after restart without losing or corrupting task state. |

## Release blockers

The new P1 reconstruction milestones do not replace or lower these production gates.
Any original-binary execution, fuzzing, or runtime tracing remains unavailable unless
the target is explicitly authorized and the current isolated worker boundary, resource
limits, project scoping, and cleanup checks pass. A compilation or export receipt only
supports its recorded build scope; it does not by itself certify application behavior or
release readiness. Capability-specific maturity and thresholds are in the
[reconstruction milestone specification](REAMON_RECONSTRUCTION_MILESTONES.md).
Protected-artifact detection/recovery and its dynamic-execution gates are specified in
the [protected-binary milestone](REAMON_PROTECTED_BINARY_RECOVERY.md); provider-family
signatures alone do not qualify as release support.
Encrypted plaintext capture and virtualized-code execution evidence have separate gates in the [encrypted recovery](REAMON_ENCRYPTED_BINARY_RECOVERY.md) and [virtualized-code reconstruction](REAMON_VIRTUALIZED_CODE_RECOVERY.md) specifications. Both remain unavailable unless explicit authorization and isolated-worker controls pass.

1. The PostgreSQL-backed capacity path passes a bounded tmpfs pressure test on
   this PC. Still exercise authenticated concurrent large imports, shared-volume
   capacity, broker admission, and recovery under pressure on the LAN deployment.
2. Implement the [Kali execution isolation decision](REAMON_KALI_ISOLATION.md), including cross-project tests for temporary files, shared workspace data, inherited credentials, terminal, and generated-file transfer. Complete deferred parser, persistence/recovery, provider, CI/deployment, and supply-chain review surfaces against one release candidate.
3. Verify project-scoped Metasploit session and job registration, listing, and kill
   behavior on LAN with owner and non-owner accounts.
4. Verify authenticated REST proxy calls and ticket-bound LAN WebSocket access
   together on the current services.
5. On 2026-10-29, the live PC PostgreSQL/artifact drill restored the database into
   a disposable database, extracted the 1.3 GiB artifact archive, and removed the
   temporary database and backup files. The separate Neo4j drill restored a
   2.2 GiB dump, queried 90,026 graph nodes, removed its temporary volume and dump,
   and returned webapp, worker, and Neo4j to healthy. Still verify agent
   conversation recovery across restart and repeat the drills on a release candidate.

## How to read the weighted progress estimate

The README bar estimates progress across the product mission and production operations.
It is calculated from the workstream weights in [`REAMON_PROGRESS.json`](REAMON_PROGRESS.json).
The estimate is not a release decision: unresolved security coverage, failing full
tests, or unverified deployment gates can block release even when the weighted score
is high. The detailed capability state remains in the [feature matrix](REAMON_FEATURE_MATRIX.md)
and [language matrix](REAMON_LANGUAGE_MATRIX.md).
