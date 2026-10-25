"""Integration checks for clangd-backed C/C++ local renaming."""

from __future__ import annotations

import hashlib
import os
import shutil

import pytest

from reamon_cpp_refactor import refactor_cpp_source


CLANGD = os.environ.get("REAMON_CLANGD", "clangd")
pytestmark = pytest.mark.integration


def test_c_and_cpp_tree_sitter_grammars_load() -> None:
    from reamon_treesitter import get_reamon_parser_with_language

    for language in ("c", "cpp"):
        parser, grammar = get_reamon_parser_with_language(language)
        assert parser is not None
        assert grammar == language


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("language", "source"),
    [
        ("c", "int sum(int left, int right) { int total = left + right; return total; }\n"),
        ("cpp", "int sum(int left, int right) { int total = left + right; return total; }\n"),
    ],
)
async def test_catalog_and_rename_local_bindings(language: str, source: str) -> None:
    if not shutil.which(CLANGD):
        pytest.skip("clangd is unavailable")

    catalog = await refactor_cpp_source(source, language=language, operation="bindings")
    assert catalog["source_sha256"] == hashlib.sha256(source.encode()).hexdigest()
    bindings = {binding["name"]: binding for binding in catalog["bindings"]}
    assert {"left", "right", "total"} <= bindings.keys()
    assert bindings["total"]["kind"] == "local variable"
    assert bindings["left"]["kind"] == "parameter"

    result = await refactor_cpp_source(
        source,
        language=language,
        operation="rename",
        expected_sha256=catalog["source_sha256"],
        renames=[{"binding_id": bindings["total"]["id"], "new_name": "sum_value"}],
    )
    assert result["source_code"] == "int sum(int left, int right) { int sum_value = left + right; return sum_value; }\n"
    assert result["output_sha256"] == hashlib.sha256(result["source_code"].encode()).hexdigest()


@pytest.mark.asyncio
async def test_rename_rejects_stale_source_and_name_capture() -> None:
    if not shutil.which(CLANGD):
        pytest.skip("clangd is unavailable")
    source = "int f(int input) { int total = input; int result = total; return result; }\n"
    catalog = await refactor_cpp_source(source, language="c", operation="bindings")
    total = next(binding for binding in catalog["bindings"] if binding["name"] == "total")

    with pytest.raises(ValueError, match="changed after rename suggestions"):
        await refactor_cpp_source(
            source,
            language="c",
            operation="rename",
            expected_sha256="0" * 64,
            renames=[{"binding_id": total["id"], "new_name": "sum_value"}],
        )

    with pytest.raises(ValueError, match="already used elsewhere"):
        await refactor_cpp_source(
            source,
            language="c",
            operation="rename",
            expected_sha256=catalog["source_sha256"],
            renames=[{"binding_id": total["id"], "new_name": "result"}],
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("language", "valid", "invalid"),
    [
        ("c", "int add(int a, int b) { return a + b; }", "int add(int a, int b) { return a + ; }"),
        ("cpp", "int add(int a, int b) { return a + b; }", "int add(int a, int b) { return a + ; }"),
    ],
)
async def test_source_validation_uses_native_compiler(language: str, valid: str, invalid: str) -> None:
    from api import ReamonCodeValidateRequest, validate_reamon_code

    passed = await validate_reamon_code(ReamonCodeValidateRequest(language=language, source_code=valid))
    failed = await validate_reamon_code(ReamonCodeValidateRequest(language=language, source_code=invalid))
    assert passed["validation_status"] == "PASSED"
    assert passed["validation_method"].startswith(("gcc-", "g++-"))
    assert failed["validation_status"] == "FAILED"
    assert failed["source_sha256"] != passed["source_sha256"]


def test_macro_and_template_sources_are_explicitly_excluded() -> None:
    from reamon_cpp_refactor import _pattern_declarations

    with pytest.raises(ValueError, match="macros, conditional compilation, and templates"):
        _pattern_declarations("#define ID(value) (value)\nint f(int input) { return ID(input); }\n", "c")
    with pytest.raises(ValueError, match="macros, conditional compilation, and templates"):
        _pattern_declarations("template <typename T> T f(T value) { return value; }\n", "cpp")
