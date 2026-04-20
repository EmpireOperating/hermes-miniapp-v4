from __future__ import annotations

from typing import Any

from visual_dev_models import dump_visual_dev_json, load_visual_dev_json


class StoreVisualDevMixin:
    def upsert_visual_dev_session(
        self,
        *,
        session_id: str,
        user_id: str,
        chat_id: int,
        preview_url: str,
        preview_origin: str,
        preview_title: str,
        bridge_parent_origin: str,
        status: str = "attached",
        metadata: dict[str, Any] | None = None,
    ) -> None:
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            conn.execute(
                """
                UPDATE visual_dev_sessions
                SET status = 'detached',
                    detached_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND chat_id = ? AND session_id != ? AND detached_at IS NULL
                """,
                (user_id, int(chat_id), session_id),
            )
            conn.execute(
                """
                INSERT INTO visual_dev_sessions (
                    session_id,
                    user_id,
                    chat_id,
                    preview_url,
                    preview_origin,
                    preview_title,
                    bridge_parent_origin,
                    status,
                    metadata_json,
                    created_at,
                    updated_at,
                    detached_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
                ON CONFLICT(session_id)
                DO UPDATE SET user_id = excluded.user_id,
                              chat_id = excluded.chat_id,
                              preview_url = excluded.preview_url,
                              preview_origin = excluded.preview_origin,
                              preview_title = excluded.preview_title,
                              bridge_parent_origin = excluded.bridge_parent_origin,
                              status = excluded.status,
                              metadata_json = excluded.metadata_json,
                              updated_at = CURRENT_TIMESTAMP,
                              detached_at = NULL
                """,
                (
                    session_id,
                    user_id,
                    int(chat_id),
                    preview_url.strip(),
                    preview_origin.strip(),
                    preview_title.strip(),
                    bridge_parent_origin.strip(),
                    status.strip() or "attached",
                    dump_visual_dev_json(metadata),
                ),
            )

    def get_visual_dev_session(self, session_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM visual_dev_sessions WHERE session_id = ? LIMIT 1",
                (session_id,),
            ).fetchone()
        if not row:
            return None
        return self._visual_dev_session_row_to_dict(row)

    def list_visual_dev_sessions(self, *, user_id: str, include_detached: bool = False) -> list[dict[str, Any]]:
        query = "SELECT * FROM visual_dev_sessions WHERE user_id = ?"
        params: list[Any] = [user_id]
        if not include_detached:
            query += " AND detached_at IS NULL"
        query += " ORDER BY updated_at DESC, session_id DESC"
        with self._connect() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
        return [self._visual_dev_session_row_to_dict(row) for row in rows]

    def detach_visual_dev_session(self, session_id: str) -> None:
        with self._connect() as conn:
            self._ensure_visual_dev_session_exists(conn, session_id)
            conn.execute(
                """
                UPDATE visual_dev_sessions
                SET status = 'detached',
                    detached_at = COALESCE(detached_at, CURRENT_TIMESTAMP),
                    updated_at = CURRENT_TIMESTAMP
                WHERE session_id = ?
                """,
                (session_id,),
            )

    def record_visual_dev_selection(
        self,
        *,
        session_id: str,
        selection_type: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        with self._connect() as conn:
            self._ensure_visual_dev_session_exists(conn, session_id)
            conn.execute(
                """
                INSERT INTO visual_dev_selections (session_id, selection_type, payload_json, created_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (session_id, selection_type.strip(), dump_visual_dev_json(payload)),
            )

    def get_latest_visual_dev_selection(self, session_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT *
                FROM visual_dev_selections
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (session_id,),
            ).fetchone()
        if not row:
            return None
        return {
            "id": int(row["id"]),
            "session_id": str(row["session_id"]),
            "selection_type": str(row["selection_type"]),
            "payload": load_visual_dev_json(row["payload_json"]),
            "created_at": str(row["created_at"] or ""),
        }

    def record_visual_dev_artifact(
        self,
        *,
        session_id: str,
        artifact_kind: str,
        storage_path: str,
        content_type: str = "",
        byte_size: int = 0,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        with self._connect() as conn:
            self._ensure_visual_dev_session_exists(conn, session_id)
            conn.execute(
                """
                INSERT INTO visual_dev_artifacts (
                    session_id,
                    artifact_kind,
                    storage_path,
                    content_type,
                    byte_size,
                    metadata_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (
                    session_id,
                    artifact_kind.strip(),
                    storage_path.strip(),
                    content_type.strip(),
                    max(int(byte_size), 0),
                    dump_visual_dev_json(metadata),
                ),
            )

    def list_visual_dev_artifacts(self, session_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM visual_dev_artifacts
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (session_id, max(int(limit), 1)),
            ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "session_id": str(row["session_id"]),
                "artifact_kind": str(row["artifact_kind"]),
                "storage_path": str(row["storage_path"]),
                "content_type": str(row["content_type"] or ""),
                "byte_size": int(row["byte_size"] or 0),
                "metadata": load_visual_dev_json(row["metadata_json"]),
                "created_at": str(row["created_at"] or ""),
            }
            for row in rows
        ]

    def record_visual_dev_console_event(
        self,
        *,
        session_id: str,
        event_type: str,
        level: str,
        message: str,
        metadata: dict[str, Any] | None = None,
        max_events: int | None = None,
    ) -> None:
        with self._connect() as conn:
            self._ensure_visual_dev_session_exists(conn, session_id)
            conn.execute(
                """
                INSERT INTO visual_dev_console_events (
                    session_id,
                    event_type,
                    level,
                    message,
                    metadata_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (
                    session_id,
                    event_type.strip(),
                    level.strip(),
                    message.strip(),
                    dump_visual_dev_json(metadata),
                ),
            )
            if max_events is not None and int(max_events) > 0:
                conn.execute(
                    """
                    DELETE FROM visual_dev_console_events
                    WHERE session_id = ?
                      AND id NOT IN (
                          SELECT id
                          FROM visual_dev_console_events
                          WHERE session_id = ?
                          ORDER BY id DESC
                          LIMIT ?
                      )
                    """,
                    (session_id, session_id, int(max_events)),
                )

    def list_visual_dev_console_events(self, session_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM visual_dev_console_events
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (session_id, max(int(limit), 1)),
            ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "session_id": str(row["session_id"]),
                "event_type": str(row["event_type"]),
                "level": str(row["level"]),
                "message": str(row["message"]),
                "metadata": load_visual_dev_json(row["metadata_json"]),
                "created_at": str(row["created_at"] or ""),
            }
            for row in rows
        ]

    @staticmethod
    def _visual_dev_session_row_to_dict(row: Any) -> dict[str, Any]:
        return {
            "session_id": str(row["session_id"]),
            "user_id": str(row["user_id"]),
            "chat_id": int(row["chat_id"]),
            "preview_url": str(row["preview_url"]),
            "preview_origin": str(row["preview_origin"]),
            "preview_title": str(row["preview_title"] or ""),
            "bridge_parent_origin": str(row["bridge_parent_origin"] or ""),
            "status": str(row["status"]),
            "metadata": load_visual_dev_json(row["metadata_json"]),
            "created_at": str(row["created_at"] or ""),
            "updated_at": str(row["updated_at"] or ""),
            "detached_at": str(row["detached_at"]) if row["detached_at"] else None,
        }
