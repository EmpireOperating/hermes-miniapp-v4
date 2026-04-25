from __future__ import annotations

from sqlite3 import Connection

from file_refs import extract_file_refs
from store_models import ChatThread, ChatTurn


def first_unarchived_chat_id(conn: Connection, *, user_id: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM chat_threads WHERE user_id = ? AND is_archived = 0 ORDER BY id ASC LIMIT 1",
        (user_id,),
    ).fetchone()
    return int(row["id"]) if row else None


def get_or_create_main_chat_id(conn: Connection, *, user_id: str) -> int:
    chat_id = first_unarchived_chat_id(conn, user_id=user_id)
    if chat_id is not None:
        return chat_id
    cursor = conn.execute(
        "INSERT INTO chat_threads (user_id, title, is_archived) VALUES (?, ?, 0)",
        (user_id, "Main"),
    )
    return int(cursor.lastrowid)


def hydrate_chat_thread(row) -> ChatThread:
    return ChatThread(
        id=int(row["id"]),
        title=str(row["title"]),
        parent_chat_id=int(row["parent_chat_id"]) if row["parent_chat_id"] not in (None, "") else None,
        unread_count=int(row["unread_count"] or 0),
        newest_unread_message_id=int(row["newest_unread_message_id"] or 0),
        pending=bool(int(row["pending"] or 0)),
        is_pinned=bool(int(row["is_pinned"] or 0)),
        updated_at=str(row["updated_at"]),
        created_at=str(row["created_at"]),
    )


def select_chat_rows(
    conn: Connection,
    *,
    user_id: str,
    include_archived: bool,
    pinned_only: bool,
    chat_id: int | None = None,
):
    where_clauses = ["ct.user_id = ?"]
    params: list[object] = [user_id]

    if not include_archived:
        where_clauses.append("ct.is_archived = 0")
    if pinned_only:
        where_clauses.append("ct.is_pinned = 1")
    if chat_id is not None:
        where_clauses.append("ct.id = ?")
        params.append(chat_id)

    query = f"""
        WITH filtered_threads AS (
            SELECT
                ct.id,
                ct.user_id,
                ct.title,
                ct.parent_chat_id,
                ct.updated_at,
                ct.created_at,
                ct.is_pinned,
                ct.last_read_message_id
            FROM chat_threads ct
            WHERE {' AND '.join(where_clauses)}
        ),
        unread_stats AS (
            SELECT
                ft.user_id,
                ft.id AS chat_id,
                SUM(CASE WHEN cm.role = 'hermes' AND cm.id > ft.last_read_message_id THEN 1 ELSE 0 END) AS unread_count,
                MAX(CASE WHEN cm.role = 'hermes' AND cm.id > ft.last_read_message_id THEN cm.id ELSE 0 END) AS newest_unread_message_id
            FROM filtered_threads ft
            LEFT JOIN chat_messages cm ON cm.user_id = ft.user_id AND cm.chat_id = ft.id
            GROUP BY ft.user_id, ft.id
        ),
        latest_messages AS (
            SELECT
                cm.user_id,
                cm.chat_id,
                MAX(cm.id) AS last_message_id
            FROM chat_messages cm
            INNER JOIN filtered_threads ft ON ft.user_id = cm.user_id AND ft.id = cm.chat_id
            GROUP BY cm.user_id, cm.chat_id
        )
        SELECT
            ft.id,
            ft.title,
            ft.parent_chat_id,
            ft.updated_at,
            ft.created_at,
            ft.is_pinned,
            COALESCE(us.unread_count, 0) AS unread_count,
            COALESCE(us.newest_unread_message_id, 0) AS newest_unread_message_id,
            CASE
                WHEN lm_row.role = 'operator'
                 AND NOT EXISTS (
                    SELECT 1
                    FROM chat_jobs cj
                    WHERE cj.user_id = ft.user_id
                      AND cj.chat_id = ft.id
                      AND cj.operator_message_id = lm.last_message_id
                      AND cj.status = 'dead'
                    LIMIT 1
                 )
                THEN 1
                ELSE 0
            END AS pending
        FROM filtered_threads ft
        LEFT JOIN unread_stats us ON us.user_id = ft.user_id AND us.chat_id = ft.id
        LEFT JOIN latest_messages lm ON lm.user_id = ft.user_id AND lm.chat_id = ft.id
        LEFT JOIN chat_messages lm_row ON lm_row.user_id = ft.user_id AND lm_row.chat_id = ft.id AND lm_row.id = lm.last_message_id
        ORDER BY ft.id ASC
    """
    return conn.execute(query, tuple(params)).fetchall()


