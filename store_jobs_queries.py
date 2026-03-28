from __future__ import annotations

from sqlite3 import Connection
from typing import Any, Callable

from job_status import JOB_STATUS_DEAD, JOB_STATUS_QUEUED, JOB_STATUS_RUNNING, SQL_JOB_STATUS_OPEN

def has_open_job(conn: Connection, *, user_id: str, chat_id: int) -> bool:
    row = conn.execute(
        f"""
        SELECT 1 AS present
        FROM chat_jobs
        WHERE user_id = ? AND chat_id = ? AND status IN {SQL_JOB_STATUS_OPEN}
        ORDER BY id DESC
        LIMIT 1
        """,
        (user_id, chat_id),
    ).fetchone()
    return bool(row)


def get_open_job(conn: Connection, *, user_id: str, chat_id: int) -> dict[str, Any] | None:
    row = conn.execute(
        f"""
        SELECT id, user_id, chat_id, operator_message_id, status, attempts, max_attempts
        FROM chat_jobs
        WHERE user_id = ? AND chat_id = ? AND status IN {SQL_JOB_STATUS_OPEN}
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


def get_job_state(conn: Connection, *, job_id: int) -> dict[str, Any] | None:
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
        WHERE status = ?
          AND id < ?
          AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
        """,
        (JOB_STATUS_QUEUED, int(job_id)),
    ).fetchone()

    running_total = conn.execute("SELECT COUNT(*) AS c FROM chat_jobs WHERE status = ?", (JOB_STATUS_RUNNING,)).fetchone()

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


def list_jobs(conn: Connection, *, user_id: str, limit: int) -> list[dict[str, Any]]:
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


def list_dead_letters(conn: Connection, *, user_id: str, limit: int) -> list[dict[str, Any]]:
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


def cleanup_stale_jobs(
    conn: Connection,
    *,
    user_id: str,
    limit: int,
    insert_dead_letter_if_missing: Callable[..., None],
) -> list[dict[str, Any]]:
    """Dead-letter queued/running jobs whose chats/messages are no longer valid."""
    safe_limit = max(1, min(int(limit or 200), 1000))
    rows = conn.execute(
        f"""
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
          AND j.status IN {SQL_JOB_STATUS_OPEN}
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
            f"""
            UPDATE chat_jobs
            SET status = ?,
                error = ?,
                finished_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN {SQL_JOB_STATUS_OPEN}
            """,
            (JOB_STATUS_DEAD, reason, job_id),
        )
        if updated.rowcount == 0:
            continue

        insert_dead_letter_if_missing(
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
