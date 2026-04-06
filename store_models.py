from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any


class ClosingConnection(sqlite3.Connection):
    """sqlite3 connection that always closes when leaving a context manager."""

    def __exit__(self, exc_type, exc, tb):
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            self.close()


MAX_OPERATOR_MESSAGE_LEN = 4000
MAX_ASSISTANT_MESSAGE_LEN = 64000
MAX_SYSTEM_MESSAGE_LEN = 16000
MAX_TITLE_LEN = 120


@dataclass(slots=True)
class ChatThread:
    id: int
    title: str
    parent_chat_id: int | None
    unread_count: int
    pending: bool
    is_pinned: bool
    updated_at: str
    created_at: str


@dataclass(slots=True)
class ChatTurn:
    id: int
    role: str
    body: str
    created_at: str
    file_refs: list[dict[str, Any]] = field(default_factory=list)
