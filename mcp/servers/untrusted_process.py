"""Run model-authored programs with bounded output and reduced privileges."""
from __future__ import annotations

import os
import signal
import subprocess
import threading

_SCOPED_EXEC_SCRIPT = """\
set -eu
mount --make-rprivate /
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /var/tmp
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /dev/shm
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /opt/output
project="/workspace/$1"
[ -d "$project" ] || { echo "Project workspace is unavailable" >&2; exit 1; }
[ "$(readlink -f -- "$project")" = "$project" ] || {
    echo "Project workspace must be a real directory" >&2
    exit 1
}
scratch="$project/.reamon-tmp"
[ ! -L "$scratch" ] || { echo "Project scratch path must not be a symlink" >&2; exit 1; }
mkdir -p -- "$scratch"
[ "$(readlink -f -- "$scratch")" = "$scratch" ] || {
    echo "Project scratch path must be a real directory" >&2
    exit 1
}
chmod 0700 -- "$scratch"
find "$scratch" -type f -mmin +1440 -delete
mount --bind "$scratch" /tmp
mount -o remount,bind,nodev,nosuid /tmp
mount --bind "$project" /workspace
mount -o remount,bind,nodev,nosuid /workspace
shift
cd /workspace
exec "$@"
"""

UNTRUSTED_EXEC_UID = 65534
UNTRUSTED_EXEC_GID = 65534
UNTRUSTED_EXEC_PATH = (
    "/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    ":/usr/local/go/bin"
)
UNTRUSTED_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024
UNTRUSTED_OUTPUT_TRUNCATION = "\n[output truncated after 2 MiB]"
UNTRUSTED_ENV_OVERRIDES = frozenset({
    "REDAMON_AGENT_URL", "REDAMON_CTX", "CAPTURE_PROXY_URL",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "LC_ALL", "PLAYWRIGHT_BROWSERS_PATH",
})


def untrusted_exec_env() -> dict[str, str]:
    """Return a minimal environment for model-authored programs."""
    return {
        "PATH": UNTRUSTED_EXEC_PATH,
        "HOME": "/tmp",
        "TMPDIR": "/tmp",
        "LANG": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
    }


def run_untrusted_child(
    argv: list[str], *, timeout: int, env_overrides: dict[str, str] | None = None,
    workspace_project_id: str | None = None,
) -> subprocess.CompletedProcess:
    """Run as nobody, cap output, and optionally isolate one project workspace."""
    command = argv
    if workspace_project_id is not None:
        project_id = str(workspace_project_id)
        if (not project_id or len(project_id) > 200
                or any(char in project_id for char in ("/", "\\", "\x00"))
                or project_id in (".", "..") or project_id.startswith(".")):
            raise ValueError("invalid project id for scoped execution")
        if os.name != "posix":
            raise RuntimeError("project-scoped execution requires Linux namespaces")
        command = [
            "/usr/bin/unshare", "--user", "--map-root-user", "--mount",
            "--pid", "--fork", "--mount-proc",
            "/bin/sh", "-c", _SCOPED_EXEC_SCRIPT,
            "reamon-exec", project_id, *argv,
        ]
    env = untrusted_exec_env()
    for name, value in (env_overrides or {}).items():
        if name not in UNTRUSTED_ENV_OVERRIDES:
            raise ValueError(f"Environment override is not allowed: {name}")
        env[name] = value

    child = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        user=UNTRUSTED_EXEC_UID,
        group=UNTRUSTED_EXEC_GID,
        extra_groups=(),
        start_new_session=(os.name == "posix"),
    )
    captured = {"stdout": bytearray(), "stderr": bytearray()}
    truncated = {"stdout": False, "stderr": False}

    def drain(name: str, stream) -> None:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                return
            remaining = UNTRUSTED_OUTPUT_LIMIT_BYTES - len(captured[name])
            if remaining > 0:
                captured[name].extend(chunk[:remaining])
            if len(chunk) > remaining:
                truncated[name] = True

    readers = [
        threading.Thread(target=drain, args=(name, stream), daemon=True)
        for name, stream in (("stdout", child.stdout), ("stderr", child.stderr))
    ]
    for reader in readers:
        reader.start()

    timed_out = False
    try:
        child.wait(timeout=timeout)
        if os.name == "posix":
            _kill_process_group(child.pid)
    except subprocess.TimeoutExpired:
        timed_out = True
        if os.name == "posix":
            _kill_process_group(child.pid)
        else:
            child.kill()
        child.wait()
    finally:
        for reader in readers:
            reader.join()
        child.stdout.close()
        child.stderr.close()

    stdout = captured["stdout"].decode("utf-8", errors="replace")
    stderr = captured["stderr"].decode("utf-8", errors="replace")
    if truncated["stdout"]:
        stdout += UNTRUSTED_OUTPUT_TRUNCATION
    if truncated["stderr"]:
        stderr += UNTRUSTED_OUTPUT_TRUNCATION
    if timed_out:
        raise subprocess.TimeoutExpired(command, timeout, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(command, child.returncode, stdout, stderr)


def _kill_process_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