def select_pinned_chat_summary_rows(conn: Connection, *, user_id: str):
    return conn.execute(
        """
        SELECT
            ct.id,
            ct.title,
            ct.parent_chat_id,
            ct.updated_at,
            ct.created_at,
            ct.is_pinned,
            0 AS unread_count,
            0 AS newest_unread_message_id,
            0 AS pending
        FROM chat_threads ct
        WHERE ct.user_id = ?
          AND ct.is_pinned = 1
        ORDER BY ct.id ASC
        """,
        (user_id,),
    ).fetchall()


def hydrate_chat_turns(rows, *, attachments_by_message_id: dict[int, list[dict[str, object]]] | None = None) -> list[ChatTurn]:
    ordered = reversed(rows)
    hydrated: list[ChatTurn] = []
    attachment_map = attachments_by_message_id or {}
    for row in ordered:
        message_id = int(row["id"])
        body = str(row["body"])
        hydrated.append(
            ChatTurn(
                id=message_id,
                role=str(row["role"]),
                body=body,
                created_at=str(row["created_at"]),
                file_refs=extract_file_refs(body, message_id=message_id),
                attachments=list(attachment_map.get(message_id, [])),
            )
        )
    return hydrated


def list_recoverable_pending_turns(conn: Connection, *, user_id: str) -> list[tuple[int, int]]:
    rows = conn.execute(
        """
        SELECT ct.id AS chat_id,
               (
                   SELECT lm.id
                   FROM chat_messages lm
                   WHERE lm.user_id = ct.user_id AND lm.chat_id = ct.id
                   ORDER BY lm.id DESC
                   LIMIT 1
               ) AS latest_message_id,
               (
                   SELECT lm.role
                   FROM chat_messages lm
                   WHERE lm.user_id = ct.user_id AND lm.chat_id = ct.id
                   ORDER BY lm.id DESC
                   LIMIT 1
               ) AS latest_role
        FROM chat_threads ct
        WHERE ct.user_id = ? AND ct.is_archived = 0
        """,
        (user_id,),
    ).fetchall()

    recoverable: list[tuple[int, int]] = []
    for row in rows:
        if str(row["latest_role"] or "") != "operator":
            continue
        chat_id = int(row["chat_id"])
        message_id = int(row["latest_message_id"] or 0)
        if message_id <= 0:
            continue
        open_job = conn.execute(
            """
            SELECT 1 AS present
            FROM chat_jobs
            WHERE user_id = ?
              AND chat_id = ?
              AND (
                status = 'running'
                OR (
                  status = 'queued'
                  AND COALESCE(attempts, 0) < CASE
                    WHEN COALESCE(max_attempts, 0) > 0 THEN COALESCE(max_attempts, 0)
                    ELSE 1
                  END
                )
              )
            ORDER BY id DESC
            LIMIT 1
            """,
            (user_id, chat_id),
        ).fetchone()
        if open_job:
            continue
        existing_turn_job = conn.execute(
            """
            SELECT 1 AS present
            FROM chat_jobs
            WHERE user_id = ?
              AND chat_id = ?
              AND operator_message_id = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (user_id, chat_id, message_id),
        ).fetchone()
        if existing_turn_job:
            continue
        recoverable.append((chat_id, message_id))
    return recoverable


def get_turn_count(conn: Connection, *, user_id: str, chat_id: int | None = None) -> int:
    if chat_id is None:
        row = conn.execute(
            "SELECT COUNT(*) AS count FROM chat_messages WHERE user_id = ?",
            (user_id,),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT COUNT(*) AS count FROM chat_messages WHERE user_id = ? AND chat_id = ?",
            (user_id, chat_id),
        ).fetchone()
    return int(row["count"]) if row else 0
