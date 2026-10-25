"""Hash-bound, single-file C/C++ local renames backed by clangd's LSP."""

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
MAX_BINDINGS = 2_000
MAX_RENAMES = 80
_DECLARATORS = {
    "identifier", "field_identifier", "pointer_declarator", "reference_declarator",
    "abstract_pointer_declarator", "array_declarator", "parenthesized_declarator",
    "attributed_declarator", "init_declarator", "function_declarator",
}
_UNSUPPORTED_NODES = {
    "preproc_def", "preproc_function_def", "preproc_call", "preproc_if", "preproc_ifdef",
    "preproc_else", "preproc_elif", "preproc_elifdef", "preproc_elifndef", "preproc_endif",
    "preproc_include_next", "template_declaration", "template_function",
    "template_method", "template_type", "template_parameter_list",
}
_CPP_KEYWORDS = set("""alignas alignof and and_eq asm atomic_cancel atomic_commit atomic_noexcept
auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept
const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype
default delete do double dynamic_cast else enum explicit export extern false float for friend
goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq
private protected public reflexpr register reinterpret_cast requires return short signed sizeof
static static_assert static_cast struct switch synchronized template this thread_local throw true
try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq
""".split())


def _sha256(source: bytes) -> str:
    return hashlib.sha256(source).hexdigest()


async def _clangd_version(executable: str) -> str:
    try:
        process = await asyncio.create_subprocess_exec(
            executable, "--version", stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=5)
    except (FileNotFoundError, asyncio.TimeoutError) as exc:
        raise RuntimeError("The pinned clangd service is unavailable") from exc
    match = re.search(rb"clangd version (\d+\.\d+\.\d+)", stdout)
    if process.returncode != 0 or not match:
        raise RuntimeError("The configured clangd version could not be identified")
    return "clangd-" + match.group(1).decode("ascii")


def _file_uri(path: Path) -> str:
    return "file://" + quote(path.resolve().as_posix(), safe="/:@")


def _position(source: str, byte_offset: int) -> dict[str, int]:
    prefix = source.encode("utf-8")[:byte_offset].decode("utf-8")
    line = prefix.count("\n")
    last_newline = prefix.rfind("\n")
    column = prefix[last_newline + 1:]
    return {"line": line, "character": len(column.encode("utf-16-le")) // 2}


def _range_key(value: dict[str, Any]) -> tuple[int, int, int, int]:
    start, end = value["start"], value["end"]
    return int(start["line"]), int(start["character"]), int(end["line"]), int(end["character"])


def _byte_offset(source: str, position: dict[str, Any]) -> int:
    lines = source.splitlines(keepends=True)
    line, character = int(position["line"]), int(position["character"])
    if line < 0 or line >= len(lines):
        raise ValueError("clangd returned a location outside the selected source")
    offset = sum(len(item.encode("utf-8")) for item in lines[:line])
    units = 0
    for char in lines[line]:
        if units == character:
            return offset
        width = len(char.encode("utf-16-le")) // 2
        if units < character < units + width:
            raise ValueError("clangd returned a location inside a UTF-16 surrogate pair")
        units += width
        offset += len(char.encode("utf-8"))
    if units == character:
        return offset
    raise ValueError("clangd returned a location outside the selected source")


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
                raise RuntimeError("clangd closed its LSP output")
            if line in (b"\r\n", b"\n"):
                break
            name, separator, value = line.decode("ascii", "strict").partition(":")
            if separator:
                headers[name.strip().lower()] = value.strip()
        length = int(headers.get("content-length", "-1"))
        if length < 0 or length > 8 * 1024 * 1024:
            raise RuntimeError("clangd returned an invalid LSP frame length")
        return json.loads(await self.process.stdout.readexactly(length))

    async def _answer_server_request(self, message: dict[str, Any]) -> None:
        method, params = message.get("method"), message.get("params") or {}
        if method == "workspace/configuration":
            result: Any = [None] * len(params.get("items", []))
        elif method == "workspace/applyEdit":
            result = {"applied": False, "failureReason": "REAmon does not permit server-initiated edits"}
        elif method in ("window/workDoneProgress/create", "client/registerCapability", "client/unregisterCapability"):
            result = None
        else:
            await self._send({"jsonrpc": "2.0", "id": message.get("id"), "error": {"code": -32601, "message": "Unsupported clangd client request"}})
            return
        await self._send({"jsonrpc": "2.0", "id": message.get("id"), "result": result})

    async def request(self, method: str, params: dict[str, Any]) -> Any:
        request_id = self.next_id
        self.next_id += 1
        await self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            message = await asyncio.wait_for(self._read(), timeout=30)
            if "method" in message:
                if "id" in message:
                    await self._answer_server_request(message)
                continue
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise ValueError(str(message["error"].get("message", "clangd request failed"))[:300])
            return message.get("result")

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})


