"""Forward cancelled MCP requests to the remote server before closing sessions."""

import asyncio


def enable_mcp_request_cancellation_notifications() -> None:
    """Send MCP's cancellation notification when an async request is cancelled.

    The MCP Python client closes its local response stream on cancellation but
    does not currently notify the server. Long-running tools would otherwise
    continue after their agent job has been marked cancelled.
    """
    from mcp import types
    from mcp.shared.session import BaseSession

    if getattr(BaseSession, "_reamon_cancel_notifications", False):
        return

    original_send_request = BaseSession.send_request

    async def send_request_with_cancellation(self, request, *args, **kwargs):
        request_id = self._request_id
        try:
            return await original_send_request(self, request, *args, **kwargs)
        except asyncio.CancelledError:
            notification = types.CancelledNotification(
                params=types.CancelledNotificationParams(
                    requestId=request_id,
                    reason="The caller cancelled this tool execution.",
                )
            )
            try:
                # Let the notification reach the server before the session
                # context closes its transport in the caller's finally block.
                await asyncio.wait_for(
                    asyncio.shield(self.send_notification(notification)),
                    timeout=1.0,
                )
            except BaseException:  # cancellation must continue if notify fails
                pass
            raise

    BaseSession.send_request = send_request_with_cancellation
    BaseSession._reamon_cancel_notifications = True
