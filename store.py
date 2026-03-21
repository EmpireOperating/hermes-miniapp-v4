from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
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
    unread_count: int
    pending: bool
    updated_at: str
    created_at: str


@dataclass(slots=True)
class ChatTurn:
    id: int
    role: str
    body: str
    created_at: str


class SessionStore:
    """SQLite-backed storage for per-user preferences, chat threads, and messages."""

    def __init__(self, db_path: str | Path = "sessions.db") -> None:
        self.db_path = str(db_path)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10, factory=ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        return connection

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_preferences (
                    user_id TEXT PRIMARY KEY,
                    skin TEXT NOT NULL DEFAULT 'terminal',
                    active_chat_id INTEGER,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_threads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    is_archived INTEGER NOT NULL DEFAULT 0,
                    last_read_message_id INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    chat_id INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    body TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(chat_id) REFERENCES chat_threads(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_threads_user_id ON chat_threads(user_id, id)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_messages_user_chat ON chat_messages(user_id, chat_id, id)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    chat_id INTEGER NOT NULL,
                    operator_message_id INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 4,
                    next_attempt_at TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    started_at TEXT,
                    finished_at TEXT,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_job_dead_letters (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id INTEGER NOT NULL,
                    user_id TEXT NOT NULL,
                    chat_id INTEGER NOT NULL,
                    operator_message_id INTEGER NOT NULL,
                    attempts INTEGER NOT NULL,
                    max_attempts INTEGER NOT NULL,
                    error TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_jobs_status_created ON chat_jobs(status, created_at, id)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_jobs_user_chat_status ON chat_jobs(user_id, chat_id, status, id)"
            )
            conn.execute(
                """
                UPDATE chat_jobs
                SET status = 'queued', started_at = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE status = 'running'
                """
            )
            columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(chat_threads)").fetchall()
            }
            if "is_archived" not in columns:
                conn.execute(
                    "ALTER TABLE chat_threads ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0"
                )

            user_pref_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(user_preferences)").fetchall()
            }
            if "active_chat_id" not in user_pref_columns:
                conn.execute("ALTER TABLE user_preferences ADD COLUMN active_chat_id INTEGER")

            chat_job_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(chat_jobs)").fetchall()
            }
            if "attempts" not in chat_job_columns:
                conn.execute("ALTER TABLE chat_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
            if "max_attempts" not in chat_job_columns:
                conn.execute("ALTER TABLE chat_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 4")
            if "next_attempt_at" not in chat_job_columns:
                conn.execute("ALTER TABLE chat_jobs ADD COLUMN next_attempt_at TEXT")

            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_jobs_next_attempt ON chat_jobs(status, next_attempt_at, id)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS runtime_checkpoints (
                    session_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    chat_id INTEGER NOT NULL,
                    history_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_runtime_checkpoints_user_chat ON runtime_checkpoints(user_id, chat_id)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    session_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    nonce_hash TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    revoked_at INTEGER,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id, expires_at)"
            )

            self._migrate_legacy_history(conn)

    def _migrate_legacy_history(self, conn: sqlite3.Connection) -> None:
        tables = {
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        if "chat_messages" not in tables:
            return
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(chat_messages)").fetchall()
        }
        if "chat_id" in columns:
            return
        legacy_rows = conn.execute(
            "SELECT user_id, role, body, created_at FROM chat_messages ORDER BY id ASC"
        ).fetchall()
        conn.execute("ALTER TABLE chat_messages RENAME TO legacy_chat_messages")
        conn.execute(
            """
            CREATE TABLE chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                chat_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(chat_id) REFERENCES chat_threads(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_messages_user_chat ON chat_messages(user_id, chat_id, id)"
        )
        thread_map: dict[str, int] = {}
        for row in legacy_rows:
            user_id = str(row["user_id"])
            if user_id not in thread_map:
                cursor = conn.execute(
                    "INSERT INTO chat_threads (user_id, title) VALUES (?, ?)",
                    (user_id, "Main"),
                )
                thread_map[user_id] = int(cursor.lastrowid)
            conn.execute(
                """
                INSERT INTO chat_messages (user_id, chat_id, role, body, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    thread_map[user_id],
                    str(row["role"]),
                    str(row["body"]),
                    str(row["created_at"]),
                ),
            )
        conn.execute("DROP TABLE legacy_chat_messages")

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

    def enqueue_chat_job(self, user_id: str, chat_id: int, operator_message_id: int, max_attempts: int = 4) -> int:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            cursor = conn.execute(
                """
                INSERT INTO chat_jobs (user_id, chat_id, operator_message_id, status, attempts, max_attempts, next_attempt_at, updated_at)
                VALUES (?, ?, ?, 'queued', 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (user_id, chat_id, operator_message_id, max(1, int(max_attempts))),
            )
            return int(cursor.lastrowid)

    def has_open_job(self, user_id: str, chat_id: int) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT 1 AS present
                FROM chat_jobs
                WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
                ORDER BY id DESC
                LIMIT 1
                """,
                (user_id, chat_id),
            ).fetchone()
        return bool(row)

    def get_open_job(self, user_id: str, chat_id: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, user_id, chat_id, operator_message_id, status, attempts, max_attempts
                FROM chat_jobs
                WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
                ORDER BY id DESC
                LIMIT 1
                """,
                (user_id, int(chat_id)),
            ).fetchone()
        if not row:
            return None
        return {
            "id": int(row["id"]),
            "user_id": str(row["user_id"]),
            "chat_id": int(row["chat_id"]),
            "operator_message_id": int(row["operator_message_id"]),
            "status": str(row["status"]),
            "attempts": int(row["attempts"] or 0),
            "max_attempts": int(row["max_attempts"] or 0),
        }

    def claim_next_job(self) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT q.id, q.user_id, q.chat_id, q.operator_message_id
                FROM chat_jobs AS q
                JOIN chat_threads AS ct
                  ON ct.user_id = q.user_id
                 AND ct.id = q.chat_id
                 AND ct.is_archived = 0
                WHERE q.status = 'queued'
                  AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= CURRENT_TIMESTAMP)
                  AND NOT EXISTS (
                      SELECT 1
                      FROM chat_jobs AS r
                      WHERE r.user_id = q.user_id
                        AND r.chat_id = q.chat_id
                        AND r.status = 'running'
                  )
                ORDER BY q.id ASC
                LIMIT 1
                """
            ).fetchone()
            if not row:
                return None
            updated = conn.execute(
                """
                UPDATE chat_jobs
                SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'queued'
                """,
                (int(row["id"]),),
            )
            if updated.rowcount == 0:
                return None
            claimed = conn.execute(
                """
                SELECT id, user_id, chat_id, operator_message_id, attempts, max_attempts
                FROM chat_jobs
                WHERE id = ?
                LIMIT 1
                """,
                (int(row["id"]),),
            ).fetchone()
            if not claimed:
                return None
            return {
                "id": int(claimed["id"]),
                "user_id": str(claimed["user_id"]),
                "chat_id": int(claimed["chat_id"]),
                "operator_message_id": int(claimed["operator_message_id"]),
                "attempts": int(claimed["attempts"] or 0),
                "max_attempts": int(claimed["max_attempts"] or 1),
            }

    def complete_job(self, job_id: int) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE chat_jobs
                SET status = 'done', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'running'
                """,
                (job_id,),
            )

    def touch_job(self, job_id: int) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE chat_jobs
                SET updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'running'
                """,
                (int(job_id),),
            )

    def fail_job(self, job_id: int, error: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE chat_jobs
                SET status = 'error', error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (error[:1000], job_id),
            )

    def retry_or_dead_letter_job(self, job_id: int, error: str, retry_base_seconds: int = 2) -> bool:
        """Returns True if retry scheduled, False if moved to dead-letter."""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, user_id, chat_id, operator_message_id, attempts, max_attempts
                FROM chat_jobs
                WHERE id = ?
                LIMIT 1
                """,
                (job_id,),
            ).fetchone()
            if not row:
                return False

            attempts = int(row["attempts"] or 0)
            max_attempts = max(1, int(row["max_attempts"] or 1))
            error_text = error[:1000]

            if attempts < max_attempts and int(retry_base_seconds) > 0:
                delay_seconds = max(1, int(retry_base_seconds)) * (2 ** max(0, attempts - 1))
                conn.execute(
                    """
                    UPDATE chat_jobs
                    SET status = 'queued',
                        error = ?,
                        next_attempt_at = datetime('now', ?),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (error_text, f"+{delay_seconds} seconds", job_id),
                )
                return True

            conn.execute(
                """
                INSERT INTO chat_job_dead_letters (
                    job_id, user_id, chat_id, operator_message_id, attempts, max_attempts, error
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(row["id"]),
                    str(row["user_id"]),
                    int(row["chat_id"]),
                    int(row["operator_message_id"]),
                    attempts,
                    max_attempts,
                    error_text,
                ),
            )
            conn.execute(
                """
                UPDATE chat_jobs
                SET status = 'dead', error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (error_text, job_id),
            )
            return False

    def dead_letter_stale_running_jobs(self, timeout_seconds: int, error: str) -> list[dict[str, Any]]:
        timeout = max(30, int(timeout_seconds or 0))
        error_text = str(error or "Job timed out")[:1000]
        with self._connect() as conn:
            stale_rows = conn.execute(
                """
                SELECT id, user_id, chat_id, operator_message_id, attempts, max_attempts
                FROM chat_jobs
                WHERE status = 'running'
                  AND updated_at <= datetime('now', ?)
                """,
                (f"-{timeout} seconds",),
            ).fetchall()

            results: list[dict[str, Any]] = []
            for row in stale_rows:
                job_id = int(row["id"])
                conn.execute(
                    """
                    INSERT INTO chat_job_dead_letters (
                        job_id, user_id, chat_id, operator_message_id, attempts, max_attempts, error
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        str(row["user_id"]),
                        int(row["chat_id"]),
                        int(row["operator_message_id"]),
                        int(row["attempts"] or 0),
                        int(row["max_attempts"] or 0),
                        error_text,
                    ),
                )
                conn.execute(
                    """
                    UPDATE chat_jobs
                    SET status = 'dead', error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status = 'running'
                    """,
                    (error_text, job_id),
                )
                results.append(
                    {
                        "id": job_id,
                        "user_id": str(row["user_id"]),
                        "chat_id": int(row["chat_id"]),
                    }
                )

        return results

    def get_job_state(self, job_id: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, chat_id, status, attempts, max_attempts, created_at, started_at, next_attempt_at
                FROM chat_jobs
                WHERE id = ?
                LIMIT 1
                """,
                (int(job_id),),
            ).fetchone()
            if not row:
                return None

            queued_ahead = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM chat_jobs
                WHERE status = 'queued'
                  AND id < ?
                  AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
                """,
                (int(job_id),),
            ).fetchone()

            running_total = conn.execute(
                "SELECT COUNT(*) AS c FROM chat_jobs WHERE status = 'running'"
            ).fetchone()

        return {
            "id": int(row["id"]),
            "chat_id": int(row["chat_id"]),
            "status": str(row["status"]),
            "attempts": int(row["attempts"] or 0),
            "max_attempts": int(row["max_attempts"] or 0),
            "created_at": str(row["created_at"] or ""),
            "started_at": str(row["started_at"] or ""),
            "next_attempt_at": str(row["next_attempt_at"] or ""),
            "queued_ahead": int((queued_ahead["c"] if queued_ahead else 0) or 0),
            "running_total": int((running_total["c"] if running_total else 0) or 0),
        }

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

    def list_jobs(self, user_id: str, limit: int = 25) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, chat_id, operator_message_id, status, attempts, max_attempts, next_attempt_at,
                       error, created_at, started_at, finished_at, updated_at
                FROM chat_jobs
                WHERE user_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (user_id, max(1, min(limit, 200))),
            ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "chat_id": int(row["chat_id"]),
                "operator_message_id": int(row["operator_message_id"]),
                "status": str(row["status"]),
                "attempts": int(row["attempts"] or 0),
                "max_attempts": int(row["max_attempts"] or 0),
                "next_attempt_at": row["next_attempt_at"],
                "error": row["error"],
                "created_at": row["created_at"],
                "started_at": row["started_at"],
                "finished_at": row["finished_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def list_dead_letters(self, user_id: str, limit: int = 25) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, job_id, chat_id, operator_message_id, attempts, max_attempts, error, created_at
                FROM chat_job_dead_letters
                WHERE user_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (user_id, max(1, min(limit, 200))),
            ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "job_id": int(row["job_id"]),
                "chat_id": int(row["chat_id"]),
                "operator_message_id": int(row["operator_message_id"]),
                "attempts": int(row["attempts"] or 0),
                "max_attempts": int(row["max_attempts"] or 0),
                "error": row["error"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def cleanup_stale_jobs(self, user_id: str, limit: int = 200) -> list[dict[str, Any]]:
        """Dead-letter queued/running jobs whose chats/messages are no longer valid."""
        safe_limit = max(1, min(int(limit or 200), 1000))
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT j.id,
                       j.chat_id,
                       j.operator_message_id,
                       j.attempts,
                       j.max_attempts,
                       ct.id AS thread_id,
                       ct.is_archived AS thread_archived,
                       m.id AS operator_exists
                FROM chat_jobs j
                LEFT JOIN chat_threads ct
                  ON ct.user_id = j.user_id
                 AND ct.id = j.chat_id
                LEFT JOIN chat_messages m
                  ON m.user_id = j.user_id
                 AND m.chat_id = j.chat_id
                 AND m.id = j.operator_message_id
                WHERE j.user_id = ?
                  AND j.status IN ('queued', 'running')
                ORDER BY j.id ASC
                LIMIT ?
                """,
                (user_id, safe_limit),
            ).fetchall()

            cleaned: list[dict[str, Any]] = []
            for row in rows:
                thread_missing = row["thread_id"] is None
                thread_archived = int(row["thread_archived"] or 0) == 1
                operator_missing = row["operator_exists"] is None

                if not (thread_missing or thread_archived or operator_missing):
                    continue

                if thread_missing:
                    reason = "Stale job cleanup: chat thread missing"
                elif thread_archived:
                    reason = "Stale job cleanup: chat archived"
                else:
                    reason = "Stale job cleanup: operator message missing"

                job_id = int(row["id"])
                chat_id = int(row["chat_id"])
                operator_message_id = int(row["operator_message_id"])
                attempts = int(row["attempts"] or 0)
                max_attempts = int(row["max_attempts"] or 1)

                conn.execute(
                    """
                    INSERT INTO chat_job_dead_letters (
                        job_id, user_id, chat_id, operator_message_id, attempts, max_attempts, error
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (job_id, user_id, chat_id, operator_message_id, attempts, max_attempts, reason),
                )
                conn.execute(
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
                cleaned.append(
                    {
                        "job_id": job_id,
                        "chat_id": chat_id,
                        "operator_message_id": operator_message_id,
                        "reason": reason,
                    }
                )

            return cleaned

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

    def upsert_auth_session(self, *, session_id: str, user_id: str, nonce_hash: str, expires_at: int) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO auth_sessions (session_id, user_id, nonce_hash, expires_at, revoked_at, updated_at)
                VALUES (?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
                ON CONFLICT(session_id)
                DO UPDATE SET
                    user_id = excluded.user_id,
                    nonce_hash = excluded.nonce_hash,
                    expires_at = excluded.expires_at,
                    revoked_at = NULL,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (session_id, user_id, nonce_hash, int(expires_at)),
            )

    def is_auth_session_active(self, *, session_id: str, user_id: str, nonce_hash: str, now_epoch: int) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT expires_at, revoked_at
                FROM auth_sessions
                WHERE session_id = ? AND user_id = ? AND nonce_hash = ?
                """,
                (session_id, user_id, nonce_hash),
            ).fetchone()
            if not row:
                return False
            if row["revoked_at"] is not None:
                return False
            if int(row["expires_at"] or 0) < int(now_epoch):
                return False
            return True

    def revoke_auth_session(self, session_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE auth_sessions
                SET revoked_at = ?, updated_at = CURRENT_TIMESTAMP
                WHERE session_id = ?
                """,
                (int(time.time()), session_id),
            )

    def revoke_all_auth_sessions(self, user_id: str) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE auth_sessions
                SET revoked_at = ?, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND revoked_at IS NULL
                """,
                (int(time.time()), user_id),
            )
            return int(cursor.rowcount or 0)

    def prune_expired_auth_sessions(self, now_epoch: int) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM auth_sessions WHERE expires_at < ?",
                (int(now_epoch),),
            )
            return int(cursor.rowcount or 0)

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

    def _ensure_chat_exists(self, conn: sqlite3.Connection, user_id: str, chat_id: int) -> None:
        row = conn.execute(
            "SELECT id FROM chat_threads WHERE user_id = ? AND id = ?",
            (user_id, chat_id),
        ).fetchone()
        if not row:
            raise KeyError(f"Chat {chat_id} not found")
