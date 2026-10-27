import hashlib
import shutil

import pytest

from reamon_go_project_build import GoProjectBuildError, compile_go_project


def _file(path: str, source: str) -> dict[str, str]:
    return {
        "relative_path": path,
        "source_code": source,
        "expected_sha256": hashlib.sha256(source.encode()).hexdigest(),
    }


@pytest.mark.unit
def test_compiles_reviewed_go_files_together_and_records_hashes():
    if not shutil.which("go"):
        pytest.skip("the agent image has no Go toolchain")
    files = [
        _file("core/value.go", "package core\nfunc Value() int { return 41 }\n"),
        _file("app/main.go", "package main\nimport (\"fmt\"; \"example.local/maintained/core\")\nfunc main() { fmt.Println(core.Value() + 1) }\n"),
    ]
    result = compile_go_project(files, go_mod="module example.local/maintained\n\ngo 1.24\n",
                               go_mod_sha256=hashlib.sha256(b"module example.local/maintained\n\ngo 1.24\n").hexdigest())

    assert result["validation_status"] == "PASSED"
    assert result["validation_method"].startswith("go-") and result["validation_method"].endswith("-project-build")
    assert result["package_count"] == 2
    assert result["compiled_sha256"] and len(result["compiled_sha256"]) == 64
    assert result["files"] == sorted(
        [{"relative_path": item["relative_path"], "source_sha256": item["expected_sha256"]} for item in files],
        key=lambda item: item["relative_path"],
    )
    assert result["dependencies"] == [{
        "path": "go.mod",
        "source_sha256": hashlib.sha256(b"module example.local/maintained\n\ngo 1.24\n").hexdigest(),
    }]


@pytest.mark.unit
def test_project_compile_catches_cross_file_type_errors():
    if not shutil.which("go"):
        pytest.skip("the agent image has no Go toolchain")
    files = [
        _file("core/value.go", "package core\nfunc Value() string { return \"wrong\" }\n"),
        _file("app/main.go", "package main\nimport \"example.local/maintained/core\"\nfunc main() { _ = core.Value() + 1 }\n"),
    ]
    result = compile_go_project(files, go_mod="module example.local/maintained\n\ngo 1.24\n",
                               go_mod_sha256=hashlib.sha256(b"module example.local/maintained\n\ngo 1.24\n").hexdigest())

    assert result["validation_status"] == "FAILED"
    assert "invalid operation" in result["validation_message"]
    assert result["compiled_sha256"] is None


@pytest.mark.unit
def test_rejects_stale_source_hash_and_unsafe_paths_before_compilation():
    with pytest.raises(GoProjectBuildError, match="source hash"):
        compile_go_project([{"relative_path": "main.go", "source_code": "package main\n", "expected_sha256": "0" * 64}])
    with pytest.raises(GoProjectBuildError, match="safe relative"):
        compile_go_project([_file("../main.go", "package main\n")])


@pytest.mark.unit
def test_rejects_go_test_sources_that_go_build_would_omit():
    if not shutil.which("go"):
        pytest.skip("the agent image has no Go toolchain")
    with pytest.raises(GoProjectBuildError, match="would omit accepted project source"):
        compile_go_project([_file("main_test.go", "package main\nimport \"testing\"\nfunc TestMain(t *testing.T) {}\n")])


@pytest.mark.unit
def test_rejects_local_module_replacements_that_escape_the_isolated_project():
    if not shutil.which("go"):
        pytest.skip("the agent image has no Go toolchain")
    module = "module example.local/maintained\n\ngo 1.24\n\nreplace example.com/dependency => ../../private\n"
    with pytest.raises(GoProjectBuildError, match="Local path replacements"):
        compile_go_project([_file("main.go", "package main\nfunc main() {}\n")],
                           go_mod=module, go_mod_sha256=hashlib.sha256(module.encode()).hexdigest())


@pytest.mark.unit
def test_external_module_resolution_is_offline_and_reported_unavailable():
    if not shutil.which("go"):
        pytest.skip("the agent image has no Go toolchain")
    module = "module example.local/maintained\n\ngo 1.24\n\nrequire example.com/not-cached v1.2.3\n"
    source = "package main\nimport \"example.com/not-cached/value\"\nfunc main() { _ = value.Value() }\n"
    result = compile_go_project(
        [_file("main.go", source)], go_mod=module, go_mod_sha256=hashlib.sha256(module.encode()).hexdigest(),
    )

    assert result["validation_status"] == "UNAVAILABLE"
    assert "module downloads" not in result["validation_message"].lower() or "offline" in result["validation_message"].lower()
