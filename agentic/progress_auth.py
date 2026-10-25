"""Internal credentials for the Kali progress and session HTTP sidecars."""

import os


def internal_mcp_headers() -> dict[str, str]:
    token = os.environ.get("MCP_AUTH_TOKEN", "")
    return {"Authorization": f"Bearer {token}"} if token else {}
