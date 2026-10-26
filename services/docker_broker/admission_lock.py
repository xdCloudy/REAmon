"""Cross-process lock for Docker broker capacity checks and container creates."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

LOCK_PATH = os.environ.get(
    "REAMON_ADMISSION_LOCK_PATH", "/run/reamon-admission/container-create.lock",
)


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
