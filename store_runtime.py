from __future__ import annotations

import json
from typing import Any


class StoreRuntimeMixin:
    @staticmethod
    def _clean_runtime_checkpoint_history(value: Any) -> list[dict[str, str]]:
        if not isinstance(value, list):
            return []
        cleaned: list[dict[str, str]] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "").strip()
            content = str(item.get("content") or "").strip()
            if role and content:
                cleaned.append({"role": role, "content": content})
        return cleaned

    @staticmethod
    def _clean_runtime_checkpoint_lines(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [line for line in (str(item or "").strip() for item in value) if line]

    @classmethod
    def _normalize_runtime_checkpoint_payload(cls, raw_value: Any) -> dict[str, Any] | None:
        if isinstance(raw_value, list):
            return {
                "history": cls._clean_runtime_checkpoint_history(raw_value),
                "pending_tool_lines": [],
                "pending_assistant": "",
            }
        if not isinstance(raw_value, dict):
            return None
        return {
            "history": cls._clean_runtime_checkpoint_history(raw_value.get("history")),
            "pending_tool_lines": cls._clean_runtime_checkpoint_lines(raw_value.get("pending_tool_lines")),
            "pending_assistant": str(raw_value.get("pending_assistant") or "").strip(),
        }

    def set_runtime_checkpoint(
        self,
        *,
        session_id: str,
        user_id: str,
        chat_id: int,
        history: list[dict[str, str]] | None = None,
        pending_tool_lines: list[str] | None = None,
        pending_assistant: str | None = None,
    ) -> None:
        existing = self.get_runtime_checkpoint_state(session_id) or {}
        next_payload = {
            "history": self._clean_runtime_checkpoint_history(
                existing.get("history") if history is None else history
            ),
            "pending_tool_lines": self._clean_runtime_checkpoint_lines(
                existing.get("pending_tool_lines") if pending_tool_lines is None else pending_tool_lines
            ),
            "pending_assistant": str(
                existing.get("pending_assistant") if pending_assistant is None else pending_assistant or ""
            ).strip(),
        }
        payload = json.dumps(next_payload, ensure_ascii=False)
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            conn.execute(
                """
                INSERT INTO runtime_checkpoints (session_id, user_id, chat_id, history_json, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(session_id)
                DO UPDATE SET history_json = excluded.history_json,
                              user_id = excluded.user_id,
                              chat_id = excluded.chat_id,
                              updated_at = CURRENT_TIMESTAMP
                """,
                (session_id, user_id, chat_id, payload),
            )

    def get_runtime_checkpoint_state(self, session_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT history_json, updated_at FROM runtime_checkpoints WHERE session_id = ? LIMIT 1",
                (session_id,),
            ).fetchone()
        if not row:
            return None
        try:
            data = json.loads(str(row["history_json"] or "[]"))
        except json.JSONDecodeError:
            return None
        normalized = self._normalize_runtime_checkpoint_payload(data)
        if not normalized:
            return None
        normalized["updated_at"] = str(row["updated_at"] or "")
        return normalized

    def get_runtime_checkpoint(self, session_id: str) -> list[dict[str, str]] | None:
        state = self.get_runtime_checkpoint_state(session_id)
        if not state:
            return None
        return list(state.get("history") or [])

    def delete_runtime_checkpoint(self, session_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM runtime_checkpoints WHERE session_id = ?", (session_id,))

    def delete_runtime_checkpoints_for_chat(self, user_id: str, chat_id: int) -> None:
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM runtime_checkpoints WHERE user_id = ? AND chat_id = ?",
                (user_id, int(chat_id)),
            )
