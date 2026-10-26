# Kali execution isolation decision

Status: required production security work; first non-terminal scoped path is implemented, broader isolation remains open.

## Current exposure

The legacy Kali deployment is one shared `redamon-kali` container whose MCP
controller still runs as root. The `kali_shell`, `execute_code`, `proxy_brain`,
and custom Playwright handlers run model-authored commands as UID/GID 65534 with
a small environment that omits MCP, scanner, tunnel, database, and agent
credentials. `kali_shell`, `execute_code`, and `proxy_brain` receive a short-lived signed
project tag, ask the agent to verify it, and enter a private user and mount
namespace with only that project's workspace and private `/tmp`, `/var/tmp`,
and `/opt/output`. Custom Playwright still uses the shared Kali filesystem and has no equivalent
project boundary.

The container also mounts the complete `agentic/agent-workspace` at `/workspace`.
Project ownership is enforced by the webapp and agent workspace APIs, but those
checks do not apply to a root shell in the Kali container. Workspace copy helpers
make files and directories writable by all local users to accommodate the shared
container, so filesystem permissions do not restore the project boundary for
the still-unscoped execution tools.

As a result, the existing project-scoped download route protects browser
access; `kali_shell` and `execute_code` now have narrower source-level
boundaries, but arbitrary Kali execution as a whole is not isolated.
Custom Playwright children still share `/tmp` and can read the complete mounted
workspace; other MCP server processes also retain the
service environment.
This remains a source-level finding; it is not a claim that any particular
deployment has been exploited.

The unused agent `/files?path=/tmp/...` endpoint has been removed; current browser
downloads use the project-authorized workspace endpoint. `kali_shell`, `execute_code`, and `proxy_brain` now have private temporary
storage; custom Playwright can still read other projects' temporary files.

The focused agent Docker regression verifies the unscoped route stays absent and
the workspace download route remains protected by master-key authentication (2
tests passed on 2026-10-25).

The terminal WebSocket proxy now passes ticket-verified user, project, and session
claims to Kali as its first frame and discards browser-supplied `init` frames. Three
focused Docker tests cover claim serialization, forged-frame detection, and the
proxy behavior. This prevents the browser from selecting another shell identity
or context.

## Implementation seams verified

The agent signs a project context tag from its `user_id`, `project_id`, session,
tool, and phase context. The MCP server receives that tag unconditionally for
`proxy_brain`, `kali_shell`, and `execute_code`, and for selected target-facing
tools when capture routing is enabled. `execute_playwright` receives it only
when capture routing is enabled. `proxy_brain` uses its tag for traffic broker
requests. The new `/execution/resolve-context` route accepts the scanner service
credential, verifies the signed tag with the agent master key, requires an exact
`kali_shell`, `execute_code`, or `proxy_brain` tool match, checks expiry and project ID shape,
and returns only the project ID. The shared MCP bearer token is not treated as
project identity.

The context tag is signed with the agent's internal key, which is deliberately
absent from the shared Kali container. A future controller can forward the
opaque tag to a trusted verifier, but must not make the signing key or Docker
socket available to processes that run model-authored code. The current Docker
broker also applies one global broker-owned label; its ownership checks do not
bind container operations to a user or project. The global filtered socket is
mounted into scan infrastructure, so a worker controller needs a separate
scoped broker API or equivalent per-worker authorization before project workers
can share that broker.

On 2026-10-26, the `proxy_brain` traffic path was tightened: agent contexts now
expire after five minutes, and the traffic read, replay, and browser routes
require the signed context to name `proxy_brain`. Those routes authenticate the
context directly, so the shared scanner transport key is not copied into the
`proxy_brain` child. Its Playwright browser cache is installed at `/ms-playwright`
for unprivileged access.

The `kali_shell` and `execute_code` children now use the same unprivileged UID/GID
and a fixed environment allowlist. Go tools installed under `/root/go/bin` are
copied to `/usr/local/bin` so those commands can still invoke them without access
to root's home directory. `execute_code` writes each source file to a unique path
without shell interpolation, makes it read-only to the child, and cleans up its
source and compiled output after the run. `proxy_brain` now writes its source file
directly instead of interpolating model-authored code into a root shell heredoc,
then uses the same bounded unprivileged runner with an explicit environment
override allowlist for its signed context and service endpoints. All four
arbitrary-code routes cap captured stdout and stderr at 2 MiB per stream, drain
excess output without retaining it, and terminate the request's process group on
completion or timeout so background descendants cannot outlive the request.
The terminal PTY child clears supplementary groups and drops to UID/GID 65534
before it executes Bash. Its environment is allowlisted and omits the master,
MCP, tunnel, and scanner keys. The agent mints a two-hour graph context from
the verified WebSocket ticket, and terminal graph reads plus `redagraph ask`
derive tenant IDs from that signed context. Request-body identity cannot select
another tenant on these terminal routes. The legacy `/graph/exec`,
`/text-to-cypher`, and `/graph/nl-query` routes now require configured master
auth, so scanner-only workers cannot select a tenant there; the trusted webapp
still supplies owner-checked IDs. Custom Playwright scripts now use the same
process runner; their source is made readable to the
unprivileged child, and output filtering remains in place. A Docker smoke
confirmed a custom script sees UID 65534 and no `INTERNAL_API_KEY`. A
delimiter-like source line is covered to ensure it remains code rather than shell
syntax. Twenty-three focused Docker tests pass for terminal privilege dropping,
credential filtering, unprivileged execution, bounded output, process-group
cleanup, unique paths, proxy context handling, Playwright capture wiring, and
wrapper formatting. These controls
reduce process privilege and resource abuse but do not add project boundaries.
The expanded terminal identity, signed graph-context, graph authorization, and
CLI regression run passes 130 Docker tests plus 65 script-style subchecks,
including scanner-only rejection and equal-key fail-closed behavior.
Context verification for non-terminal tools, custom Playwright project scoping,
and project-worker ownership remain open; the full shared-Kali finding is not
closed.

