from __future__ import annotations

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

    def _first_unarchived_chat_id(self, conn, *, user_id: str) -> int | None:
        row = conn.execute(
            "SELECT id FROM chat_threads WHERE user_id = ? AND is_archived = 0 ORDER BY id ASC LIMIT 1",
            (user_id,),
        ).fetchone()
        return int(row["id"]) if row else None

    def _get_or_create_main_chat_id(self, conn, *, user_id: str) -> int:
        chat_id = self._first_unarchived_chat_id(conn, user_id=user_id)
        if chat_id is not None:
            return chat_id
        cursor = conn.execute(
            "INSERT INTO chat_threads (user_id, title, is_archived) VALUES (?, ?, 0)",
            (user_id, "Main"),
        )
        return int(cursor.lastrowid)

    def ensure_default_chat(self, user_id: str) -> int:
        with self._connect() as conn:
            return self._get_or_create_main_chat_id(conn, user_id=user_id)

    def _hydrate_chat_thread(self, row) -> ChatThread:
        return ChatThread(
            id=int(row["id"]),
            title=str(row["title"]),
            unread_count=int(row["unread_count"] or 0),
            pending=bool(int(row["pending"] or 0)),
            is_pinned=bool(int(row["is_pinned"] or 0)),
            updated_at=str(row["updated_at"]),
            created_at=str(row["created_at"]),
        )

    def _select_chat_rows(
        self,
        conn,
        *,
        user_id: str,
        include_archived: bool,
        pinned_only: bool,
        chat_id: int | None = None,
    ):
        where_clauses = ["ct.user_id = ?"]
        params: list[object] = [user_id]

        if not include_archived:
            where_clauses.append("ct.is_archived = 0")
        if pinned_only:
            where_clauses.append("ct.is_pinned = 1")
        if chat_id is not None:
            where_clauses.append("ct.id = ?")
            params.append(chat_id)

        query = f"""
            SELECT
                ct.id,
                ct.title,
                ct.updated_at,
                ct.created_at,
                ct.is_pinned,
                SUM(CASE WHEN cm.role = 'hermes' AND cm.id > ct.last_read_message_id THEN 1 ELSE 0 END) AS unread_count,
                CASE WHEN (
                    SELECT last_msg.role
                    FROM chat_messages last_msg
                    WHERE last_msg.user_id = ct.user_id AND last_msg.chat_id = ct.id
                    ORDER BY last_msg.id DESC
                    LIMIT 1
                ) = 'operator' THEN 1 ELSE 0 END AS pending
            FROM chat_threads ct
            LEFT JOIN chat_messages cm ON cm.chat_id = ct.id AND cm.user_id = ct.user_id
            WHERE {' AND '.join(where_clauses)}
            GROUP BY ct.id, ct.title, ct.updated_at, ct.created_at, ct.is_pinned
            ORDER BY ct.id ASC
        """
        return conn.execute(query, tuple(params)).fetchall()

    def list_chats(self, user_id: str) -> list[ChatThread]:
        self.ensure_default_chat(user_id)
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
        ordered = reversed(rows)
        return [
            ChatTurn(
                id=int(row["id"]),
                role=str(row["role"]),
                body=str(row["body"]),
                created_at=str(row["created_at"]),
            )
            for row in ordered
        ]

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

    def _cancel_open_jobs_for_chat(self, conn, *, user_id: str, chat_id: int, reason: str) -> None:
        cancelled_jobs = conn.execute(
            """
            SELECT id, operator_message_id, attempts, max_attempts
            FROM chat_jobs
            WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
            """,
            (user_id, chat_id),
        ).fetchall()

        if not cancelled_jobs:
            return

        for row in cancelled_jobs:
            job_id = int(row["id"])
            updated = conn.execute(
                """
                UPDATE chat_jobs
                SET status = 'dead',
                    error = ?,
                    finished_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status IN ('queued', 'running')
                """,
                (reason, job_id),
            )
            if updated.rowcount == 0:
                continue

            self._insert_dead_letter_if_missing(
                conn,
                job_id=job_id,
                user_id=user_id,
                chat_id=chat_id,
                operator_message_id=int(row["operator_message_id"]),
                attempts=int(row["attempts"] or 0),
                max_attempts=int(row["max_attempts"] or 1),
                error=reason,
            )

    def clear_chat(self, user_id: str, chat_id: int) -> None:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            self._cancel_open_jobs_for_chat(
                conn,
                user_id=user_id,
                chat_id=chat_id,
                reason="Chat cleared by user before job completed",
            )

            conn.execute(
                "DELETE FROM chat_messages WHERE user_id = ? AND chat_id = ?",
                (user_id, chat_id),
            )
            conn.execute(
                "UPDATE chat_threads SET last_read_message_id = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?",
                (user_id, chat_id),
            )

    def remove_chat(self, user_id: str, chat_id: int) -> int:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            self._cancel_open_jobs_for_chat(
                conn,
                user_id=user_id,
                chat_id=chat_id,
                reason="Chat archived by user before job completed",
            )

            conn.execute(
                "UPDATE chat_threads SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?",
                (user_id, chat_id),
            )
            return self._get_or_create_main_chat_id(conn, user_id=user_id)

    def list_pinned_chats(self, user_id: str) -> list[ChatThread]:
        with self._connect() as conn:
            rows = self._select_chat_rows(
                conn,
                user_id=user_id,
                include_archived=True,
                pinned_only=True,
            )
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
            rows = conn.execute(
                """
                SELECT ct.id AS chat_id,
                       (
                           SELECT lm.id
                           FROM chat_messages lm
                           WHERE lm.user_id = ct.user_id AND lm.chat_id = ct.id
                           ORDER BY lm.id DESC
                           LIMIT 1
                       ) AS latest_message_id,
                       (
                           SELECT lm.role
                           FROM chat_messages lm
                           WHERE lm.user_id = ct.user_id AND lm.chat_id = ct.id
                           ORDER BY lm.id DESC
                           LIMIT 1
                       ) AS latest_role
                FROM chat_threads ct
                WHERE ct.user_id = ? AND ct.is_archived = 0
                """,
                (user_id,),
            ).fetchall()

            recoverable: list[tuple[int, int]] = []
            for row in rows:
                if str(row["latest_role"] or "") != "operator":
                    continue
                chat_id = int(row["chat_id"])
                message_id = int(row["latest_message_id"] or 0)
                if message_id <= 0:
                    continue
                open_job = conn.execute(
                    """
                    SELECT 1 AS present
                    FROM chat_jobs
                    WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
                    ORDER BY id DESC
                    LIMIT 1
                    """,
                    (user_id, chat_id),
                ).fetchone()
                if open_job:
                    continue
                recoverable.append((chat_id, message_id))
            return recoverable

    def get_turn_count(self, user_id: str, chat_id: int | None = None) -> int:
        with self._connect() as conn:
            if chat_id is None:
                row = conn.execute(
                    "SELECT COUNT(*) AS count FROM chat_messages WHERE user_id = ?",
                    (user_id,),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT COUNT(*) AS count FROM chat_messages WHERE user_id = ? AND chat_id = ?",
                    (user_id, chat_id),
                ).fetchone()
        return int(row["count"]) if row else 0
