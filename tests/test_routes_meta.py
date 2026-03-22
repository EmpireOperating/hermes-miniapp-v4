from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

from server_test_utils import load_server as _load_server

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
