"""Hash-bound local Rust renames backed by rust-analyzer's semantic LSP."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

MAX_SOURCE_BYTES = 512 * 1024
MAX_BINDINGS = 5_000
MAX_RENAMES = 80
RUST_ANALYZER_VERSION = "2026-10-12"
_BINDING_CONTAINERS = {
    "let_declaration", "parameter", "self_parameter", "closure_parameter",
    "match_arm", "for_expression", "if_let_expression", "while_let_expression",
}
_NON_EXPANDING_ATTRIBUTES = {
    "allow", "deny", "forbid", "warn", "expect", "cfg", "cfg_attr", "derive", "doc",
    "inline", "cold", "must_use", "repr", "non_exhaustive", "test", "should_panic",
    "ignore", "no_mangle", "export_name", "link", "link_section", "track_caller",
}


def _sha256(source: bytes) -> str:
    return hashlib.sha256(source).hexdigest()


def _file_uri(path: Path) -> str:
    return "file://" + quote(path.resolve().as_posix(), safe="/:@")


def _position(source: str, byte_offset: int) -> dict[str, int]:
    prefix = source.encode("utf-8")[:byte_offset].decode("utf-8")
    line = prefix.count("\n")
    last_newline = prefix.rfind("\n")
    column_text = prefix[last_newline + 1:]
    return {"line": line, "character": len(column_text.encode("utf-16-le")) // 2}


def _range_key(value: dict[str, Any]) -> tuple[int, int, int, int]:
    start, end = value["start"], value["end"]
    return (int(start["line"]), int(start["character"]), int(end["line"]), int(end["character"]))


def _byte_offset(source: str, position: dict[str, Any]) -> int:
    lines = source.splitlines(keepends=True)
    line = int(position["line"])
    character = int(position["character"])
    if line < 0 or line >= len(lines):
        raise ValueError("rust-analyzer returned a location outside the selected source")
    offset = sum(len(item.encode("utf-8")) for item in lines[:line])
    units = 0
    for char in lines[line]:
        if units == character:
            return offset
        width = len(char.encode("utf-16-le")) // 2
        if units < character < units + width:
            raise ValueError("rust-analyzer returned a location inside a UTF-16 surrogate pair")
        units += width
        offset += len(char.encode("utf-8"))
    if units == character:
        return offset
    raise ValueError("rust-analyzer returned a location outside the selected source")


class _Lsp:
    def __init__(self, process: asyncio.subprocess.Process):
        self.process = process
        self.next_id = 1

    async def _send(self, message: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        body = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.process.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body)
        await self.process.stdin.drain()

    async def _read(self) -> dict[str, Any]:
        assert self.process.stdout is not None
        headers: dict[str, str] = {}
        while True:
            line = await self.process.stdout.readline()
            if not line:
                raise RuntimeError("rust-analyzer closed its LSP output")
            if line in (b"\r\n", b"\n"):
                break
            name, separator, value = line.decode("ascii", "strict").partition(":")
            if separator:
                headers[name.strip().lower()] = value.strip()
        length = int(headers.get("content-length", "-1"))
        if length < 0 or length > 8 * 1024 * 1024:
            raise RuntimeError("rust-analyzer returned an invalid LSP frame length")
        body = await self.process.stdout.readexactly(length)
        return json.loads(body)

    async def _answer_server_request(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        params = message.get("params") or {}
        if method == "workspace/configuration":
            result: Any = [None] * len(params.get("items", []))
        elif method == "workspace/applyEdit":
            result = {"applied": False, "failureReason": "REAmon does not permit server-initiated edits"}
        elif method in ("window/workDoneProgress/create", "client/registerCapability", "client/unregisterCapability"):
            result = None
        else:
            await self._send({"jsonrpc": "2.0", "id": message.get("id"), "error": {"code": -32601, "message": "Unsupported rust-analyzer client request"}})
            return
        await self._send({"jsonrpc": "2.0", "id": message.get("id"), "result": result})

    async def request(self, method: str, params: dict[str, Any]) -> Any:
        request_id = self.next_id
        self.next_id += 1
        await self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            message = await asyncio.wait_for(self._read(), timeout=20)
            if "method" in message:
                if "id" in message:
                    await self._answer_server_request(message)
                continue
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise ValueError(str(message["error"].get("message", "rust-analyzer request failed"))[:300])
            return message.get("result")

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})


def _pattern_declarations(source: str) -> list[tuple[int, str]]:
    from reamon_treesitter import get_reamon_parser_with_language

    parser, _ = get_reamon_parser_with_language("rust")
    if parser is None:
        raise RuntimeError("The Rust Tree-sitter grammar is unavailable")
    tree = parser.parse(source.encode("utf-8"))
    if tree.root_node.has_error:
        raise ValueError("The Rust parser rejected the selected source")
    declarations: list[tuple[int, str]] = []
    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        if node.type == "macro_invocation":
            raise ValueError("Rust safe rename is unavailable for files containing macro invocations until macro references can be validated")
        if node.type == "mod_item" and node.child_by_field_name("body") is None:
            raise ValueError("Rust safe rename is unavailable when the selected file declares external modules")
        if node.type in ("attribute_item", "inner_attribute_item"):
            attribute = node.text.decode("utf-8")
            match = re.match(r"#\s*!?\s*\[\s*([A-Za-z_][A-Za-z0-9_]*)", attribute)
            name = match.group(1) if match else ""
            if name in ("cfg", "cfg_attr"):
                raise ValueError("Rust safe rename is unavailable for cfg-conditional source until all variants are indexed")
            if name not in _NON_EXPANDING_ATTRIBUTES:
                raise ValueError("Rust safe rename is unavailable for custom attributes without procedural-macro expansion")
        if node.type in ("identifier", "raw_identifier"):
            parent = node.parent
            while parent is not None:
                if parent.type in _BINDING_CONTAINERS:
                    pattern = parent.child_by_field_name("pattern")
                    if pattern is not None and pattern.start_byte <= node.start_byte < pattern.end_byte:
                        declarations.append((node.start_byte, node.text.decode("utf-8")))
                    break
                if parent.type in ("block", "function_item", "source_file", "match_expression"):
                    break
                parent = parent.parent
        stack.extend(reversed(node.children))
    return declarations


async def _workspace(source: str):
    source_bytes = source.encode("utf-8")
    if len(source_bytes) > MAX_SOURCE_BYTES:
        raise ValueError("Rust source exceeds the 512 KiB safe-rename limit")
    temp = tempfile.TemporaryDirectory(prefix="reamon-rust-rename-")
    root = Path(temp.name)
    source_path = root / "main.rs"
    source_path.write_bytes(source_bytes)
    project = {
        "crates": [{
            "root_module": str(source_path), "edition": "2021", "deps": [], "cfg": [],
            "env": {}, "is_proc_macro": False, "display_name": "reamon_selected_source",
        }],
    }
    project_path = root / "rust-project.json"
    project_path.write_text(json.dumps(project), encoding="utf-8")
    executable = os.environ.get("REAMON_RUST_ANALYZER", "/usr/local/bin/rust-analyzer")
    try:
        process = await asyncio.create_subprocess_exec(
            executable, cwd=root, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ, "RA_LOG": "error", "RUSTUP_AUTO_INSTALL": "0"},
        )
    except FileNotFoundError as exc:
        temp.cleanup()
        raise RuntimeError("The pinned rust-analyzer service is unavailable") from exc
    lsp = _Lsp(process)
    uri = _file_uri(source_path)
    try:
        await lsp.request("initialize", {
            "processId": None,
            "rootUri": _file_uri(root),
            "workspaceFolders": [{"uri": _file_uri(root), "name": "reamon-selected-source"}],
            "capabilities": {
                "general": {"positionEncodings": ["utf-16"]},
                "workspace": {"applyEdit": False, "configuration": True, "workspaceFolders": True},
                "textDocument": {"rename": {"dynamicRegistration": False, "prepareSupport": True}},
            },
            "initializationOptions": {
                "cargo": {"buildScripts": {"enable": False}, "autoreload": {"enable": False}},
                "procMacro": {"enable": False},
                "linkedProjects": [str(project_path)],
            },
        })
        await lsp.notify("initialized", {})
        await lsp.notify("textDocument/didOpen", {"textDocument": {
            "uri": uri, "languageId": "rust", "version": 1, "text": source,
        }})
        await lsp.request("textDocument/documentSymbol", {"textDocument": {"uri": uri}})
        yield lsp, uri, source_path, temp
    finally:
        try:
            if process.returncode is None:
                try:
                    await asyncio.wait_for(lsp.request("shutdown", {}), timeout=2)
                    await lsp.notify("exit", {})
                    await asyncio.wait_for(process.wait(), timeout=2)
                except asyncio.CancelledError:
                    process.kill()
                    await process.wait()
                    raise
                except Exception:  # noqa: BLE001
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
        finally:
            temp.cleanup()


async def _catalog(source: str) -> tuple[str, list[dict[str, Any]], bool]:
    source_bytes = source.encode("utf-8")
    source_hash = _sha256(source_bytes)
    declarations = _pattern_declarations(source)
    bindings: list[dict[str, Any]] = []
    seen: set[tuple[int, int, int, int]] = set()
    async for (lsp, uri, _source_path, _temp) in _workspace(source):
        for byte_offset, name in declarations[:MAX_BINDINGS * 2]:
            pos = _position(source, byte_offset)
            params = {"textDocument": {"uri": uri}, "position": pos}
            try:
                prepared = await lsp.request("textDocument/prepareRename", params)
                if not isinstance(prepared, dict):
                    continue
                declaration_value = prepared.get("range") if isinstance(prepared.get("range"), dict) else prepared
                if not isinstance(declaration_value, dict) or not isinstance(declaration_value.get("start"), dict):
                    continue
                declaration_range = _range_key(declaration_value)
                if declaration_range in seen:
                    continue
                references = await lsp.request("textDocument/references", {
                    **params, "context": {"includeDeclaration": True},
                })
                if not isinstance(references, list) or not references:
                    continue
                ref_keys = set()
                local = True
                for location in references:
                    if not isinstance(location, dict) or location.get("uri") != uri or not isinstance(location.get("range"), dict):
                        local = False
                        break
                    ref_keys.add(_range_key(location["range"]))
                if not local or declaration_range not in ref_keys:
                    continue
                binding_id = hashlib.sha256(f"{source_hash}\0{byte_offset}\0{name}".encode("utf-8")).hexdigest()[:24]
                bindings.append({
                    "id": binding_id, "name": name.removeprefix("r#"),
                    "kind": "local binding", "scopeType": "rust-analyzer LSP local binding",
                    "declarationStart": byte_offset, "referenceCount": len(ref_keys), "exported": False,
                    "_position": pos, "_ranges": sorted(ref_keys),
                })
                seen.add(declaration_range)
                if len(bindings) >= MAX_BINDINGS:
                    break
            except (asyncio.TimeoutError, ValueError, KeyError, TypeError):
                continue
    truncated = len(declarations) > MAX_BINDINGS * 2 or len(bindings) >= MAX_BINDINGS
    return source_hash, bindings, truncated


async def list_rust_bindings(source: str) -> dict[str, Any]:
    source_hash, bindings, truncated = await _catalog(source)
    public = [{key: value for key, value in binding.items() if not key.startswith("_")} for binding in bindings]
    return {"source_sha256": source_hash, "bindings": public, "truncated": truncated, "parser_version": RUST_ANALYZER_VERSION}


async def apply_rust_renames(source: str, expected_sha256: str, renames: list[dict[str, Any]]) -> dict[str, Any]:
    source_bytes = source.encode("utf-8")
    source_hash, bindings, _ = await _catalog(source)
    if source_hash != expected_sha256.lower():
        raise ValueError("Rust source changed after rename suggestions were generated")
    if not 1 <= len(renames) <= MAX_RENAMES:
        raise ValueError("Select between 1 and 80 Rust bindings to rename")
    by_id = {binding["id"]: binding for binding in bindings}
    selected = []
    seen_ids: set[str] = set()
    for item in renames:
        binding_id = item.get("binding_id")
        new_name = item.get("new_name")
        binding = by_id.get(binding_id) if isinstance(binding_id, str) else None
        if (binding is None or binding_id in seen_ids or not isinstance(new_name, str)
                or not new_name or len(new_name) > 128 or not new_name.isidentifier()
                or new_name.startswith("r#") or new_name == binding["name"]):
            raise ValueError("A selected Rust rename no longer matches a valid local binding")
        seen_ids.add(binding_id)
        selected.append((binding, new_name))

    edits: list[tuple[int, int, str]] = []
    renamed: list[dict[str, Any]] = []
    async for (lsp, uri, _source_path, _temp) in _workspace(source):
        for binding, new_name in selected:
            result = await lsp.request("textDocument/rename", {
                "textDocument": {"uri": uri}, "position": binding["_position"], "newName": new_name,
            })
            if not isinstance(result, dict):
                raise ValueError("rust-analyzer could not produce a complete rename edit")
            changes: list[dict[str, Any]] = []
            for edit_uri, items in (result.get("changes") or {}).items():
                if edit_uri != uri or not isinstance(items, list):
                    raise ValueError("Rust rename reaches beyond the selected source file")
                changes.extend(items)
            for change in result.get("documentChanges") or []:
                text_document = change.get("textDocument", {})
                if text_document.get("uri") != uri or "edits" not in change:
                    raise ValueError("Rust rename includes an unsupported workspace operation")
                changes.extend(change["edits"])
            if not changes:
                raise ValueError("rust-analyzer returned no edits for the selected Rust binding")
            changed_ranges = set()
            for change in changes:
                range_value = change.get("range")
                if not isinstance(range_value, dict) or change.get("newText") != new_name:
                    raise ValueError("rust-analyzer returned an unexpected Rust rename edit")
                key = _range_key(range_value)
                changed_ranges.add(key)
                start = _byte_offset(source, range_value["start"])
                end = _byte_offset(source, range_value["end"])
                if source_bytes[start:end].decode("utf-8").removeprefix("r#") != binding["name"]:
                    raise ValueError("rust-analyzer returned an edit that does not match the selected binding")
                edits.append((start, end, new_name))
            if changed_ranges != set(binding["_ranges"]):
                raise ValueError("rust-analyzer returned an incomplete or unexpected reference set")
            renamed.append({
                "bindingId": binding["id"], "oldName": binding["name"], "newName": new_name,
                "kind": binding["kind"], "referenceCount": binding["referenceCount"],
                "scopeType": binding["scopeType"],
            })

    output = source_bytes
    for start, end, replacement in sorted(edits, key=lambda item: item[0], reverse=True):
        output = output[:start] + replacement.encode("utf-8") + output[end:]
    output_source = output.decode("utf-8")
    _pattern_declarations(output_source)
    return {
        "source_sha256": source_hash, "output_sha256": _sha256(output),
        "source_code": output_source, "renamed_bindings": renamed,
        "parser_version": RUST_ANALYZER_VERSION,
    }
