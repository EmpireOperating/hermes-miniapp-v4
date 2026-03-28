from __future__ import annotations

from sqlite3 import Connection
from typing import Any, Callable

from job_status import JOB_STATUS_DEAD, JOB_STATUS_QUEUED, JOB_STATUS_RUNNING, SQL_JOB_STATUS_OPEN

def retry_or_dead_letter_job(
    conn: Connection,
    *,
    job_id: int,
    error: str,
    retry_base_seconds: int,
    insert_dead_letter_if_missing: Callable[..., None],
) -> bool:
    """Returns True if retry scheduled, False if moved to dead-letter."""
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
        scheduled = conn.execute(
            """
            UPDATE chat_jobs
            SET status = ?,
                error = ?,
                next_attempt_at = datetime('now', ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND status = ?
              AND COALESCE(attempts, 0) < CASE WHEN COALESCE(max_attempts, 0) > 0 THEN COALESCE(max_attempts, 0) ELSE 1 END
            """,
            (JOB_STATUS_QUEUED, error_text, f"+{delay_seconds} seconds", job_id, JOB_STATUS_RUNNING),
        )
        if scheduled.rowcount > 0:
            return True

    updated = conn.execute(
        f"""
        UPDATE chat_jobs
        SET status = ?, error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN {SQL_JOB_STATUS_OPEN}
        """,
        (JOB_STATUS_DEAD, error_text, job_id),
    )
    if updated.rowcount > 0:
        insert_dead_letter_if_missing(
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


def dead_letter_stale_running_jobs(
    conn: Connection,
    *,
    timeout_seconds: int,
    error: str,
    insert_dead_letter_if_missing: Callable[..., None],
) -> list[dict[str, Any]]:
    timeout = max(30, int(timeout_seconds or 0))
    error_text = str(error or "Job timed out")[:1000]
    stale_rows = conn.execute(
        """
        SELECT id, user_id, chat_id, operator_message_id, attempts, max_attempts
        FROM chat_jobs
        WHERE status = ?
          AND updated_at <= datetime('now', ?)
        """,
        (JOB_STATUS_RUNNING, f"-{timeout} seconds"),
    ).fetchall()

    results: list[dict[str, Any]] = []
    for row in stale_rows:
        job_id = int(row["id"])
        updated = conn.execute(
            """
            UPDATE chat_jobs
            SET status = ?, error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = ?
            """,
            (JOB_STATUS_DEAD, error_text, job_id, JOB_STATUS_RUNNING),
        )
        if updated.rowcount == 0:
            continue

        insert_dead_letter_if_missing(
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
