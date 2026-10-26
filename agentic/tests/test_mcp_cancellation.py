import asyncio
import unittest
from unittest import mock

from mcp.shared.session import BaseSession

from mcp_cancellation import enable_mcp_request_cancellation_notifications


class McpRequestCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_request_notifies_server_with_its_request_id(self):
        class FakeSession:
            _request_id = 23

            def __init__(self):
                self.notifications = []

            async def send_notification(self, notification):
                self.notifications.append(notification)

        async def cancelled_send_request(self, request, *args, **kwargs):
            raise asyncio.CancelledError

        session = FakeSession()
        with (
            mock.patch.object(BaseSession, "send_request", cancelled_send_request),
            mock.patch.object(
                BaseSession, "_reamon_cancel_notifications", False, create=True
            ),
        ):
            enable_mcp_request_cancellation_notifications()
            with self.assertRaises(asyncio.CancelledError):
                await BaseSession.send_request(session, object())

        self.assertEqual(len(session.notifications), 1)
        notification = session.notifications[0]
        self.assertEqual(notification.method, "notifications/cancelled")
        self.assertEqual(notification.params.requestId, 23)
        self.assertTrue(notification.params.reason)


if __name__ == "__main__":
    unittest.main()
