from __future__ import annotations

import threading
import time
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class VisibleChatLease:
    user_id: str
    chat_id: int
    expires_at_monotonic: float
    instance_id: str = ""


class MiniAppPresenceTracker:
    def __init__(self, *, default_ttl_seconds: int = 45) -> None:
        self.default_ttl_seconds = max(5, int(default_ttl_seconds or 45))
        self._lock = threading.Lock()
        self._visible_chat_by_user: dict[str, dict[str, VisibleChatLease]] = {}

    @staticmethod
    def _normalize_user_id(user_id: str) -> str:
        return str(user_id or "").strip()

    @staticmethod
    def _normalize_instance_id(instance_id: str | None) -> str:
        return str(instance_id or "").strip()

    def mark_visible(
        self,
        user_id: str,
        chat_id: int,
        *,
        instance_id: str | None = None,
        ttl_seconds: int | None = None,
        now: float | None = None,
    ) -> VisibleChatLease:
        resolved_user_id = self._normalize_user_id(user_id)
        resolved_chat_id = int(chat_id)
        resolved_instance_id = self._normalize_instance_id(instance_id) or "__legacy__"
        resolved_now = time.monotonic() if now is None else float(now)
        ttl = max(1, int(ttl_seconds or self.default_ttl_seconds))
        lease = VisibleChatLease(
            user_id=resolved_user_id,
            chat_id=resolved_chat_id,
            expires_at_monotonic=resolved_now + ttl,
            instance_id=resolved_instance_id,
        )
        with self._lock:
            per_user = self._visible_chat_by_user.setdefault(resolved_user_id, {})
            per_user[resolved_instance_id] = lease
        return lease

    def mark_hidden(self, user_id: str, *, instance_id: str | None = None, chat_id: int | None = None) -> None:
        resolved_user_id = self._normalize_user_id(user_id)
        resolved_instance_id = self._normalize_instance_id(instance_id)
        with self._lock:
            per_user = self._visible_chat_by_user.get(resolved_user_id)
            if not per_user:
                return
            if resolved_instance_id:
                existing = per_user.get(resolved_instance_id)
                if existing is None:
                    return
                if chat_id is not None and int(existing.chat_id) != int(chat_id):
                    return
                per_user.pop(resolved_instance_id, None)
            else:
                if chat_id is None:
                    self._visible_chat_by_user.pop(resolved_user_id, None)
                    return
                matching_instance_ids = [
                    key for key, lease in per_user.items() if int(lease.chat_id) == int(chat_id)
                ]
                for key in matching_instance_ids:
                    per_user.pop(key, None)
            if not per_user:
                self._visible_chat_by_user.pop(resolved_user_id, None)

    def _active_leases(self, user_id: str, *, now: float | None = None) -> list[VisibleChatLease]:
        resolved_user_id = self._normalize_user_id(user_id)
        resolved_now = time.monotonic() if now is None else float(now)
        with self._lock:
            per_user = self._visible_chat_by_user.get(resolved_user_id)
            if not per_user:
                return []
            expired_instance_ids = [
                key for key, lease in per_user.items() if lease.expires_at_monotonic <= resolved_now
            ]
            for key in expired_instance_ids:
                per_user.pop(key, None)
            if not per_user:
                self._visible_chat_by_user.pop(resolved_user_id, None)
                return []
            return list(per_user.values())

    def get_visible_chat_id(self, user_id: str, *, now: float | None = None) -> int | None:
        leases = self._active_leases(user_id, now=now)
        if not leases:
            return None
        chat_ids = {int(lease.chat_id) for lease in leases}
        if len(chat_ids) == 1:
            return next(iter(chat_ids))
        latest = max(leases, key=lambda lease: float(lease.expires_at_monotonic))
        return int(latest.chat_id)

    def is_chat_visibly_open(self, user_id: str, chat_id: int, *, now: float | None = None) -> bool:
        target_chat_id = int(chat_id)
        return any(int(lease.chat_id) == target_chat_id for lease in self._active_leases(user_id, now=now))

    def prune_expired(self, *, now: float | None = None) -> int:
        resolved_now = time.monotonic() if now is None else float(now)
        removed = 0
        with self._lock:
            empty_user_ids: list[str] = []
            for user_id, per_user in self._visible_chat_by_user.items():
                expired_instance_ids = [
                    key for key, lease in per_user.items() if lease.expires_at_monotonic <= resolved_now
                ]
                for key in expired_instance_ids:
                    per_user.pop(key, None)
                    removed += 1
                if not per_user:
                    empty_user_ids.append(user_id)
            for user_id in empty_user_ids:
                self._visible_chat_by_user.pop(user_id, None)
        return removed
