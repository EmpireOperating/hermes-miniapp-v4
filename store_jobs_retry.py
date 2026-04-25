from __future__ import annotations

from sqlite3 import Connection
from typing import Any, Callable

FailureMetadata = dict[str, Any]

from job_status import JOB_STATUS_DEAD, JOB_STATUS_QUEUED, JOB_STATUS_RUNNING, SQL_JOB_STATUS_OPEN

def _sanitize_failure_metadata(failure_metadata: FailureMetadata | None) -> FailureMetadata:
    metadata = dict(failure_metadata or {})

    def _safe_int(value: object) -> int | None:
        try:
            if value is None or value == "":
                return None
            return int(value)
        except (TypeError, ValueError):
            return None

    def _safe_text(value: object, *, limit: int = 1000) -> str | None:
        text = str(value or "").strip()
        if not text:
            return None
        return text[:limit]

    return {
        "child_pid": _safe_int(metadata.get("child_pid")),
        "child_transport": _safe_text(metadata.get("child_transport"), limit=120),
        "terminal_return_code": _safe_int(metadata.get("terminal_return_code")),
        "terminal_failure_kind": _safe_text(metadata.get("terminal_failure_kind"), limit=120),
        "terminal_outcome": _safe_text(metadata.get("terminal_outcome"), limit=120),
        "terminal_error": _safe_text(metadata.get("terminal_error"), limit=1000),
        "limit_breach": _safe_text(metadata.get("limit_breach"), limit=120),
        "limit_breach_detail": _safe_text(metadata.get("limit_breach_detail"), limit=120),
    }


def _row_failure_metadata(row: Any) -> FailureMetadata:
    return _sanitize_failure_metadata(
        {
            "child_pid": row["child_pid"] if row is not None else None,
            "child_transport": row["child_transport"] if row is not None else None,
            "terminal_return_code": row["terminal_return_code"] if row is not None else None,
            "terminal_failure_kind": row["terminal_failure_kind"] if row is not None else None,
            "terminal_outcome": row["terminal_outcome"] if row is not None else None,
            "terminal_error": row["terminal_error"] if row is not None else None,
            "limit_breach": row["limit_breach"] if row is not None else None,
            "limit_breach_detail": row["limit_breach_detail"] if row is not None else None,
        }
    )


