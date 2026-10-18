"""Conservative, single-file Lua and Luau binding refactors using LSP servers."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any


LUALS_VERSION = "3.19.2"
LUAU_LSP_VERSION = "1.70.1"
MAX_SOURCE_BYTES = 512 * 1024
MAX_BINDINGS = 200
MAX_RENAMES = 80
LUA_KEYWORDS = {
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
    "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return",
    "then", "true", "until", "while",
}
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


class LuaRefactorError(ValueError):
    """A Lua binding catalog or rename could not be produced conservatively."""


class LuaRefactorUnavailable(LuaRefactorError):
    """The pinned semantic refactor runtime is not installed or could not start."""


def _source_hash(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _line_offsets(source: str) -> list[int]:
    offsets = [0]
    for index, char in enumerate(source):
        if char == "\n":
            offsets.append(index + 1)
    return offsets


def _utf16_column_to_index(line: str, column: int) -> int:
    if column < 0:
        raise LuaRefactorError("LuaLS returned a negative source position")
    units = 0
    for index, char in enumerate(line):
        if units == column:
            return index
        units += 2 if ord(char) > 0xFFFF else 1
        if units > column:
            raise LuaRefactorError("LuaLS returned a position inside a UTF-16 character")
    if units == column:
        return len(line)
    raise LuaRefactorError("LuaLS returned a source position outside the document")


def _position_index(source: str, position: dict[str, Any], offsets: list[int] | None = None) -> int:
    line_number = position.get("line")
    column = position.get("character")
    if not isinstance(line_number, int) or not isinstance(column, int):
        raise LuaRefactorError("LuaLS returned a malformed source position")
    line_offsets = offsets or _line_offsets(source)
    if line_number < 0 or line_number >= len(line_offsets):
        raise LuaRefactorError("LuaLS returned a source line outside the document")
    start = line_offsets[line_number]
    end = source.find("\n", start)
    if end < 0:
        end = len(source)
    line = source[start:end]
    return start + _utf16_column_to_index(line, column)


def _range_indexes(source: str, value: dict[str, Any], offsets: list[int]) -> tuple[int, int]:
    start = value.get("start")
    end = value.get("end")
    if not isinstance(start, dict) or not isinstance(end, dict):
        raise LuaRefactorError("LuaLS returned a malformed source range")
    left = _position_index(source, start, offsets)
    right = _position_index(source, end, offsets)
    if right <= left:
        raise LuaRefactorError("LuaLS returned an empty or reversed source range")
    return left, right


def _apply_text_edits(source: str, edits: list[dict[str, Any]]) -> str:
    offsets = _line_offsets(source)
    indexed: list[tuple[int, int, str]] = []
    for edit in edits:
        value = edit.get("range")
        new_text = edit.get("newText")
        if not isinstance(value, dict) or not isinstance(new_text, str):
            raise LuaRefactorError("LuaLS returned a malformed text edit")
        left, right = _range_indexes(source, value, offsets)
        indexed.append((left, right, new_text))
    indexed.sort(key=lambda item: (item[0], item[1]))
    for previous, current in zip(indexed, indexed[1:]):
        if current[0] < previous[1]:
            raise LuaRefactorError("LuaLS returned overlapping rename edits")
    output = source
    for left, right, new_text in reversed(indexed):
        output = output[:left] + new_text + output[right:]
    return output


async def _validate_luau_source(source: str) -> str:
    """Parse with the pinned Luau compiler or a Luau Tree-sitter grammar."""
    binary = shutil.which("luau-compile")
    if binary:
        with tempfile.TemporaryDirectory(prefix="reamon-luau-validate-") as temp_dir:
            source_path = Path(temp_dir) / "source.luau"
            source_path.write_text(source, encoding="utf-8", newline="")
            process = await asyncio.create_subprocess_exec(
                binary, "--only-parse", str(source_path),
                cwd=temp_dir,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
            except asyncio.TimeoutError as exc:
                process.kill()
                await process.wait()
                raise LuaRefactorUnavailable("The Luau syntax parser exceeded its time limit") from exc
        if process.returncode != 0:
            detail = (stderr + stdout).decode("utf-8", errors="replace").replace("\x00", " ").strip()
            raise LuaRefactorError(f"Luau compiler rejected the renamed source: {detail[:300] or 'syntax parse failed'}")
        return f"luau-compile-{os.environ.get('REAMON_LUAU_COMPILER_VERSION', '0.742')}-only-parse"
    from reamon_treesitter import get_reamon_parser_with_language
    parser, grammar = get_reamon_parser_with_language("Luau")
    if parser is None or not grammar:
        raise LuaRefactorUnavailable("Neither the pinned Luau compiler nor a Luau syntax grammar is available")
    if parser.parse(source.encode("utf-8")).root_node.has_error:
        raise LuaRefactorError("Tree-sitter rejected the renamed Luau source")
    return f"tree-sitter-{grammar}"


class _LuaLanguageServer:
    def __init__(self, source: str, runtime: str):
        self.source = source
        self.runtime = runtime
        self.is_luau = runtime == "Luau"
        self.server_name = "Luau LSP" if self.is_luau else "LuaLS"
        self.server_version = LUAU_LSP_VERSION if self.is_luau else LUALS_VERSION
        self.temp: tempfile.TemporaryDirectory[str] | None = None
        self.process: asyncio.subprocess.Process | None = None
        self.stderr_task: asyncio.Task[None] | None = None
        self.stderr_tail = bytearray()
        self.request_id = 0
        self.root_uri = ""
        self.document_uri = ""
        self.server_capabilities: dict[str, Any] = {}
        self.server_settings = ({"Luau": {}} if self.is_luau else {
            "Lua": {
                "runtime": {"version": runtime},
                "diagnostics": {"enable": False},
                "workspace": {"checkThirdParty": False, "library": []},
            },
        })

    async def __aenter__(self) -> "_LuaLanguageServer":
        binary = os.environ.get("REAMON_LUAU_LSP", "/usr/local/bin/luau-lsp") if self.is_luau else os.environ.get("REAMON_LUALS", "/opt/lua-language-server/bin/lua-language-server")
        self.temp = tempfile.TemporaryDirectory(prefix="reamon-luau-lsp-" if self.is_luau else "reamon-luals-")
        root = Path(self.temp.name).resolve()
        source_path = root / ("unit.luau" if self.is_luau else "unit.lua")
        source_path.write_text(self.source, encoding="utf-8", newline="")
        self.root_uri = root.as_uri()
        self.document_uri = source_path.as_uri()
        env = os.environ.copy()
        env.update({
            "HOME": str(root),
            "XDG_CONFIG_HOME": str(root / ".config"),
            "XDG_CACHE_HOME": str(root / ".cache"),
            "XDG_DATA_HOME": str(root / ".local" / "share"),
        })
        try:
            self.process = await asyncio.create_subprocess_exec(
                *([binary, "lsp"] if self.is_luau else [binary]),
                cwd=str(root),
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            self.temp.cleanup()
            self.temp = None
            raise LuaRefactorUnavailable(f"The pinned {self.server_name} semantic refactor service is unavailable") from exc
        self.stderr_task = asyncio.create_task(self._drain_stderr())
        try:
            result = await self.request("initialize", {
                "processId": None,
                "clientInfo": {"name": "REAmon", "version": "1"},
                "rootUri": self.root_uri,
                "workspaceFolders": [{"uri": self.root_uri, "name": "reamon-source"}],
                "capabilities": {
                    "workspace": {"configuration": True, "workspaceFolders": True, "applyEdit": False},
                    "textDocument": {
                        "references": {"dynamicRegistration": False},
                        "rename": {"dynamicRegistration": False, "prepareSupport": True},
                        "semanticTokens": {
                            "requests": {"full": True},
                            "tokenTypes": ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
                            "tokenModifiers": ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary", "global"],
                        },
                    },
                },
                "initializationOptions": self.server_settings,
            }, timeout=10)
            capabilities = result.get("capabilities") if isinstance(result, dict) else None
            if not isinstance(capabilities, dict):
                raise LuaRefactorError("LuaLS did not return language-server capabilities")
            self.server_capabilities = capabilities
            await self.notify("initialized", {})
            await self.notify("workspace/didChangeConfiguration", {"settings": self.server_settings})
            await self.notify("textDocument/didOpen", {
                "textDocument": {
                    "uri": self.document_uri,
                    "languageId": "luau" if self.is_luau else "lua",
                    "version": 1,
                    "text": self.source,
                },
            })
            return self
        except Exception:
            await self.close()
            raise

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        await self.close()

    async def _drain_stderr(self) -> None:
        process = self.process
        if process is None or process.stderr is None:
            return
        while True:
            chunk = await process.stderr.read(4096)
            if not chunk:
                return
            self.stderr_tail.extend(chunk)
            if len(self.stderr_tail) > 16 * 1024:
                del self.stderr_tail[:-16 * 1024]

    async def _read_message(self) -> dict[str, Any]:
        process = self.process
        if process is None or process.stdout is None:
            raise LuaRefactorError("LuaLS stopped before completing the request")
        content_length: int | None = None
        while True:
            line = await asyncio.wait_for(process.stdout.readline(), timeout=12)
            if not line:
                raise LuaRefactorError("LuaLS stopped before completing the request")
            if line in (b"\r\n", b"\n"):
                break
            key, separator, value = line.partition(b":")
            if separator and key.strip().lower() == b"content-length":
                try:
                    content_length = int(value.strip())
                except ValueError as exc:
                    raise LuaRefactorError("LuaLS sent an invalid JSON-RPC frame") from exc
        if content_length is None or content_length < 0 or content_length > 16 * 1024 * 1024:
            raise LuaRefactorError("LuaLS sent an invalid JSON-RPC frame")
        payload = await asyncio.wait_for(process.stdout.readexactly(content_length), timeout=12)
        try:
            message = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise LuaRefactorError("LuaLS sent invalid JSON-RPC data") from exc
        if not isinstance(message, dict):
            raise LuaRefactorError("LuaLS sent an invalid JSON-RPC message")
        return message

    async def _write_message(self, message: dict[str, Any]) -> None:
        process = self.process
        if process is None or process.stdin is None:
            raise LuaRefactorError("LuaLS stopped before completing the request")
        data = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        process.stdin.write(f"Content-Length: {len(data)}\r\n\r\n".encode("ascii") + data)
        await process.stdin.drain()

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        if self.process is None or self.process.stdin is None:
            raise LuaRefactorError("LuaLS stopped before completing the request")
        data = json.dumps({"jsonrpc": "2.0", "method": method, "params": params}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.process.stdin.write(f"Content-Length: {len(data)}\r\n\r\n".encode("ascii") + data)
        await self.process.stdin.drain()

    async def _respond_to_server_request(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params")
        if request_id is None:
            return
        if method == "workspace/configuration":
            items = params.get("items", []) if isinstance(params, dict) else []
            result = [self.server_settings.get(str(item.get("section", "")).split(".")[0], {}) for item in items if isinstance(item, dict)]
        elif method in {"window/workDoneProgress/create", "client/registerCapability", "client/unregisterCapability"}:
            result = {}
        elif method == "workspace/applyEdit":
            result = {"applied": False, "failureReason": "REAmon applies only explicitly selected source-hash-bound edits."}
        elif method == "window/showMessageRequest":
            result = None
        else:
            result = None
        await self._write_message({"jsonrpc": "2.0", "id": request_id, "result": result})

    async def request(self, method: str, params: dict[str, Any], *, timeout: float = 6) -> Any:
        self.request_id += 1
        request_id = self.request_id
        await self._write_message({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            message = await asyncio.wait_for(self._read_message(), timeout=timeout)
            if message.get("id") == request_id and ("result" in message or "error" in message):
                if "error" in message:
                    error = message["error"]
                    detail = error.get("message") if isinstance(error, dict) else "request failed"
                    raise LuaRefactorError(f"LuaLS {method} failed: {str(detail)[:200]}")
                return message.get("result")
            if "method" in message and "id" in message:
                await self._respond_to_server_request(message)

    async def close(self) -> None:
        process = self.process
        if process is not None:
            if process.returncode is None:
                try:
                    await self.request("shutdown", {}, timeout=1)
                    await self.notify("exit", {})
                    await asyncio.wait_for(process.wait(), timeout=1)
                except Exception:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=1)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()
            self.process = None
        if self.stderr_task:
            self.stderr_task.cancel()
            try:
                await self.stderr_task
            except asyncio.CancelledError:
                pass
            self.stderr_task = None
        if self.temp:
            self.temp.cleanup()
            self.temp = None

    async def catalog(self) -> dict[str, Any]:
        if self.server_capabilities.get("renameProvider") is None:
            raise LuaRefactorError("The configured LuaLS release does not provide semantic rename")
        semantic_capability = self.server_capabilities.get("semanticTokensProvider")
        legend = semantic_capability.get("legend") if isinstance(semantic_capability, dict) else None
        token_types = legend.get("tokenTypes") if isinstance(legend, dict) else None
        token_modifiers = legend.get("tokenModifiers") if isinstance(legend, dict) else None
        if not isinstance(token_types, list) or not isinstance(token_modifiers, list):
            raise LuaRefactorError("LuaLS semantic binding metadata is unavailable")
        semantic = await self.request("textDocument/semanticTokens/full", {"textDocument": {"uri": self.document_uri}})
        data = semantic.get("data") if isinstance(semantic, dict) else None
        if not isinstance(data, list) or len(data) % 5 != 0:
            raise LuaRefactorError("LuaLS returned malformed semantic binding metadata")

        line = 0
        character = 0
        offsets = _line_offsets(self.source)
        bindings: list[dict[str, Any]] = []
        token_kinds = {"variable", "parameter", "function"}
        required_modifiers = {"declaration", "definition"}
        for index in range(0, len(data), 5):
            delta_line, delta_character, length, type_index, modifier_bits = data[index:index + 5]
            if not all(isinstance(value, int) and value >= 0 for value in (delta_line, delta_character, length, type_index, modifier_bits)) or length < 1:
                raise LuaRefactorError("LuaLS returned an invalid semantic token")
            if delta_line:
                line += delta_line
                character = delta_character
            else:
                character += delta_character
            if line >= len(offsets) or type_index >= len(token_types):
                continue
            kind = token_types[type_index]
            modifiers = {
                name for bit, name in enumerate(token_modifiers)
                if isinstance(name, str) and modifier_bits & (1 << bit)
            }
            if kind not in token_kinds or not modifiers.intersection(required_modifiers) or "global" in modifiers or "defaultLibrary" in modifiers:
                continue
            start_position = {"line": line, "character": character}
            end_position = {"line": line, "character": character + length}
            start = _position_index(self.source, start_position, offsets)
            end = _position_index(self.source, end_position, offsets)
            name = self.source[start:end]
            if not IDENTIFIER.fullmatch(name):
                continue
            if not self.is_luau:
                prepared = await self.request("textDocument/prepareRename", {
                    "textDocument": {"uri": self.document_uri},
                    "position": start_position,
                })
                prepared_range = prepared.get("range") if isinstance(prepared, dict) else prepared
                if not isinstance(prepared_range, dict):
                    continue
                try:
                    prepare_start, prepare_end = _range_indexes(self.source, prepared_range, offsets)
                except LuaRefactorError:
                    continue
                if (prepare_start, prepare_end) != (start, end):
                    continue
            references = await self.request("textDocument/references", {
                "textDocument": {"uri": self.document_uri},
                "position": start_position,
                "context": {"includeDeclaration": True},
            })
            if not isinstance(references, list) or len(references) > 20_000:
                continue
            declaration_seen = False
            valid_references = True
            reference_count = 0
            for reference in references:
                if not isinstance(reference, dict) or reference.get("uri") != self.document_uri:
                    valid_references = False
                    break
                range_value = reference.get("range")
                if not isinstance(range_value, dict):
                    valid_references = False
                    break
                try:
                    ref_start, ref_end = _range_indexes(self.source, range_value, offsets)
                except LuaRefactorError:
                    valid_references = False
                    break
                if self.source[ref_start:ref_end] != name:
                    valid_references = False
                    break
                if (ref_start, ref_end) == (start, end):
                    declaration_seen = True
                else:
                    reference_count += 1
            if not valid_references or not declaration_seen or reference_count < 1:
                continue
            start_byte = len(self.source[:start].encode("utf-8"))
            binding_id = hashlib.sha256(f"{_source_hash(self.source)}:{start_byte}:{name}".encode("utf-8")).hexdigest()[:24]
            bindings.append({
                "id": binding_id,
                "name": name,
                "kind": "parameter" if kind == "parameter" else "local-function" if kind == "function" else "local-variable",
                "scopeType": "parameter" if kind == "parameter" else "local",
                "declarationStart": start_byte,
                "declarationLine": line,
                "declarationCharacter": character,
                "referenceCount": reference_count,
                "exported": False,
            })
            if len(bindings) >= MAX_BINDINGS:
                break
        return {
            "source_sha256": _source_hash(self.source),
            "parser_version": self.server_version,
            "bindings": bindings,
            "truncated": len(bindings) >= MAX_BINDINGS,
        }

    async def rename(self, catalog: dict[str, Any], renames: list[dict[str, Any]]) -> dict[str, Any]:
        if not isinstance(renames, list) or not renames or len(renames) > MAX_RENAMES:
            raise LuaRefactorError("Select between 1 and 80 Lua bindings to rename")
        available = {binding["id"]: binding for binding in catalog["bindings"]}
        requested_ids: set[str] = set()
        edits: list[dict[str, Any]] = []
        renamed_bindings = []
        for selection in renames:
            binding_id = selection.get("binding_id") if isinstance(selection, dict) else None
            new_name = selection.get("new_name") if isinstance(selection, dict) else None
            binding = available.get(binding_id) if isinstance(binding_id, str) else None
            if binding is None or binding_id in requested_ids:
                raise LuaRefactorError("A selected Lua rename no longer matches a current local binding")
            keywords = LUA_KEYWORDS | ({"continue", "export", "type"} if self.is_luau else set())
            if not isinstance(new_name, str) or not IDENTIFIER.fullmatch(new_name) or new_name in keywords:
                raise LuaRefactorError("A selected Lua name is not a valid identifier")
            if new_name == binding["name"]:
                raise LuaRefactorError("A selected Lua rename has no name change")
            if re.search(rf"(?<![A-Za-z0-9_]){re.escape(new_name)}(?![A-Za-z0-9_])", self.source):
                raise LuaRefactorError("A proposed Lua name already appears in the source; rename was rejected conservatively")
            requested_ids.add(binding_id)
            start_position = {"line": binding["declarationLine"], "character": binding["declarationCharacter"]}
            result = await self.request("textDocument/rename", {
                "textDocument": {"uri": self.document_uri},
                "position": start_position,
                "newName": new_name,
            })
            if not isinstance(result, dict):
                raise LuaRefactorError("LuaLS could not produce an edit for one selected binding")
            changes = result.get("changes")
            if isinstance(changes, dict):
                if set(changes) != {self.document_uri} or not isinstance(changes[self.document_uri], list):
                    raise LuaRefactorError("LuaLS proposed edits outside the selected source file")
                current_edits = changes[self.document_uri]
            else:
                document_changes = result.get("documentChanges")
                if not isinstance(document_changes, list) or len(document_changes) != 1:
                    raise LuaRefactorError("LuaLS proposed an unsupported multi-file rename")
                document_edit = document_changes[0]
                text_document = document_edit.get("textDocument") if isinstance(document_edit, dict) else None
                current_edits = document_edit.get("edits") if isinstance(document_edit, dict) else None
                if not isinstance(text_document, dict) or text_document.get("uri") != self.document_uri or not isinstance(current_edits, list):
                    raise LuaRefactorError("LuaLS proposed edits outside the selected source file")
            if not current_edits:
                raise LuaRefactorError("LuaLS returned no edits for one selected binding")
            offsets = _line_offsets(self.source)
            for edit in current_edits:
                if not isinstance(edit, dict) or edit.get("newText") != new_name or not isinstance(edit.get("range"), dict):
                    raise LuaRefactorError("LuaLS returned an invalid rename edit")
                left, right = _range_indexes(self.source, edit["range"], offsets)
                if self.source[left:right] != binding["name"]:
                    raise LuaRefactorError("LuaLS rename range no longer matches the binding source")
                edits.append(edit)
            renamed_bindings.append({
                "bindingId": binding_id,
                "oldName": binding["name"],
                "newName": new_name,
                "kind": binding["kind"],
                "referenceCount": binding["referenceCount"],
            })
        output = _apply_text_edits(self.source, edits)
        if self.is_luau:
            syntax_validator = await _validate_luau_source(output)
            parser_version = f"{self.server_version}+{syntax_validator}"
        else:
            from reamon_treesitter import get_reamon_parser_with_language
            parser, _ = get_reamon_parser_with_language("Lua")
            if parser is None or parser.parse(output.encode("utf-8")).root_node.has_error:
                raise LuaRefactorError("The renamed Lua source did not pass structural parsing")
            parser_version = self.server_version
        return {
            "source_sha256": _source_hash(self.source),
            "output_sha256": _source_hash(output),
            "source_code": output,
            "parser_version": parser_version,
            "renamed_bindings": renamed_bindings,
        }


async def refactor_source(
    source: str,
    *,
    operation: str,
    expected_sha256: str = "",
    renames: list[dict[str, Any]] | None = None,
    runtime: str = "Lua 5.5",
) -> dict[str, Any]:
    encoded = source.encode("utf-8")
    if len(encoded) > MAX_SOURCE_BYTES:
        raise LuaRefactorError("Lua/Luau source exceeds the 512 KiB safe-rename limit")
    if runtime not in {f"Lua 5.{minor}" for minor in range(1, 6)} | {"LuaJIT", "Luau"}:
        raise LuaRefactorError("LuaLS supports Lua 5.1–5.5 and LuaJIT; Luau uses the separate Luau language server")
    source_sha256 = _source_hash(source)
    if operation == "rename":
        if not re.fullmatch(r"[a-f0-9]{64}", expected_sha256, re.IGNORECASE) or expected_sha256.lower() != source_sha256:
            raise LuaRefactorError("The source changed after the rename suggestions were generated")
    elif operation != "bindings":
        raise LuaRefactorError("A Lua bindings or rename operation is required")
    async with _LuaLanguageServer(source, runtime) as language_server:
        catalog = await language_server.catalog()
        if operation == "bindings":
            return catalog
        return await language_server.rename(catalog, renames or [])
