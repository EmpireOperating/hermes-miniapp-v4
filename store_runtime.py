from __future__ import annotations

import json


class StoreRuntimeMixin:
    def set_runtime_checkpoint(
        self,
        *,
        session_id: str,
        user_id: str,
        chat_id: int,
        history: list[dict[str, str]],
    ) -> None:
        payload = json.dumps(history, ensure_ascii=False)
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

    def get_runtime_checkpoint(self, session_id: str) -> list[dict[str, str]] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT history_json FROM runtime_checkpoints WHERE session_id = ? LIMIT 1",
                (session_id,),
            ).fetchone()
        if not row:
            return None
        try:
            data = json.loads(str(row["history_json"] or "[]"))
        except json.JSONDecodeError:
            return None
        if not isinstance(data, list):
            return None
        cleaned: list[dict[str, str]] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "").strip()
            content = str(item.get("content") or "").strip()
            if role and content:
                cleaned.append({"role": role, "content": content})
        return cleaned

    def delete_runtime_checkpoint(self, session_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM runtime_checkpoints WHERE session_id = ?", (session_id,))

    def delete_runtime_checkpoints_for_chat(self, user_id: str, chat_id: int) -> None:
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM runtime_checkpoints WHERE user_id = ? AND chat_id = ?",
                (user_id, int(chat_id)),
            )
