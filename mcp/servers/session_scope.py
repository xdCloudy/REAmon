"""Project ownership helpers for shared Metasploit session state."""


def session_belongs_to_project(ownership: dict, session_id: int, project_id: str) -> bool:
    owner = ownership.get(session_id)
    return bool(project_id and isinstance(owner, dict) and owner.get("project_id") == project_id)


def filter_sessions_for_project(data: dict, project_id: str) -> dict:
    """Return only project-owned sessions; jobs stay hidden until scoped too."""
    scoped = dict(data)
    scoped["sessions"] = [
        session for session in data.get("sessions", [])
        if session.get("project_id") == project_id
    ]
    scoped["non_msf_sessions"] = [
        session for session in data.get("non_msf_sessions", [])
        if session.get("project_id") == project_id
    ]
    scoped["jobs"] = []
    return scoped
