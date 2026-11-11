"""HTTP contract tests for bounded Go source refactoring requests."""

import hashlib
import json
import sys
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

_AGENTIC_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_AGENTIC_DIR))


class GoRefactorApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        @asynccontextmanager
        async def fake_lifespan(_app):
            yield

        with patch("api.lifespan", fake_lifespan):
            import api
            from fastapi.testclient import TestClient

            cls.api = api
            cls.client = TestClient(api.app)

    def setUp(self):
        self.api.app.dependency_overrides[self.api.require_internal_auth] = lambda: None

    def tearDown(self):
        self.api.app.dependency_overrides.pop(self.api.require_internal_auth, None)

    def test_project_snapshot_fields_are_forwarded_to_engine(self):
        forwarded = {}

        class Process:
            returncode = 0

            async def communicate(self, payload):
                forwarded.update(json.loads(payload))
                return json.dumps({"bindings": [], "source_sha256": "selected"}).encode(), b""

        async def create_process(*_args, **_kwargs):
            return Process()

        files = [
            {"relative_path": "pkg/a.go", "source_code": "package sample\n", "expected_sha256": "a" * 64},
            {"relative_path": "pkg/b.go", "source_code": "package sample\n", "expected_sha256": "b" * 64},
        ]
        with patch.object(self.api.asyncio, "create_subprocess_exec", create_process):
            response = self.client.post("/reamon/code/go/refactor", json={
                "operation": "project_bindings",
                "source_code": files[0]["source_code"],
                "selected_path": "pkg/a.go",
                "files": files,
            })

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(forwarded["operation"], "project_bindings")
        self.assertEqual(forwarded["selected_path"], "pkg/a.go")
        self.assertEqual(forwarded["files"], files)

    def test_project_rename_requires_a_source_set_hash_before_engine_dispatch(self):
        async def create_process(*_args, **_kwargs):
            self.fail("invalid source-set hash must be rejected before starting the helper")

        files = [
            {"relative_path": "pkg/a.go", "source_code": "package sample\n"},
            {"relative_path": "pkg/b.go", "source_code": "package sample\n"},
        ]
        with patch.object(self.api.asyncio, "create_subprocess_exec", create_process):
            response = self.client.post("/reamon/code/go/refactor", json={
                "operation": "project_rename",
                "source_code": files[0]["source_code"],
                "expected_sha256": "a" * 64,
                "source_set_sha256": "stale",
                "selected_path": "pkg/a.go",
                "files": files,
                "renames": [{"binding_id": "0123456789abcdef01234567", "new_name": "scale"}],
            })

        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("source-set SHA-256", response.json()["error"])

    def test_module_rename_accepts_a_complete_single_file_snapshot_and_forwards_scope_receipts(self):
        forwarded = {}

        class Process:
            returncode = 0

            async def communicate(self, payload):
                forwarded.update(json.loads(payload))
                return json.dumps({"scope": "module", "source_sha256": "selected"}).encode(), b""

        async def create_process(*_args, **_kwargs):
            return Process()

        source = "package sample\ntype Worker struct{}\nfunc (Worker) Do() {}\n"
        go_mod = "module example.test/project\n\ngo 1.25\n"
        files = [{"relative_path": "pkg/a.go", "source_code": source, "expected_sha256": hashlib.sha256(source.encode()).hexdigest()}]
        with patch.object(self.api.asyncio, "create_subprocess_exec", create_process):
            response = self.client.post("/reamon/code/go/refactor", json={
                "operation": "project_module_rename", "source_code": source,
                "expected_sha256": hashlib.sha256(source.encode()).hexdigest(),
                "source_set_sha256": "b" * 64, "selected_path": "pkg/a.go",
                "module_path": "example.test/project", "go_mod": go_mod,
                "go_mod_sha256": hashlib.sha256(go_mod.encode()).hexdigest(),
                "files": files,
                "renames": [{"binding_id": "0123456789abcdef01234567", "new_name": "Execute"}],
            })

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(forwarded["operation"], "project_module_rename")
        self.assertEqual(forwarded["files"], files)
        self.assertEqual(forwarded["module_path"], "example.test/project")
        self.assertEqual(forwarded["source_set_sha256"], "b" * 64)

    def test_module_rename_rejects_missing_source_set_hash_before_engine_dispatch(self):
        async def create_process(*_args, **_kwargs):
            self.fail("invalid module source-set hash must be rejected before starting the helper")

        source = "package sample\n"
        with patch.object(self.api.asyncio, "create_subprocess_exec", create_process):
            response = self.client.post("/reamon/code/go/refactor", json={
                "operation": "project_module_rename", "source_code": source,
                "expected_sha256": "a" * 64, "source_set_sha256": "stale",
                "selected_path": "pkg/a.go", "files": [{"relative_path": "pkg/a.go", "source_code": source}],
            })

        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("source-set SHA-256", response.json()["error"])

    def test_exported_go_method_candidates_require_explicit_module_scope_and_preserve_export(self):
        messages = []

        class ModelResponse:
            content = json.dumps({"renames": [{
                "bindingId": "0123456789abcdef01234567", "newName": "Serve", "rationale": "clear call sites",
            }]})

        async def build_llm(*_args):
            return object(), None

        async def invoke(_name, _model, _llm, prompt_messages):
            messages.extend(prompt_messages)
            return ModelResponse(), None

        candidate = {
            "id": "0123456789abcdef01234567", "name": "Do", "kind": "method",
            "scopeType": "member", "referenceCount": 2, "exported": True,
        }
        with patch.object(self.api, "_feature_request_error", return_value=None), \
                patch.object(self.api, "_build_feature_llm", build_llm), \
                patch.object(self.api, "_invoke_feature_llm", invoke):
            response = self.client.post("/reamon/code/suggest-renames", json={
                "model": "custom/provider-1", "user_id": "owner-1", "unit_name": "pkg.Worker.Do",
                "language": "Go", "source_code": "package pkg\n",
                "bindings": [candidate], "allow_exported_go_methods": True,
            })

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["renames"][0]["newName"], "Serve")
        self.assertTrue(any("downstream consumers outside the supplied module" in message.content for message in messages))

        with patch.object(self.api, "_feature_request_error", return_value=None):
            rejected = self.client.post("/reamon/code/suggest-renames", json={
                "model": "custom/provider-1", "user_id": "owner-1", "unit_name": "pkg.Worker.Do",
                "language": "Go", "source_code": "package pkg\n", "bindings": [candidate],
            })
        self.assertEqual(rejected.status_code, 400, rejected.text)
        self.assertIn("binding catalog is invalid", rejected.json()["error"])

    def test_whole_project_inventory_accepts_a_single_file_package(self):
        forwarded = {}

        class Process:
            returncode = 0

            async def communicate(self, payload):
                forwarded.update(json.loads(payload))
                return json.dumps({"inventory": {"complete": True}}).encode(), b""

        async def create_process(*_args, **_kwargs):
            return Process()

        files = [{"relative_path": "cmd/main.go", "source_code": "package main\n"}]
        go_mod = "module example.test/project\n\ngo 1.24\n"
        with patch.object(self.api.asyncio, "create_subprocess_exec", create_process):
            response = self.client.post("/reamon/code/go/refactor", json={
                "operation": "project_inventory",
                "source_code": files[0]["source_code"],
                "selected_path": "cmd/main.go",
                "module_path": "example.test/project",
                "module_root": "src",
                "go_mod": go_mod,
                "go_mod_sha256": hashlib.sha256(go_mod.encode()).hexdigest(),
                "go_sum": "",
                "go_sum_sha256": "",
                "build_goos": "linux",
                "build_goarch": "amd64",
                "build_cgo_enabled": False,
                "build_tags": ["integration"],
                "files": files,
            })

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(forwarded["operation"], "project_inventory")
        self.assertEqual(forwarded["module_path"], "example.test/project")
        self.assertEqual(forwarded["module_root"], "src")
        self.assertEqual(forwarded["go_mod"], go_mod)
        self.assertEqual(forwarded["go_mod_sha256"], hashlib.sha256(go_mod.encode()).hexdigest())
        self.assertEqual(forwarded["go_sum"], "")
        self.assertEqual(forwarded["go_sum_sha256"], "")
        self.assertEqual(forwarded["build_goos"], "linux")
        self.assertEqual(forwarded["build_goarch"], "amd64")
        self.assertFalse(forwarded["build_cgo_enabled"])
        self.assertEqual(forwarded["build_tags"], ["integration"])
        self.assertEqual(forwarded["files"], [{**files[0], "expected_sha256": ""}])

    def test_project_snapshot_file_count_is_bounded(self):
        files = [
            {"relative_path": f"pkg/f{index}.go", "source_code": "package sample\n"}
            for index in range(257)
        ]
        response = self.client.post("/reamon/code/go/refactor", json={
            "operation": "project_bindings",
            "source_code": files[0]["source_code"],
            "selected_path": "pkg/f0.go",
            "files": files,
        })

        self.assertEqual(response.status_code, 413, response.text)
        self.assertIn("file-count", response.json()["error"])
