from __future__ import annotations

import sqlite3

from store import SessionStore


def _store(tmp_path) -> SessionStore:
    return SessionStore(tmp_path / "sessions.db")


def test_store_persists_telegram_unread_notification_preference(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "notif-user"

    assert store.get_telegram_unread_notifications_enabled(user_id) is False

    store.set_skin(user_id, "oracle")
    store.set_telegram_unread_notifications_enabled(user_id, True)

    assert store.get_telegram_unread_notifications_enabled(user_id) is True
    assert store.get_skin(user_id) == "oracle"

    store.set_telegram_unread_notifications_enabled(user_id, False)

    assert store.get_telegram_unread_notifications_enabled(user_id) is False
    assert store.get_skin(user_id) == "oracle"


def test_store_init_migrates_legacy_user_preferences_for_telegram_unread_notifications(tmp_path) -> None:
    db_path = tmp_path / "sessions.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE user_preferences (
            user_id TEXT PRIMARY KEY,
            skin TEXT NOT NULL DEFAULT 'terminal',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        "INSERT INTO user_preferences(user_id, skin) VALUES(?, ?)",
        ("legacy-user", "terminal"),
    )
    conn.commit()
    conn.close()

    store = SessionStore(db_path)

    conn = sqlite3.connect(db_path)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(user_preferences)").fetchall()}
    conn.close()

    assert "active_chat_id" in columns
    assert "telegram_unread_notifications_enabled" in columns
    assert store.get_telegram_unread_notifications_enabled("legacy-user") is False

    store.set_telegram_unread_notifications_enabled("legacy-user", True)

    assert store.get_telegram_unread_notifications_enabled("legacy-user") is True
