from __future__ import annotations

import threading
import time
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class VisibleChatLease:
    user_id: str
    chat_id: int
    expires_at_monotonic: float


class MiniAppPresenceTracker:
    def __init__(self, *, default_ttl_seconds: int = 45) -> None:
        self.default_ttl_seconds = max(5, int(default_ttl_seconds or 45))
        self._lock = threading.Lock()
        self._visible_chat_by_user: dict[str, VisibleChatLease] = {}

    def mark_visible(self, user_id: str, chat_id: int, *, ttl_seconds: int | None = None, now: float | None = None) -> VisibleChatLease:
        resolved_user_id = str(user_id or "").strip()
        resolved_chat_id = int(chat_id)
        resolved_now = time.monotonic() if now is None else float(now)
        ttl = max(1, int(ttl_seconds or self.default_ttl_seconds))
        lease = VisibleChatLease(
            user_id=resolved_user_id,
            chat_id=resolved_chat_id,
            expires_at_monotonic=resolved_now + ttl,
        )
        with self._lock:
            self._visible_chat_by_user[resolved_user_id] = lease
        return lease

    def mark_hidden(self, user_id: str, *, chat_id: int | None = None) -> None:
        resolved_user_id = str(user_id or "").strip()
        with self._lock:
            existing = self._visible_chat_by_user.get(resolved_user_id)
            if existing is None:
                return
            if chat_id is not None and int(existing.chat_id) != int(chat_id):
                return
            self._visible_chat_by_user.pop(resolved_user_id, None)

    def get_visible_chat_id(self, user_id: str, *, now: float | None = None) -> int | None:
        resolved_user_id = str(user_id or "").strip()
        resolved_now = time.monotonic() if now is None else float(now)
        with self._lock:
            lease = self._visible_chat_by_user.get(resolved_user_id)
            if lease is None:
                return None
            if lease.expires_at_monotonic <= resolved_now:
                self._visible_chat_by_user.pop(resolved_user_id, None)
                return None
            return int(lease.chat_id)

    def is_chat_visibly_open(self, user_id: str, chat_id: int, *, now: float | None = None) -> bool:
        visible_chat_id = self.get_visible_chat_id(user_id, now=now)
        return visible_chat_id is not None and int(visible_chat_id) == int(chat_id)

    def prune_expired(self, *, now: float | None = None) -> int:
        resolved_now = time.monotonic() if now is None else float(now)
        removed = 0
        with self._lock:
            expired_user_ids = [
                user_id
                for user_id, lease in self._visible_chat_by_user.items()
                if lease.expires_at_monotonic <= resolved_now
            ]
            for user_id in expired_user_ids:
                self._visible_chat_by_user.pop(user_id, None)
                removed += 1
        return removed