"""
Output-offload helper.

After a tool runs, route its output through `maybe_offload()`. If policy says
"always" - or "auto" + size exceeds threshold - write the full output to
/workspace/<projectId>/tool-outputs/<utc-iso>-<tool>.txt and return a head/tail
stub. Otherwise return the output unchanged.

Per-call override: the executor sniffs `output_mode` out of tool_args (via
`strip_output_mode()`) BEFORE dispatching, so MCP servers never see it. The
returned override wins over the per-tool policy.
"""
from __future__ import annotations

import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from tool_offload_policy import get_offload_mode, OFFLOAD_THRESHOLD

logger = logging.getLogger(__name__)

WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", "/workspace"))

HEAD_LINES = 80
TAIL_LINES = 40
# Char caps protect against tools that emit huge single-line output
# (base64 blobs, minified JSON) - without these, head/tail join would
# render the entire output and defeat the offload.
HEAD_CHAR_CAP = 4000
TAIL_CHAR_CAP = 2000


_OFFLOAD_OVERRIDE_VALUES = {"inline", "file", "auto"}
_SAFE_PATH_COMPONENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def _is_safe_component(value: str) -> bool:
    return value not in {".", ".."} and bool(_SAFE_PATH_COMPONENT.fullmatch(value))


def _open_directory_at(parent_fd: int, name: str) -> int:
    try:
        os.mkdir(name, mode=0o770, dir_fd=parent_fd)
    except FileExistsError:
        pass
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    return os.open(name, flags, dir_fd=parent_fd)


def _open_project_outputs(project_id: str) -> int:
    """Open the project output directory without following project symlinks."""
    if not _is_safe_component(project_id):
        raise ValueError("project id is not a safe path component")
    root_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    root_fd = os.open(WORKSPACE_ROOT, root_flags)
    project_fd = None
    try:
        project_fd = _open_directory_at(root_fd, project_id)
        return _open_directory_at(project_fd, "tool-outputs")
    finally:
        if project_fd is not None:
            os.close(project_fd)
        os.close(root_fd)


def _create_output_file(outputs_fd: int, filename: str) -> tuple[int, str]:
    """Create a new output entry; never truncate an existing file or follow links."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        return os.open(filename, flags, 0o666, dir_fd=outputs_fd), filename
    except FileExistsError:
        stem, suffix = os.path.splitext(filename)
        for _ in range(8):
            unique_name = f"{stem}-{uuid.uuid4().hex[:12]}{suffix}"
            try:
                return os.open(unique_name, flags, 0o666, dir_fd=outputs_fd), unique_name
            except FileExistsError:
                continue
        raise OSError("could not allocate a unique output filename")


def strip_output_mode(tool_args) -> tuple:
    """
    Pop `output_mode` from tool_args ONLY when its value is an offload override
    (`inline` | `file` | `auto`), and return (cleaned_args, override).

    Tools like `fs_grep` own a native `output_mode` param with a different
    vocabulary (`files_with_matches` | `content` | `count`). Stripping it
    unconditionally would silently revert those calls to the default and
    swallow caller intent — bug observed: fs_grep(output_mode="content")
    returned just the filename because the param was eaten before reaching
    the tool. Now the strip only fires for the offload tokens.

    Called by PhaseAwareToolExecutor BEFORE invoking the tool so MCP servers
    never see the offload override. Returns the original args dict (unchanged)
    and None when no override is set OR the value belongs to the tool.
    """
    if not isinstance(tool_args, dict) or "output_mode" not in tool_args:
        return tool_args, None
    value = tool_args.get("output_mode")
    if value not in _OFFLOAD_OVERRIDE_VALUES:
        return tool_args, None
    cleaned = {k: v for k, v in tool_args.items() if k != "output_mode"}
    return cleaned, value


def _resolve_mode(tool_name: str, override: Optional[str]) -> str:
    """
    Return one of: "inline" (never offload), "offload" (always offload),
    or "auto" (size-driven).

    Override values are the user-facing ones: "inline" | "file" | "auto".
    Policy values are the registry ones: "never" | "always" | "auto".
    This function normalises both into the three internal decision modes.
    """
    if override == "inline":
        return "inline"
    if override == "file":
        return "offload"
    if override == "auto":
        return "auto"
    # unknown override (or None) -> fall through to per-tool policy
    pol = get_offload_mode(tool_name)
    if pol == "never":
        return "inline"
    if pol == "always":
        return "offload"
    return "auto"


def maybe_offload(
    project_id: str,
    tool_name: str,
    output,
    *,
    override: Optional[str] = None,
    job_id: Optional[str] = None,
) -> str:
    """
    Possibly write `output` to disk and return a head/tail stub; else return
    `output` unchanged.

    Args:
        project_id: required - decides which /workspace/<projectId>/tool-outputs/ dir.
        tool_name: used for the policy lookup + filename.
        output: tool output (str or anything coercible).
        override: per-call override stripped from tool_args by the executor.
        job_id: if set, file is named "<job_id>-<tool>.log" instead of timestamp.
    """
    if output is None:
        return ""
    if not isinstance(output, str):
        output = str(output)
    if not project_id or not _is_safe_component(project_id):
        # No project scope - can't safely offload. Return as-is.
        return output

    mode = _resolve_mode(tool_name, override)
    if mode == "inline":
        return output
    if mode == "auto" and len(output) <= OFFLOAD_THRESHOLD:
        return output
    # else: mode == "offload", or mode == "auto" and over threshold

    if not _is_safe_component(tool_name) or (job_id is not None and not _is_safe_component(job_id)):
        logger.error("offload: refusing unsafe tool or job identifier")
        return output

    try:
        outputs_fd = _open_project_outputs(project_id)
    except Exception as e:
        logger.error(f"offload: cannot safely open output directory for project {project_id}: {e}")
        return output

    if job_id:
        filename = f"{job_id}-{tool_name}.log"
    else:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
        filename = f"{ts}-{tool_name}.txt"
    try:
        file_fd, filename = _create_output_file(outputs_fd, filename)
        try:
            with os.fdopen(file_fd, "w", encoding="utf-8") as target:
                target.write(output)
        except Exception:
            try:
                os.unlink(filename, dir_fd=outputs_fd)
            except OSError:
                pass
            raise
    except Exception as e:
        logger.error(f"offload: failed to write tool output for project {project_id}: {e}")
        return output
    finally:
        os.close(outputs_fd)

    return _format_stub(output, filename, len(output))


def _format_stub(output: str, filename: str, byte_len: int) -> str:
    lines = output.splitlines()
    head = "\n".join(lines[:HEAD_LINES])
    if len(head) > HEAD_CHAR_CAP:
        head = head[:HEAD_CHAR_CAP] + "\n[head truncated]"
    has_tail = len(lines) > HEAD_LINES
    tail = "\n".join(lines[-TAIL_LINES:]) if has_tail else ""
    if len(tail) > TAIL_CHAR_CAP:
        tail = "[tail truncated]\n" + tail[-TAIL_CHAR_CAP:]
    parts = [
        f"[Output offloaded: {byte_len} chars -> tool-outputs/{filename}]",
        f"[Head {HEAD_LINES} lines / Tail {TAIL_LINES} lines below. "
        f"Use fs_read for full output; fs_grep over tool-outputs/ to search.]",
        "--- head ---",
        head,
    ]
    if tail:
        parts.append("--- tail ---")
        parts.append(tail)
    return "\n".join(parts)