def retry_or_dead_letter_job(
    conn: Connection,
    *,
    job_id: int,
    error: str,
    retry_base_seconds: int,
    insert_dead_letter_if_missing: Callable[..., None],
    failure_metadata: FailureMetadata | None = None,
) -> bool:
    """Returns True if retry scheduled, False if moved to dead-letter."""
    row = conn.execute(
        """
        SELECT id, user_id, chat_id, operator_message_id, attempts, max_attempts, status, error
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
    current_status = str(row["status"] or "")
    current_error = str(row["error"] or "")
    error_text = error[:1000]
    metadata = _sanitize_failure_metadata(failure_metadata)

    if attempts < max_attempts and int(retry_base_seconds) > 0:
        delay_seconds = max(1, int(retry_base_seconds)) * (2 ** max(0, attempts - 1))
        scheduled = conn.execute(
            """
            UPDATE chat_jobs
            SET status = ?,
                error = ?,
                next_attempt_at = datetime('now', ?),
                child_pid = ?,
                child_transport = ?,
                terminal_return_code = ?,
                terminal_failure_kind = ?,
                terminal_outcome = ?,
                terminal_error = ?,
                limit_breach = ?,
                limit_breach_detail = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND status = ?
              AND COALESCE(attempts, 0) < CASE WHEN COALESCE(max_attempts, 0) > 0 THEN COALESCE(max_attempts, 0) ELSE 1 END
            """,
            (
                JOB_STATUS_QUEUED,
                error_text,
                f"+{delay_seconds} seconds",
                metadata.get("child_pid"),
                metadata.get("child_transport"),
                metadata.get("terminal_return_code"),
                metadata.get("terminal_failure_kind"),
                metadata.get("terminal_outcome"),
                metadata.get("terminal_error"),
                metadata.get("limit_breach"),
                metadata.get("limit_breach_detail"),
                job_id,
                JOB_STATUS_RUNNING,
            ),
        )
        if scheduled.rowcount > 0:
            return True

    updated = conn.execute(
        f"""
        UPDATE chat_jobs
        SET status = ?,
            error = ?,
            child_pid = ?,
            child_transport = ?,
            terminal_return_code = ?,
            terminal_failure_kind = ?,
            terminal_outcome = ?,
            terminal_error = ?,
            limit_breach = ?,
            limit_breach_detail = ?,
            finished_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN {SQL_JOB_STATUS_OPEN}
        """,
        (
            JOB_STATUS_DEAD,
            error_text,
            metadata.get("child_pid"),
            metadata.get("child_transport"),
            metadata.get("terminal_return_code"),
            metadata.get("terminal_failure_kind"),
            metadata.get("terminal_outcome"),
            metadata.get("terminal_error"),
            metadata.get("limit_breach"),
            metadata.get("limit_breach_detail"),
            job_id,
        ),
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
            failure_metadata=metadata,
        )
        return False

    if current_status == JOB_STATUS_DEAD and current_error == "interrupted_by_runtime_recovery":
        conn.execute(
            """
            UPDATE chat_jobs
            SET error = ?,
                child_pid = ?,
                child_transport = ?,
                terminal_return_code = ?,
                terminal_failure_kind = ?,
                terminal_outcome = ?,
                terminal_error = ?,
                limit_breach = ?,
                limit_breach_detail = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = ?
            """,
            (
                error_text,
                metadata.get("child_pid"),
                metadata.get("child_transport"),
                metadata.get("terminal_return_code"),
                metadata.get("terminal_failure_kind"),
                metadata.get("terminal_outcome"),
                metadata.get("terminal_error"),
                metadata.get("limit_breach"),
                metadata.get("limit_breach_detail"),
                job_id,
                JOB_STATUS_DEAD,
            ),
        )
        insert_dead_letter_if_missing(
            conn,
            job_id=int(row["id"]),
            user_id=str(row["user_id"]),
            chat_id=int(row["chat_id"]),
            operator_message_id=int(row["operator_message_id"]),
            attempts=attempts,
            max_attempts=max_attempts,
            error=error_text,
            failure_metadata=metadata,
        )
    return False


def dead_letter_stale_open_job_for_chat(
    conn: Connection,
    *,
    user_id: str,
    chat_id: int,
    timeout_seconds: int,
    error: str,
    insert_dead_letter_if_missing: Callable[..., None],
) -> dict[str, Any] | None:
    timeout = max(30, int(timeout_seconds or 0))
    error_text = str(error or "Stale open job")[:1000]
    row = conn.execute(
        f"""
        SELECT id, user_id, chat_id, operator_message_id, attempts, max_attempts, status, error,
               child_pid, child_transport, terminal_return_code, terminal_failure_kind,
               terminal_outcome, terminal_error, limit_breach, limit_breach_detail
        FROM chat_jobs
        WHERE user_id = ?
          AND chat_id = ?
          AND status IN {SQL_JOB_STATUS_OPEN}
          AND (
            (
              status = ?
              AND COALESCE(updated_at, created_at) <= datetime('now', ?)
            )
            OR
            (
              status = ?
              AND COALESCE(updated_at, started_at, created_at) <= datetime('now', ?)
            )
          )
        ORDER BY id DESC
        LIMIT 1
        """,
        (
            str(user_id),
            int(chat_id),
            JOB_STATUS_QUEUED,
            f"-{timeout} seconds",
            JOB_STATUS_RUNNING,
            f"-{timeout} seconds",
        ),
    ).fetchone()
    if not row:
        return None

    job_id = int(row["id"])
    metadata = _row_failure_metadata(row)
    updated = conn.execute(
        f"""
        UPDATE chat_jobs
        SET status = ?,
            error = ?,
            child_pid = ?,
            child_transport = ?,
            terminal_return_code = ?,
            terminal_failure_kind = ?,
            terminal_outcome = ?,
            terminal_error = ?,
            limit_breach = ?,
            limit_breach_detail = ?,
            finished_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN {SQL_JOB_STATUS_OPEN}
        """,
        (
            JOB_STATUS_DEAD,
            error_text,
            metadata.get("child_pid"),
            metadata.get("child_transport"),
            metadata.get("terminal_return_code"),
            metadata.get("terminal_failure_kind"),
            metadata.get("terminal_outcome"),
            metadata.get("terminal_error"),
            metadata.get("limit_breach"),
            metadata.get("limit_breach_detail"),
            job_id,
        ),
    )
    if updated.rowcount == 0:
        return None

    attempts = int(row["attempts"] or 0)
    max_attempts = int(row["max_attempts"] or 0)
    insert_dead_letter_if_missing(
        conn,
        job_id=job_id,
        user_id=str(row["user_id"]),
        chat_id=int(row["chat_id"]),
        operator_message_id=int(row["operator_message_id"]),
        attempts=attempts,
        max_attempts=max_attempts,
        error=error_text,
        failure_metadata=metadata,
    )
    return {
        "id": job_id,
        "user_id": str(row["user_id"]),
        "chat_id": int(row["chat_id"]),
        "attempts": attempts,
        "max_attempts": max_attempts,
        "error": error_text,
    }


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
        SELECT id, user_id, chat_id, operator_message_id, attempts, max_attempts, status, error,
               child_pid, child_transport, terminal_return_code, terminal_failure_kind,
               terminal_outcome, terminal_error, limit_breach, limit_breach_detail
        FROM chat_jobs
        WHERE status = ?
          AND COALESCE(updated_at, started_at, created_at) <= datetime('now', ?)
        """,
        (JOB_STATUS_RUNNING, f"-{timeout} seconds"),
    ).fetchall()

    results: list[dict[str, Any]] = []
    for row in stale_rows:
        job_id = int(row["id"])
        metadata = _row_failure_metadata(row)
        updated = conn.execute(
            """
            UPDATE chat_jobs
            SET status = ?,
                error = ?,
                child_pid = ?,
                child_transport = ?,
                terminal_return_code = ?,
                terminal_failure_kind = ?,
                terminal_outcome = ?,
                terminal_error = ?,
                limit_breach = ?,
                limit_breach_detail = ?,
                finished_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = ?
            """,
            (
                JOB_STATUS_DEAD,
                error_text,
                metadata.get("child_pid"),
                metadata.get("child_transport"),
                metadata.get("terminal_return_code"),
                metadata.get("terminal_failure_kind"),
                metadata.get("terminal_outcome"),
                metadata.get("terminal_error"),
                metadata.get("limit_breach"),
                metadata.get("limit_breach_detail"),
                job_id,
                JOB_STATUS_RUNNING,
            ),
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
            failure_metadata=metadata,
        )
        results.append(
            {
                "id": job_id,
                "user_id": str(row["user_id"]),
                "chat_id": int(row["chat_id"]),
            }
        )

    return results
