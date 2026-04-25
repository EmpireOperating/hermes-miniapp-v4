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
        self._startup_recovery_stats = self._default_startup_recovery_stats()
        with self._connect() as conn:
            self._ensure_core_chat_schema(conn)
            self._ensure_job_schema(conn)
            self._recover_startup_running_jobs(conn)
            self._ensure_chat_thread_schema(conn)
            self._ensure_user_preferences_schema(conn)
            self._ensure_telegram_notification_attempt_schema(conn)
            self._ensure_chat_job_schema(conn)
            self._ensure_runtime_checkpoint_schema(conn)
            self._ensure_auth_session_schema(conn)
            self._ensure_media_project_schema(conn)
            self._ensure_visual_dev_schema(conn)
            self._migrate_legacy_history(conn)

    def _default_startup_recovery_stats(self) -> dict[str, int]:
        return {
            "startup_recovered_running_total": 0,
            "startup_clamped_exhausted_total": 0,
        }

    def _ensure_core_chat_schema(self, conn: sqlite3.Connection) -> None:
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
            CREATE TABLE IF NOT EXISTS chat_message_attachments (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                chat_id INTEGER NOT NULL,
                message_id INTEGER,
                filename TEXT NOT NULL,
                content_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                storage_path TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'file',
                width INTEGER,
                height INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(chat_id) REFERENCES chat_threads(id) ON DELETE CASCADE,
                FOREIGN KEY(message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_user_chat_message ON chat_message_attachments(user_id, chat_id, message_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_pending ON chat_message_attachments(user_id, chat_id, message_id, created_at)"
        )

    def _ensure_job_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                chat_id INTEGER NOT NULL,
                operator_message_id INTEGER NOT NULL,
                visual_context TEXT,
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'error', 'dead')),
                attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
                max_attempts INTEGER NOT NULL DEFAULT 4 CHECK (max_attempts >= 1),
                next_attempt_at TEXT,
                error TEXT,
                child_pid INTEGER,
                child_transport TEXT,
                terminal_return_code INTEGER,
                terminal_failure_kind TEXT,
                terminal_outcome TEXT,
                terminal_error TEXT,
                limit_breach TEXT,
                limit_breach_detail TEXT,
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
                child_pid INTEGER,
                child_transport TEXT,
                terminal_return_code INTEGER,
                terminal_failure_kind TEXT,
                terminal_outcome TEXT,
                terminal_error TEXT,
                limit_breach TEXT,
                limit_breach_detail TEXT,
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
        dead_letter_columns = self._table_columns(conn, "chat_job_dead_letters")
        if "child_pid" not in dead_letter_columns:
            conn.execute("ALTER TABLE chat_job_dead_letters ADD COLUMN child_pid INTEGER")
        if "child_transport" not in dead_letter_columns:
            conn.execute("ALTER TABLE chat_job_dead_letters ADD COLUMN child_transport TEXT")
        if "terminal_return_code" not in dead_letter_columns:
            conn.execute("ALTER TABLE chat_job_dead_letters ADD COLUMN terminal_return_code INTEGER")
        if "terminal_failure_kind" not in dead_letter_columns:
            conn.execute("ALTER TABLE chat_job_dead_letters ADD COLUMN terminal_failure_kind TEXT")
        if "terminal_outcome" not in dead_letter_columns:
            conn.execute("ALTER TABLE chat_job_dead_letters ADD COLUMN terminal_outcome TEXT")
        if "terminal_error" not in dead_letter_columns:
            conn.execute("ALTER TABLE chat_job_dead_letters ADD COLUMN terminal_error TEXT")
        if "limit_breach" not in dead_letter_columns:
            conn.execute("ALTER TABLE chat_job_dead_letters ADD COLUMN limit_breach TEXT")
        if "limit_breach_detail" not in dead_letter_columns:
            conn.execute("ALTER TABLE chat_job_dead_letters ADD COLUMN limit_breach_detail TEXT")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_job_dead_letters_job_id ON chat_job_dead_letters(job_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_jobs_status_created ON chat_jobs(status, created_at, id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_jobs_user_chat_status ON chat_jobs(user_id, chat_id, status, id)"
        )

    def _recover_startup_running_jobs(self, conn: sqlite3.Connection) -> None:
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
        conn.execute(
            """
            INSERT INTO chat_job_dead_letters (
                job_id, user_id, chat_id, operator_message_id, attempts, max_attempts, error
            )
            SELECT id, user_id, chat_id, operator_message_id, attempts, max_attempts,
                   'interrupted_by_runtime_recovery'
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
                error = 'interrupted_by_runtime_recovery',
                finished_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE status = 'running'
            """
        )
        self._startup_recovery_stats = {
            "startup_recovered_running_total": running_total,
            "startup_clamped_exhausted_total": 0,
        }

    def _ensure_chat_thread_schema(self, conn: sqlite3.Connection) -> None:
        columns = self._table_columns(conn, "chat_threads")
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

    def _ensure_user_preferences_schema(self, conn: sqlite3.Connection) -> None:
        user_pref_columns = self._table_columns(conn, "user_preferences")
        if "active_chat_id" not in user_pref_columns:
            conn.execute("ALTER TABLE user_preferences ADD COLUMN active_chat_id INTEGER")
        if "telegram_unread_notifications_enabled" not in user_pref_columns:
            conn.execute(
                "ALTER TABLE user_preferences ADD COLUMN telegram_unread_notifications_enabled INTEGER NOT NULL DEFAULT 0"
            )

    def _ensure_telegram_notification_attempt_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS telegram_notification_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                chat_id INTEGER NOT NULL,
                unread_anchor_message_id INTEGER,
                prior_unread_count INTEGER NOT NULL DEFAULT 0,
                decision_reason TEXT NOT NULL,
                attempt_ok INTEGER NOT NULL DEFAULT 0,
                status_code INTEGER,
                error TEXT,
                response_text TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        columns = self._table_columns(conn, "telegram_notification_attempts")
        if "unread_anchor_message_id" not in columns:
            conn.execute("ALTER TABLE telegram_notification_attempts ADD COLUMN unread_anchor_message_id INTEGER")
        if "decision_reason" not in columns:
            conn.execute(
                "ALTER TABLE telegram_notification_attempts ADD COLUMN decision_reason TEXT NOT NULL DEFAULT 'unknown'"
            )
        if "attempt_ok" not in columns:
            conn.execute(
                "ALTER TABLE telegram_notification_attempts ADD COLUMN attempt_ok INTEGER NOT NULL DEFAULT 0"
            )
        if "status_code" not in columns:
            conn.execute("ALTER TABLE telegram_notification_attempts ADD COLUMN status_code INTEGER")
        if "error" not in columns:
            conn.execute("ALTER TABLE telegram_notification_attempts ADD COLUMN error TEXT")
        if "response_text" not in columns:
            conn.execute("ALTER TABLE telegram_notification_attempts ADD COLUMN response_text TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tg_notification_attempts_chat ON telegram_notification_attempts(user_id, chat_id, id DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tg_notification_attempts_anchor ON telegram_notification_attempts(user_id, chat_id, unread_anchor_message_id, attempt_ok, id DESC)"
        )

    def _ensure_chat_job_schema(self, conn: sqlite3.Connection) -> None:
        chat_job_columns = self._table_columns(conn, "chat_jobs")
        if "attempts" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
        if "max_attempts" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 4")
        if "next_attempt_at" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN next_attempt_at TEXT")
        if "visual_context" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN visual_context TEXT")
        if "child_pid" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN child_pid INTEGER")
        if "child_transport" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN child_transport TEXT")
        if "terminal_return_code" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN terminal_return_code INTEGER")
        if "terminal_failure_kind" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN terminal_failure_kind TEXT")
        if "terminal_outcome" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN terminal_outcome TEXT")
        if "terminal_error" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN terminal_error TEXT")
        if "limit_breach" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN limit_breach TEXT")
        if "limit_breach_detail" not in chat_job_columns:
            conn.execute("ALTER TABLE chat_jobs ADD COLUMN limit_breach_detail TEXT")

        self._migrate_chat_jobs_invariants(conn)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_jobs_next_attempt ON chat_jobs(status, next_attempt_at, id)"
        )

    def _ensure_runtime_checkpoint_schema(self, conn: sqlite3.Connection) -> None:
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

    def _ensure_auth_session_schema(self, conn: sqlite3.Connection) -> None:
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
        auth_session_columns = self._table_columns(conn, "auth_sessions")
        if "display_name" not in auth_session_columns:
            conn.execute("ALTER TABLE auth_sessions ADD COLUMN display_name TEXT")
        if "username" not in auth_session_columns:
            conn.execute("ALTER TABLE auth_sessions ADD COLUMN username TEXT")

    def _ensure_media_project_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS media_projects (
                project_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                chat_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                aspect_ratio TEXT NOT NULL DEFAULT '9:16',
                resolution_json TEXT NOT NULL DEFAULT '{}',
                fps INTEGER NOT NULL DEFAULT 30,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'draft',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS media_project_tracks (
                track_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                label TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(project_id) REFERENCES media_projects(project_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS media_project_assets (
                asset_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                storage_path TEXT NOT NULL DEFAULT '',
                content_type TEXT NOT NULL DEFAULT '',
                label TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(project_id) REFERENCES media_projects(project_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS media_project_clips (
                clip_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                track_id TEXT NOT NULL,
                asset_id TEXT,
                kind TEXT NOT NULL DEFAULT 'asset',
                start_ms INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                source_in_ms INTEGER NOT NULL DEFAULT 0,
                source_out_ms INTEGER NOT NULL DEFAULT 0,
                z_index INTEGER NOT NULL DEFAULT 0,
                params_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(project_id) REFERENCES media_projects(project_id) ON DELETE CASCADE,
                FOREIGN KEY(track_id) REFERENCES media_project_tracks(track_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS media_project_operations (
                operation_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                batch_id TEXT,
                author TEXT NOT NULL DEFAULT 'user',
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'applied',
                before_state_json TEXT NOT NULL DEFAULT '{}',
                after_state_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(project_id) REFERENCES media_projects(project_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS media_project_suggestion_batches (
                batch_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                author TEXT NOT NULL DEFAULT 'hermes',
                status TEXT NOT NULL DEFAULT 'pending',
                summary TEXT NOT NULL DEFAULT '',
                operations_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(project_id) REFERENCES media_projects(project_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS media_project_export_jobs (
                export_job_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                output_path TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(project_id) REFERENCES media_projects(project_id) ON DELETE CASCADE
            )
            """
        )
        media_project_column_defaults = {
            "media_projects": {
                "title": "TEXT NOT NULL DEFAULT ''",
                "aspect_ratio": "TEXT NOT NULL DEFAULT '9:16'",
                "resolution_json": "TEXT NOT NULL DEFAULT '{}'",
                "fps": "INTEGER NOT NULL DEFAULT 30",
                "duration_ms": "INTEGER NOT NULL DEFAULT 0",
                "status": "TEXT NOT NULL DEFAULT 'draft'",
                "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
                "created_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
                "updated_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
            },
            "media_project_tracks": {
                "kind": "TEXT NOT NULL DEFAULT ''",
                "position": "INTEGER NOT NULL DEFAULT 0",
                "label": "TEXT NOT NULL DEFAULT ''",
                "created_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
                "updated_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
            },
            "media_project_assets": {
                "kind": "TEXT NOT NULL DEFAULT ''",
                "storage_path": "TEXT NOT NULL DEFAULT ''",
                "content_type": "TEXT NOT NULL DEFAULT ''",
                "label": "TEXT NOT NULL DEFAULT ''",
                "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
                "created_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
                "updated_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
            },
            "media_project_clips": {
                "asset_id": "TEXT",
                "kind": "TEXT NOT NULL DEFAULT 'asset'",
                "start_ms": "INTEGER NOT NULL DEFAULT 0",
                "duration_ms": "INTEGER NOT NULL DEFAULT 0",
                "source_in_ms": "INTEGER NOT NULL DEFAULT 0",
                "source_out_ms": "INTEGER NOT NULL DEFAULT 0",
                "z_index": "INTEGER NOT NULL DEFAULT 0",
                "params_json": "TEXT NOT NULL DEFAULT '{}'",
                "created_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
                "updated_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
            },
            "media_project_operations": {
                "batch_id": "TEXT",
                "author": "TEXT NOT NULL DEFAULT 'user'",
                "kind": "TEXT NOT NULL DEFAULT ''",
                "payload_json": "TEXT NOT NULL DEFAULT '{}'",
                "status": "TEXT NOT NULL DEFAULT 'applied'",
                "before_state_json": "TEXT NOT NULL DEFAULT '{}'",
                "after_state_json": "TEXT NOT NULL DEFAULT '{}'",
                "created_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
            },
            "media_project_suggestion_batches": {
                "author": "TEXT NOT NULL DEFAULT 'hermes'",
                "status": "TEXT NOT NULL DEFAULT 'pending'",
                "summary": "TEXT NOT NULL DEFAULT ''",
                "operations_json": "TEXT NOT NULL DEFAULT '[]'",
                "created_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
                "updated_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
            },
            "media_project_export_jobs": {
                "status": "TEXT NOT NULL DEFAULT 'queued'",
                "output_path": "TEXT NOT NULL DEFAULT ''",
                "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
                "created_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
                "updated_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
            },
        }
        for table_name, default_columns in media_project_column_defaults.items():
            existing_columns = self._table_columns(conn, table_name)
            for column_name, column_spec in default_columns.items():
                if column_name not in existing_columns:
                    conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_spec}")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS media_project_suggestion_batches (
                batch_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                author TEXT NOT NULL DEFAULT 'hermes',
                status TEXT NOT NULL DEFAULT 'pending',
                summary TEXT NOT NULL DEFAULT '',
                operations_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(project_id) REFERENCES media_projects(project_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS media_project_export_jobs (
                export_job_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                output_path TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(project_id) REFERENCES media_projects(project_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_media_projects_user_chat ON media_projects(user_id, chat_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_media_project_tracks_project_position ON media_project_tracks(project_id, position, track_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_media_project_assets_project_created ON media_project_assets(project_id, created_at DESC, asset_id DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_media_project_clips_project_start ON media_project_clips(project_id, start_ms, clip_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_media_project_operations_project_created ON media_project_operations(project_id, created_at DESC, operation_id DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_media_project_suggestion_batches_project_created ON media_project_suggestion_batches(project_id, created_at DESC, batch_id DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_media_project_export_jobs_project_created ON media_project_export_jobs(project_id, created_at DESC, export_job_id DESC)"
        )


    def _ensure_visual_dev_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS visual_dev_sessions (
                session_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                chat_id INTEGER NOT NULL,
                preview_url TEXT NOT NULL,
                preview_origin TEXT NOT NULL,
                preview_title TEXT NOT NULL DEFAULT '',
                bridge_parent_origin TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'attached',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                detached_at TEXT,
                FOREIGN KEY(chat_id) REFERENCES chat_threads(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS visual_dev_selections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                selection_type TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(session_id) REFERENCES visual_dev_sessions(session_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS visual_dev_artifacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                artifact_kind TEXT NOT NULL,
                storage_path TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT '',
                byte_size INTEGER NOT NULL DEFAULT 0,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(session_id) REFERENCES visual_dev_sessions(session_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS visual_dev_console_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                level TEXT NOT NULL,
                message TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(session_id) REFERENCES visual_dev_sessions(session_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_visual_dev_sessions_user_chat_active ON visual_dev_sessions(user_id, chat_id, detached_at, updated_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_visual_dev_selections_session_id ON visual_dev_selections(session_id, id DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_visual_dev_artifacts_session_id ON visual_dev_artifacts(session_id, id DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_visual_dev_console_events_session_id ON visual_dev_console_events(session_id, id DESC)"
        )

    def _table_columns(self, conn: sqlite3.Connection, table_name: str) -> set[str]:
        return {
            str(row["name"])
            for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        }

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
                visual_context TEXT,
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'error', 'dead')),
                attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
                max_attempts INTEGER NOT NULL DEFAULT 4 CHECK (max_attempts >= 1),
                next_attempt_at TEXT,
                error TEXT,
                child_pid INTEGER,
                child_transport TEXT,
                terminal_return_code INTEGER,
                terminal_failure_kind TEXT,
                terminal_outcome TEXT,
                terminal_error TEXT,
                limit_breach TEXT,
                limit_breach_detail TEXT,
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
                visual_context,
                status,
                attempts,
                max_attempts,
                next_attempt_at,
                error,
                child_pid,
                child_transport,
                terminal_return_code,
                terminal_failure_kind,
                terminal_outcome,
                terminal_error,
                limit_breach,
                limit_breach_detail,
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
                visual_context,
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
                child_pid,
                child_transport,
                terminal_return_code,
                terminal_failure_kind,
                terminal_outcome,
                terminal_error,
                limit_breach,
                limit_breach_detail,
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

    def _ensure_visual_dev_session_exists(self, conn: sqlite3.Connection, session_id: str) -> None:
        row = conn.execute(
            "SELECT session_id FROM visual_dev_sessions WHERE session_id = ? LIMIT 1",
            (session_id,),
        ).fetchone()
        if not row:
            raise KeyError(f"Visual dev session {session_id} not found")

    def startup_recovery_stats(self) -> dict[str, int]:
        stats = getattr(self, "_startup_recovery_stats", None)
        if not isinstance(stats, dict):
            return self._default_startup_recovery_stats()
        return {
            "startup_recovered_running_total": int(stats.get("startup_recovered_running_total", 0) or 0),
            "startup_clamped_exhausted_total": int(stats.get("startup_clamped_exhausted_total", 0) or 0),
        }
