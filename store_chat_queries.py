from __future__ import annotations

from sqlite3 import Connection

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
        unread_count=int(row["unread_count"] or 0),
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
                SUM(CASE WHEN cm.role = 'hermes' AND cm.id > ft.last_read_message_id THEN 1 ELSE 0 END) AS unread_count
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
            ft.updated_at,
            ft.created_at,
            ft.is_pinned,
            COALESCE(us.unread_count, 0) AS unread_count,
            CASE WHEN lm_row.role = 'operator' THEN 1 ELSE 0 END AS pending
        FROM filtered_threads ft
        LEFT JOIN unread_stats us ON us.user_id = ft.user_id AND us.chat_id = ft.id
        LEFT JOIN latest_messages lm ON lm.user_id = ft.user_id AND lm.chat_id = ft.id
        LEFT JOIN chat_messages lm_row ON lm_row.user_id = ft.user_id AND lm_row.chat_id = ft.id AND lm_row.id = lm.last_message_id
        ORDER BY ft.id ASC
    """
    return conn.execute(query, tuple(params)).fetchall()


def hydrate_chat_turns(rows, *, file_refs_by_message_id: dict[int, list[dict[str, object]]] | None = None) -> list[ChatTurn]:
    ordered = reversed(rows)
    refs_by_id = file_refs_by_message_id or {}
    return [
        ChatTurn(
            id=int(row["id"]),
            role=str(row["role"]),
            body=str(row["body"]),
            created_at=str(row["created_at"]),
            file_refs=list(refs_by_id.get(int(row["id"]), [])),
        )
        for row in ordered
    ]


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
            WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
            ORDER BY id DESC
            LIMIT 1
            """,
            (user_id, chat_id),
        ).fetchone()
        if open_job:
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
