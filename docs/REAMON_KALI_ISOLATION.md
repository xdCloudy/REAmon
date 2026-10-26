# Kali execution isolation decision

Status: required production security work; implementation is still open.

## Current exposure

The legacy Kali deployment is one shared `redamon-kali` container whose MCP
controller still runs as root. The `kali_shell`, `execute_code`, and `proxy_brain`
handlers run model-authored commands as UID/GID 65534 with a small environment
that omits MCP, scanner, tunnel, database, and agent credentials. `execute_code`
and `proxy_brain` use unique temporary source paths; execute_code also uses a
unique binary path and removes its files after execution. These changes reduce
child-process privilege and credential exposure, but do not create a
project-scoped filesystem or process boundary.

The container also mounts the complete `agentic/agent-workspace` at `/workspace`.
Project ownership is enforced by the webapp and agent workspace APIs, but those
checks do not apply to a root shell in the Kali container. Workspace copy helpers
make files and directories writable by all local users to accommodate the shared
container, so filesystem permissions do not restore the project boundary.

As a result, the existing project-scoped download route protects browser access
but does not isolate arbitrary Kali execution. The unprivileged command children
still share `/tmp` and can read the complete mounted workspace; other MCP server
processes also retain the service environment. This remains a source-level finding;
it is not a claim that any particular deployment has been exploited.

The unused agent `/files?path=/tmp/...` endpoint has been removed; current browser
downloads use the project-authorized workspace endpoint. This closes that direct
download path only. It does not prevent a shell or code-execution tool in the
shared Kali service from reading other projects' temporary files.

The focused agent Docker regression verifies the unscoped route stays absent and
the workspace download route remains protected by master-key authentication (2
tests passed on 2026-10-25).

The terminal WebSocket proxy now passes ticket-verified user, project, and session
claims to Kali as its first frame and discards browser-supplied `init` frames. Three
focused Docker tests cover claim serialization, forged-frame detection, and the
proxy behavior. This prevents the browser from selecting another shell identity,
but each terminal shell still runs in the shared Kali container.

## Implementation seams verified

The current agent signs a project context tag from its `user_id`, `project_id`,
session, tool, and phase context. The MCP server receives that tag only for
`proxy_brain`, and for selected target-facing tools when capture routing is
enabled. `kali_shell` and `execute_code` are not in that injection set;
`execute_playwright` is conditional on capture routing. The MCP bearer token is
shared across the Kali service and does not identify a project. Therefore these
execution routes currently have no authenticated project identity to present to
a worker controller.

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
override allowlist for its signed context and service endpoints. Shell and code
execution cap captured stdout and stderr at 2 MiB per stream, drain excess output
without retaining it, and terminate the request's process group on completion or
timeout so background descendants cannot outlive the request. A delimiter-like
source line is covered to ensure it remains code rather than shell syntax.
Forty-six focused Docker tests pass for credential filtering, unprivileged
execution, bounded output, process-group cleanup, unique paths, proxy context
handling, and existing wrapper formatting. These controls reduce process
privilege and resource abuse but do not add project boundaries. Context
verification, custom Playwright, terminal isolation, and project-scoped `/tmp` and
workspace storage remain open; the full project-worker finding is not closed.

The live local deployment was checked on 2026-10-26: both the localhost and LAN
readiness endpoints returned `ready` with database and artifact checks `ok`.
`redamon-kali` was healthy, ran as the image's default user, and had
a read/write `/workspace` bind mount. The `reamon-webapp:latest` image had no
`org.opencontainers.image.revision` label, so the deployed source revision could
not be confirmed.

These observations make context propagation and the broker ownership model
implementation prerequisites, in addition to moving the shell into a separate
worker. They do not change the isolation decision or close the shared-container
finding.

## Decision

Run every arbitrary-code surface in a project-scoped sandbox worker with its own
filesystem, process namespace, and temporary directory. The shared MCP service
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
