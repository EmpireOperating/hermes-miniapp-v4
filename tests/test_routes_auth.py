from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

from server_test_utils import load_server as _load_server

def test_auth_sets_secure_session_cookie_by_default(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    response = client.post("/api/auth", json={"init_data": "ok"})

    assert response.status_code == 200
    set_cookie = response.headers.get("Set-Cookie", "")
    assert "Secure" in set_cookie

def test_verify_from_payload_prefers_init_data_over_cookie(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)

    cookie_verified = SimpleNamespace(user=SimpleNamespace(id=1, first_name=None, username=None))
    init_verified = SimpleNamespace(user=SimpleNamespace(id=2, first_name="Lemon", username="lemonsqueeze"))
    captured: dict[str, object] = {}

    monkeypatch.setattr(server, "_verified_from_session_cookie", lambda: cookie_verified)

    def fake_verify(*, init_data: str, bot_token: str, max_age_seconds: int):
        captured["init_data"] = init_data
        captured["bot_token"] = bot_token
        captured["max_age_seconds"] = max_age_seconds
        return init_verified

    monkeypatch.setattr(server, "verify_telegram_init_data", fake_verify)

    resolved = server._verify_from_payload({"init_data": "fresh-init-data"})

    assert resolved is init_verified
    assert captured["init_data"] == "fresh-init-data"

def test_verify_from_payload_uses_cookie_when_init_data_missing(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)

    cookie_verified = SimpleNamespace(user=SimpleNamespace(id=7, first_name=None, username=None))
    monkeypatch.setattr(server, "_verified_from_session_cookie", lambda: cookie_verified)

    resolved = server._verify_from_payload({})

    assert resolved is cookie_verified

def test_auth_reopens_last_active_chat(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    main_chat_id = server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")
    server.store.add_message("123", alt_chat.id, "operator", "pending question")
    server.store.set_active_chat("123", alt_chat.id)

    response = client.post("/api/auth", json={"init_data": "ok"})

    assert response.status_code == 200
    data = response.get_json()
    assert data["active_chat_id"] == alt_chat.id
    assert data["history"][-1]["body"] == "pending question"
    pending_chat = next(chat for chat in data["chats"] if chat["id"] == alt_chat.id)
    assert pending_chat["pending"] is True
    assert any(chat["id"] == main_chat_id for chat in data["chats"])
    assert "hermes_skin=terminal" in response.headers.get("Set-Cookie", "")

def test_logout_all_revokes_cookie_session(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    fake_verified = SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test"))

    def fake_verify(*, init_data: str, bot_token: str, max_age_seconds: int):
        if not init_data:
            raise server.TelegramAuthError("Missing init data")
        return fake_verified

    monkeypatch.setattr(server, "verify_telegram_init_data", fake_verify)

    auth_response = client.post("/api/auth", json={"init_data": "ok"})
    assert auth_response.status_code == 200

    logout_response = client.post("/api/auth/logout-all", json={"init_data": "ok"})
    assert logout_response.status_code == 200
    assert logout_response.get_json()["ok"] is True

    # No init_data: should rely on cookie session, which is now revoked.
    unauthorized = client.post("/api/chats", json={"title": "x"})
    assert unauthorized.status_code == 401

def test_set_skin_sets_cookie(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    response = client.post("/api/preferences/skin", json={"init_data": "ok", "skin": "oracle"})

    assert response.status_code == 200
    assert response.get_json()["skin"] == "oracle"
    assert "hermes_skin=oracle" in response.headers.get("Set-Cookie", "")