def _declarator_name(node) -> Any:
    if node.type in ("identifier", "field_identifier"):
        return node
    if node.type not in _DECLARATORS:
        return None
    declarator = node.child_by_field_name("declarator")
    if declarator is not None:
        return _declarator_name(declarator)
    candidates = [child for child in node.named_children if child.type in _DECLARATORS]
    if len(candidates) == 1:
        return _declarator_name(candidates[0])
    return None


def _pattern_declarations(source: str, language: str) -> list[tuple[int, str, str]]:
    from reamon_treesitter import get_reamon_parser_with_language

    parser, _ = get_reamon_parser_with_language(language)
    if parser is None:
        raise RuntimeError("The C/C++ Tree-sitter grammar is unavailable")
    tree = parser.parse(source.encode("utf-8"))
    if tree.root_node.has_error:
        raise ValueError("The C/C++ parser rejected the selected source")
    declarations: list[tuple[int, str, str]] = []
    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        if node.type in _UNSUPPORTED_NODES:
            raise ValueError("C/C++ safe rename is unavailable for macros, conditional compilation, and templates until complete references can be verified")
        if node.type in ("declaration", "parameter_declaration"):
            declarator = node.child_by_field_name("declarator")
            declarators = ([declarator] if declarator is not None else []) + [
                child for child in node.named_children
                if child.type == "init_declarator" and child is not declarator
            ]
            parent = node.parent
            in_function = False
            while parent is not None:
                if parent.type in ("function_definition", "lambda_expression"):
                    in_function = True
                    break
                if parent.type in ("translation_unit", "class_specifier", "struct_specifier"):
                    break
                parent = parent.parent
            if in_function:
                for candidate in declarators:
                    identifier = _declarator_name(candidate)
                    if identifier is not None:
                        declarations.append((
                            identifier.start_byte, identifier.text.decode("utf-8"),
                            "parameter" if node.type == "parameter_declaration" else "local variable",
                        ))
        stack.extend(reversed(node.children))
    return declarations


def _identifier_offsets(source: str, name: str, language: str) -> set[int]:
    from reamon_treesitter import get_reamon_parser_with_language

    parser, _ = get_reamon_parser_with_language(language)
    if parser is None:
        raise RuntimeError("The C/C++ Tree-sitter grammar is unavailable")
    tree = parser.parse(source.encode("utf-8"))
    offsets: set[int] = set()
    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        if node.type in ("identifier", "field_identifier") and node.text.decode("utf-8") == name:
            offsets.add(node.start_byte)
        stack.extend(node.children)
    return offsets


