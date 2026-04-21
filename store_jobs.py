from __future__ import annotations

import sqlite3
from sqlite3 import Connection
import threading
import time
from typing import Any

FailureMetadata = dict[str, Any]

from job_status import (
    JOB_STATUS_DONE,
    JOB_STATUS_ERROR,
    JOB_STATUS_QUEUED,
    JOB_STATUS_RUNNING,
)
from store_chat_mutations import cancel_open_jobs_for_chat
from store_jobs_claim import claim_next_job, dead_letter_exhausted_queued_jobs
from store_jobs_queries import cleanup_stale_jobs, get_job_state, get_open_job, has_open_job, list_dead_letters, list_jobs
from store_jobs_retry import dead_letter_stale_open_job_for_chat, dead_letter_stale_running_jobs, retry_or_dead_letter_job
from store_models import MAX_OPERATOR_MESSAGE_LEN


class StoreJobsMixin:
    def enqueue_chat_job(self, user_id: str, chat_id: int, operator_message_id: int, max_attempts: int = 4) -> int:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            cursor = conn.execute(
                """
                INSERT INTO chat_jobs (user_id, chat_id, operator_message_id, status, attempts, max_attempts, next_attempt_at, updated_at)
                VALUES (?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (user_id, chat_id, operator_message_id, JOB_STATUS_QUEUED, max(1, int(max_attempts))),
            )
            return int(cursor.lastrowid)

    def has_open_job(self, user_id: str, chat_id: int) -> bool:
        with self._connect() as conn:
            return has_open_job(conn, user_id=user_id, chat_id=chat_id)

    def get_open_job(self, user_id: str, chat_id: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            return get_open_job(conn, user_id=user_id, chat_id=chat_id)

    def interrupt_open_jobs_for_chat(self, user_id: str, chat_id: int, *, reason: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            interrupted = []
            open_job = get_open_job(conn, user_id=user_id, chat_id=chat_id)
            if open_job:
                interrupted.append(dict(open_job))
            cancel_open_jobs_for_chat(
                conn,
                user_id=user_id,
                chat_id=chat_id,
                reason=str(reason or "interrupted_by_new_message"),
                insert_dead_letter_if_missing=self._insert_dead_letter_if_missing,
            )
            return interrupted

    def _queue_diag_lock(self) -> threading.Lock:
        lock = getattr(self, "_job_queue_diag_lock", None)
        if lock is not None and hasattr(lock, "acquire") and hasattr(lock, "release"):
            return lock
        new_lock = threading.Lock()
        self._job_queue_diag_lock = new_lock
        return new_lock

    def _claim_lock(self) -> threading.Lock:
        lock = getattr(self, "_job_claim_lock", None)
        if lock is not None and hasattr(lock, "acquire") and hasattr(lock, "release"):
            return lock
        new_lock = threading.Lock()
        self._job_claim_lock = new_lock
        return new_lock

    def _enqueue_lock(self) -> threading.Lock:
        lock = getattr(self, "_job_enqueue_lock", None)
        if lock is not None and hasattr(lock, "acquire") and hasattr(lock, "release"):
            return lock
        new_lock = threading.Lock()
        self._job_enqueue_lock = new_lock
        return new_lock

    def start_chat_job(self, *, user_id: str, chat_id: int, message: str, max_attempts: int = 4) -> dict[str, Any]:
        cleaned_message = str(message or "").strip()
        if not cleaned_message:
            raise ValueError("Message body cannot be empty")
        if len(cleaned_message) > MAX_OPERATOR_MESSAGE_LEN:
            raise ValueError(f"Message body exceeds {MAX_OPERATOR_MESSAGE_LEN} characters")

        lock_error_text = "database is locked"
        retry_attempts = 3
        for attempt in range(1, retry_attempts + 1):
            try:
                with self._connect() as conn:
                    conn.execute("BEGIN IMMEDIATE")
                    open_job = get_open_job(conn, user_id=user_id, chat_id=chat_id)
                    if open_job:
                        return {
                            "created": False,
                            "job_id": int(open_job["id"]),
                            "operator_message_id": int(open_job["operator_message_id"]),
                            "open_job": dict(open_job),
                        }

                    self._ensure_chat_exists(conn, user_id, chat_id)
                    message_cursor = conn.execute(
                        "INSERT INTO chat_messages (user_id, chat_id, role, body) VALUES (?, ?, ?, ?)",
                        (user_id, chat_id, "operator", cleaned_message),
                    )
                    conn.execute(
                        "UPDATE chat_threads SET updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?",
                        (user_id, chat_id),
                    )
                    operator_message_id = int(message_cursor.lastrowid)
                    job_cursor = conn.execute(
                        """
                        INSERT INTO chat_jobs (
                            user_id,
                            chat_id,
                            operator_message_id,
                            status,
                            attempts,
                            max_attempts,
                            next_attempt_at,
                            updated_at
                        )
                        VALUES (?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        """,
                        (user_id, chat_id, operator_message_id, JOB_STATUS_QUEUED, max(1, int(max_attempts))),
                    )
                    return {
                        "created": True,
                        "job_id": int(job_cursor.lastrowid),
                        "operator_message_id": operator_message_id,
                        "open_job": None,
                    }
            except sqlite3.OperationalError as exc:
                if lock_error_text not in str(exc).lower():
                    raise
                if attempt >= retry_attempts:
                    raise
                time.sleep(0.05 * attempt)
        raise RuntimeError("start_chat_job failed after retries")

    def _record_preclaim_dead_letter_total(self, delta: int) -> None:
        increment = max(0, int(delta or 0))
        if increment <= 0:
            return
        with self._queue_diag_lock():
            current = int(getattr(self, "_preclaim_dead_letter_total", 0) or 0)
            self._preclaim_dead_letter_total = current + increment

    def job_queue_diagnostics(self) -> dict[str, int]:
        with self._queue_diag_lock():
            preclaim_dead_letter_total = int(getattr(self, "_preclaim_dead_letter_total", 0) or 0)
        startup = self.startup_recovery_stats() if hasattr(self, "startup_recovery_stats") else {}
        return {
            "startup_recovered_running_total": int(startup.get("startup_recovered_running_total", 0) or 0),
            "startup_clamped_exhausted_total": int(startup.get("startup_clamped_exhausted_total", 0) or 0),
            "preclaim_dead_letter_total": preclaim_dead_letter_total,
        }

    def claim_next_job(self) -> dict[str, Any] | None:
        lock_error_text = "database is locked"
        max_attempts = 3
        with self._claim_lock():
            for attempt in range(1, max_attempts + 1):
                try:
                    with self._connect() as conn:
                        conn.execute("BEGIN IMMEDIATE")
                        preclaim_dead_lettered = dead_letter_exhausted_queued_jobs(
                            conn,
                            insert_dead_letter_if_missing=self._insert_dead_letter_if_missing,
                        )
                        self._record_preclaim_dead_letter_total(preclaim_dead_lettered)
                        return claim_next_job(conn)
                except sqlite3.OperationalError as exc:
                    if lock_error_text not in str(exc).lower():
                        raise
                    if attempt >= max_attempts:
                        raise
                    time.sleep(0.05 * attempt)
        return None

    def complete_job(self, job_id: int) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE chat_jobs
                SET status = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = ?
                """,
                (JOB_STATUS_DONE, job_id, JOB_STATUS_RUNNING),
            )

    def touch_job(self, job_id: int) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE chat_jobs
                SET updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = ?
                """,
                (int(job_id), JOB_STATUS_RUNNING),
            )

    def fail_job(self, job_id: int, error: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE chat_jobs
                SET status = ?, error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (JOB_STATUS_ERROR, error[:1000], job_id),
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
        failure_metadata: FailureMetadata | None = None,
    ) -> None:
        failure_metadata = dict(failure_metadata or {})
        conn.execute(
            """
            INSERT INTO chat_job_dead_letters (
                job_id, user_id, chat_id, operator_message_id, attempts, max_attempts, error,
                child_pid, child_transport, terminal_return_code, terminal_failure_kind,
                terminal_outcome, terminal_error, limit_breach, limit_breach_detail
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_id) DO UPDATE SET
                error = excluded.error,
                child_pid = excluded.child_pid,
                child_transport = excluded.child_transport,
                terminal_return_code = excluded.terminal_return_code,
                terminal_failure_kind = excluded.terminal_failure_kind,
                terminal_outcome = excluded.terminal_outcome,
                terminal_error = excluded.terminal_error,
                limit_breach = excluded.limit_breach,
                limit_breach_detail = excluded.limit_breach_detail
            """,
            (
                int(job_id),
                str(user_id),
                int(chat_id),
                int(operator_message_id),
                int(attempts),
                int(max_attempts),
                str(error)[:1000],
                failure_metadata.get("child_pid"),
                failure_metadata.get("child_transport"),
                failure_metadata.get("terminal_return_code"),
                failure_metadata.get("terminal_failure_kind"),
                failure_metadata.get("terminal_outcome"),
                failure_metadata.get("terminal_error"),
                failure_metadata.get("limit_breach"),
                failure_metadata.get("limit_breach_detail"),
            ),
        )

    def retry_or_dead_letter_job(
        self,
        job_id: int,
        error: str,
        retry_base_seconds: int = 2,
        *,
        failure_metadata: FailureMetadata | None = None,
    ) -> bool:
        with self._connect() as conn:
            return retry_or_dead_letter_job(
                conn,
                job_id=job_id,
                error=error,
                retry_base_seconds=retry_base_seconds,
                insert_dead_letter_if_missing=self._insert_dead_letter_if_missing,
                failure_metadata=failure_metadata,
            )

    def dead_letter_stale_running_jobs(self, timeout_seconds: int, error: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            return dead_letter_stale_running_jobs(
                conn,
                timeout_seconds=timeout_seconds,
                error=error,
                insert_dead_letter_if_missing=self._insert_dead_letter_if_missing,
            )

    def dead_letter_stale_open_job_for_chat(
        self,
        *,
        user_id: str,
        chat_id: int,
        timeout_seconds: int,
        error: str,
    ) -> dict[str, Any] | None:
        with self._connect() as conn:
            return dead_letter_stale_open_job_for_chat(
                conn,
                user_id=user_id,
                chat_id=chat_id,
                timeout_seconds=timeout_seconds,
                error=error,
                insert_dead_letter_if_missing=self._insert_dead_letter_if_missing,
            )

    def get_job_state(self, job_id: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            return get_job_state(conn, job_id=job_id)

    def list_jobs(self, user_id: str, limit: int = 25) -> list[dict[str, Any]]:
        with self._connect() as conn:
            return list_jobs(conn, user_id=user_id, limit=limit)

    def list_dead_letters(self, user_id: str, limit: int = 25) -> list[dict[str, Any]]:
        with self._connect() as conn:
            return list_dead_letters(conn, user_id=user_id, limit=limit)

    def cleanup_stale_jobs(self, user_id: str, limit: int = 200) -> list[dict[str, Any]]:
        with self._connect() as conn:
            return cleanup_stale_jobs(
                conn,
                user_id=user_id,
                limit=limit,
                insert_dead_letter_if_missing=self._insert_dead_letter_if_missing,
            )
