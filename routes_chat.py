from __future__ import annotations

from routes_chat_context import ChatRouteContext
from routes_chat_management import register_chat_management_routes
from routes_chat_stream import register_stream_routes
from routes_chat_sync import register_sync_chat_routes


def register_chat_routes(api_bp, *, context: ChatRouteContext) -> None:
    register_chat_management_routes(api_bp, context=context)
    register_sync_chat_routes(api_bp, context=context)
    register_stream_routes(api_bp, context=context)