async def _workspace(source: str, language: str):
    source_bytes = source.encode("utf-8")
    if len(source_bytes) > MAX_SOURCE_BYTES:
        raise ValueError("C/C++ source exceeds the 512 KiB safe-rename limit")
    temp = tempfile.TemporaryDirectory(prefix="reamon-cpp-rename-")
    root = Path(temp.name)
    suffix = ".c" if language == "c" else ".cpp"
    source_path = root / ("main" + suffix)
    source_path.write_bytes(source_bytes)
    executable = os.environ.get("REAMON_CLANGD", "/usr/bin/clangd")
    try:
        process = await asyncio.create_subprocess_exec(
            executable, "--background-index=false", "--clang-tidy=false", "--log=error",
            cwd=root, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        temp.cleanup()
        raise RuntimeError("The pinned clangd service is unavailable") from exc
    lsp = _Lsp(process)
    uri = _file_uri(source_path)
    try:
        await lsp.request("initialize", {
            "processId": None, "rootUri": _file_uri(root),
            "workspaceFolders": [{"uri": _file_uri(root), "name": "reamon-selected-source"}],
            "capabilities": {
                "general": {"positionEncodings": ["utf-16"]},
                "workspace": {"applyEdit": False, "configuration": True, "workspaceFolders": True},
                "textDocument": {"rename": {"dynamicRegistration": False, "prepareSupport": True}},
            },
            "initializationOptions": {"clangdFileStatus": False, "compilationDatabasePath": str(root)},
        })
        await lsp.notify("initialized", {})
        await lsp.notify("textDocument/didOpen", {"textDocument": {
            "uri": uri, "languageId": language, "version": 1, "text": source,
        }})
        await lsp.request("textDocument/documentSymbol", {"textDocument": {"uri": uri}})
        yield lsp, uri, temp
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


async def _catalog(source: str, language: str) -> tuple[str, list[dict[str, Any]], bool, str]:
    raw = source.encode("utf-8")
    source_hash = _sha256(raw)
    declarations = _pattern_declarations(source, language)
    bindings: list[dict[str, Any]] = []
    seen: set[tuple[int, int, int, int]] = set()
    executable = os.environ.get("REAMON_CLANGD", "/usr/bin/clangd")
    parser_version = await _clangd_version(executable)
    async for lsp, uri, _temp in _workspace(source, language):
        for byte_offset, name, kind in declarations[:MAX_BINDINGS * 2]:
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
                ref_keys: set[tuple[int, int, int, int]] = set()
                if not isinstance(references, list) or not references:
                    continue
                for location in references:
                    if not isinstance(location, dict) or location.get("uri") != uri or not isinstance(location.get("range"), dict):
                        ref_keys.clear()
                        break
                    ref_keys.add(_range_key(location["range"]))
                if not ref_keys or declaration_range not in ref_keys:
                    continue
                binding_id = hashlib.sha256(f"{source_hash}\0{byte_offset}\0{name}".encode("utf-8")).hexdigest()[:24]
                bindings.append({
                    "id": binding_id, "name": name, "kind": kind,
                    "scopeType": "clangd same-file semantic binding", "declarationStart": byte_offset,
                    "referenceCount": len(ref_keys), "exported": False,
                    "_position": pos, "_ranges": sorted(ref_keys),
                })
                seen.add(declaration_range)
                if len(bindings) >= MAX_BINDINGS:
                    break
            except (asyncio.TimeoutError, ValueError, KeyError, TypeError):
                continue
    return source_hash, bindings, len(declarations) > MAX_BINDINGS * 2 or len(bindings) >= MAX_BINDINGS, parser_version


async def refactor_cpp_source(
    source: str, *, language: str, operation: str, expected_sha256: str = "",
    renames: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if language not in ("c", "cpp"):
        raise ValueError("C/C++ refactor language must be c or cpp")
    source_bytes = source.encode("utf-8")
    if len(source_bytes) > MAX_SOURCE_BYTES:
        raise ValueError("C/C++ source exceeds the 512 KiB safe-rename limit")
    source_hash, bindings, truncated, parser_version = await _catalog(source, language)
    if operation == "bindings":
        return {
            "source_sha256": source_hash,
            "bindings": [{key: value for key, value in item.items() if not key.startswith("_")} for item in bindings],
            "truncated": truncated, "parser_version": parser_version,
        }
    if source_hash != expected_sha256.lower():
        raise ValueError("C/C++ source changed after rename suggestions were generated")
    if not renames or len(renames) > MAX_RENAMES:
        raise ValueError("Select between 1 and 80 C/C++ bindings to rename")
    by_id = {item["id"]: item for item in bindings}
    selected = []
    seen_ids: set[str] = set()
    for item in renames:
        binding_id, new_name = item.get("binding_id"), item.get("new_name")
        if (not isinstance(binding_id, str) or binding_id not in by_id or binding_id in seen_ids
                or not isinstance(new_name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", new_name)
                or new_name in _CPP_KEYWORDS or new_name == by_id[binding_id]["name"]):
            raise ValueError("A selected C/C++ rename no longer matches a valid local binding")
        seen_ids.add(binding_id)
        selected.append((by_id[binding_id], new_name))

    for binding, new_name in selected:
        binding_occurrences = {
            _byte_offset(source, {"line": key[0], "character": key[1]})
            for key in binding["_ranges"]
        }
        if _identifier_offsets(source, new_name, language) - binding_occurrences:
            raise ValueError("C/C++ safe rename rejected a name already used elsewhere in this source")

    edits: list[tuple[int, int, str]] = []
    renamed: list[dict[str, Any]] = []
    async for lsp, uri, _temp in _workspace(source, language):
        for binding, new_name in selected:
            result = await lsp.request("textDocument/rename", {
                "textDocument": {"uri": uri}, "position": binding["_position"], "newName": new_name,
            })
            if not isinstance(result, dict):
                raise ValueError("clangd could not produce a complete C/C++ rename edit")
            changes: list[dict[str, Any]] = []
            for edit_uri, items in (result.get("changes") or {}).items():
                if edit_uri != uri or not isinstance(items, list):
                    raise ValueError("C/C++ rename reaches beyond the selected source file")
                changes.extend(items)
            for change in result.get("documentChanges") or []:
                if change.get("textDocument", {}).get("uri") != uri or "edits" not in change:
                    raise ValueError("C/C++ rename includes an unsupported workspace operation")
                changes.extend(change["edits"])
            changed_ranges: set[tuple[int, int, int, int]] = set()
            if not changes:
                raise ValueError("clangd returned no edits for the selected C/C++ binding")
            for change in changes:
                range_value = change.get("range")
                if not isinstance(range_value, dict) or change.get("newText") != new_name:
                    raise ValueError("clangd returned an unexpected C/C++ rename edit")
                changed_ranges.add(_range_key(range_value))
                start, end = _byte_offset(source, range_value["start"]), _byte_offset(source, range_value["end"])
                if source_bytes[start:end].decode("utf-8") != binding["name"]:
                    raise ValueError("clangd returned an edit that does not match the selected binding")
                edits.append((start, end, new_name))
            if changed_ranges != set(binding["_ranges"]):
                raise ValueError("clangd returned an incomplete or unexpected C/C++ reference set")
            renamed.append({
                "bindingId": binding["id"], "oldName": binding["name"], "newName": new_name,
                "kind": binding["kind"], "referenceCount": binding["referenceCount"],
                "scopeType": binding["scopeType"],
            })

    output = source_bytes
    ordered_edits = sorted(edits, key=lambda item: item[0], reverse=True)
    for previous, current in zip(ordered_edits, ordered_edits[1:]):
        if current[1] > previous[0]:
            raise ValueError("clangd returned overlapping C/C++ rename edits")
    for start, end, replacement in ordered_edits:
        output = output[:start] + replacement.encode("utf-8") + output[end:]
    output_source = output.decode("utf-8")
    _pattern_declarations(output_source, language)
    return {
        "source_sha256": source_hash, "output_sha256": _sha256(output), "source_code": output_source,
        "renamed_bindings": renamed, "parser_version": parser_version,
    }
