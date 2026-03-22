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

    def ensure_default_chat(self, user_id: str) -> int:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id FROM chat_threads WHERE user_id = ? AND is_archived = 0 ORDER BY id ASC LIMIT 1",
                (user_id,),
            ).fetchone()
            if row:
                return int(row["id"])
            cursor = conn.execute(
                "INSERT INTO chat_threads (user_id, title, is_archived) VALUES (?, ?, 0)",
                (user_id, "Main"),
            )
            return int(cursor.lastrowid)

    def list_chats(self, user_id: str) -> list[ChatThread]:
        self.ensure_default_chat(user_id)
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    ct.id,
                    ct.title,
                    ct.updated_at,
                    ct.created_at,
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
                WHERE ct.user_id = ? AND ct.is_archived = 0
                GROUP BY ct.id, ct.title, ct.updated_at, ct.created_at
                ORDER BY ct.id ASC
                """,
                (user_id,),
            ).fetchall()
        return [
            ChatThread(
                id=int(row["id"]),
                title=str(row["title"]),
                unread_count=int(row["unread_count"] or 0),
                pending=bool(int(row["pending"] or 0)),
                updated_at=str(row["updated_at"]),
                created_at=str(row["created_at"]),
            )
            for row in rows
        ]

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
            row = conn.execute(
                """
                SELECT
                    ct.id,
                    ct.title,
                    ct.updated_at,
                    ct.created_at,
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
                WHERE ct.user_id = ? AND ct.id = ?
                GROUP BY ct.id, ct.title, ct.updated_at, ct.created_at
                """,
                (user_id, chat_id),
            ).fetchone()
        if not row:
            raise KeyError(f"Chat {chat_id} not found")
        return ChatThread(
            id=int(row["id"]),
            title=str(row["title"]),
            unread_count=int(row["unread_count"] or 0),
            pending=bool(int(row["pending"] or 0)),
            updated_at=str(row["updated_at"]),
            created_at=str(row["created_at"]),
        )

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

    def clear_chat(self, user_id: str, chat_id: int) -> None:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)

            cancelled_jobs = conn.execute(
                """
                SELECT id, operator_message_id, attempts, max_attempts
                FROM chat_jobs
                WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
                """,
                (user_id, chat_id),
            ).fetchall()

            if cancelled_jobs:
                cancellation_reason = "Chat cleared by user before job completed"
                for row in cancelled_jobs:
                    conn.execute(
                        """
                        INSERT INTO chat_job_dead_letters (
                            job_id, user_id, chat_id, operator_message_id, attempts, max_attempts, error
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            int(row["id"]),
                            user_id,
                            chat_id,
                            int(row["operator_message_id"]),
                            int(row["attempts"] or 0),
                            int(row["max_attempts"] or 1),
                            cancellation_reason,
                        ),
                    )

                conn.execute(
                    """
                    UPDATE chat_jobs
                    SET status = 'dead',
                        error = ?,
                        finished_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
                    """,
                    (cancellation_reason, user_id, chat_id),
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

            cancelled_jobs = conn.execute(
                """
                SELECT id, operator_message_id, attempts, max_attempts
                FROM chat_jobs
                WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
                """,
                (user_id, chat_id),
            ).fetchall()

            if cancelled_jobs:
                cancellation_reason = "Chat archived by user before job completed"
                for row in cancelled_jobs:
                    conn.execute(
                        """
                        INSERT INTO chat_job_dead_letters (
                            job_id, user_id, chat_id, operator_message_id, attempts, max_attempts, error
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            int(row["id"]),
                            user_id,
                            chat_id,
                            int(row["operator_message_id"]),
                            int(row["attempts"] or 0),
                            int(row["max_attempts"] or 1),
                            cancellation_reason,
                        ),
                    )

                conn.execute(
                    """
                    UPDATE chat_jobs
                    SET status = 'dead',
                        error = ?,
                        finished_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
                    """,
                    (cancellation_reason, user_id, chat_id),
                )

            conn.execute(
                "UPDATE chat_threads SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?",
                (user_id, chat_id),
            )
            row = conn.execute(
                "SELECT id FROM chat_threads WHERE user_id = ? AND is_archived = 0 ORDER BY id ASC LIMIT 1",
                (user_id,),
            ).fetchone()
            if row:
                return int(row["id"])
            cursor = conn.execute(
                "INSERT INTO chat_threads (user_id, title, is_archived) VALUES (?, ?, 0)",
                (user_id, "Main"),
            )
            return int(cursor.lastrowid)

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
