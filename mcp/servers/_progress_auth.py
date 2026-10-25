"""Bearer authentication for internal progress and session HTTP endpoints."""

import hmac
import json
import os


def authorized(headers) -> bool:
    """Return true only for the configured internal bearer token."""
    expected = os.environ.get("MCP_AUTH_TOKEN", "")
    if not expected:
        return False

    value = headers.get("Authorization", "")
    scheme, separator, supplied = value.partition(" ")
    return bool(
        separator
        and scheme.lower() == "bearer"
        and supplied.strip()
        and hmac.compare_digest(supplied.strip(), expected)
    )


class AuthenticatedProgressHandler:
    """Mixin for progress HTTP handlers; only health checks may be public."""

    def _require_progress_auth(self, public_health: bool = False) -> bool:
        if public_health and self.path.split("?", 1)[0] == "/health":
            return True
        if authorized(self.headers):
            return True

        payload = json.dumps({"error": "Unauthorized"}).encode()
        try:
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("WWW-Authenticate", "Bearer")
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass
        return False
