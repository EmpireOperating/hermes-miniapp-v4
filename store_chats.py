from __future__ import annotations

import re

from store_chat_mutations import cancel_open_jobs_for_chat, clear_chat as clear_chat_rows, remove_chat as remove_chat_row
from store_chat_queries import (
    first_unarchived_chat_id,
    get_or_create_main_chat_id,
    get_turn_count as query_turn_count,
    hydrate_chat_thread,
    hydrate_chat_turns,
    list_recoverable_pending_turns as query_recoverable_pending_turns,
    select_chat_rows,
    select_pinned_chat_summary_rows,
)
from store_models import (
    MAX_ASSISTANT_MESSAGE_LEN,
    MAX_OPERATOR_MESSAGE_LEN,
    MAX_SYSTEM_MESSAGE_LEN,
    MAX_TITLE_LEN,
    ChatThread,
    ChatTurn,
)


class StoreChatsMixin:
    def get_skin(self, user_id: str) -> str:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT skin FROM user_preferences WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        return str(row["skin"]) if row else "terminal"

    def get_telegram_unread_notifications_enabled(self, user_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT telegram_unread_notifications_enabled FROM user_preferences WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        return bool(int(row["telegram_unread_notifications_enabled"] or 0)) if row else False

    def set_telegram_unread_notifications_enabled(self, user_id: str, enabled: bool) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO user_preferences (user_id, skin, telegram_unread_notifications_enabled, updated_at)
                VALUES (?, COALESCE((SELECT skin FROM user_preferences WHERE user_id = ?), 'terminal'), ?, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id)
                DO UPDATE SET telegram_unread_notifications_enabled = excluded.telegram_unread_notifications_enabled,
                              updated_at = CURRENT_TIMESTAMP
                """,
                (user_id, user_id, 1 if enabled else 0),
            )

    def set_skin(self, user_id: str, skin: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO user_preferences (user_id, skin, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id)
                DO UPDATE SET skin = excluded.skin, updated_at = CURRENT_TIMESTAMP
                """,
                (user_id, skin),
            )

    def get_active_chat(self, user_id: str) -> int | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT active_chat_id FROM user_preferences WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        if not row or row["active_chat_id"] in (None, ""):
            return None
        return int(row["active_chat_id"])

    def get_last_read_message_id(self, user_id: str, chat_id: int) -> int:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            row = conn.execute(
                "SELECT last_read_message_id FROM chat_threads WHERE user_id = ? AND id = ? LIMIT 1",
                (user_id, chat_id),
            ).fetchone()
        return int(row["last_read_message_id"] or 0) if row else 0

    def count_telegram_notification_send_attempts(self, user_id: str, chat_id: int, unread_streak_key: int) -> int:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS total
                FROM telegram_notification_attempts
                WHERE user_id = ?
                  AND chat_id = ?
                  AND unread_streak_key = ?
                  AND send_attempted = 1
                """,
                (user_id, chat_id, int(unread_streak_key)),
            ).fetchone()
        return int(row["total"] or 0) if row else 0

    def has_successful_telegram_notification_for_streak(self, user_id: str, chat_id: int, unread_streak_key: int) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT 1 AS present
                FROM telegram_notification_attempts
                WHERE user_id = ?
                  AND chat_id = ?
                  AND unread_streak_key = ?
                  AND send_ok = 1
                LIMIT 1
                """,
                (user_id, chat_id, int(unread_streak_key)),
            ).fetchone()
        return row is not None

    def record_telegram_notification_attempt(
        self,
        *,
        user_id: str,
        chat_id: int,
        unread_streak_key: int,
        prior_unread_count: int,
        notifications_enabled: bool,
        active_chat_id: int | None,
        visibly_open_chat_id: int | None,
        decision_reason: str,
        send_attempted: bool,
        send_ok: bool,
        status_code: int | None,
        error: str | None,
        response_text: str | None,
    ) -> int:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            cursor = conn.execute(
                """
                INSERT INTO telegram_notification_attempts (
                    user_id,
                    chat_id,
                    unread_streak_key,
                    prior_unread_count,
                    notifications_enabled,
                    active_chat_id,
                    visibly_open_chat_id,
                    decision_reason,
                    send_attempted,
                    send_ok,
                    status_code,
                    error,
                    response_text
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    int(chat_id),
                    int(unread_streak_key),
                    max(0, int(prior_unread_count or 0)),
                    1 if notifications_enabled else 0,
                    None if active_chat_id is None else int(active_chat_id),
                    None if visibly_open_chat_id is None else int(visibly_open_chat_id),
                    str(decision_reason or "unknown")[:120],
                    1 if send_attempted else 0,
                    1 if send_ok else 0,
                    None if status_code is None else int(status_code),
                    None if error is None else str(error)[:1000],
                    None if response_text is None else str(response_text)[:4000],
                ),
            )
            return int(cursor.lastrowid)

    def list_telegram_notification_attempts(
        self,
        user_id: str,
        *,
        chat_id: int | None = None,
        unread_streak_key: int | None = None,
        limit: int = 50,
    ) -> list[dict[str, object]]:
        where = ["user_id = ?"]
        params: list[object] = [user_id]
        if chat_id is not None:
            where.append("chat_id = ?")
            params.append(int(chat_id))
        if unread_streak_key is not None:
            where.append("unread_streak_key = ?")
            params.append(int(unread_streak_key))
        params.append(max(1, int(limit or 50)))
        query = f"""
            SELECT
                id,
                user_id,
                chat_id,
                unread_streak_key,
                prior_unread_count,
                notifications_enabled,
                active_chat_id,
                visibly_open_chat_id,
                decision_reason,
                send_attempted,
                send_ok,
                status_code,
                error,
                response_text,
                created_at
            FROM telegram_notification_attempts
            WHERE {' AND '.join(where)}
            ORDER BY id ASC
            LIMIT ?
        """
        with self._connect() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
        return [dict(row) for row in rows]

    def set_active_chat(self, user_id: str, chat_id: int) -> None:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            conn.execute(
                """
                INSERT INTO user_preferences (user_id, skin, active_chat_id, updated_at)
                VALUES (?, COALESCE((SELECT skin FROM user_preferences WHERE user_id = ?), 'terminal'), ?, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id)
                DO UPDATE SET active_chat_id = excluded.active_chat_id, updated_at = CURRENT_TIMESTAMP
                """,
                (user_id, user_id, chat_id),
            )

    def clear_active_chat(self, user_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO user_preferences (user_id, skin, active_chat_id, updated_at)
                VALUES (?, COALESCE((SELECT skin FROM user_preferences WHERE user_id = ?), 'terminal'), NULL, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id)
                DO UPDATE SET active_chat_id = NULL, updated_at = CURRENT_TIMESTAMP
                """,
                (user_id, user_id),
            )

    def has_explicit_empty_chat_state(self, user_id: str) -> bool:
        with self._connect() as conn:
            pref_row = conn.execute(
                "SELECT 1 FROM user_preferences WHERE user_id = ? AND active_chat_id IS NULL LIMIT 1",
                (user_id,),
            ).fetchone()
            if not pref_row:
                return False
            chat_row = conn.execute(
                "SELECT 1 FROM chat_threads WHERE user_id = ? AND is_archived = 0 LIMIT 1",
                (user_id,),
            ).fetchone()
        return chat_row is None

    def _first_unarchived_chat_id(self, conn, *, user_id: str) -> int | None:
        return first_unarchived_chat_id(conn, user_id=user_id)

    def _get_or_create_main_chat_id(self, conn, *, user_id: str) -> int:
        return get_or_create_main_chat_id(conn, user_id=user_id)

    def ensure_default_chat(self, user_id: str) -> int:
        with self._connect() as conn:
            return self._get_or_create_main_chat_id(conn, user_id=user_id)

    def _hydrate_chat_thread(self, row) -> ChatThread:
        return hydrate_chat_thread(row)

    def _select_chat_rows(
        self,
        conn,
        *,
        user_id: str,
        include_archived: bool,
        pinned_only: bool,
        chat_id: int | None = None,
    ):
        return select_chat_rows(
            conn,
            user_id=user_id,
            include_archived=include_archived,
            pinned_only=pinned_only,
            chat_id=chat_id,
        )

    def list_chats(self, user_id: str) -> list[ChatThread]:
        with self._connect() as conn:
            rows = self._select_chat_rows(
                conn,
                user_id=user_id,
                include_archived=False,
                pinned_only=False,
            )
        return [self._hydrate_chat_thread(row) for row in rows]

    def create_chat(self, user_id: str, title: str) -> ChatThread:
        cleaned = title.strip() or "New chat"
        if len(cleaned) > MAX_TITLE_LEN:
            raise ValueError(f"Title exceeds {MAX_TITLE_LEN} characters")
        with self._connect() as conn:
            cursor = conn.execute(
                "INSERT INTO chat_threads (user_id, title, is_archived) VALUES (?, ?, 0)",
                (user_id, cleaned),
            )
            chat_id = int(cursor.lastrowid)
        return self.get_chat(user_id, chat_id)

    def _get_next_title_in_lineage(self, conn, *, user_id: str, base_title: str) -> str:
        cleaned_base = str(base_title or "").strip() or "branch"
        match = re.match(r"^(.*?) #(\d+)$", cleaned_base)
        lineage_base = str(match.group(1)).strip() if match else cleaned_base
        escaped = lineage_base.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = conn.execute(
            "SELECT title FROM chat_threads WHERE user_id = ? AND (title = ? OR title LIKE ? ESCAPE '\\')",
            (user_id, lineage_base, f"{escaped} #%"),
        ).fetchall()
        existing = [str(row["title"] or "") for row in rows]
        if not existing:
            return lineage_base

        max_num = 1
        for current_title in existing:
            suffix_match = re.match(r"^.* #(\d+)$", current_title)
            if suffix_match:
                max_num = max(max_num, int(suffix_match.group(1)))
        return f"{lineage_base} #{max_num + 1}"

    def fork_chat(self, user_id: str, source_chat_id: int, title: str | None = None) -> ChatThread:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, source_chat_id)
            source = conn.execute(
                "SELECT title FROM chat_threads WHERE user_id = ? AND id = ? LIMIT 1",
                (user_id, source_chat_id),
            ).fetchone()
            source_title = str(source["title"] or "Chat") if source else "Chat"

            cleaned_title = str(title or "").strip() or self._get_next_title_in_lineage(
                conn,
                user_id=user_id,
                base_title=source_title,
            )
            if len(cleaned_title) > MAX_TITLE_LEN:
                raise ValueError(f"Title exceeds {MAX_TITLE_LEN} characters")

            cursor = conn.execute(
                "INSERT INTO chat_threads (user_id, title, parent_chat_id, is_archived) VALUES (?, ?, ?, 0)",
                (user_id, cleaned_title, source_chat_id),
            )
            fork_chat_id = int(cursor.lastrowid)

            source_rows = conn.execute(
                """
                SELECT role, body
                FROM chat_messages
                WHERE user_id = ? AND chat_id = ?
                ORDER BY id ASC
                """,
                (user_id, source_chat_id),
            ).fetchall()

            for row in source_rows:
                role = str(row["role"])
                body = str(row["body"])
                conn.execute(
                    "INSERT INTO chat_messages (user_id, chat_id, role, body) VALUES (?, ?, ?, ?)",
                    (user_id, fork_chat_id, role, body),
                )

            last_message_row = conn.execute(
                "SELECT COALESCE(MAX(id), 0) AS max_id FROM chat_messages WHERE user_id = ? AND chat_id = ?",
                (user_id, fork_chat_id),
            ).fetchone()
            last_read_message_id = int(last_message_row["max_id"] or 0) if last_message_row else 0
            conn.execute(
                "UPDATE chat_threads SET last_read_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?",
                (last_read_message_id, user_id, fork_chat_id),
            )

        return self.get_chat(user_id, fork_chat_id)

    def rename_chat(self, user_id: str, chat_id: int, title: str) -> ChatThread:
        cleaned = title.strip() or "Untitled"
        if len(cleaned) > MAX_TITLE_LEN:
            raise ValueError(f"Title exceeds {MAX_TITLE_LEN} characters")
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE chat_threads SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?",
                (cleaned, user_id, chat_id),
            )
            if cursor.rowcount == 0:
                raise KeyError(f"Chat {chat_id} not found")
        return self.get_chat(user_id, chat_id)

    def get_chat(self, user_id: str, chat_id: int) -> ChatThread:
        with self._connect() as conn:
            rows = self._select_chat_rows(
                conn,
                user_id=user_id,
                include_archived=True,
                pinned_only=False,
                chat_id=chat_id,
            )
        if not rows:
            raise KeyError(f"Chat {chat_id} not found")
        return self._hydrate_chat_thread(rows[0])

    def _hydrate_chat_turns(self, rows) -> list[ChatTurn]:
        return hydrate_chat_turns(rows)

    def add_message(self, user_id: str, chat_id: int, role: str, body: str) -> int:
        cleaned = body.strip()
        if not cleaned:
            raise ValueError("Message body cannot be empty")

        normalized_role = str(role or "").strip().lower()
        if normalized_role == "operator":
            max_len = MAX_OPERATOR_MESSAGE_LEN
        elif normalized_role == "hermes":
            max_len = MAX_ASSISTANT_MESSAGE_LEN
        else:
            max_len = MAX_SYSTEM_MESSAGE_LEN

        if len(cleaned) > max_len:
            raise ValueError(f"Message body exceeds {max_len} characters")
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            cursor = conn.execute(
                "INSERT INTO chat_messages (user_id, chat_id, role, body) VALUES (?, ?, ?, ?)",
                (user_id, chat_id, role, cleaned),
            )
            conn.execute(
                "UPDATE chat_threads SET updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?",
                (user_id, chat_id),
            )
            return int(cursor.lastrowid)

    def get_history(self, user_id: str, chat_id: int, limit: int = 120) -> list[ChatTurn]:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            rows = conn.execute(
                """
                SELECT id, role, body, created_at
                FROM chat_messages
                WHERE user_id = ? AND chat_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (user_id, chat_id, limit),
            ).fetchall()
        return self._hydrate_chat_turns(rows)

    def mark_chat_read(self, user_id: str, chat_id: int) -> None:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            row = conn.execute(
                "SELECT COALESCE(MAX(id), 0) AS max_id FROM chat_messages WHERE user_id = ? AND chat_id = ?",
                (user_id, chat_id),
            ).fetchone()
            last_message_id = int(row["max_id"] or 0)
            conn.execute(
                "UPDATE chat_threads SET last_read_message_id = ?, updated_at = updated_at WHERE user_id = ? AND id = ?",
                (last_message_id, user_id, chat_id),
            )

    def mark_chat_read_through(self, user_id: str, chat_id: int, message_id: int) -> None:
        last_message_id = max(0, int(message_id or 0))
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            conn.execute(
                "UPDATE chat_threads SET last_read_message_id = ?, updated_at = updated_at WHERE user_id = ? AND id = ?",
                (last_message_id, user_id, chat_id),
            )

    def _cancel_open_jobs_for_chat(self, conn, *, user_id: str, chat_id: int, reason: str) -> None:
        cancel_open_jobs_for_chat(
            conn,
            user_id=user_id,
            chat_id=chat_id,
            reason=reason,
            insert_dead_letter_if_missing=self._insert_dead_letter_if_missing,
        )

    def clear_chat(self, user_id: str, chat_id: int) -> None:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            clear_chat_rows(
                conn,
                user_id=user_id,
                chat_id=chat_id,
                cancel_open_jobs_for_chat_fn=lambda active_conn: self._cancel_open_jobs_for_chat(
                    active_conn,
                    user_id=user_id,
                    chat_id=chat_id,
                    reason="Chat cleared by user before job completed",
                ),
            )

    def remove_chat(self, user_id: str, chat_id: int, *, allow_empty: bool = False) -> int | None:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            next_chat_id = remove_chat_row(
                conn,
                user_id=user_id,
                chat_id=chat_id,
                cancel_open_jobs_for_chat_fn=lambda active_conn: self._cancel_open_jobs_for_chat(
                    active_conn,
                    user_id=user_id,
                    chat_id=chat_id,
                    reason="Chat archived by user before job completed",
                ),
                get_or_create_main_chat_id_fn=lambda active_conn, active_user_id: self._get_or_create_main_chat_id(
                    active_conn,
                    user_id=active_user_id,
                ),
                first_unarchived_chat_id_fn=lambda active_conn, active_user_id: self._first_unarchived_chat_id(
                    active_conn,
                    user_id=active_user_id,
                ),
                allow_empty=allow_empty,
            )
            if next_chat_id is None:
                conn.execute(
                    """
                    INSERT INTO user_preferences (user_id, skin, active_chat_id, updated_at)
                    VALUES (?, COALESCE((SELECT skin FROM user_preferences WHERE user_id = ?), 'terminal'), NULL, CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id)
                    DO UPDATE SET active_chat_id = NULL, updated_at = CURRENT_TIMESTAMP
                    """,
                    (user_id, user_id),
                )
            return next_chat_id

    def list_pinned_chats(self, user_id: str) -> list[ChatThread]:
        with self._connect() as conn:
            rows = self._select_chat_rows(
                conn,
                user_id=user_id,
                include_archived=True,
                pinned_only=True,
            )
        return [self._hydrate_chat_thread(row) for row in rows]

    def list_pinned_chat_summaries(self, user_id: str) -> list[ChatThread]:
        with self._connect() as conn:
            rows = select_pinned_chat_summary_rows(conn, user_id=user_id)
        return [self._hydrate_chat_thread(row) for row in rows]

    def set_chat_pinned(self, user_id: str, chat_id: int, *, is_pinned: bool) -> ChatThread:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            conn.execute(
                "UPDATE chat_threads SET is_pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?",
                (1 if is_pinned else 0, user_id, chat_id),
            )
        return self.get_chat(user_id, chat_id)

    def reopen_chat(self, user_id: str, chat_id: int) -> ChatThread:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            conn.execute(
                "UPDATE chat_threads SET is_archived = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?",
                (user_id, chat_id),
            )
        return self.get_chat(user_id, chat_id)

    def get_history_before(self, user_id: str, chat_id: int, before_message_id: int, limit: int = 120) -> list[ChatTurn]:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            rows = conn.execute(
                """
                SELECT id, role, body, created_at
                FROM chat_messages
                WHERE user_id = ? AND chat_id = ? AND id < ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (user_id, chat_id, before_message_id, limit),
            ).fetchall()
        return self._hydrate_chat_turns(rows)

    def get_message(self, user_id: str, chat_id: int, message_id: int) -> ChatTurn:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, role, body, created_at
                FROM chat_messages
                WHERE user_id = ? AND chat_id = ? AND id = ?
                LIMIT 1
                """,
                (user_id, chat_id, message_id),
            ).fetchone()
        if not row:
            raise KeyError(f"Message {message_id} not found")
        return ChatTurn(
            id=int(row["id"]),
            role=str(row["role"]),
            body=str(row["body"]),
            created_at=str(row["created_at"]),
        )

    def list_recoverable_pending_turns(self, user_id: str) -> list[tuple[int, int]]:
        with self._connect() as conn:
            return query_recoverable_pending_turns(conn, user_id=user_id)

    def get_turn_count(self, user_id: str, chat_id: int | None = None) -> int:
        with self._connect() as conn:
            return query_turn_count(conn, user_id=user_id, chat_id=chat_id)
