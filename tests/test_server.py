from __future__ import annotations

import importlib
import re
from pathlib import Path
from types import SimpleNamespace


def _load_server(
    monkeypatch,
    tmp_path,
    *,
    max_message_len: int = 20,
    max_title_len: int = 10,
    max_content_length: int = 2048,
):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-token")
    monkeypatch.setenv("MAX_MESSAGE_LEN", str(max_message_len))
    monkeypatch.setenv("MAX_TITLE_LEN", str(max_title_len))
    monkeypatch.setenv("MAX_CONTENT_LENGTH", str(max_content_length))

    import server  # noqa: PLC0415
    import store as store_mod  # noqa: PLC0415

    module = importlib.reload(server)
    module.store = store_mod.SessionStore(tmp_path / "sessions.db")
    return module


def test_health_includes_security_headers(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    response = client.get("/health")

    assert response.status_code == 200
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert "Content-Security-Policy" in response.headers
    assert "Permissions-Policy" in response.headers


def test_create_app_returns_flask_app(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)

    app = server.create_app()

    assert app is server.app


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


def test_enforced_origin_check_rejects_disallowed_origin(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_ALLOWED_ORIGINS", "https://allowed.example")
    monkeypatch.setenv("MINI_APP_ENFORCE_ORIGIN_CHECK", "1")
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    response = client.post(
        "/api/chats",
        json={"init_data": "ok", "title": "x"},
        headers={"Origin": "https://evil.example"},
    )

    assert response.status_code == 403
    assert response.get_json()["error"] == "Origin not allowed."


def test_origin_check_accepts_allowed_referer_when_origin_missing(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_ALLOWED_ORIGINS", "https://allowed.example")
    monkeypatch.setenv("MINI_APP_ENFORCE_ORIGIN_CHECK", "1")
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    response = client.post(
        "/api/chats",
        json={"init_data": "ok", "title": "x"},
        headers={"Referer": "https://allowed.example/app"},
    )

    # Origin gate should pass via Referer fallback; auth still fails on dummy init_data.
    assert response.status_code == 401


def test_rate_limit_helper_enforces_limit(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)

    key = "test-rate-limit"
    assert server._check_rate_limit(key=key, limit=1, window_seconds=60) is True
    assert server._check_rate_limit(key=key, limit=1, window_seconds=60) is False


def test_rate_limit_ignores_x_forwarded_for_when_proxy_headers_disabled(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_TRUST_PROXY_HEADERS", "0")
    monkeypatch.setenv("MINI_APP_RATE_LIMIT_API_REQUESTS", "10")
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    for i in range(10):
        response = client.get("/api/state", headers={"X-Forwarded-For": f"198.51.100.{i}"})
        assert response.status_code == 200

    blocked = client.get("/api/state", headers={"X-Forwarded-For": "203.0.113.77"})
    assert blocked.status_code == 429


def test_stream_rate_limit_blocks_burst_reconnects(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_RATE_LIMIT_STREAM_REQUESTS", "3")
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    for _ in range(3):
        response = client.post("/api/chat/stream/resume", json={"init_data": "ok"})
        assert response.status_code in {400, 401, 404, 409}

    blocked = client.post("/api/chat/stream/resume", json={"init_data": "ok"})
    assert blocked.status_code == 429


def test_rate_limit_scopes_authenticated_requests_by_user(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_RATE_LIMIT_API_REQUESTS", "1")
    server = _load_server(monkeypatch, tmp_path)

    client_a = server.app.test_client()
    client_b = server.app.test_client()

    token_a = server._create_auth_session_token("123")
    token_b = server._create_auth_session_token("456")

    client_a.set_cookie(server.AUTH_COOKIE_NAME, token_a)
    client_b.set_cookie(server.AUTH_COOKIE_NAME, token_b)

    first_a = client_a.get("/api/state")
    first_b = client_b.get("/api/state")
    blocked_a = client_a.get("/api/state")

    assert first_a.status_code == 200
    assert first_b.status_code == 200
    assert blocked_a.status_code == 429


def test_app_rejects_payload_over_max_content_length(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path, max_content_length=128)
    client = server.app.test_client()

    response = client.post("/api/auth", json={"init_data": "x" * 400})

    assert response.status_code == 413


def test_app_boots_skin_from_cookie(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    client.set_cookie("hermes_skin", "obsidian")
    response = client.get("/app")

    assert response.status_code == 200
    page = response.get_data(as_text=True)
    assert 'data-skin="obsidian"' in page
    assert 'const serverBoot = "obsidian";' in page


def test_app_csp_nonce_is_emitted_and_applied_to_inline_scripts(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    response = client.get("/app")

    assert response.status_code == 200
    csp = response.headers.get("Content-Security-Policy", "")
    nonce_match = re.search(r"script-src[^;]*'nonce-([^']+)'", csp)
    assert nonce_match, csp

    nonce = nonce_match.group(1)
    page = response.get_data(as_text=True)
    assert f'nonce="{nonce}"' in page


def test_app_csp_script_src_keeps_telegram_origin_and_nonce(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    response = client.get("/app")

    assert response.status_code == 200
    csp = response.headers.get("Content-Security-Policy", "")
    assert "script-src" in csp
    assert "https://telegram.org" in csp
    assert "'nonce-" in csp


def test_app_template_uses_server_message_length_limit(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path, max_message_len=123)
    client = server.app.test_client()

    response = client.get("/app")

    assert response.status_code == 200
    page = response.get_data(as_text=True)
    assert 'maxlength="123"' in page


def test_app_includes_quote_selection_controls(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    response = client.get("/app")

    assert response.status_code == 200
    page = response.get_data(as_text=True)
    assert 'id="selection-quote-button"' in page
    assert 'id="composer-quote-preview"' not in page
    assert 'id="composer-quote-apply"' not in page


def test_app_includes_per_message_copy_button(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()

    response = client.get("/app")

    assert response.status_code == 200
    page = response.get_data(as_text=True)
    assert 'class="message__copy"' in page
    assert 'aria-label="Copy message"' in page


def test_mobile_viewport_and_composer_zoom_guards_present() -> None:
    template = (Path(__file__).resolve().parents[1] / "templates" / "app.html").read_text(encoding="utf-8")
    css = (Path(__file__).resolve().parents[1] / "static" / "app.css").read_text(encoding="utf-8")

    assert "maximum-scale=1" in template
    assert "user-scalable=no" in template
    assert "@media (max-width: 860px)" in css
    assert "Keep mobile composer focus from triggering viewport zoom" in css
    assert "font-size: 16px;" in css
    assert "-webkit-text-size-adjust: none;" in css
    assert "text-size-adjust: none;" in css
    assert "margin-left: auto;" in css
    assert "margin-left: auto !important;" in css


def test_quote_selection_sync_is_debounced_in_client_script() -> None:
    script = (Path(__file__).resolve().parents[1] / "static" / "app.js").read_text(encoding="utf-8")

    assert "function scheduleSelectionQuoteSync" in script
    assert "function scheduleSelectionQuoteClear" in script
    assert "function cancelSelectionQuoteSettle" in script
    assert "selectionQuoteSettleTimer" in script
    assert "scheduleSelectionQuoteSync(140);" in script
    assert "cancelSelectionQuoteSync();" in script
    assert "const mobileQuoteMode = isCoarsePointer();" in script
    assert "selection-quote-button--docked" not in script
    assert "selectionQuoteButton.hidden = false;" in script
    assert "scheduleSelectionQuoteSync(220);" in script
    assert "scheduleSelectionQuoteClear(220);" in script
    assert "mobileToolbarUnsafeTop" in script
    assert "composerTop" in script
    assert "composer-quote-apply" not in script
    assert "const skipTouchDismiss = mobileQuoteMode && target === messagesEl;" in script
    assert "function formatQuoteBlock" in script
    assert "function unwrapLegacyQuoteBlock" in script
    assert "return `┌ Quote\\n${lines.join(\"\\n\")}\\n└\\n\\n\\n`;" in script
    assert "lines.push(line ? `│ ${line}` : \"│\");" in script
    assert "looksLikeLegacyFrame" in script
    assert "╭─ Quote ─" not in script
    assert "╰────────" not in script
    assert "\\n\\n\\n" in script


def test_detects_stale_chat_job_errors(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)

    assert server._is_stale_chat_job_error(KeyError("Chat 22 not found")) is True
    assert server._is_stale_chat_job_error(RuntimeError("Chat 22 not found")) is False
    assert server._is_stale_chat_job_error(KeyError("Message 22 not found")) is False


def test_chat_rejects_oversized_message_before_auth(monkeypatch, tmp_path) -> None:

    server = _load_server(monkeypatch, tmp_path, max_message_len=5)
    client = server.app.test_client()

    response = client.post("/api/chat", json={"message": "abcdef"})

    assert response.status_code == 400
    assert "exceeds" in response.get_json()["error"]


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


def test_create_chat_rejects_oversized_title_before_auth(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path, max_title_len=4)
    client = server.app.test_client()

    response = client.post("/api/chats", json={"title": "abcde"})

    assert response.status_code == 400
    assert "Title exceeds" in response.get_json()["error"]


def test_remove_chat_returns_replacement_active_chat(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    first_chat_id = server.store.ensure_default_chat("123")
    second_chat = server.store.create_chat("123", "Second")
    server.store.add_message("123", second_chat.id, "operator", "hello")

    response = client.post("/api/chats/remove", json={"init_data": "ok", "chat_id": second_chat.id})

    assert response.status_code == 200
    data = response.get_json()
    assert data["removed_chat_id"] == second_chat.id
    assert data["active_chat_id"] == first_chat_id
    assert data["active_chat"]["id"] == first_chat_id
    assert [chat["id"] for chat in data["chats"]] == [first_chat_id]
    assert data["history"] == []
    assert server.store.get_turn_count("123", second_chat.id) == 1


def test_remove_chat_cancels_open_stream_jobs(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    server.store.ensure_default_chat("123")
    removable = server.store.create_chat("123", "Busy")
    operator_message_id = server.store.add_message("123", removable.id, "operator", "in flight")
    job_id = server.store.enqueue_chat_job("123", removable.id, operator_message_id)

    response = client.post("/api/chats/remove", json={"init_data": "ok", "chat_id": removable.id})

    assert response.status_code == 200
    state = server.store.get_job_state(job_id)
    assert state is not None
    assert state["status"] == "dead"


def test_clear_chat_evicts_persistent_runtime(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    captured = {"session_id": None}
    monkeypatch.setattr(server.client, "evict_session", lambda session_id: captured.__setitem__("session_id", session_id) or True)

    chat_id = server.store.ensure_default_chat("123")
    server.store.add_message("123", chat_id, "operator", "x")

    response = client.post("/api/chats/clear", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 200
    assert captured["session_id"] == f"miniapp-123-{chat_id}"


def test_clear_chat_cancels_open_stream_jobs(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "in flight")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id)

    response = client.post("/api/chats/clear", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 200
    state = server.store.get_job_state(job_id)
    assert state is not None
    assert state["status"] == "dead"


def test_remove_chat_evicts_persistent_runtime(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    captured = {"session_id": None}
    monkeypatch.setattr(server.client, "evict_session", lambda session_id: captured.__setitem__("session_id", session_id) or True)

    default_chat_id = server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")

    response = client.post("/api/chats/remove", json={"init_data": "ok", "chat_id": alt_chat.id})

    assert response.status_code == 200
    assert captured["session_id"] == f"miniapp-123-{alt_chat.id}"
    assert response.get_json()["active_chat_id"] == default_chat_id


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


def test_stream_chat_rejects_when_open_job_exists(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "already running")
    server.store.enqueue_chat_job("123", chat_id, operator_message_id)

    response = client.post(
        "/api/chat/stream",
        json={"init_data": "ok", "chat_id": chat_id, "message": "second"},
    )

    assert response.status_code == 409
    body = response.get_data(as_text=True)
    assert "already working" in body


def test_stream_resume_rejects_when_no_open_job(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    chat_id = server.store.ensure_default_chat("123")
    response = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 409
    body = response.get_data(as_text=True)
    assert "No active Hermes job" in body


def test_stream_resume_replays_buffered_events_for_open_job(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "resume this")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id)
    claimed = server.store.claim_next_job()
    assert claimed is not None
    assert claimed["id"] == job_id

    server._publish_job_event(job_id, "tool", {"chat_id": chat_id, "display": "read_file: test"})
    server._publish_job_event(job_id, "done", {"chat_id": chat_id, "reply": "ok", "latency_ms": 1})

    response = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "event: tool" in body
    assert "read_file: test" in body
    assert "event: done" in body
    assert '"reply": "ok"' in body



def test_stream_resume_can_reconnect_multiple_times_to_same_open_job(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "resume this")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id)
    server.store.claim_next_job()

    server._publish_job_event(job_id, "tool", {"chat_id": chat_id, "display": "tool call"})
    server._publish_job_event(job_id, "done", {"chat_id": chat_id, "reply": "ok", "latency_ms": 1})

    first = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})
    assert first.status_code == 200
    assert "event: tool" in first.get_data(as_text=True)

    server._publish_job_event(job_id, "tool", {"chat_id": chat_id, "display": "tool call 2"})
    server._publish_job_event(job_id, "done", {"chat_id": chat_id, "reply": "ok", "latency_ms": 1})
    second = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})
    assert second.status_code == 200
    assert "event: tool" in second.get_data(as_text=True)


def test_chat_history_endpoint_can_read_without_activating(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    main_chat_id = server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")
    server.store.add_message("123", alt_chat.id, "hermes", "new reply")
    server.store.set_active_chat("123", main_chat_id)

    response = client.post(
        "/api/chats/history",
        json={"init_data": "ok", "chat_id": alt_chat.id, "activate": False},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert data["chat"]["id"] == alt_chat.id
    assert data["history"][-1]["body"] == "new reply"
    assert server.store.get_active_chat("123") == main_chat_id
    assert server.store.get_chat("123", alt_chat.id).unread_count == 1


def test_jobs_status_endpoint_returns_jobs_and_dead_letters(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "job")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id, max_attempts=1)
    server.store.claim_next_job()
    server.store.retry_or_dead_letter_job(job_id, "hard fail", retry_base_seconds=1)

    response = client.post("/api/jobs/status", json={"init_data": "ok", "limit": 10})

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert "summary" in data
    assert any(job["id"] == job_id for job in data["jobs"])
    assert data["summary"]["dead_letter_count"] >= 1


def test_jobs_cleanup_endpoint_dead_letters_stale_jobs(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    stale_chat = server.store.create_chat("123", "Stale")
    operator_message_id = server.store.add_message("123", stale_chat.id, "operator", "stale")
    job_id = server.store.enqueue_chat_job("123", stale_chat.id, operator_message_id)

    # Simulate stale open job by archiving the chat directly (legacy state).
    import sqlite3

    conn = sqlite3.connect(server.store.db_path)
    conn.execute("UPDATE chat_threads SET is_archived = 1 WHERE user_id = ? AND id = ?", ("123", stale_chat.id))
    conn.commit()
    conn.close()

    response = client.post("/api/jobs/cleanup", json={"init_data": "ok", "limit": 50})

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert data["cleaned_count"] >= 1
    assert any(item["job_id"] == job_id for item in data["cleaned"])

    state = server.store.get_job_state(job_id)
    assert state is not None
    assert state["status"] == "dead"


def test_jobs_status_endpoint_rejects_non_integer_limit(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    response = client.post("/api/jobs/status", json={"init_data": "ok", "limit": "abc"})

    assert response.status_code == 400
    assert "limit" in response.get_json()["error"].lower()


def test_jobs_cleanup_endpoint_rejects_non_integer_limit(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )

    response = client.post("/api/jobs/cleanup", json={"init_data": "ok", "limit": "abc"})

    assert response.status_code == 400
    assert "limit" in response.get_json()["error"].lower()


def test_runtime_status_endpoint_returns_persistent_stats(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test")),
    )
    monkeypatch.setattr(
        server.client,
        "runtime_status",
        lambda: {
            "persistent": {"enabled": True, "total": 2, "bootstrapped": 1, "unbootstrapped": 1},
            "routing": {
                "model": "gpt-5.3-codex",
                "provider": "openai-codex",
                "base_url": "https://chatgpt.com/backend-api/codex",
                "direct_agent_enabled": True,
                "persistent_sessions_enabled": True,
            },
        },
    )

    response = client.post("/api/runtime/status", json={"init_data": "ok"})

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert data["persistent"]["enabled"] is True
    assert data["persistent"]["total"] == 2
    assert data["routing"]["provider"] == "openai-codex"
    assert data["routing"]["direct_agent_enabled"] is True


def test_run_chat_job_skips_db_history_when_runtime_already_bootstrapped(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    server.store.add_message(user_id, chat_id, "operator", "older context")
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "latest question")
    server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = server.store.claim_next_job()
    assert job is not None

    captured = {"history": "unset"}

    monkeypatch.setattr(server.client, "should_include_conversation_history", lambda session_id: False)

    def fake_stream_events(*, user_id, message, conversation_history, session_id):
        captured["history"] = conversation_history
        yield {"type": "meta", "source": "agent-persistent"}
        yield {"type": "done", "reply": "ok", "latency_ms": 1}

    monkeypatch.setattr(server.client, "stream_events", fake_stream_events)

    server._run_chat_job(job)

    assert captured["history"] == []
    latest = server.store.get_history(user_id=user_id, chat_id=chat_id, limit=5)
    assert any(turn.role == "hermes" and "ok" in turn.body for turn in latest)


def test_run_chat_job_uses_runtime_checkpoint_when_bootstrapping(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "latest question")
    session_id = f"miniapp-{user_id}-{chat_id}"
    checkpoint_history = [
        {"role": "system", "content": "You are Hermes."},
        {"role": "user", "content": "Older user turn"},
    ]
    server.store.set_runtime_checkpoint(
        session_id=session_id,
        user_id=user_id,
        chat_id=chat_id,
        history=checkpoint_history,
    )

    server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = server.store.claim_next_job()
    assert job is not None

    captured = {"history": None}
    monkeypatch.setattr(server.client, "should_include_conversation_history", lambda session_id: True)

    def fake_stream_events(*, user_id, message, conversation_history, session_id):
        captured["history"] = conversation_history
        yield {"type": "meta", "source": "agent-persistent"}
        yield {"type": "done", "reply": "ok", "latency_ms": 1}

    monkeypatch.setattr(server.client, "stream_events", fake_stream_events)

    server._run_chat_job(job)

    assert captured["history"] == checkpoint_history


def test_run_chat_job_persists_runtime_checkpoint_from_done_event(monkeypatch, tmp_path) -> None:
    server = _load_server(monkeypatch, tmp_path)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "latest question")
    session_id = f"miniapp-{user_id}-{chat_id}"

    server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = server.store.claim_next_job()
    assert job is not None

    monkeypatch.setattr(server.client, "should_include_conversation_history", lambda session_id: False)

    checkpoint_history = [
        {"role": "system", "content": "You are Hermes."},
        {"role": "user", "content": "latest question"},
        {"role": "assistant", "content": "ok"},
    ]

    def fake_stream_events(*, user_id, message, conversation_history, session_id):
        yield {"type": "meta", "source": "agent-persistent"}
        yield {"type": "done", "reply": "ok", "latency_ms": 1, "runtime_checkpoint": checkpoint_history}

    monkeypatch.setattr(server.client, "stream_events", fake_stream_events)

    server._run_chat_job(job)

    stored = server.store.get_runtime_checkpoint(session_id)
    assert stored == checkpoint_history
