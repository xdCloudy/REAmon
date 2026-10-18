"""Bounded single-file PHP binding discovery and renames via Phpactor LSP."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any


PHPACTOR_VERSION = "2026.10.07.0"
MAX_SOURCE_BYTES = 512 * 1024
MAX_RENAMES = 80
MAX_VARIABLE_OCCURRENCES = 256
MAX_BINDINGS = 200
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
PHP_KEYWORDS = {
    "__halt_compiler", "abstract", "and", "array", "as", "break", "callable", "case", "catch",
    "class", "clone", "const", "continue", "declare", "default", "die", "do", "echo", "else",
    "elseif", "empty", "enddeclare", "endfor", "endforeach", "endif", "endswitch", "endwhile",
    "enum", "eval", "exit", "extends", "final", "finally", "fn", "for", "foreach", "function",
    "global", "goto", "if", "implements", "include", "include_once", "instanceof", "insteadof",
    "interface", "isset", "list", "match", "namespace", "new", "or", "parent", "print", "private",
    "protected", "public", "readonly", "require", "require_once", "return", "self", "static", "switch",
    "throw", "trait", "try", "unset", "use", "var", "while", "xor", "yield", "yield from",
}


class PhpRefactorError(ValueError):
    """Phpactor could not produce a conservative source refactor."""


class PhpactorUnavailable(PhpRefactorError):
    """The pinned Phpactor runtime is not installed or failed to start."""


def _source_hash(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _php_variable_occurrences(source: str) -> tuple[list[dict[str, Any]], bool]:
    if not re.search(r"<\?(?:php\b|=)", source, re.IGNORECASE):
        raise PhpRefactorError("PHP source must contain a PHP opening tag")
    try:
        from reamon_treesitter import get_reamon_parser_with_language

        parser, _language = get_reamon_parser_with_language("php")
    except Exception as exc:  # noqa: BLE001
        raise PhpRefactorError("The pinned PHP Tree-sitter grammar is unavailable") from exc
    if parser is None:
        raise PhpRefactorError("The pinned PHP Tree-sitter grammar is unavailable")
    tree = parser.parse(source.encode("utf-8"))
    root = tree.root_node
    if root.has_error:
        raise PhpRefactorError("Tree-sitter could not parse this PHP source conservatively")

    scope_nodes = {"function_definition", "method_declaration", "anonymous_function", "arrow_function"}
    occurrences: list[dict[str, Any]] = []
    stack = [(root, False, False, False)]
    truncated = False
    while stack:
        node, inside_scope, inside_global, inside_dynamic = stack.pop()
        inside_scope = inside_scope or node.type in scope_nodes
        inside_global = inside_global or node.type == "global_declaration"
        inside_dynamic = inside_dynamic or node.type == "dynamic_variable_name"
        if node.type == "variable_name" and inside_scope:
            name = node.text.decode("utf-8", errors="strict")
            if name.startswith("$") and name != "$this" and IDENTIFIER.fullmatch(name[1:]):
                if len(occurrences) < MAX_VARIABLE_OCCURRENCES:
                    occurrences.append({
                        "start_byte": node.start_byte,
                        "name": name[1:],
                        "global": inside_global,
                        "dynamic": inside_dynamic,
                    })
                else:
                    truncated = True
        stack.extend((child, inside_scope, inside_global, inside_dynamic) for child in reversed(node.named_children))
    occurrences.sort(key=lambda item: item["start_byte"])
    return occurrences, truncated


def _line_offsets(source: str) -> list[int]:
    offsets = [0]
    for index, char in enumerate(source):
        if char == "\n":
            offsets.append(index + 1)
    return offsets


def _position_index(source: str, position: dict[str, Any], offsets: list[int]) -> int:
    line = position.get("line")
    column = position.get("character")
    if not isinstance(line, int) or not isinstance(column, int) or line < 0 or line >= len(offsets) or column < 0:
        raise PhpRefactorError("Phpactor returned an invalid source range")
    start = offsets[line]
    end = source.find("\n", start)
    if end < 0:
        end = len(source)
    units = 0
    for index, char in enumerate(source[start:end]):
        if units == column:
            return start + index
        units += 2 if ord(char) > 0xFFFF else 1
        if units > column:
            raise PhpRefactorError("Phpactor returned a range inside a UTF-16 character")
    if units == column:
        return end
    raise PhpRefactorError("Phpactor returned a range outside the source")


def _source_position(source: str, byte_offset: int) -> dict[str, int]:
    encoded = source.encode("utf-8")
    if byte_offset < 0 or byte_offset >= len(encoded):
        raise PhpRefactorError("PHP parser returned an invalid variable position")
    prefix = encoded[:byte_offset].decode("utf-8", errors="strict")
    line = prefix.count("\n")
    previous_newline = prefix.rfind("\n")
    line_text = prefix[previous_newline + 1:]
    return {"line": line, "character": len(line_text.encode("utf-16-le")) // 2}


def _byte_offset_to_index(source: str, byte_offset: int) -> int:
    try:
        return len(source.encode("utf-8")[:byte_offset].decode("utf-8", errors="strict"))
    except UnicodeDecodeError as exc:
        raise PhpRefactorError("PHP parser returned an invalid UTF-8 variable position") from exc


class _PhpactorLsp:
    def __init__(self, source: str):
        self.source = source
        self.temp: tempfile.TemporaryDirectory[str] | None = None
        self.process: asyncio.subprocess.Process | None = None
        self.request_id = 0
        self.root_uri = ""
        self.document_uri = ""
        self.server_capabilities: dict[str, Any] = {}

    async def __aenter__(self) -> "_PhpactorLsp":
        binary = os.environ.get("REAMON_PHPACTOR", "/usr/local/bin/phpactor")
        self.temp = tempfile.TemporaryDirectory(prefix="reamon-phpactor-")
        root = Path(self.temp.name).resolve()
        source_path = root / "unit.php"
        source_path.write_text(self.source, encoding="utf-8", newline="")
        for directory in (root / ".home", root / ".config", root / ".cache", root / ".local" / "share"):
            directory.mkdir(parents=True, exist_ok=True)
        self.root_uri = root.as_uri()
        self.document_uri = source_path.as_uri()
        environment = os.environ.copy()
        environment.update({
            "HOME": str(root / ".home"),
            "XDG_CONFIG_HOME": str(root / ".config"),
            "XDG_CACHE_HOME": str(root / ".cache"),
            "XDG_DATA_HOME": str(root / ".local" / "share"),
            "PHPACTOR_DEPRECATIONS": "0",
        })
        environment.pop("PHPRC", None)
        environment.pop("PHP_INI_SCAN_DIR", None)
        try:
            self.process = await asyncio.create_subprocess_exec(
                binary, "language-server", cwd=str(root), env=environment,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            self.temp.cleanup()
            self.temp = None
            raise PhpactorUnavailable("The pinned Phpactor language server is unavailable") from exc
        try:
            result = await self.request("initialize", {
                "processId": None,
                "clientInfo": {"name": "REAmon", "version": "1"},
                "rootUri": self.root_uri,
                "workspaceFolders": [{"uri": self.root_uri, "name": "reamon-php-source"}],
                "capabilities": {
                    "workspace": {"configuration": True, "workspaceFolders": True, "applyEdit": False},
                    "textDocument": {"rename": {"dynamicRegistration": False, "prepareSupport": True}},
                },
                "initializationOptions": {
                    "language_server_phpstan.enabled": False,
                    "language_server_psalm.enabled": False,
                    "language_server_configuration.auto_config": False,
                    "composer.enable": False,
                },
            }, timeout=20)
            capabilities = result.get("capabilities") if isinstance(result, dict) else None
            if not isinstance(capabilities, dict) or not capabilities.get("renameProvider"):
                raise PhpRefactorError("Phpactor did not advertise semantic rename support")
            self.server_capabilities = capabilities
            await self.notify("initialized", {})
            await self.notify("textDocument/didOpen", {"textDocument": {
                "uri": self.document_uri, "languageId": "php", "version": 1, "text": self.source,
            }})
            return self
        except Exception:
            await self.close()
            raise

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        await self.close()

    async def _read_message(self) -> dict[str, Any]:
        process = self.process
        if process is None or process.stdout is None:
            raise PhpRefactorError("Phpactor stopped before completing the request")
        headers: dict[str, str] = {}
        while True:
            line = await process.stdout.readline()
            if not line:
                raise PhpRefactorError("Phpactor closed its LSP output")
            if line in (b"\r\n", b"\n"):
                break
            key, separator, value = line.decode("ascii", errors="replace").partition(":")
            if separator:
                headers[key.strip().lower()] = value.strip()
        try:
            length = int(headers["content-length"])
        except (KeyError, ValueError) as exc:
            raise PhpRefactorError("Phpactor returned a malformed LSP header") from exc
        if length < 2 or length > 4 * 1024 * 1024:
            raise PhpRefactorError("Phpactor returned an oversized LSP message")
        try:
            message = json.loads(await process.stdout.readexactly(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise PhpRefactorError("Phpactor returned invalid LSP JSON") from exc
        if not isinstance(message, dict):
            raise PhpRefactorError("Phpactor returned a malformed LSP message")
        return message

    async def _write_message(self, message: dict[str, Any]) -> None:
        process = self.process
        if process is None or process.stdin is None:
            raise PhpRefactorError("Phpactor input is unavailable")
        payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
        process.stdin.write(f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii") + payload)
        await process.stdin.drain()

    async def request(self, method: str, params: dict[str, Any], timeout: float = 15) -> Any:
        self.request_id += 1
        request_id = self.request_id
        await self._write_message({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            message = await asyncio.wait_for(self._read_message(), timeout=timeout)
            if message.get("method") and "id" in message:
                server_id = message["id"]
                server_method = message.get("method")
                server_params = message.get("params") if isinstance(message.get("params"), dict) else {}
                if server_method == "workspace/configuration":
                    items = server_params.get("items")
                    result = [{} for _ in items] if isinstance(items, list) else []
                else:
                    result = None
                await self._write_message({"jsonrpc": "2.0", "id": server_id, "result": result})
                continue
            if message.get("id") != request_id:
                continue
            error = message.get("error")
            if isinstance(error, dict):
                raise PhpRefactorError(str(error.get("message", "Phpactor LSP request failed"))[:240])
            return message.get("result")

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._write_message({"jsonrpc": "2.0", "method": method, "params": params})

    async def close(self) -> None:
        process = self.process
        if process is not None and process.returncode is None:
            try:
                await asyncio.wait_for(self.request("shutdown", {}, timeout=2), timeout=3)
                await self.notify("exit", {})
                await asyncio.wait_for(process.wait(), timeout=3)
            except Exception:  # noqa: BLE001
                process.kill()
                await process.wait()
        self.process = None
        if self.temp is not None:
            self.temp.cleanup()
            self.temp = None

    async def rename(self, byte_offset: int, new_name: str) -> dict[str, Any] | None:
        return await self.request("textDocument/rename", {
            "textDocument": {"uri": self.document_uri},
            "position": _source_position(self.source, byte_offset),
            "newName": new_name,
        })

    def edits(self, result: Any) -> list[tuple[int, int, str]]:
        if result is None:
            return []
        if not isinstance(result, dict):
            raise PhpRefactorError("Phpactor returned an invalid workspace edit")
        uri_edits: list[tuple[str, list[dict[str, Any]]]] = []
        changes = result.get("changes")
        if isinstance(changes, dict):
            uri_edits.extend((str(uri), edits) for uri, edits in changes.items() if isinstance(edits, list))
        document_changes = result.get("documentChanges")
        if isinstance(document_changes, list):
            for change in document_changes:
                if not isinstance(change, dict) or "textDocument" not in change:
                    raise PhpRefactorError("Phpactor returned a non-text or resource edit")
                document = change.get("textDocument")
                edits = change.get("edits")
                if not isinstance(document, dict) or not isinstance(edits, list):
                    raise PhpRefactorError("Phpactor returned a malformed document edit")
                if document.get("version") not in (None, 1):
                    raise PhpRefactorError("Phpactor returned edits for an unexpected document version")
                uri_edits.append((str(document.get("uri", "")), edits))
        if not uri_edits:
            return []
        if len(uri_edits) != 1 or uri_edits[0][0] != self.document_uri:
            raise PhpRefactorError("Phpactor proposed edits outside the selected PHP file")
        offsets = _line_offsets(self.source)
        indexed: list[tuple[int, int, str]] = []
        for edit in uri_edits[0][1]:
            if not isinstance(edit, dict) or not isinstance(edit.get("range"), dict) or not isinstance(edit.get("newText"), str):
                raise PhpRefactorError("Phpactor returned a malformed text edit")
            range_value = edit["range"]
            start = range_value.get("start")
            end = range_value.get("end")
            if not isinstance(start, dict) or not isinstance(end, dict):
                raise PhpRefactorError("Phpactor returned a malformed source range")
            left = _position_index(self.source, start, offsets)
            right = _position_index(self.source, end, offsets)
            if right <= left:
                raise PhpRefactorError("Phpactor returned an empty or reversed edit")
            indexed.append((left, right, edit["newText"]))
        indexed.sort(key=lambda item: (item[0], item[1]))
        if len(indexed) > 5_000 or any(current[0] < previous[1] for previous, current in zip(indexed, indexed[1:])):
            raise PhpRefactorError("Phpactor returned overlapping or excessive edits")
        return indexed


def _binding_id(source_sha256: str, name: str, edits: list[tuple[int, int, str]]) -> str:
    identity = json.dumps([source_sha256, name, [(left, right) for left, right, _text in edits]], separators=(",", ":"))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]


def _edited_variable_name(source: str, left: int, right: int) -> str | None:
    old_text = source[left:right]
    if old_text.startswith("$") and IDENTIFIER.fullmatch(old_text[1:]):
        return old_text[1:]
    if left > 0 and source[left - 1] == "$" and IDENTIFIER.fullmatch(old_text):
        return old_text
    return None


async def _catalog(source: str, lsp: _PhpactorLsp, *, keep_edits: bool = False) -> tuple[list[dict[str, Any]], bool]:
    occurrences, truncated = _php_variable_occurrences(source)
    source_sha256 = _source_hash(source)
    allowed_edit_ranges: set[tuple[int, int]] = set()
    for occurrence in occurrences:
        token_start = _byte_offset_to_index(source, occurrence["start_byte"])
        token_end = token_start + len(occurrence["name"]) + 1
        if occurrence.get("global") or occurrence.get("dynamic"):
            continue
        allowed_edit_ranges.add((token_start, token_end))
        allowed_edit_ranges.add((token_start + 1, token_end))
    by_ranges: dict[tuple[tuple[int, int], ...], dict[str, Any]] = {}
    for index, occurrence in enumerate(occurrences):
        probe = f"reamonProbe{source_sha256[:12]}{index:04d}"
        try:
            edits = lsp.edits(await lsp.rename(occurrence["start_byte"], probe))
        except PhpRefactorError:
            continue
        if not edits:
            continue
        token_ranges = []
        valid = True
        old_names: set[str] = set()
        for left, right, new_text in edits:
            old_name = _edited_variable_name(source, left, right)
            included_dollar = source[left:right].startswith("$")
            if old_name is None or new_text not in ((f"${probe}", probe) if included_dollar else (probe,)):
                valid = False
                break
            old_names.add(old_name)
            token_ranges.append((left, right))
        if not valid or not token_ranges or len(old_names) != 1 or any(value not in allowed_edit_ranges for value in token_ranges):
            continue
        signature = tuple(sorted(token_ranges))
        old_name = next(iter(old_names))
        binding = by_ranges.get(signature)
        if binding is None:
            binding = {
                "id": _binding_id(source_sha256, old_name, edits),
                "name": old_name,
                "kind": "variable",
                "scopeType": "local",
                "declarationStart": signature[0][0] - (1 if not source[signature[0][0]:signature[0][1]].startswith("$") else 0),
                "referenceCount": len(signature),
                "exported": False,
                "_edits": edits,
            }
            by_ranges[signature] = binding
        if len(by_ranges) >= MAX_BINDINGS:
            truncated = truncated or index < len(occurrences) - 1
            break
    bindings = list(by_ranges.values())
    if not keep_edits:
        for binding in bindings:
            binding.pop("_edits", None)
    return bindings, truncated


async def refactor_source(
    source: str,
    *,
    operation: str,
    expected_sha256: str = "",
    renames: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    encoded = source.encode("utf-8")
    if len(encoded) > MAX_SOURCE_BYTES:
        raise PhpRefactorError("PHP source exceeds the 512 KiB refactor limit")
    if operation not in {"bindings", "rename"}:
        raise PhpRefactorError("Unsupported PHP refactor operation")
    source_sha256 = _source_hash(source)
    requests = renames or []
    if len(requests) > MAX_RENAMES:
        raise PhpRefactorError("The PHP rename request exceeds the 80-binding limit")
    if operation == "rename" and not requests:
        raise PhpRefactorError("Select at least one PHP binding to rename")
    if operation == "rename" and expected_sha256.lower() != source_sha256:
        raise PhpRefactorError("PHP source changed after rename suggestions were generated")
    try:
        async with _PhpactorLsp(source) as lsp:
            raw_occurrences, truncated = _php_variable_occurrences(source)
            catalog, catalog_truncated = await _catalog(source, lsp, keep_edits=operation == "rename")
            if operation == "bindings":
                return {
                    "source_sha256": source_sha256,
                    "bindings": catalog,
                    "truncated": catalog_truncated or truncated or len(raw_occurrences) >= MAX_VARIABLE_OCCURRENCES,
                    "parser_version": PHPACTOR_VERSION,
                }
            by_id = {binding["id"]: binding for binding in catalog}
            selected: list[tuple[dict[str, Any], str, list[tuple[int, int, str]]]] = []
            used_new_names: set[str] = set()
            for item in requests:
                binding_id = str(item.get("binding_id", ""))
                new_name = str(item.get("new_name", ""))
                binding = by_id.get(binding_id)
                if binding is None or not IDENTIFIER.fullmatch(new_name) or new_name.lower() in PHP_KEYWORDS:
                    raise PhpRefactorError("A requested PHP rename does not match a current local binding")
                if new_name == binding["name"] or new_name in used_new_names:
                    raise PhpRefactorError("PHP rename targets must be distinct and differ from the old name")
                if re.search(rf"\${re.escape(new_name)}\b", source):
                    raise PhpRefactorError("PHP rename target already exists in this source file")
                used_new_names.add(new_name)
                selected.append((binding, new_name, binding["_edits"]))

            # Re-resolve every selection by semantic LSP identity immediately
            # before applying its edits; never trust client-supplied positions.
            for index, (binding, new_name, original_edits) in enumerate(selected):
                declaration_byte = len(source[:original_edits[0][0]].encode("utf-8"))
                edits = lsp.edits(await lsp.rename(declaration_byte, new_name))
                expected_ranges = {(left, right) for left, right, _text in original_edits}
                actual_ranges = {(left, right) for left, right, _text in edits}
                if actual_ranges != expected_ranges or any(
                    text not in ((f"${new_name}", new_name) if source[left:right].startswith("$") else (new_name,))
                    for left, right, text in edits
                ):
                    raise PhpRefactorError("Phpactor returned incomplete or unexpected PHP rename edits")
                selected[index] = (binding, new_name, edits)

            all_edits = sorted((edit for _binding, _name, edits in selected for edit in edits), key=lambda value: (value[0], value[1]))
            if any(current[0] < previous[1] for previous, current in zip(all_edits, all_edits[1:])):
                raise PhpRefactorError("Selected PHP renames produced overlapping edits")
            output = source
            for left, right, text in reversed(all_edits):
                output = output[:left] + text + output[right:]
            if len(output.encode("utf-8")) > MAX_SOURCE_BYTES:
                raise PhpRefactorError("Renamed PHP output exceeds the 512 KiB source limit")
            renamed = [{
                "bindingId": binding["id"],
                "oldName": binding["name"],
                "newName": new_name,
                "kind": binding["kind"],
                "referenceCount": binding["referenceCount"],
            } for binding, new_name, _edits in selected]
            return {
                "source_code": output,
                "source_sha256": source_sha256,
                "output_sha256": _source_hash(output),
                "renamed_bindings": renamed,
                "parser_version": PHPACTOR_VERSION,
            }
    except PhpRefactorError:
        raise
    except FileNotFoundError as exc:
        raise PhpactorUnavailable("PHP or the pinned Phpactor language server is unavailable") from exc
    except asyncio.TimeoutError as exc:
        raise PhpactorUnavailable("Phpactor semantic analysis exceeded its time limit") from exc
    except Exception as exc:  # noqa: BLE001
        raise PhpRefactorError("Phpactor could not safely analyze this PHP source") from exc
