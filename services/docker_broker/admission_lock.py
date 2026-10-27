"""Cross-process lock for Docker broker capacity checks and container creates."""
from __future__ import annotations

import asyncio
import hashlib
import os
import re
import stat
from contextlib import asynccontextmanager
from typing import AsyncIterator

LOCK_PATH = os.environ.get(
    "REAMON_ADMISSION_LOCK_PATH", "/run/reamon-admission/container-create.lock",
)
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")


def project_scope_tombstone_path(project_id: str) -> str:
    """Return the stable tombstone path alongside the shared admission lock."""
    if not isinstance(project_id, str) or not _PROJECT_ID_RE.fullmatch(project_id):
        raise ValueError("project scope is invalid")
    scope = hashlib.sha256(project_id.encode("utf-8")).hexdigest()
    return os.path.join(os.path.dirname(LOCK_PATH), "deleted-project-scopes", f"{scope}.tombstone")


def is_project_scope_tombstoned(project_id: str) -> bool:
    """Check whether project admission was permanently closed by deletion."""
    path = project_scope_tombstone_path(project_id)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return False
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError("project scope tombstone is not a regular file")
        return True
    finally:
        os.close(fd)


def tombstone_project_scope(project_id: str) -> bool:
    """Durably prevent new workers for a deleted project; safe to retry."""
    path = project_scope_tombstone_path(project_id)
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        # Existing regular tombstones are the idempotent retry case. A symlink
        # or unexpected file type must fail closed.
        return is_project_scope_tombstoned(project_id)
    try:
        os.write(fd, b"deleted\n")
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        # Some host filesystems do not permit fsync on directory descriptors;
        # the file itself has still been synced, and the volume persists it.
        pass
    return True


def _acquire(path: str) -> int:
    import fcntl

    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _release(fd: int) -> None:
    import fcntl

    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


@asynccontextmanager
async def admission_lock(path: str | None = None) -> AsyncIterator[None]:
    """Hold the shared host lock without blocking the asyncio event loop."""
    acquire_task = asyncio.create_task(asyncio.to_thread(_acquire, path or LOCK_PATH))
    try:
        fd = await asyncio.shield(acquire_task)
    except asyncio.CancelledError:
        # Cancelling to_thread does not stop its OS thread. Wait for its lock
        # acquisition and release it, or that abandoned thread could hold the
        # shared capacity lock forever.
        fd = await acquire_task
        await asyncio.to_thread(_release, fd)
        raise
    try:
        yield
    finally:
        await asyncio.to_thread(_release, fd)
