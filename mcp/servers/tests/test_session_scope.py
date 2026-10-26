from session_scope import filter_sessions_for_project, session_belongs_to_project


def test_project_filter_hides_unowned_and_other_project_sessions_and_jobs():
    data = {
        "sessions": [
            {"id": 1, "project_id": "p1"},
            {"id": 2, "project_id": "p2"},
            {"id": 3},
        ],
        "non_msf_sessions": [
            {"id": "n1", "project_id": "p1"},
            {"id": "n2", "project_id": "p2"},
            {"id": "n3"},
        ],
        "jobs": [{"id": 7}],
        "agent_busy": True,
    }

    result = filter_sessions_for_project(data, "p1")

    assert result["sessions"] == [{"id": 1, "project_id": "p1"}]
    assert result["non_msf_sessions"] == [{"id": "n1", "project_id": "p1"}]
    assert result["jobs"] == []
    assert result["agent_busy"] is True
    assert data["jobs"] == [{"id": 7}]


def test_session_controls_fail_closed_for_missing_legacy_and_other_project_owners():
    ownership = {
        1: {"project_id": "p1"},
        2: {"project_id": "p2"},
        3: "legacy-chat-id",
    }

    assert session_belongs_to_project(ownership, 1, "p1")
    assert not session_belongs_to_project(ownership, 1, "p2")
    assert not session_belongs_to_project(ownership, 2, "p1")
    assert not session_belongs_to_project(ownership, 3, "p1")
    assert not session_belongs_to_project(ownership, 404, "p1")
