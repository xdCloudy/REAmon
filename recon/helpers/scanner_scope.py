"""Headers used for webapp API calls made by an isolated scan container."""

import os


def scanner_request_headers() -> dict[str, str]:
    """Return the low-tier scanner identity and its project-bound assertion.

    The shared key is still used by middleware and capture-tag verification. It
    does not grant project or user access without the separately signed scope.
    """
    return {
        "X-Internal-Key": os.environ.get("SCANNER_API_KEY", ""),
        "X-Scanner-Scope": os.environ.get("SCANNER_SCOPE_TOKEN", ""),
    }
