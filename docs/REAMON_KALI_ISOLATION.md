# Kali execution isolation decision

Status: required production security work; implementation is still open.

## Current exposure

The legacy Kali deployment is one shared `redamon-kali` container. Its Dockerfile
does not select a non-root user, and the `kali_shell` MCP tool runs arbitrary
commands with `bash -c` in the MCP server process environment. The `execute_code`
and `proxy_brain` tools also execute caller-provided code in that shared container;
`proxy_brain` explicitly copies the server environment into the child process.

The container also mounts the complete `agentic/agent-workspace` at `/workspace`.
Project ownership is enforced by the webapp and agent workspace APIs, but those
checks do not apply to a root shell in the Kali container. Workspace copy helpers
make files and directories writable by all local users to accommodate the shared
container, so filesystem permissions do not restore the project boundary.

As a result, the existing project-scoped download route protects browser access
but does not isolate arbitrary Kali execution. A process in the shared service can
read another project's temporary files or workspace files, and arbitrary code can
observe environment values passed to its process. This is a source-level finding;
it is not a claim that any particular deployment has been exploited.

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
