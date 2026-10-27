import asyncio
import hashlib
import shutil

import pytest
from fastapi.responses import JSONResponse


def _file(path: str, source: str) -> dict[str, str]:
    return {
        "relative_path": path,
        "source_code": source,
        "expected_sha256": hashlib.sha256(source.encode()).hexdigest(),
    }


def _api(monkeypatch):
    import logging_config

    monkeypatch.setattr(logging_config, "setup_logging", lambda **_kwargs: None)
    import api
    return api


@pytest.mark.unit
def test_go_project_compile_endpoint_dispatches_bounded_project_build(monkeypatch):
    if not shutil.which("go"):
        pytest.skip("the agent image has no Go toolchain")
    api = _api(monkeypatch)

    module = "module example.local/maintained\n\ngo 1.24\n"
    body = api.ReamonCodeProjectCompileRequest(
        language="go",
        go_mod=module,
        go_mod_sha256=hashlib.sha256(module.encode()).hexdigest(),
        files=[
            _file("core/value.go", "package core\nfunc Value() int { return 41 }\n"),
            _file("app/main.go", "package main\nimport (\"fmt\"; \"example.local/maintained/core\")\nfunc main() { fmt.Println(core.Value() + 1) }\n"),
        ],
    )

    result = asyncio.run(api.compile_reamon_csharp_project(body))

    assert isinstance(result, dict)
    assert result["validation_status"] == "PASSED"
    assert result["file_count"] == 2
    assert result["package_count"] == 2
    assert result["dependency_sha256"] == hashlib.sha256(
        b"go.mod\0" + hashlib.sha256(module.encode()).hexdigest().encode() + b"\n"
    ).hexdigest()


@pytest.mark.unit
def test_go_project_compile_endpoint_rejects_stale_source_without_building(monkeypatch):
    api = _api(monkeypatch)

    body = api.ReamonCodeProjectCompileRequest(
        language="go",
        files=[{"relative_path": "main.go", "source_code": "package main\n", "expected_sha256": "0" * 64}],
    )

    response = asyncio.run(api.compile_reamon_csharp_project(body))

    assert isinstance(response, JSONResponse)
    assert response.status_code == 409
