from __future__ import annotations

from pathlib import Path

from store_auth import StoreAuthMixin
from store_chats import StoreChatsMixin
from store_jobs import StoreJobsMixin
from store_models import (
    MAX_ASSISTANT_MESSAGE_LEN,
    MAX_OPERATOR_MESSAGE_LEN,
    MAX_SYSTEM_MESSAGE_LEN,
    MAX_TITLE_LEN,
    ChatThread,
    ChatTurn,
    ClosingConnection,
)
from store_runtime import StoreRuntimeMixin
from store_schema import StoreSchemaMixin
from store_media_projects import StoreMediaProjectsMixin
from store_visual_dev import StoreVisualDevMixin


class SessionStore(
    StoreSchemaMixin,
    StoreChatsMixin,
    StoreJobsMixin,
    StoreRuntimeMixin,
    StoreAuthMixin,
    StoreMediaProjectsMixin,
    StoreVisualDevMixin,
):
    """SQLite-backed storage for per-user preferences, chat threads, and messages."""

    def __init__(self, db_path: str | Path = "sessions.db") -> None:
        self.db_path = str(db_path)
        self._init_db()


__all__ = [
    "ClosingConnection",
    "MAX_OPERATOR_MESSAGE_LEN",
    "MAX_ASSISTANT_MESSAGE_LEN",
    "MAX_SYSTEM_MESSAGE_LEN",
    "MAX_TITLE_LEN",
    "ChatThread",
    "ChatTurn",
    "SessionStore",
]