The terminal PTY now starts through unprivileged user and mount namespaces.
Inside it, `/workspace` is a bind mount of only the ticket-bound project
directory, while `/tmp`, `/var/tmp`, and `/opt/output` are private tmpfs mounts.
A session without a project identity receives an empty private workspace. The
namespace maps its root back to the already-unprivileged UID 65534, and mount
propagation is made private before changing mounts. Docker unit coverage passes
for command construction and path validation; a smoke through the running Kali
PTY confirmed the shell starts, sees only its project, cannot see markers in
the shared temporary paths, and maps namespace UID 0 to host UID 65534. A
disconnect smoke with a running background job confirmed the job and shell are
removed without leaving a Bash zombie. The terminal server uses Linux
child-subreaper behavior and signals all processes in the PTY session, including
jobs that move to a separate process group. The namespace deliberately does not
create a PID namespace; PID isolation remains part of the project-worker design
below. The shared Kali container still hosts the controller and other execution
tools, so this is an incremental terminal boundary rather than the per-project
worker architecture selected below.

The live local deployment was checked on 2026-10-26: both the localhost and LAN
readiness endpoints returned `ready` with database and artifact checks `ok`.
`redamon-kali` was healthy, ran as the image's default user, and had
a read/write `/workspace` bind mount. The `reamon-webapp:latest` image had no
`org.opencontainers.image.revision` label, so the deployed source revision could
not be confirmed.

On 2026-10-26, `kali_shell`, `execute_code`, and `proxy_brain` gained verified project scope.
The trusted executor injects a signed tag; the agent verifies it through
`/execution/resolve-context`; and each run uses a user/mount namespace with
project-only `/workspace` and private `/tmp`, `/var/tmp`, and `/opt/output`.
`execute_code` stages its unique source and compiled binary in the active
project, then removes both after execution. `proxy_brain` stages its Python source
in that project and cleans it after the namespaced run; its signed traffic SDK
context remains available to the broker. Focused Docker suites passed 8 MCP
execution tests and 9 agent identity tests (including subtests). Live Kali
smokes confirmed sibling workspace and shared temporary markers are invisible;
Python and compiled C code both ran and left no source/binary files behind.
The running agent has not been rebuilt against this source. custom Playwright and the global broker ownership model remain open, so the
shared-container finding is not closed.

## Decision

Run every arbitrary-code surface in a project-scoped sandbox worker with its own
filesystem, process namespace, and temporary directory. The `kali_shell`, `execute_code`, `proxy_brain`,
and terminal namespaces are interim boundaries; custom Playwright still needs
this worker architecture. The shared MCP service
will remain a controller: it will authenticate the agent, verify the signed
project scope, route work to the matching worker, and publish selected artifacts
through a project-authorized transfer path.

Use the existing Docker socket broker as the only container-management boundary.
Extend it with a fixed Kali worker profile that enforces the pinned worker image,
resource limits, an isolated bridge network, no host bind mounts, no privileged
mode, no Docker socket, and only the capabilities required for approved Kali
workflows. The MCP controller must not gain direct access to the host Docker
socket. The worker receives no MCP, scanner, agent, database, or tunnel credentials.

The project scope must come from agent-authenticated context, never from a model
argument or a browser-supplied project ID. The worker name and persisted state must
be derived from a verified scope, with explicit expiry and cleanup. Generated
files must cross back through a bounded, project-authorized transfer operation;
the worker must not mount the shared workspace volume.

Route all arbitrary execution through this boundary:

- `kali_shell`
- `execute_code`
- `proxy_brain`
- custom Playwright scripts
- the Kali interactive terminal

Missing scope, failed verification, an unavailable broker, or an invalid worker
must fail closed. Fixed-argument scanner tools can stay in the shared controller
only after review confirms they do not execute model-supplied code or expose
cross-project file paths.

## Acceptance gates

1. Project A writes unique canaries in `/tmp` and its workspace. Project B cannot
   read them using shell, code execution, custom Playwright, terminal, generated
   file download, or another tool route.
2. Project B cannot select Project A's worker by editing tool arguments. The
   controller derives scope from authenticated agent context and the broker
   rejects unverified scope.
3. Commands in a worker cannot read MCP, scanner, agent, database, or tunnel
   credentials from their environment, parent processes, mounts, or broker API.
4. Generated-file publication writes only into the authenticated project's
   workspace, preserves the existing download behavior, and enforces file-size
   and path limits.
5. Workers have tested CPU, memory, process, disk, network, and idle-lifetime
   bounds. Cancellation, project deletion, broker restart, and service upgrade
   clean up or safely recover worker state.
6. CI exercises the broker policy and cross-project isolation. A live deployment
   drill confirms the same behavior on the release candidate.

Until these gates pass, the shared Kali service remains a release blocker for
multi-user production operation.
