"""
RedAmon Terminal Server — WebSocket PTY for Kali Sandbox

Provides a WebSocket endpoint that spawns an interactive bash shell
with full PTY support. Used by the RedAmon Terminal tab in the webapp.

Runs on port 8016 inside the kali-sandbox container.
"""

import asyncio
import ctypes
import fcntl
import os
import sys
import pty
import signal
import struct
import termios
import json
import logging
from untrusted_process import UNTRUSTED_EXEC_NOFILE_LIMIT, UNTRUSTED_EXEC_PRLIMIT

logging.basicConfig(level=logging.INFO, format="%(asctime)s [terminal] %(message)s")
logger = logging.getLogger("terminal-server")

PORT = int(os.getenv("TERMINAL_WS_PORT", "8016"))
MAX_SESSIONS = int(os.getenv("TERMINAL_MAX_SESSIONS", "5"))
_TERMINAL_UID = 65534
_TERMINAL_GID = 65534
_TERMINAL_PATH = (
    "/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    ":/usr/local/go/bin"
)
_TERMINAL_SANDBOX_SCRIPT = """\
set -eu
mount --make-rprivate /
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /var/tmp
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /opt/output
if [ -n "$1" ]; then
    project="/workspace/$1"
    [ -d "$project" ] || { echo "Project workspace is unavailable" >&2; exit 1; }
    [ "$(readlink -f -- "$project")" = "$project" ] || {
        echo "Project workspace must be a real directory" >&2
        exit 1
    }
    mount --bind "$project" /workspace
    mount -o remount,bind,nodev,nosuid /workspace
else
    mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /workspace
fi
cd /workspace
exec /bin/bash --login
"""

_active_sessions = 0
_session_lock = asyncio.Lock()
_PR_SET_CHILD_SUBREAPER = 36


