import os
import unittest
from unittest.mock import patch

from progress_auth import internal_mcp_headers


class ProgressAuthHeaders(unittest.TestCase):
    def test_configured_token_is_sent_as_bearer(self):
        with patch.dict(os.environ, {"MCP_AUTH_TOKEN": "internal-token"}, clear=True):
            self.assertEqual(
                internal_mcp_headers(),
                {"Authorization": "Bearer internal-token"},
            )

    def test_unset_token_does_not_send_an_empty_credential(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(internal_mcp_headers(), {})


if __name__ == "__main__":
    unittest.main()
