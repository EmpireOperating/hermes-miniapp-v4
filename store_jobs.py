from __future__ import annotations

from sqlite3 import Connection
from typing import Any


class StoreJobsMixin:
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

    def _insert_dead_letter_if_missing(
        self,
        conn: Connection,
        *,
        job_id: int,
        user_id: str,
        chat_id: int,
        operator_message_id: int,
        attempts: int,
        max_attempts: int,
        error: str,
    ) -> None:
        conn.execute(
            """
            INSERT INTO chat_job_dead_letters (
                job_id, user_id, chat_id, operator_message_id, attempts, max_attempts, error
            )
            SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
                SELECT 1 FROM chat_job_dead_letters WHERE job_id = ?
            )
            """,
            (
                int(job_id),
                str(user_id),
                int(chat_id),
                int(operator_message_id),
                int(attempts),
                int(max_attempts),
                str(error)[:1000],
                int(job_id),
            ),
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

            updated = conn.execute(
                """
                UPDATE chat_jobs
                SET status = 'dead', error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status IN ('queued', 'running')
                """,
                (error_text, job_id),
            )
            if updated.rowcount > 0:
                self._insert_dead_letter_if_missing(
                    conn,
                    job_id=int(row["id"]),
                    user_id=str(row["user_id"]),
                    chat_id=int(row["chat_id"]),
                    operator_message_id=int(row["operator_message_id"]),
                    attempts=attempts,
                    max_attempts=max_attempts,
                    error=error_text,
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
                updated = conn.execute(
                    """
                    UPDATE chat_jobs
                    SET status = 'dead', error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status = 'running'
                    """,
                    (error_text, job_id),
                )
                if updated.rowcount == 0:
                    continue

                self._insert_dead_letter_if_missing(
                    conn,
                    job_id=job_id,
                    user_id=str(row["user_id"]),
                    chat_id=int(row["chat_id"]),
                    operator_message_id=int(row["operator_message_id"]),
                    attempts=int(row["attempts"] or 0),
                    max_attempts=int(row["max_attempts"] or 0),
                    error=error_text,
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
                    operator_message_id=operator_message_id,
                    attempts=attempts,
                    max_attempts=max_attempts,
                    error=reason,
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
