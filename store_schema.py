from __future__ import annotations

import sqlite3

from store_models import ClosingConnection


class StoreSchemaMixin:
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

    def _ensure_chat_exists(self, conn: sqlite3.Connection, user_id: str, chat_id: int) -> None:
        row = conn.execute(
            "SELECT id FROM chat_threads WHERE user_id = ? AND id = ?",
            (user_id, chat_id),
        ).fetchone()
        if not row:
            raise KeyError(f"Chat {chat_id} not found")
