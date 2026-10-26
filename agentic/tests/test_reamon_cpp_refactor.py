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


@pytest.mark.asyncio
async def test_go_source_validation_type_checks_without_running_or_downloading_modules() -> None:
    from api import ReamonCodeValidateRequest, validate_reamon_code

    if not shutil.which("go"):
        pytest.skip("Go toolchain is unavailable")

    valid = 'package sample\nimport "strings"\nfunc normalize(value string) string { return strings.TrimSpace(value) }\n'
    type_error = "package sample\nfunc normalize(value string) string { return value + 1 }\n"
    external_module = 'package sample\nimport "example.invalid/reamon-test/module"\nfunc normalize() {}\n'

    passed = await validate_reamon_code(ReamonCodeValidateRequest(language="Go", source_code=valid))
    failed = await validate_reamon_code(ReamonCodeValidateRequest(language="golang", source_code=type_error))
    unavailable = await validate_reamon_code(ReamonCodeValidateRequest(language="go", source_code=external_module))

    assert passed["validation_status"] == "PASSED"
    assert passed["validation_method"].startswith("go-")
    assert "without executing" in passed["validation_message"]
    assert failed["validation_status"] == "FAILED"
    assert "rejected the source" in failed["validation_message"]
    assert unavailable["validation_status"] == "UNAVAILABLE"
    assert "external module" in unavailable["validation_message"]


@pytest.mark.asyncio
async def test_csharp_project_compiler_resolves_types_across_accepted_files() -> None:
    from api import ReamonCodeProjectCompileFile, ReamonCodeProjectCompileRequest, compile_reamon_csharp_project

    files = [
        ReamonCodeProjectCompileFile(
            relative_path="Core/Pair.cs",
            source_code="namespace Sample; public static class Pair { public static int Sum(int left, int right) => left + right; }\n",
            expected_sha256=hashlib.sha256(b"namespace Sample; public static class Pair { public static int Sum(int left, int right) => left + right; }\n").hexdigest(),
        ),
        ReamonCodeProjectCompileFile(
            relative_path="App/Runner.cs",
            source_code="namespace Sample; public sealed class Runner { public int Compute() => Pair.Sum(2, 3); }\n",
            expected_sha256=hashlib.sha256(b"namespace Sample; public sealed class Runner { public int Compute() => Pair.Sum(2, 3); }\n").hexdigest(),
        ),
    ]
    result = await compile_reamon_csharp_project(ReamonCodeProjectCompileRequest(files=files))

    assert result["validation_status"] == "PASSED"
    assert result["validation_method"].startswith("roslyn-csharp-project-")
    assert result["file_count"] == 2
    assert len(result["source_sha256"]) == 64
    assert len(result["compiled_sha256"]) == 64
    assert [file["relative_path"] for file in result["files"]] == ["App/Runner.cs", "Core/Pair.cs"]


@pytest.mark.asyncio
async def test_csharp_project_compiler_rejects_cross_file_errors_and_stale_hashes() -> None:
    from fastapi.responses import JSONResponse
    from api import ReamonCodeProjectCompileFile, ReamonCodeProjectCompileRequest, compile_reamon_csharp_project

    source = "namespace Sample; public sealed class Runner { public int Compute() => Missing.Sum(); }\n"
    result = await compile_reamon_csharp_project(ReamonCodeProjectCompileRequest(files=[
        ReamonCodeProjectCompileFile(
            relative_path="Runner.cs", source_code=source,
            expected_sha256=hashlib.sha256(source.encode()).hexdigest(),
        ),
    ]))
    assert result["validation_status"] == "FAILED"
    assert result["compiled_sha256"] is None
    assert result["diagnostics"]

    stale = await compile_reamon_csharp_project(ReamonCodeProjectCompileRequest(files=[
        ReamonCodeProjectCompileFile(relative_path="Runner.cs", source_code=source, expected_sha256="0" * 64),
    ]))
    assert isinstance(stale, JSONResponse)
    assert stale.status_code == 409


@pytest.mark.asyncio
async def test_visual_basic_source_validation_uses_roslyn() -> None:
    from api import ReamonCodeValidateRequest, validate_reamon_code

    valid = "Module Sample\n    Function Add(left As Integer, right As Integer) As Integer\n        Return left + right\n    End Function\nEnd Module\n"
    invalid = "Module Sample\n    Function Add(left As Integer, right As Integer) As Integer\n        Return left +\n    End Function\nEnd Module\n"
    passed = await validate_reamon_code(ReamonCodeValidateRequest(language="Visual Basic", source_code=valid))
    failed = await validate_reamon_code(ReamonCodeValidateRequest(language="Visual Basic", source_code=invalid))

    assert passed["validation_status"] == "PASSED"
    assert passed["validation_method"].startswith("roslyn-visual-basic-")
    assert failed["validation_status"] == "FAILED"
    assert failed["source_sha256"] != passed["source_sha256"]


def test_macro_and_template_sources_are_explicitly_excluded() -> None:
    from reamon_cpp_refactor import _pattern_declarations

    with pytest.raises(ValueError, match="macros, conditional compilation, and templates"):
        _pattern_declarations("#define ID(value) (value)\nint f(int input) { return ID(input); }\n", "c")
    with pytest.raises(ValueError, match="macros, conditional compilation, and templates"):
        _pattern_declarations("template <typename T> T f(T value) { return value; }\n", "cpp")
