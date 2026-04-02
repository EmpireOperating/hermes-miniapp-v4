from __future__ import annotations

import time


class StoreAuthMixin:
    def upsert_auth_session(
        self,
        *,
        session_id: str,
        user_id: str,
        nonce_hash: str,
        expires_at: int,
        display_name: str | None = None,
        username: str | None = None,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO auth_sessions (session_id, user_id, nonce_hash, display_name, username, expires_at, revoked_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
                ON CONFLICT(session_id)
                DO UPDATE SET
                    user_id = excluded.user_id,
                    nonce_hash = excluded.nonce_hash,
                    display_name = excluded.display_name,
                    username = excluded.username,
                    expires_at = excluded.expires_at,
                    revoked_at = NULL,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (session_id, user_id, nonce_hash, display_name, username, int(expires_at)),
            )

    def is_auth_session_active(self, *, session_id: str, user_id: str, nonce_hash: str, now_epoch: int) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT expires_at, revoked_at
                FROM auth_sessions
                WHERE session_id = ? AND user_id = ? AND nonce_hash = ?
                """,
                (session_id, user_id, nonce_hash),
            ).fetchone()
            if not row:
                return False
            if row["revoked_at"] is not None:
                return False
            if int(row["expires_at"] or 0) < int(now_epoch):
                return False
            return True

    def revoke_auth_session(self, session_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE auth_sessions
                SET revoked_at = ?, updated_at = CURRENT_TIMESTAMP
                WHERE session_id = ?
                """,
                (int(time.time()), session_id),
            )

    def revoke_all_auth_sessions(self, user_id: str) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE auth_sessions
                SET revoked_at = ?, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND revoked_at IS NULL
                """,
                (int(time.time()), user_id),
            )
            return int(cursor.rowcount or 0)

    def prune_expired_auth_sessions(self, now_epoch: int) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM auth_sessions WHERE expires_at < ?",
                (int(now_epoch),),
            )
            return int(cursor.rowcount or 0)

    def get_latest_auth_session_profile(self, user_id: str, *, now_epoch: int | None = None) -> dict[str, str | None]:
        safe_now_epoch = int(time.time()) if now_epoch is None else int(now_epoch)
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT display_name, username
                FROM auth_sessions
                WHERE user_id = ?
                  AND revoked_at IS NULL
                  AND expires_at >= ?
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 1
                """,
                (user_id, safe_now_epoch),
            ).fetchone()
        if not row:
            return {"display_name": None, "username": None}
        return {
            "display_name": str(row["display_name"] or "").strip() or None,
            "username": str(row["username"] or "").strip() or None,
        }
