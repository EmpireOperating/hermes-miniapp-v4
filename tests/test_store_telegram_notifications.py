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
    attempt_columns = {row[1] for row in conn.execute("PRAGMA table_info(telegram_notification_attempts)").fetchall()}
    conn.close()

    assert "active_chat_id" in columns
    assert "telegram_unread_notifications_enabled" in columns
    assert "decision_reason" in attempt_columns
    assert "unread_anchor_message_id" in attempt_columns
    assert store.get_telegram_unread_notifications_enabled("legacy-user") is False

    store.set_telegram_unread_notifications_enabled("legacy-user", True)

    assert store.get_telegram_unread_notifications_enabled("legacy-user") is True


def test_store_init_migrates_legacy_telegram_notification_attempts_schema(tmp_path) -> None:
    db_path = tmp_path / "sessions.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE telegram_notification_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            chat_id INTEGER NOT NULL,
            unread_streak_key INTEGER NOT NULL,
            prior_unread_count INTEGER NOT NULL DEFAULT 0,
            notifications_enabled INTEGER NOT NULL DEFAULT 0,
            active_chat_id INTEGER,
            visibly_open_chat_id INTEGER,
            decision_reason TEXT NOT NULL,
            send_attempted INTEGER NOT NULL DEFAULT 0,
            send_ok INTEGER NOT NULL DEFAULT 0,
            status_code INTEGER,
            error TEXT,
            response_text TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.commit()
    conn.close()

    SessionStore(db_path)

    conn = sqlite3.connect(db_path)
    attempt_columns = {row[1] for row in conn.execute("PRAGMA table_info(telegram_notification_attempts)").fetchall()}
    conn.close()

    assert "unread_anchor_message_id" in attempt_columns
    assert "attempt_ok" in attempt_columns
    assert "decision_reason" in attempt_columns



def test_store_records_notification_attempts_and_tracks_success_per_unread_anchor(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "notif-user"
    chat_id = store.ensure_default_chat(user_id)
    store.add_message(user_id, chat_id, "operator", "question")
    first_reply_id = store.add_message(user_id, chat_id, "hermes", "reply one")
    store.add_message(user_id, chat_id, "hermes", "reply two")

    assert store.get_oldest_unread_hermes_message_id(user_id, chat_id) == first_reply_id
    assert store.unread_reply_notification_sent_for_anchor(user_id, chat_id, first_reply_id) is False

    store.record_telegram_notification_attempt(
        user_id=user_id,
        chat_id=chat_id,
        unread_anchor_message_id=first_reply_id,
        prior_unread_count=0,
        decision_reason="send",
        result=type("Result", (), {"ok": False, "status_code": 500, "error": "telegram_send_failed:500", "response_text": "boom"})(),
    )

    assert store.unread_reply_notification_sent_for_anchor(user_id, chat_id, first_reply_id) is False

    store.record_telegram_notification_attempt(
        user_id=user_id,
        chat_id=chat_id,
        unread_anchor_message_id=first_reply_id,
        prior_unread_count=2,
        decision_reason="retry_pending_unread",
        result=type("Result", (), {"ok": True, "status_code": 200, "error": None, "response_text": '{"ok":true}'})(),
    )

    assert store.unread_reply_notification_sent_for_anchor(user_id, chat_id, first_reply_id) is True

    attempts = store.list_telegram_notification_attempts(user_id=user_id, chat_id=chat_id, limit=5)
    assert [attempt["decision_reason"] for attempt in attempts] == ["retry_pending_unread", "send"]
    assert attempts[0]["ok"] is True
    assert attempts[1]["error"] == "telegram_send_failed:500"
