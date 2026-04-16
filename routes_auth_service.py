from __future__ import annotations

import time
from dataclasses import asdict
from types import SimpleNamespace
from typing import Any, Callable

from file_preview_eligibility import file_preview_allowed_roots, file_preview_context_roots, previewable_file_refs


_AUTH_PRUNE_INTERVAL_SECONDS = 300
_last_pruned_auth_sessions_at = 0


class AuthBootstrapService:
    def __init__(
        self,
        *,
        store_getter: Callable[[], Any],
        runtime_getter: Callable[[], Any],
        serialize_chat_fn: Callable[[Any], dict[str, object]],
        session_id_builder_fn: Callable[[str, int], str],
    ) -> None:
        self._store_getter = store_getter
        self._runtime_getter = runtime_getter
        self._serialize_chat_fn = serialize_chat_fn
        self._session_id_builder_fn = session_id_builder_fn

    def serialize_turn(self, turn: Any) -> dict[str, object]:
        payload = asdict(turn)
        allowed_roots = file_preview_allowed_roots()
        preferred_roots = file_preview_context_roots(allowed_roots)
        refs = previewable_file_refs(
            payload.get("body") or "",
            message_id=int(payload.get("id") or 0),
            allowed_roots=allowed_roots,
            preferred_roots=preferred_roots,
        )
        if refs:
            payload["file_refs"] = refs
        else:
            payload.pop("file_refs", None)
        return payload

    @staticmethod
    def parse_allow_empty_flag(payload: dict[str, object]) -> tuple[bool | None, tuple[dict[str, object], int] | None]:
        raw_allow_empty = payload.get("allow_empty", False)
        if isinstance(raw_allow_empty, bool):
            return raw_allow_empty, None
        if raw_allow_empty is None:
            return False, None
        return None, ({"ok": False, "error": "Invalid allow_empty flag. Expected boolean."}, 400)

    def _maybe_prune_expired_auth_sessions(self, store: Any, *, now_ts: int) -> None:
        global _last_pruned_auth_sessions_at
        if now_ts - _last_pruned_auth_sessions_at < _AUTH_PRUNE_INTERVAL_SECONDS:
            return
        store.prune_expired_auth_sessions(now_ts)
        _last_pruned_auth_sessions_at = now_ts

    def augment_history_with_runtime_pending(
        self,
        *,
        user_id: str,
        chat_id: int,
        history: list[dict[str, object]],
        chat_pending: bool = False,
    ) -> list[dict[str, object]]:
        if not bool(chat_pending):
            return history
        store = self._store_getter()
        checkpoint_state = store.get_runtime_checkpoint_state(self._session_id_builder_fn(user_id, chat_id))
        if not checkpoint_state:
            return history
        next_history = list(history)
        checkpoint_updated_at = str(checkpoint_state.get("updated_at") or "")
        pending_tool_lines = [
            str(line).strip()
            for line in (checkpoint_state.get("pending_tool_lines") or [])
            if str(line).strip()
        ]
        pending_assistant = str(checkpoint_state.get("pending_assistant") or "").strip()
        if pending_tool_lines and not any(
            item.get("pending") and str(item.get("role") or "").lower() == "tool"
            for item in next_history
        ):
            next_history.append(
                {
                    "id": 0,
                    "chat_id": int(chat_id),
                    "role": "tool",
                    "body": "\n".join(pending_tool_lines),
                    "created_at": checkpoint_updated_at,
                    "pending": True,
                }
            )
        if pending_assistant and not any(
            item.get("pending") and str(item.get("role") or "").lower() in {"assistant", "hermes"}
            for item in next_history
        ):
            next_history.append(
                {
                    "id": 0,
                    "chat_id": int(chat_id),
                    "role": "assistant",
                    "body": pending_assistant,
                    "created_at": checkpoint_updated_at,
                    "pending": True,
                }
            )
        return next_history

    def _visible_chats(self, *, user_id: str) -> list[dict[str, object]]:
        return [self._serialize_chat_fn(chat) for chat in self._store_getter().list_chats(user_id=user_id)]

    def _pinned_chats(self, *, user_id: str) -> list[dict[str, object]]:
        store = self._store_getter()
        if hasattr(store, "list_pinned_chat_summaries"):
            pinned_chats = store.list_pinned_chat_summaries(user_id=user_id)
        else:
            pinned_chats = store.list_pinned_chats(user_id=user_id)
        return [self._serialize_chat_fn(chat) for chat in pinned_chats]

    def _ensure_default_active_chat(
        self,
        *,
        store: Any,
        user_id: str,
        chats: list[dict[str, object]],
        visible_chat_ids: set[int],
    ) -> int | None:
        if chats:
            return int(chats[0]["id"])
        if store.has_explicit_empty_chat_state(user_id):
            return None
        active_chat_id = store.ensure_default_chat(user_id)
        try:
            ensured_chat = self._serialize_chat_fn(store.get_chat(user_id=user_id, chat_id=int(active_chat_id)))
        except KeyError:
            ensured_chat = None
        if ensured_chat:
            chats.append(ensured_chat)
            visible_chat_ids.add(int(ensured_chat["id"]))
        return int(active_chat_id)

    def _load_active_chat_history(
        self,
        *,
        store: Any,
        user_id: str,
        active_chat_id: int,
        chats: list[dict[str, object]],
    ) -> tuple[int | None, list[dict[str, object]]]:
        serialized_active_chat = next((chat for chat in chats if int(chat["id"]) == int(active_chat_id)), None)
        history = [
            self.serialize_turn(turn)
            for turn in store.get_history(user_id=user_id, chat_id=active_chat_id, limit=120)
        ]
        history = self.augment_history_with_runtime_pending(
            user_id=user_id,
            chat_id=int(active_chat_id),
            history=history,
            chat_pending=bool(serialized_active_chat and serialized_active_chat.get("pending")),
        )
        return int(active_chat_id), history

    @staticmethod
    def parse_preferred_chat_id(payload: dict[str, object]) -> tuple[int | None, tuple[dict[str, object], int] | None]:
        if "preferred_chat_id" not in payload or payload.get("preferred_chat_id") in (None, ""):
            return None, None
        try:
            preferred_chat_id = int(payload.get("preferred_chat_id"))
        except (TypeError, ValueError):
            return None, ({"ok": False, "error": "Invalid preferred_chat_id. Expected positive integer."}, 400)
        if preferred_chat_id <= 0:
            return None, ({"ok": False, "error": "Invalid preferred_chat_id. Expected positive integer."}, 400)
        return preferred_chat_id, None

    def auth_success_state(
        self,
        verified_user: Any,
        *,
        auth_mode: str,
        allow_empty: bool = False,
        preferred_chat_id: int | None = None,
    ) -> dict[str, object]:
        store = self._store_getter()
        runtime = self._runtime_getter()
        user_id = str(verified_user.id)
        self._maybe_prune_expired_auth_sessions(store, now_ts=int(time.time()))
        display_name = verified_user.first_name or verified_user.username or "Operator"

        chats = self._visible_chats(user_id=user_id)
        pinned_chats = self._pinned_chats(user_id=user_id)
        visible_chat_ids = {int(chat["id"]) for chat in chats}
        if any(bool(chat.get("pending")) for chat in chats):
            runtime.ensure_pending_jobs(user_id)
            chats = self._visible_chats(user_id=user_id)
            pinned_chats = self._pinned_chats(user_id=user_id)
            visible_chat_ids = {int(chat["id"]) for chat in chats}

        stored_active_chat_id = store.get_active_chat(user_id)
        active_chat_id = stored_active_chat_id
        if preferred_chat_id and int(preferred_chat_id) in visible_chat_ids:
            active_chat_id = int(preferred_chat_id)
        elif active_chat_id and int(active_chat_id) not in visible_chat_ids:
            active_chat_id = None

        if not active_chat_id and not allow_empty:
            active_chat_id = self._ensure_default_active_chat(
                store=store,
                user_id=user_id,
                chats=chats,
                visible_chat_ids=visible_chat_ids,
            )

        if active_chat_id and int(active_chat_id) in visible_chat_ids:
            active_chat_id, history = self._load_active_chat_history(
                store=store,
                user_id=user_id,
                active_chat_id=int(active_chat_id),
                chats=chats,
            )
        else:
            active_chat_id = None
            history = []
            if stored_active_chat_id and int(stored_active_chat_id) not in visible_chat_ids:
                store.clear_active_chat(user_id=user_id)

        skin = store.get_skin(user_id=user_id)
        telegram_unread_notifications_enabled = store.get_telegram_unread_notifications_enabled(user_id=user_id)
        return {
            "display_name": display_name,
            "payload": {
                "ok": True,
                "auth_mode": auth_mode,
                "user": {
                    "id": verified_user.id,
                    "display_name": display_name,
                    "username": verified_user.username,
                },
                "skin": skin,
                "telegram_unread_notifications_enabled": telegram_unread_notifications_enabled,
                "active_chat_id": active_chat_id,
                "history": history,
                "chats": chats,
                "pinned_chats": pinned_chats,
            },
        }

    @staticmethod
    def build_dev_verified_user(payload: dict[str, object]) -> tuple[Any | None, tuple[dict[str, object], int] | None]:
        raw_user_id = payload.get("user_id", 9001)
        try:
            user_id = int(raw_user_id)
        except (TypeError, ValueError):
            return None, ({"ok": False, "error": "Invalid dev user id."}, 400)
        if user_id <= 0:
            return None, ({"ok": False, "error": "Invalid dev user id."}, 400)

        display_name = str(payload.get("display_name") or "Desktop Tester").strip() or "Desktop Tester"
        username = str(payload.get("username") or "desktop").strip() or None
        verified = SimpleNamespace(
            user=SimpleNamespace(
                id=user_id,
                first_name=display_name,
                username=username,
            )
        )
        return verified, None
