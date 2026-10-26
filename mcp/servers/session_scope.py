"""Project ownership helpers for shared Metasploit session state."""


def session_belongs_to_project(ownership: dict, session_id: int, project_id: str) -> bool:
    owner = ownership.get(session_id)
    return bool(project_id and isinstance(owner, dict) and owner.get("project_id") == project_id)


def job_belongs_to_project(ownership: dict, job_id: int, project_id: str) -> bool:
    owner = ownership.get(job_id)
    return bool(project_id and isinstance(owner, dict) and owner.get("project_id") == project_id)


def filter_sessions_for_project(
    data: dict, project_id: str, job_ownership: dict | None = None
) -> dict:
    """Return only sessions and jobs whose project ownership is known."""
    scoped = dict(data)
    job_ownership = job_ownership or {}
    scoped["sessions"] = [
        session for session in data.get("sessions", [])
        if session.get("project_id") == project_id
    ]
    scoped["non_msf_sessions"] = [
        session for session in data.get("non_msf_sessions", [])
        if session.get("project_id") == project_id
    ]
    scoped["jobs"] = [
        {**job, **job_ownership[job.get("id")], "project_id": project_id}
        for job in data.get("jobs", [])
        if job_belongs_to_project(job_ownership, job.get("id"), project_id)
    ]
    return scoped
