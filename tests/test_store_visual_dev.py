from __future__ import annotations

import sqlite3

import pytest

from store import SessionStore


def _store(tmp_path) -> SessionStore:
    return SessionStore(tmp_path / "sessions.db")


def test_store_init_creates_visual_dev_tables_and_indexes(tmp_path) -> None:
    db_path = tmp_path / "sessions.db"

    SessionStore(db_path)

    conn = sqlite3.connect(db_path)
    table_names = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'visual_dev_%'"
        ).fetchall()
    }
    session_columns = {row[1] for row in conn.execute("PRAGMA table_info(visual_dev_sessions)").fetchall()}
    selection_columns = {row[1] for row in conn.execute("PRAGMA table_info(visual_dev_selections)").fetchall()}
    artifact_columns = {row[1] for row in conn.execute("PRAGMA table_info(visual_dev_artifacts)").fetchall()}
    console_columns = {row[1] for row in conn.execute("PRAGMA table_info(visual_dev_console_events)").fetchall()}
    session_indexes = {row[1] for row in conn.execute("PRAGMA index_list('visual_dev_sessions')").fetchall()}
    conn.close()

    assert table_names == {
        "visual_dev_artifacts",
        "visual_dev_console_events",
        "visual_dev_selections",
        "visual_dev_sessions",
    }
    assert {
        "session_id",
        "user_id",
        "chat_id",
        "preview_url",
        "preview_origin",
        "preview_title",
        "bridge_parent_origin",
        "status",
        "metadata_json",
        "created_at",
        "updated_at",
        "detached_at",
    }.issubset(session_columns)
    assert {"id", "session_id", "selection_type", "payload_json", "created_at"}.issubset(selection_columns)
    assert {
        "id",
        "session_id",
        "artifact_kind",
        "storage_path",
        "content_type",
        "byte_size",
        "metadata_json",
        "created_at",
    }.issubset(artifact_columns)
    assert {
        "id",
        "session_id",
        "event_type",
        "level",
        "message",
        "metadata_json",
        "created_at",
    }.issubset(console_columns)
    assert "idx_visual_dev_sessions_user_chat_active" in session_indexes



def test_upsert_visual_dev_session_replaces_existing_active_session_for_chat(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "visual-user"
    chat_id = store.ensure_default_chat(user_id)

    store.upsert_visual_dev_session(
        session_id="session-a",
        user_id=user_id,
        chat_id=chat_id,
        preview_url="https://preview-one.example.com/app",
        preview_origin="https://preview-one.example.com",
        preview_title="Preview One",
        bridge_parent_origin="https://miniapp-dev.example.com",
        status="attached",
        metadata={"viewport": "desktop"},
    )

    store.upsert_visual_dev_session(
        session_id="session-b",
        user_id=user_id,
        chat_id=chat_id,
        preview_url="https://preview-two.example.com/app",
        preview_origin="https://preview-two.example.com",
        preview_title="Preview Two",
        bridge_parent_origin="https://miniapp-dev.example.com",
        status="attached",
        metadata={"viewport": "mobile"},
    )

    detached = store.get_visual_dev_session("session-a")
    active = store.get_visual_dev_session("session-b")
    sessions = store.list_visual_dev_sessions(user_id=user_id)

    assert detached is not None
    assert detached["detached_at"]
    assert detached["status"] == "detached"
    assert active is not None
    assert active["chat_id"] == chat_id
    assert active["preview_title"] == "Preview Two"
    assert active["metadata"]["viewport"] == "mobile"
    assert active["detached_at"] is None
    assert [session["session_id"] for session in sessions] == ["session-b"]



def test_record_visual_dev_selection_and_artifacts_and_trim_console_history(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "visual-user"
    chat_id = store.ensure_default_chat(user_id)
    store.upsert_visual_dev_session(
        session_id="session-a",
        user_id=user_id,
        chat_id=chat_id,
        preview_url="https://preview.example.com/app",
        preview_origin="https://preview.example.com",
        preview_title="Preview",
        bridge_parent_origin="https://miniapp-dev.example.com",
    )

    store.record_visual_dev_selection(
        session_id="session-a",
        selection_type="dom",
        payload={"selector": "#score-badge", "text": "12"},
    )
    store.record_visual_dev_selection(
        session_id="session-a",
        selection_type="region",
        payload={"x": 10, "y": 20, "width": 200, "height": 80},
    )
    store.record_visual_dev_artifact(
        session_id="session-a",
        artifact_kind="screenshot",
        storage_path="/tmp/visual-dev/shot-1.png",
        content_type="image/png",
        byte_size=12345,
        metadata={"selection_type": "region"},
    )
    store.record_visual_dev_console_event(
        session_id="session-a",
        event_type="console",
        level="info",
        message="booted",
        metadata={"source": "preview"},
        max_events=2,
    )
    store.record_visual_dev_console_event(
        session_id="session-a",
        event_type="console",
        level="warn",
        message="slow frame",
        metadata={"source": "preview"},
        max_events=2,
    )
    store.record_visual_dev_console_event(
        session_id="session-a",
        event_type="runtime-error",
        level="error",
        message="ReferenceError: score is not defined",
        metadata={"source": "preview"},
        max_events=2,
    )

    latest_selection = store.get_latest_visual_dev_selection("session-a")
    artifacts = store.list_visual_dev_artifacts("session-a")
    console_events = store.list_visual_dev_console_events("session-a", limit=10)

    assert latest_selection is not None
    assert latest_selection["selection_type"] == "region"
    assert latest_selection["payload"]["width"] == 200
    assert len(artifacts) == 1
    assert artifacts[0]["artifact_kind"] == "screenshot"
    assert artifacts[0]["metadata"]["selection_type"] == "region"
    assert [event["message"] for event in console_events] == [
        "ReferenceError: score is not defined",
        "slow frame",
    ]
    assert console_events[0]["level"] == "error"



def test_visual_dev_store_methods_require_existing_chat_and_session(tmp_path) -> None:
    store = _store(tmp_path)

    with pytest.raises(KeyError, match="Chat 999 not found"):
        store.upsert_visual_dev_session(
            session_id="missing-chat",
            user_id="visual-user",
            chat_id=999,
            preview_url="https://preview.example.com/app",
            preview_origin="https://preview.example.com",
            preview_title="Preview",
            bridge_parent_origin="https://miniapp-dev.example.com",
        )

    with pytest.raises(KeyError, match="Visual dev session missing-session not found"):
        store.record_visual_dev_selection(
            session_id="missing-session",
            selection_type="dom",
            payload={"selector": "#missing"},
        )
