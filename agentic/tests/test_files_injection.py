"""Keep downloads on the owner-checked project workspace API.

Run through the agent Docker test gate; importing ``api`` needs the agent image's
FastAPI and application dependencies.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def test_unscoped_kali_tmp_download_route_is_removed():
    import api

    paths = {getattr(route, "path", None) for route in api.app.routes}
    assert "/files" not in paths


def test_project_workspace_download_remains_master_key_protected():
    import api
    from llm_guard import require_configured_master_internal_auth

    route = next(
        route for route in api.app.routes
        if getattr(route, "path", None) == "/workspace/download"
    )
    dependencies = [dep.call for dep in route.dependant.dependencies]
    assert require_configured_master_internal_auth in dependencies
