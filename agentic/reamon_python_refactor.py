"""Conservative, single-file Python binding catalog and rename operations."""

from __future__ import annotations

import builtins
import hashlib
import keyword
from dataclasses import dataclass
from typing import Any

import libcst as cst
from libcst.codemod import CodemodContext
from libcst.codemod.commands.rename import RenameCommand
from libcst.metadata import ComprehensionScope, FunctionScope, MetadataWrapper, PositionProvider, Scope, ScopeProvider

MAX_SOURCE_BYTES = 512 * 1024
MAX_BINDINGS = 5_000
MAX_RENAMES = 80


@dataclass(frozen=True)
class PythonBinding:
    id: str
    name: str
    qualified_name: str
    kind: str
    scope_type: str
    declaration_start: int
    reference_count: int
    scope: Scope

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "scopeType": self.scope_type,
            "declarationStart": self.declaration_start,
            "referenceCount": self.reference_count,
            "exported": False,
        }


def source_sha256(source_code: str) -> str:
    return hashlib.sha256(source_code.encode("utf-8")).hexdigest()


def _byte_offset(source_lines: list[str], line: int, column: int) -> int:
    return sum(len(item.encode("utf-8")) for item in source_lines[:line - 1]) + len(
        source_lines[line - 1][:column].encode("utf-8")
    )


def _catalog(source_code: str) -> tuple[str, list[PythonBinding], bool]:
    source_bytes = source_code.encode("utf-8")
    if len(source_bytes) > MAX_SOURCE_BYTES:
        raise ValueError("Python source exceeds the 512 KiB safe-rename limit")
    digest = hashlib.sha256(source_bytes).hexdigest()
    wrapper = MetadataWrapper(cst.parse_module(source_code))
    scopes = wrapper.resolve(ScopeProvider)
    positions = wrapper.resolve(PositionProvider)
    source_lines = source_code.splitlines(keepends=True) or [""]
    bindings: list[PythonBinding] = []
    qualified_name_counts: dict[str, int] = {}

    for scope in set(scopes.values()):
        if not isinstance(scope, (FunctionScope, ComprehensionScope)):
            continue
        for name, scope_assignments in scope.assignments.items():
            assignments = [
                assignment for assignment in scope_assignments
                if isinstance(assignment.node, (cst.Name, cst.Param))
            ]
            if not assignments:
                continue
            qualified_names = {
                qualified_name.name
                for assignment in assignments
                for qualified_name in assignment.get_qualified_names_for(name)
            }
            if len(qualified_names) != 1:
                continue
            qualified_name = next(iter(qualified_names))
            if not qualified_name:
                continue
            qualified_name_counts[qualified_name] = qualified_name_counts.get(qualified_name, 0) + 1
            position = positions.get(assignments[0].node)
            if position is None:
                continue
            declaration_start = _byte_offset(source_lines, position.start.line, position.start.column)
            references = {access for assignment in assignments for access in assignment.references}
            binding_id = hashlib.sha256(
                f"{digest}\0{qualified_name}\0{declaration_start}\0{name}".encode("utf-8")
            ).hexdigest()[:24]
            bindings.append(PythonBinding(
                id=binding_id,
                name=name,
                qualified_name=qualified_name,
                kind="parameter" if isinstance(assignments[0].node, cst.Param) else "local variable",
                scope_type=type(scope).__name__,
                declaration_start=declaration_start,
                reference_count=len(references),
                scope=scope,
            ))

    # RenameCommand addresses a binding by qualified name. Duplicate qualified
    # names can arise from repeated definitions; omit them rather than merge scopes.
    unambiguous = [binding for binding in bindings if qualified_name_counts[binding.qualified_name] == 1]
    truncated = len(unambiguous) > MAX_BINDINGS
    return digest, unambiguous[:MAX_BINDINGS], truncated


def list_python_bindings(source_code: str) -> dict[str, Any]:
    digest, bindings, truncated = _catalog(source_code)
    return {
        "source_sha256": digest,
        "bindings": [binding.public() for binding in bindings],
        "truncated": truncated,
    }


def apply_python_renames(
    source_code: str,
    expected_sha256: str,
    renames: list[dict[str, Any]],
) -> dict[str, Any]:
    digest, bindings, _ = _catalog(source_code)
    if digest != expected_sha256.lower():
        raise ValueError("Python source changed after rename suggestions were generated")
    if not 1 <= len(renames) <= MAX_RENAMES:
        raise ValueError("Select between 1 and 80 Python bindings to rename")
    binding_by_id = {binding.id: binding for binding in bindings}
    selected: list[tuple[PythonBinding, str]] = []
    seen_ids: set[str] = set()
    target_names_by_scope: dict[int, set[str]] = {}

    for rename in renames:
        binding_id = rename.get("binding_id")
        new_name = rename.get("new_name")
        binding = binding_by_id.get(binding_id) if isinstance(binding_id, str) else None
        if (binding is None or binding_id in seen_ids or not isinstance(new_name, str)
                or len(new_name) > 128 or not new_name.isidentifier() or keyword.iskeyword(new_name)
                or new_name == binding.name):
            raise ValueError("A selected Python rename no longer matches a valid local binding")
        seen_ids.add(binding_id)

        # Avoid changing lookup from a local/closure binding to another name.
        current: Scope | None = binding.scope
        while current is not None:
            if current.assignments.get(new_name):
                raise ValueError(f"Renaming {binding.name} to {new_name} would capture an existing Python name")
            current = current.parent
        if hasattr(builtins, new_name):
            raise ValueError(f"Renaming {binding.name} to builtin {new_name} is not allowed")

        targets = target_names_by_scope.setdefault(id(binding.scope), set())
        if new_name in targets:
            raise ValueError("Two selected Python bindings in the same scope cannot share a new name")
        targets.add(new_name)
        selected.append((binding, new_name))

    module = cst.parse_module(source_code)
    renamed_bindings = []
    for binding, new_name in selected:
        module = RenameCommand(
            CodemodContext(),
            old_name=binding.qualified_name,
            new_name=new_name,
        ).transform_module(module)
        renamed_bindings.append({
            "bindingId": binding.id,
            "oldName": binding.name,
            "newName": new_name,
            "kind": binding.kind,
            "referenceCount": binding.reference_count,
            "scopeType": binding.scope_type,
        })

    output_source = module.code
    cst.parse_module(output_source)
    _, output_bindings, _ = _catalog(output_source)
    output_qualified_names = {binding.qualified_name for binding in output_bindings}
    for binding, new_name in selected:
        expected_qualified_name = f"{binding.qualified_name.rpartition('.')[0]}.{new_name}"
        if expected_qualified_name not in output_qualified_names:
            raise ValueError(f"LibCST did not verify the selected rename for {binding.name}")
    return {
        "source_sha256": digest,
        "output_sha256": source_sha256(output_source),
        "source_code": output_source,
        "renamed_bindings": renamed_bindings,
        "parser_version": "libcst",
    }
