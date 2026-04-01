from __future__ import annotations

from sqlite3 import Connection
from typing import Callable

from job_status import JOB_STATUS_DEAD, SQL_JOB_STATUS_OPEN

def cancel_open_jobs_for_chat(
    conn: Connection,
    *,
    user_id: str,
    chat_id: int,
    reason: str,
    insert_dead_letter_if_missing: Callable[..., None],
) -> None:
    cancelled_jobs = conn.execute(
        f"""
        SELECT id, operator_message_id, attempts, max_attempts
        FROM chat_jobs
        WHERE user_id = ? AND chat_id = ? AND status IN {SQL_JOB_STATUS_OPEN}
        """,
        (user_id, chat_id),
    ).fetchall()

    if not cancelled_jobs:
        return

    for row in cancelled_jobs:
        job_id = int(row["id"])
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
            operator_message_id=int(row["operator_message_id"]),
            attempts=int(row["attempts"] or 0),
            max_attempts=int(row["max_attempts"] or 1),
            error=reason,
        )


def clear_chat(
    conn: Connection,
    *,
    user_id: str,
    chat_id: int,
    cancel_open_jobs_for_chat_fn: Callable[[Connection], None],
) -> None:
    cancel_open_jobs_for_chat_fn(conn)
    conn.execute(
        "DELETE FROM chat_messages WHERE user_id = ? AND chat_id = ?",
        (user_id, chat_id),
    )
    conn.execute(
        "UPDATE chat_threads SET last_read_message_id = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?",
        (user_id, chat_id),
    )


def remove_chat(
    conn: Connection,
    *,
    user_id: str,
    chat_id: int,
    cancel_open_jobs_for_chat_fn: Callable[[Connection], None],
    get_or_create_main_chat_id_fn: Callable[[Connection, str], int],
    first_unarchived_chat_id_fn: Callable[[Connection, str], int | None] | None = None,
    allow_empty: bool = False,
) -> int | None:
    cancel_open_jobs_for_chat_fn(conn)
    conn.execute(
        "UPDATE chat_threads SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?",
        (user_id, chat_id),
    )
    if allow_empty and callable(first_unarchived_chat_id_fn):
        next_chat_id = first_unarchived_chat_id_fn(conn, user_id)
        if next_chat_id is None:
            return None
        return int(next_chat_id)
    return int(get_or_create_main_chat_id_fn(conn, user_id))
