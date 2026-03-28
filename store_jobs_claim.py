from __future__ import annotations

from sqlite3 import Connection
from typing import Any

from job_status import JOB_STATUS_DEAD, JOB_STATUS_QUEUED, JOB_STATUS_RUNNING

def dead_letter_exhausted_queued_jobs(
    conn: Connection,
    *,
    insert_dead_letter_if_missing: Callable[..., None],
) -> int:
    exhausted_rows = conn.execute(
        """
        SELECT id, user_id, chat_id, operator_message_id, attempts, max_attempts
        FROM chat_jobs
        WHERE status = ?
          AND COALESCE(attempts, 0) >= CASE WHEN COALESCE(max_attempts, 0) > 0 THEN COALESCE(max_attempts, 0) ELSE 1 END
        """,
        (JOB_STATUS_QUEUED,),
    ).fetchall()
    if not exhausted_rows:
        return 0

    reason = "Retry limit reached before claim"
    dead_lettered_count = 0
    for row in exhausted_rows:
        job_id = int(row["id"])
        updated = conn.execute(
            """
            UPDATE chat_jobs
            SET status = ?, error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND status = ?
              AND COALESCE(attempts, 0) >= CASE WHEN COALESCE(max_attempts, 0) > 0 THEN COALESCE(max_attempts, 0) ELSE 1 END
            """,
            (JOB_STATUS_DEAD, reason, job_id, JOB_STATUS_QUEUED),
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
            max_attempts=max(1, int(row["max_attempts"] or 1)),
            error=reason,
        )
        dead_lettered_count += 1

    return dead_lettered_count


def claim_next_job(conn: Connection) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT q.id, q.user_id, q.chat_id, q.operator_message_id
        FROM chat_jobs AS q
        JOIN chat_threads AS ct
          ON ct.user_id = q.user_id
         AND ct.id = q.chat_id
         AND ct.is_archived = 0
        WHERE q.status = ?
          AND COALESCE(q.attempts, 0) < CASE WHEN COALESCE(q.max_attempts, 0) > 0 THEN COALESCE(q.max_attempts, 0) ELSE 1 END
          AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= CURRENT_TIMESTAMP)
          AND NOT EXISTS (
              SELECT 1
              FROM chat_jobs AS r
              WHERE r.user_id = q.user_id
                AND r.chat_id = q.chat_id
                AND r.status = ?
          )
        ORDER BY q.id ASC
        LIMIT 1
        """,
        (JOB_STATUS_QUEUED, JOB_STATUS_RUNNING),
    ).fetchone()
    if not row:
        return None
    updated = conn.execute(
        """
        UPDATE chat_jobs
        SET status = ?, attempts = attempts + 1, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status = ?
          AND COALESCE(attempts, 0) < CASE WHEN COALESCE(max_attempts, 0) > 0 THEN COALESCE(max_attempts, 0) ELSE 1 END
        """,
        (JOB_STATUS_RUNNING, int(row["id"]), JOB_STATUS_QUEUED),
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
