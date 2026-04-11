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
        self._startup_recovery_stats = {
            "startup_recovered_running_total": 0,
            "startup_clamped_exhausted_total": 0,
        }
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_preferences (
                    user_id TEXT PRIMARY KEY,
                    skin TEXT NOT NULL DEFAULT 'terminal',
                    active_chat_id INTEGER,
                    telegram_unread_notifications_enabled INTEGER NOT NULL DEFAULT 0,
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
                    parent_chat_id INTEGER,
                    is_archived INTEGER NOT NULL DEFAULT 0,
                    is_pinned INTEGER NOT NULL DEFAULT 0,
                    last_read_message_id INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(parent_chat_id) REFERENCES chat_threads(id) ON DELETE SET NULL
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
                "CREATE INDEX IF NOT EXISTS idx_chat_messages_user_chat_role ON chat_messages(user_id, chat_id, role, id)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    chat_id INTEGER NOT NULL,
                    operator_message_id INTEGER NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'error', 'dead')),
                    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
                    max_attempts INTEGER NOT NULL DEFAULT 4 CHECK (max_attempts >= 1),
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
                """
                DELETE FROM chat_job_dead_letters
                WHERE id NOT IN (
                    SELECT MIN(id)
                    FROM chat_job_dead_letters
                    GROUP BY job_id
                )
                """
            )
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_job_dead_letters_job_id ON chat_job_dead_letters(job_id)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_jobs_status_created ON chat_jobs(status, created_at, id)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_jobs_user_chat_status ON chat_jobs(user_id, chat_id, status, id)"
            )
            # Crash-recovery for orphaned running jobs. Do not silently requeue them on
            # process restart: that can resurrect wedged mid-stream work into endless
            # resume loops with stale pending state. Instead, mark them dead once and let
            # the user explicitly retry from the thread.
            running_recovery_row = conn.execute(
                """
                SELECT COUNT(*) AS running_total
                FROM chat_jobs
                WHERE status = 'running'
                """
            ).fetchone()
            running_total = int((running_recovery_row["running_total"] if running_recovery_row else 0) or 0)
            clamped_total = 0
            conn.execute(
                """
                INSERT INTO chat_job_dead_letters (
                    job_id, user_id, chat_id, operator_message_id, attempts, max_attempts, error
                )
                SELECT id, user_id, chat_id, operator_message_id, attempts, max_attempts,
                       'interrupted_by_service_restart'
                FROM chat_jobs
                WHERE status = 'running'
                  AND NOT EXISTS (
                      SELECT 1 FROM chat_job_dead_letters dl WHERE dl.job_id = chat_jobs.id
                  )
                """
            )
            conn.execute(
                """
                UPDATE chat_jobs
                SET status = 'dead',
                    error = 'interrupted_by_service_restart',
                    finished_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE status = 'running'
                """
            )
            self._startup_recovery_stats = {
                "startup_recovered_running_total": running_total,
                "startup_clamped_exhausted_total": clamped_total,
            }
            columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(chat_threads)").fetchall()
            }
            if "is_archived" not in columns:
                conn.execute(
                    "ALTER TABLE chat_threads ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0"
                )
            if "is_pinned" not in columns:
                conn.execute(
                    "ALTER TABLE chat_threads ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0"
                )
            if "parent_chat_id" not in columns:
                conn.execute("ALTER TABLE chat_threads ADD COLUMN parent_chat_id INTEGER")

            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_threads_user_flags ON chat_threads(user_id, is_archived, is_pinned, id)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_threads_parent ON chat_threads(user_id, parent_chat_id, id)"
            )

            user_pref_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(user_preferences)").fetchall()
            }
            if "active_chat_id" not in user_pref_columns:
                conn.execute("ALTER TABLE user_preferences ADD COLUMN active_chat_id INTEGER")
            if "telegram_unread_notifications_enabled" not in user_pref_columns:
                conn.execute(
                    "ALTER TABLE user_preferences ADD COLUMN telegram_unread_notifications_enabled INTEGER NOT NULL DEFAULT 0"
                )

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

            self._migrate_chat_jobs_invariants(conn)

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
                    display_name TEXT,
                    username TEXT,
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
            auth_session_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(auth_sessions)").fetchall()
            }
            if "display_name" not in auth_session_columns:
                conn.execute("ALTER TABLE auth_sessions ADD COLUMN display_name TEXT")
            if "username" not in auth_session_columns:
                conn.execute("ALTER TABLE auth_sessions ADD COLUMN username TEXT")

            self._migrate_legacy_history(conn)

    def _migrate_chat_jobs_invariants(self, conn: sqlite3.Connection) -> None:
        table_sql_row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_jobs'"
        ).fetchone()
        table_sql = str(table_sql_row["sql"] or "") if table_sql_row else ""

        conn.execute(
            """
            UPDATE chat_jobs
            SET status = CASE
                WHEN status IN ('queued', 'running', 'done', 'error', 'dead') THEN status
                ELSE 'dead'
            END,
            attempts = CASE
                WHEN attempts IS NULL OR attempts < 0 THEN 0
                ELSE attempts
            END,
            max_attempts = CASE
                WHEN max_attempts IS NULL OR max_attempts < 1 THEN 1
                ELSE max_attempts
            END,
            updated_at = CURRENT_TIMESTAMP
            WHERE status NOT IN ('queued', 'running', 'done', 'error', 'dead')
               OR attempts IS NULL
               OR attempts < 0
               OR max_attempts IS NULL
               OR max_attempts < 1
            """
        )

        has_status_check = "CHECK (status IN ('queued', 'running', 'done', 'error', 'dead'))" in table_sql
        has_attempts_check = "CHECK (attempts >= 0)" in table_sql
        has_max_attempts_check = "CHECK (max_attempts >= 1)" in table_sql
        if has_status_check and has_attempts_check and has_max_attempts_check:
            return

        conn.execute("ALTER TABLE chat_jobs RENAME TO chat_jobs__legacy_invariants")
        conn.execute(
            """
            CREATE TABLE chat_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                chat_id INTEGER NOT NULL,
                operator_message_id INTEGER NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'error', 'dead')),
                attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
                max_attempts INTEGER NOT NULL DEFAULT 4 CHECK (max_attempts >= 1),
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
            INSERT INTO chat_jobs (
                id,
                user_id,
                chat_id,
                operator_message_id,
                status,
                attempts,
                max_attempts,
                next_attempt_at,
                error,
                created_at,
                started_at,
                finished_at,
                updated_at
            )
            SELECT
                id,
                user_id,
                chat_id,
                operator_message_id,
                CASE
                    WHEN status IN ('queued', 'running', 'done', 'error', 'dead') THEN status
                    ELSE 'dead'
                END,
                CASE
                    WHEN attempts IS NULL OR attempts < 0 THEN 0
                    ELSE attempts
                END,
                CASE
                    WHEN max_attempts IS NULL OR max_attempts < 1 THEN 1
                    ELSE max_attempts
                END,
                next_attempt_at,
                error,
                created_at,
                started_at,
                finished_at,
                updated_at
            FROM chat_jobs__legacy_invariants
            ORDER BY id ASC
            """
        )
        conn.execute("DROP TABLE chat_jobs__legacy_invariants")

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_jobs_status_created ON chat_jobs(status, created_at, id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_jobs_user_chat_status ON chat_jobs(user_id, chat_id, status, id)"
        )

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

    def startup_recovery_stats(self) -> dict[str, int]:
        stats = getattr(self, "_startup_recovery_stats", None)
        if not isinstance(stats, dict):
            return {
                "startup_recovered_running_total": 0,
                "startup_clamped_exhausted_total": 0,
            }
        return {
            "startup_recovered_running_total": int(stats.get("startup_recovered_running_total", 0) or 0),
            "startup_clamped_exhausted_total": int(stats.get("startup_clamped_exhausted_total", 0) or 0),
        }
