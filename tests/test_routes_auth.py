from __future__ import annotations

from types import SimpleNamespace

from server_test_utils import load_server, patch_verified_user


def _authed_client(monkeypatch, tmp_path, **load_kwargs):
    server = load_server(monkeypatch, tmp_path, **load_kwargs)
    client = server.app.test_client()
    patch_verified_user(monkeypatch, server)
    return server, client

def test_auth_sets_secure_session_cookie_by_default(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = client.post("/api/auth", json={"init_data": "ok"})

    assert response.status_code == 200
    set_cookie = response.headers.get("Set-Cookie", "")
    assert "Secure" in set_cookie

def test_verify_from_payload_prefers_init_data_over_cookie(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

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
    server = load_server(monkeypatch, tmp_path)

    cookie_verified = SimpleNamespace(user=SimpleNamespace(id=7, first_name=None, username=None))
    monkeypatch.setattr(server, "_verified_from_session_cookie", lambda: cookie_verified)

    resolved = server._verify_from_payload({})

    assert resolved is cookie_verified

def test_auth_reopens_last_active_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    main_chat_id = server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")
    server.store.add_message("123", alt_chat.id, "operator", "pending question")
    server.store.set_active_chat("123", alt_chat.id)
    server.store.set_chat_pinned("123", alt_chat.id, is_pinned=True)

    response = client.post("/api/auth", json={"init_data": "ok"})

    assert response.status_code == 200
    data = response.get_json()
    assert data["active_chat_id"] == alt_chat.id
    assert data["history"][-1]["body"] == "pending question"
    pending_chat = next(chat for chat in data["chats"] if chat["id"] == alt_chat.id)
    assert pending_chat["pending"] is True
    assert pending_chat["is_pinned"] is True
    assert [chat["id"] for chat in data["pinned_chats"]] == [alt_chat.id]
    assert any(chat["id"] == main_chat_id for chat in data["chats"])
    assert "hermes_skin=terminal" in response.headers.get("Set-Cookie", "")

def test_logout_all_revokes_cookie_session(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
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
    server, client = _authed_client(monkeypatch, tmp_path)

    response = client.post("/api/preferences/skin", json={"init_data": "ok", "skin": "oracle"})

    assert response.status_code == 200
    assert response.get_json()["skin"] == "oracle"
    assert "hermes_skin=oracle" in response.headers.get("Set-Cookie", "")


def test_dev_auth_returns_404_when_bypass_disabled(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    response = client.post("/api/dev/auth", json={"user_id": 9001, "display_name": "Desktop Tester"})

    assert response.status_code == 404


def test_dev_auth_rejects_wrong_secret(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINIAPP_DEV_BYPASS", "1")
    monkeypatch.setenv("MINIAPP_DEV_SECRET", "expected-secret")
    server = load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    response = client.post(
        "/api/dev/auth",
        json={"user_id": 9001, "display_name": "Desktop Tester"},
        headers={"X-Dev-Auth": "wrong-secret"},
    )

    assert response.status_code == 401


def test_dev_auth_sets_cookie_and_reuses_authenticated_endpoints(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINIAPP_DEV_BYPASS", "1")
    monkeypatch.setenv("MINIAPP_DEV_SECRET", "expected-secret")
    server = load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    auth_response = client.post(
        "/api/dev/auth",
        json={"user_id": 9001, "display_name": "Desktop Tester", "username": "desktop"},
        headers={"X-Dev-Auth": "expected-secret"},
    )

    assert auth_response.status_code == 200
    auth_data = auth_response.get_json()
    assert auth_data["ok"] is True
    assert auth_data["auth_mode"] == "dev"
    assert auth_data["user"]["id"] == 9001
    assert auth_data["user"]["display_name"] == "Desktop Tester"
    assert any("hermes_auth_session=" in value for value in auth_response.headers.getlist("Set-Cookie"))

    create_chat = client.post("/api/chats", json={"title": "desk"})

    assert create_chat.status_code == 201
    assert create_chat.get_json()["chat"]["title"] == "desk"