def _enable_terminal_child_reaper() -> None:
    """Let the PTY server reap descendants orphaned during session shutdown."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(_PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def _terminal_session_pids(session_id: int) -> list[int]:
    """Return visible process IDs that still belong to this PTY session."""
    members: list[int] = []
    try:
        entries = os.scandir("/proc")
    except OSError:
        return members
    with entries:
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            process_id = int(entry.name)
            if process_id == os.getpid():
                continue
            try:
                if os.getsid(process_id) == session_id:
                    members.append(process_id)
            except (ProcessLookupError, PermissionError):
                continue
    return members


def _signal_terminal_session(session_id: int, signum: int) -> None:
    for process_id in _terminal_session_pids(session_id):
        try:
            os.kill(process_id, signum)
        except (ProcessLookupError, PermissionError):
            continue


def _reap_terminal_session_descendants(session_id: int, direct_child_pid: int) -> None:
    for process_id in _terminal_session_pids(session_id):
        if process_id == direct_child_pid:
            continue
        try:
            os.waitpid(process_id, os.WNOHANG)
        except (ChildProcessError, ProcessLookupError):
            continue


async def _terminate_terminal_session(session_id: int) -> None:
    """Stop every process in the PTY session and reap adopted descendants."""
    _signal_terminal_session(session_id, signal.SIGTERM)
    direct_child_reaped = False
    for _ in range(10):
        _reap_terminal_session_descendants(session_id, session_id)
        if not direct_child_reaped:
            try:
                result = os.waitpid(session_id, os.WNOHANG)
                direct_child_reaped = result[0] == session_id
            except ChildProcessError:
                direct_child_reaped = True
        if direct_child_reaped and not _terminal_session_pids(session_id):
            return
        await asyncio.sleep(0.1)

    _signal_terminal_session(session_id, signal.SIGKILL)
    for _ in range(10):
        _reap_terminal_session_descendants(session_id, session_id)
        if not direct_child_reaped:
            try:
                result = os.waitpid(session_id, os.WNOHANG)
                direct_child_reaped = result[0] == session_id
            except ChildProcessError:
                direct_child_reaped = True
        if direct_child_reaped and not _terminal_session_pids(session_id):
            return
        await asyncio.sleep(0.1)


def _effective_max_sessions() -> int:
    """MAX_SESSIONS, further reduced under memory pressure by the resource
    governor when available. Byte-budget on the measured terminal-session
    envelope. Fail-open to MAX_SESSIONS (governor absent/disabled)."""
    try:
        from graph_db import resource_governor as rg
    except Exception:
        try:
            # Functional fallback: graph_db lives beside mcp_servers (…/graph_db).
            _gd = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "graph_db")
            if _gd not in sys.path:
                sys.path.insert(0, _gd)
            import resource_governor as rg
        except Exception:
            return MAX_SESSIONS
    try:
        if not rg.governor_enabled():
            return MAX_SESSIONS
        env = rg.envelope("mcp_terminal_session_envelope_bytes")
        frac = rg._env_float("AGENT_MEM_BUDGET_FRACTION", 0.5)
        return max(1, min(MAX_SESSIONS, rg.scaled_cap(MAX_SESSIONS, env, frac, 1)))
    except Exception:
        return MAX_SESSIONS


async def _pty_session(ws):
    """Handle a single WebSocket connection with a PTY bash shell."""
    global _active_sessions

    async with _session_lock:
        eff_max = _effective_max_sessions()
        if _active_sessions >= eff_max:
            logger.warning("Max sessions (%d) reached, rejecting connection", eff_max)
            await ws.close(1013, "Max terminal sessions reached")
            return
        _active_sessions += 1

    logger.info("Terminal session started (active: %d)", _active_sessions)

    try:
        await _run_pty_session(ws)
    finally:
        async with _session_lock:
            _active_sessions -= 1
        logger.info("Terminal session ended (active: %d)", _active_sessions)


async def _read_init_frame(ws, timeout: float = 0.5):
    """
    Try to read an optional `init` JSON frame from the browser before forking.

    Expected shape: {"type": "init", "user_id": "...", "project_id": "..."}.
    Returns (tenant_env, replay_bytes):
      - tenant_env: dict of env vars to inject into the shell (may be empty)
      - replay_bytes: the first frame's raw bytes if it was NOT an init frame,
        so the PTY loop can replay it (preserves backward compat with clients
        that don't send init).
    """
    tenant_env: dict = {}
    replay: bytes = b""
    try:
        first = await asyncio.wait_for(ws.recv(), timeout=timeout)
    except (asyncio.TimeoutError, Exception):
        return tenant_env, replay

    if isinstance(first, str):
        try:
            msg = json.loads(first)
            if isinstance(msg, dict) and msg.get("type") == "init":
                user_id = str(msg.get("user_id", "")).strip()
                project_id = str(msg.get("project_id", "")).strip()
                graph_ctx = str(msg.get("graph_ctx", "")).strip()
                if user_id:
                    tenant_env["REDAMON_USER_ID"] = user_id
                if project_id:
                    tenant_env["REDAMON_PROJECT_ID"] = project_id
                if graph_ctx and len(graph_ctx) <= 4096 and not any(
                    ord(char) < 32 for char in graph_ctx
                ):
                    tenant_env["REDAMON_CTX"] = graph_ctx
                logger.info(
                    "Init frame received (user=%s project=%s)",
                    user_id or "<none>", project_id or "<none>",
                )
                return tenant_env, replay
        except (json.JSONDecodeError, TypeError):
            pass
        replay = first.encode("utf-8")
    elif isinstance(first, (bytes, bytearray)):
        replay = bytes(first)

    return tenant_env, replay


def _terminal_shell_env(tenant_env: dict) -> dict[str, str]:
    """Build the small environment needed by the interactive unprivileged shell."""
    env = {
        "PATH": _TERMINAL_PATH,
        "HOME": "/tmp",
        "TMPDIR": "/tmp",
        "LANG": "C.UTF-8",
        "TERM": "xterm-256color",
        "SHELL": "/bin/bash",
        "PS1": r"\[\033[1;31m\]redamon\[\033[0m\]@\[\033[1;36m\]kali\[\033[0m\]:\[\033[1;33m\]\w\[\033[0m\]$ ",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
        "REDAMON_AGENT_URL": os.environ.get("REDAMON_AGENT_URL", "http://agent:8080"),
    }
    # Do not expose the reusable scanner key. The agent's terminal proxy can
    # instead pass a short-lived signed context bound to this project's session.
    graph_ctx = str(tenant_env.get("REDAMON_CTX", ""))[:4096]
    if graph_ctx and not any(ord(char) < 32 for char in graph_ctx):
        env["REDAMON_CTX"] = graph_ctx
    for name in ("REDAMON_USER_ID", "REDAMON_PROJECT_ID"):
        value = str(tenant_env.get(name, ""))[:200]
        if value and not any(ord(char) < 32 for char in value):
            env[name] = value
    return env


def _drop_terminal_privileges() -> None:
    """Drop the PTY child from the root controller account to nobody."""
    os.setgroups([])
    os.setgid(_TERMINAL_GID)
    os.setuid(_TERMINAL_UID)


def _terminal_sandbox_command(tenant_env: dict) -> list[str]:
    """Build the namespace wrapper that confines the shell to one project.

    The outer shell process is already nobody. ``--map-root-user`` maps the
    namespace's root back to that unprivileged host UID, so mount operations
    are allowed without granting capabilities in the container's host namespace.
    Avoiding a PID namespace keeps the shell attached to the PTY process tree;
    session cleanup handles descendants and reaps orphans in the server process.
    """
    project_id = str(tenant_env.get("REDAMON_PROJECT_ID", "")).strip()
    if project_id:
        invalid_separator = any(char in project_id for char in ("/", "\\", "\x00"))
        if len(project_id) > 200 or invalid_separator:
            raise ValueError("invalid project id for terminal workspace")
        if project_id in (".", "..") or project_id.startswith("."):
            raise ValueError("invalid project id for terminal workspace")
    return [
        UNTRUSTED_EXEC_PRLIMIT,
        "--core=0:0",
        f"--nofile={UNTRUSTED_EXEC_NOFILE_LIMIT}:{UNTRUSTED_EXEC_NOFILE_LIMIT}",
        "--",
        "/usr/bin/unshare", "--user", "--map-root-user", "--mount",
        "--pid", "--fork", "--mount-proc",
        "/bin/sh", "-c",
        _TERMINAL_SANDBOX_SCRIPT, "reamon-terminal", project_id,
    ]


async def _run_pty_session(ws):
    """Run the actual PTY session for a WebSocket connection."""
    tenant_env, replay_bytes = await _read_init_frame(ws)

    master_fd, slave_fd = pty.openpty()
    pid = os.fork()

    if pid == 0:
        # Child process — become the shell
        os.setsid()
        os.close(master_fd)

        # Set slave as controlling terminal
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)

        env = _terminal_shell_env(tenant_env)
        try:
            _drop_terminal_privileges()
        except Exception as e:
            logger.error("Could not drop terminal shell privileges: %s", e)
            os._exit(126)

        try:
            command = _terminal_sandbox_command(tenant_env)
            os.execvpe(command[0], command, env)
        except Exception as e:
            logger.error("Could not start isolated terminal namespace: %s", e)
            os._exit(126)
        # Never reached
        os._exit(1)

    # Parent process — bridge WebSocket ↔ PTY
    os.close(slave_fd)

    # Set initial terminal size
    _set_pty_size(master_fd, 24, 80)

    # If the first frame was not an init message, replay it to the shell so
    # non-webapp clients (e.g. wscat) keep working.
    if replay_bytes:
        try:
            os.write(master_fd, replay_bytes)
        except OSError as e:
            logger.debug("Replay write failed: %s", e)

    close_event = asyncio.Event()

    async def read_pty():
        """Read from PTY master and forward to WebSocket using async I/O."""
        loop = asyncio.get_event_loop()
        queue = asyncio.Queue()

        def on_readable():
            try:
                data = os.read(master_fd, 4096)
                if data:
                    queue.put_nowait(data)
                else:
                    queue.put_nowait(None)
            except OSError as e:
                logger.debug("PTY read error: %s", e)
                queue.put_nowait(None)

        loop.add_reader(master_fd, on_readable)
        try:
            while not close_event.is_set():
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                if data is None:
                    break
                try:
                    await ws.send(data)
                except Exception as e:
                    logger.debug("WebSocket send error: %s", e)
                    break
        finally:
            try:
                loop.remove_reader(master_fd)
            except Exception:
                pass

    async def write_pty():
        """Read from WebSocket and forward to PTY master."""
        try:
            async for message in ws:
                if close_event.is_set():
                    break

                if isinstance(message, bytes):
                    os.write(master_fd, message)
                elif isinstance(message, str):
                    # Handle JSON control messages
                    try:
                        msg = json.loads(message)
                        msg_type = msg.get("type")
                        if msg_type == "resize":
                            rows = msg.get("rows", 24)
                            cols = msg.get("cols", 80)
                            _set_pty_size(master_fd, rows, cols)
                            continue
                        if msg_type == "ping":
                            continue
                    except (json.JSONDecodeError, TypeError):
                        pass
                    os.write(master_fd, message.encode("utf-8"))
        except Exception as e:
            logger.debug("PTY write loop ended: %s", e)
        finally:
            close_event.set()

    try:
        reader_task = asyncio.create_task(read_pty())
        writer_task = asyncio.create_task(write_pty())
        await asyncio.wait(
            [reader_task, writer_task], return_when=asyncio.FIRST_COMPLETED
        )
    finally:
        close_event.set()
        # Interactive jobs can move to another process group but stay in this
        # session; stop and reap the session as a whole on disconnect.
        await _terminate_terminal_session(pid)
        try:
            os.close(master_fd)
        except OSError:
            pass


def _set_pty_size(fd: int, rows: int, cols: int):
    """Set the PTY window size, clamping to safe bounds."""
    try:
        rows = max(1, min(500, int(rows)))
        cols = max(1, min(500, int(cols)))
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except (OSError, ValueError, TypeError, OverflowError):
        pass


def main():
    """Start the WebSocket terminal server."""
    import websockets

    _enable_terminal_child_reaper()

    logger.info(f"Starting terminal WebSocket server on port {PORT}")

    async def _run():
        async with websockets.serve(
            _pty_session,
            "0.0.0.0",
            PORT,
            ping_interval=30,
            ping_timeout=60,
            max_size=2**20,
        ):
            logger.info(f"Terminal server listening on ws://0.0.0.0:{PORT}")
            await asyncio.Future()  # Run forever

    asyncio.run(_run())


if __name__ == "__main__":
    main()
