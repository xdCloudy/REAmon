"""Bounded single-file Ruby local-binding renames resolved by Solargraph."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any


SOLARGRAPH_VERSION = "0.60.4"
MAX_SOURCE_BYTES = 512 * 1024
MAX_RENAMES = 80
MAX_BINDINGS = 200
MAX_BINDING_PROBES = 500
MAX_LOCAL_TOKENS = 50_000
MAX_REFERENCE_ROWS = 20_000
IDENTIFIER = re.compile(r"^[a-z_][A-Za-z0-9_]{0,127}$")
RUBY_KEYWORDS = {
    "BEGIN", "END", "alias", "and", "begin", "break", "case", "class", "def", "defined?", "do",
    "else", "elsif", "end", "ensure", "false", "for", "if", "in", "module", "next", "nil", "not",
    "or", "redo", "rescue", "retry", "return", "self", "super", "then", "true", "undef", "unless",
    "until", "when", "while", "yield", "__ENCODING__", "__FILE__", "__LINE__",
}


class RubyRefactorError(ValueError):
    """Solargraph could not produce a conservative Ruby local-binding refactor."""


class SolargraphUnavailable(RubyRefactorError):
    """The pinned Ruby or Solargraph runtime is missing or failed to start."""


# Ripper identifies local-variable syntax; Solargraph supplies the semantic
# binding identity and same-file reference set. The AST allowlist prevents a
# method name or keyword label from entering the local rename surface.
_SOLARGRAPH_SCRIPT = r'''require "json"
require "ripper"
require "solargraph"
require "solargraph/language_server/host"
require "tempfile"

def add_token(node, output, kind = "variable", candidate = false)
  return unless node.is_a?(Array) && node[0] == :@ident && node[1].is_a?(String)
  pos = node[2]
  return unless pos.is_a?(Array) && pos.length == 2
  output << {"name" => node[1], "line" => pos[0], "column" => pos[1], "kind" => kind, "candidate" => candidate}
end

def add_parameter_pattern(value, output)
  return unless value.is_a?(Array)
  if value[0] == :@ident
    add_token(value, output, "parameter", true)
  elsif value[0] == :mlhs
    value.drop(1).each { |child| add_parameter_pattern(child, output) }
  elsif [:rest_param, :kwrest_param, :blockarg].include?(value[0])
    add_parameter_pattern(value[1], output)
  end
end

def add_params(node, output)
  required, optional, rest, post, keywords, keyword_rest, block = node[1..7]
  Array(required).each { |value| add_parameter_pattern(value, output) }
  Array(optional).each { |pair| add_parameter_pattern(pair.is_a?(Array) ? pair[0] : pair, output) }
  add_parameter_pattern(rest, output)
  Array(post).each { |value| add_parameter_pattern(value, output) }
  # Keyword parameter names are external call-site API. Keep them out of this
  # local-only rename operation until a provider can preserve labels safely.
  add_parameter_pattern(keyword_rest, output)
  add_parameter_pattern(block, output)
end

def collect_locals(node, output)
  return unless node.is_a?(Array)
  case node[0]
  when :var_ref, :var_field
    add_token(node[1], output, "variable", node[0] == :var_field)
  when :params
    add_params(node, output)
  end
  node.each { |child| collect_locals(child, output) if child.is_a?(Array) }
end

input = JSON.parse(STDIN.read)
source = input.fetch("source")
tree = Ripper.sexp(source)
abort("Ruby parser could not parse this source") unless tree
tokens = []
collect_locals(tree, tokens)
tokens.uniq! { |item| [item["line"], item["column"], item["name"]] }
tokens.sort_by! { |item| [item["line"], item["column"]] }
token_truncated = tokens.length > 50_000
tokens = tokens.first(50_000)
candidates = tokens.select { |item| item["candidate"] }
truncated = token_truncated || candidates.length > 500
candidates = candidates.first(500)

file = Tempfile.new(["reamon-ruby-", ".rb"])
host = Solargraph::LanguageServer::Host.new
begin
  file.binmode
  file.write(source)
  file.flush
  uri = "file://#{file.path}"
  host.start
  host.open(uri, source, 1)
  deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 12
  until !host.libraries.empty? && host.libraries.all?(&:mapped?)
    raise "Solargraph workspace mapping timed out" if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
    sleep 0.02
  end
  records = []
  total_references = 0
  candidates.each do |token|
    refs = host.references_from(uri, token["line"] - 1, token["column"], strip: false, only: true) || []
    if refs.length > 20_000 || total_references + refs.length > 20_000
      truncated = true
      break
    end
    total_references += refs.length
    records << {"token" => token, "references" => refs.map(&:to_hash)}
  end
  puts JSON.generate({"solargraph_version" => Solargraph::VERSION, "tokens" => tokens, "records" => records, "truncated" => truncated})
ensure
  host.stop unless host.stopped?
  file.close!
end
'''


def _source_hash(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _line_byte_offsets(source: str) -> list[int]:
    offsets = [0]
    for index, byte in enumerate(source.encode("utf-8")):
        if byte == 0x0A:
            offsets.append(index + 1)
    return offsets


def _records_to_catalog(source: str, source_hash: str, payload: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    records = payload.get("records")
    tokens = payload.get("tokens")
    if (not isinstance(records, list) or len(records) > MAX_BINDING_PROBES
            or not isinstance(tokens, list) or len(tokens) > MAX_LOCAL_TOKENS):
        raise RubyRefactorError("Solargraph returned an invalid local reference index")
    reference_rows = 0
    for record in records:
        refs = record.get("references") if isinstance(record, dict) else None
        if not isinstance(refs, list):
            raise RubyRefactorError("Solargraph returned a malformed local reference record")
        reference_rows += len(refs)
        if reference_rows > MAX_REFERENCE_ROWS:
            raise RubyRefactorError("Solargraph returned too many local reference rows")
    encoded = source.encode("utf-8")
    line_offsets = _line_byte_offsets(source)
    allowed: dict[tuple[int, int], str] = {}
    normalized: list[tuple[str, list[tuple[int, int]], str, int]] = []
    for token in tokens:
        if not isinstance(token, dict):
            raise RubyRefactorError("Solargraph returned a malformed local token")
        name = token.get("name")
        line = token.get("line")
        column = token.get("column")
        if (not isinstance(name, str) or not IDENTIFIER.fullmatch(name) or not isinstance(line, int)
                or not isinstance(column, int) or line < 1 or line > len(line_offsets) or column < 0):
            continue
        start = line_offsets[line - 1] + column
        end = start + len(name.encode("utf-8"))
        if encoded[start:end].decode("utf-8", errors="replace") != name:
            continue
        allowed[(start, end)] = name

    for record in records:
        if not isinstance(record, dict):
            raise RubyRefactorError("Solargraph returned a malformed local reference record")
        token = record.get("token")
        name = token.get("name") if isinstance(token, dict) else None
        refs = record.get("references")
        if not isinstance(name, str) or not isinstance(refs, list):
            continue
        line = token.get("line")
        column = token.get("column")
        if not isinstance(line, int) or not isinstance(column, int) or line < 1 or line > len(line_offsets) or column < 0:
            continue
        candidate_start = line_offsets[line - 1] + column
        if allowed.get((candidate_start, candidate_start + len(name.encode("utf-8")))) != name:
            continue
        ranges: set[tuple[int, int]] = set()
        valid = True
        for reference in refs:
            if not isinstance(reference, dict) or not isinstance(reference.get("range"), dict):
                valid = False
                break
            range_value = reference["range"]
            start_pos = range_value.get("start")
            end_pos = range_value.get("end")
            if not isinstance(start_pos, dict) or not isinstance(end_pos, dict):
                valid = False
                break
            start_line = start_pos.get("line")
            start_column = start_pos.get("character")
            end_line = end_pos.get("line")
            end_column = end_pos.get("character")
            if any(not isinstance(value, int) for value in (start_line, start_column, end_line, end_column)):
                valid = False
                break
            if start_line < 0 or end_line < start_line or end_line >= len(line_offsets) or start_column < 0 or end_column < 0:
                valid = False
                break
            left = line_offsets[start_line] + start_column
            right = line_offsets[end_line] + end_column
            if right <= left or right > len(encoded):
                valid = False
                break
            ranges.add((left, right))
        if not valid or not ranges or any(allowed.get(span) != name for span in ranges):
            continue
        normalized.append((name, sorted(ranges), str(token.get("kind", "variable")), candidate_start))

    by_ranges: dict[tuple[tuple[int, int], ...], dict[str, Any]] = {}
    for name, ranges, kind, candidate_start in normalized:
        signature = tuple(ranges)
        binding = by_ranges.get(signature)
        if binding is None:
            identity = json.dumps([source_hash, name, signature], separators=(",", ":"))
            binding = {
                "id": hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24],
                "name": name,
                "kind": "parameter" if kind == "parameter" else "variable",
                "scopeType": "local",
                "declarationStart": candidate_start,
                "referenceCount": len(signature),
                "exported": False,
                "_ranges": list(signature),
            }
            by_ranges[signature] = binding
        else:
            binding["declarationStart"] = min(binding["declarationStart"], candidate_start)
        if len(by_ranges) >= MAX_BINDINGS:
            break
    return list(by_ranges.values()), payload.get("truncated") is True or len(by_ranges) >= MAX_BINDINGS


async def _solargraph_records(source: str) -> dict[str, Any]:
    executable = os.environ.get("REAMON_SOLARGRAPH_RUBY", "/usr/local/bin/reamon-solargraph-ruby")
    with tempfile.TemporaryDirectory(prefix="reamon-solargraph-") as directory:
        root = Path(directory)
        env = os.environ.copy()
        env.update({
            "HOME": str(root / "home"),
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_DATA_HOME": str(root / "data"),
            "SOLARGRAPH_CACHE": str(root / "solargraph-cache"),
            "SOLARGRAPH_GLOBAL_CONFIG": str(root / "solargraph.yml"),
        })
        for name in ("HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "SOLARGRAPH_CACHE"):
            Path(env[name]).mkdir(parents=True, exist_ok=True)
        try:
            process = await asyncio.create_subprocess_exec(
                executable, "-e", _SOLARGRAPH_SCRIPT,
                cwd=directory,
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise SolargraphUnavailable("The pinned Ruby and Solargraph runtime is unavailable") from exc
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(json.dumps({"source": source}, ensure_ascii=False).encode("utf-8")),
                timeout=25,
            )
        except asyncio.TimeoutError as exc:
            process.kill()
            await process.wait()
            raise SolargraphUnavailable("Solargraph semantic analysis exceeded its time limit") from exc
        if process.returncode != 0:
            detail = stderr.decode("utf-8", errors="replace").replace("\x00", " ").strip()
            if "cannot load such file -- solargraph" in detail or "uninitialized constant Solargraph" in detail:
                raise SolargraphUnavailable("The pinned Solargraph runtime is unavailable")
            raise RubyRefactorError(f"Solargraph could not safely analyze this Ruby source: {detail[:240] or 'analysis failed'}")
        try:
            payload = json.loads(stdout)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise RubyRefactorError("Solargraph returned invalid local reference data") from exc
        if not isinstance(payload, dict) or payload.get("solargraph_version") != SOLARGRAPH_VERSION or not isinstance(payload.get("records"), list):
            raise RubyRefactorError("Solargraph returned an unexpected version or response")
        return payload


def _apply_ranges(source: str, ranges: list[tuple[int, int]], new_name: str) -> str:
    encoded = source.encode("utf-8")
    for left, right in ranges:
        if left < 0 or right <= left or right > len(encoded):
            raise RubyRefactorError("Solargraph returned an invalid Ruby identifier range")
        try:
            old = encoded[left:right].decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise RubyRefactorError("Solargraph returned a range inside a UTF-8 character") from exc
        if not IDENTIFIER.fullmatch(old):
            raise RubyRefactorError("Solargraph returned an edit outside a local identifier")
    output = encoded
    for left, right in reversed(ranges):
        output = output[:left] + new_name.encode("utf-8") + output[right:]
    return output.decode("utf-8", errors="strict")


async def refactor_source(
    source: str,
    *,
    operation: str,
    expected_sha256: str = "",
    renames: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    encoded = source.encode("utf-8")
    if len(encoded) > MAX_SOURCE_BYTES:
        raise RubyRefactorError("Ruby source exceeds the 512 KiB refactor limit")
    if operation not in {"bindings", "rename"}:
        raise RubyRefactorError("Unsupported Ruby refactor operation")
    source_sha256 = _source_hash(source)
    requests = renames or []
    if len(requests) > MAX_RENAMES:
        raise RubyRefactorError("The Ruby rename request exceeds the 80-binding limit")
    if operation == "rename" and not requests:
        raise RubyRefactorError("Select at least one Ruby local binding to rename")
    if operation == "rename" and expected_sha256.lower() != source_sha256:
        raise RubyRefactorError("Ruby source changed after rename suggestions were generated")
    payload = await _solargraph_records(source)
    catalog, truncated = _records_to_catalog(source, source_sha256, payload)
    if operation == "bindings":
        return {
            "source_sha256": source_sha256,
            "bindings": [{key: value for key, value in binding.items() if key != "_ranges"} for binding in catalog],
            "truncated": truncated,
            "parser_version": SOLARGRAPH_VERSION,
        }

    by_id = {binding["id"]: binding for binding in catalog}
    selected: list[tuple[dict[str, Any], str, list[tuple[int, int]]]] = []
    target_names: set[str] = set()
    local_names = {binding["name"] for binding in catalog}
    for item in requests:
        binding = by_id.get(str(item.get("binding_id", "")))
        new_name = str(item.get("new_name", ""))
        if binding is None or not IDENTIFIER.fullmatch(new_name) or new_name in RUBY_KEYWORDS:
            raise RubyRefactorError("A requested Ruby rename does not match a current local binding")
        if new_name == binding["name"] or new_name in target_names or (new_name in local_names and new_name != binding["name"]):
            raise RubyRefactorError("Ruby rename targets must be distinct and avoid existing local bindings")
        if re.search(rf"(?<![A-Za-z0-9_]){re.escape(new_name)}(?![A-Za-z0-9_])", source):
            raise RubyRefactorError("The Ruby rename target already exists in this source file")
        target_names.add(new_name)
        selected.append((binding, new_name, list(binding["_ranges"])))

    combined = sorted((span, name) for _binding, name, ranges in selected for span in ranges)
    for (left, right), (next_left, _next_right) in zip((entry[0] for entry in combined), (entry[0] for entry in combined[1:])):
        if next_left < right:
            raise RubyRefactorError("Selected Ruby renames produced overlapping local edits")
    output = source
    for (left, right), name in reversed(combined):
        output = _apply_ranges(output, [(left, right)], name)
    renamed = [{
        "bindingId": binding["id"],
        "oldName": binding["name"],
        "newName": name,
        "kind": binding["kind"],
        "referenceCount": binding["referenceCount"],
    } for binding, name, _ranges in selected]
    return {
        "source_code": output,
        "source_sha256": source_sha256,
        "output_sha256": _source_hash(output),
        "renamed_bindings": renamed,
        "parser_version": SOLARGRAPH_VERSION,
    }
