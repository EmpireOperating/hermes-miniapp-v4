from __future__ import annotations

import re
import time
from pathlib import Path

from server_test_utils import load_server


def _client(monkeypatch, tmp_path, **load_kwargs):
    server = load_server(monkeypatch, tmp_path, **load_kwargs)
    return server, server.app.test_client()


def _app_page(client) -> str:
    response = client.get("/app")
    assert response.status_code == 200
    return response.get_data(as_text=True)


def _read_repo_file(*parts: str) -> str:
    return (Path(__file__).resolve().parents[1].joinpath(*parts)).read_text(encoding="utf-8")


def _capture_request_debug_calls(server, monkeypatch) -> list[tuple[object, ...]]:
    calls: list[tuple[object, ...]] = []
    monkeypatch.setattr(server.app.logger, "info", lambda *args, **kwargs: calls.append(args))
    return calls


def test_health_includes_security_headers(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert "X-Frame-Options" not in response.headers
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert "Content-Security-Policy" in response.headers
    assert "Permissions-Policy" in response.headers

def test_create_app_returns_flask_app(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    app = server.create_app()

    assert app is server.app


def test_server_reload_shuts_down_previous_runtime_threads(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    old_runtime = server.runtime
    old_worker_threads = list(old_runtime._worker_threads)
    old_watchdog = old_runtime._watchdog_thread

    reloaded = load_server(monkeypatch, tmp_path)

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        workers_stopped = all(not thread.is_alive() for thread in old_worker_threads)
        watchdog_stopped = old_watchdog is None or not old_watchdog.is_alive()
        if workers_stopped and watchdog_stopped:
            break
        time.sleep(0.02)

    assert reloaded.runtime is not old_runtime
    assert all(not thread.is_alive() for thread in old_worker_threads)
    assert old_watchdog is None or not old_watchdog.is_alive()


def test_enforced_origin_check_rejects_disallowed_origin(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_ALLOWED_ORIGINS", "https://allowed.example")
    monkeypatch.setenv("MINI_APP_ENFORCE_ORIGIN_CHECK", "1")
    server, client = _client(monkeypatch, tmp_path, isolate_security_env=False)

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
    server, client = _client(monkeypatch, tmp_path, isolate_security_env=False)

    response = client.post(
        "/api/chats",
        json={"init_data": "ok", "title": "x"},
        headers={"Referer": "https://allowed.example/app"},
    )

    # Origin gate should pass via Referer fallback; auth still fails on dummy init_data.
    assert response.status_code == 401

def test_rate_limit_helper_enforces_limit(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    key = "test-rate-limit"
    assert server._check_rate_limit(key=key, limit=1, window_seconds=60) is True
    assert server._check_rate_limit(key=key, limit=1, window_seconds=60) is False

def test_rate_limit_ignores_x_forwarded_for_when_proxy_headers_disabled(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_TRUST_PROXY_HEADERS", "0")
    monkeypatch.setenv("MINI_APP_RATE_LIMIT_API_REQUESTS", "10")
    server, client = _client(monkeypatch, tmp_path)

    for i in range(10):
        response = client.get("/api/state", headers={"X-Forwarded-For": f"198.51.100.{i}"})
        assert response.status_code == 200

    blocked = client.get("/api/state", headers={"X-Forwarded-For": "203.0.113.77"})
    assert blocked.status_code == 429

def test_stream_rate_limit_blocks_burst_reconnects(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_RATE_LIMIT_STREAM_REQUESTS", "3")
    server, client = _client(monkeypatch, tmp_path)

    for _ in range(3):
        response = client.post("/api/chat/stream/resume", json={"init_data": "ok"})
        assert response.status_code in {400, 401, 404, 409}

    blocked = client.post("/api/chat/stream/resume", json={"init_data": "ok"})
    assert blocked.status_code == 429

def test_rate_limit_scopes_authenticated_requests_by_user(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_RATE_LIMIT_API_REQUESTS", "1")
    server = load_server(monkeypatch, tmp_path)

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
    server, client = _client(monkeypatch, tmp_path, max_content_length=128)

    response = client.post("/api/auth", json={"init_data": "x" * 400})

    assert response.status_code == 413

def test_app_boots_skin_from_cookie(monkeypatch, tmp_path) -> None:
    _, client = _client(monkeypatch, tmp_path)

    client.set_cookie("hermes_skin", "obsidian")
    page = _app_page(client)
    assert 'data-skin="obsidian"' in page
    assert 'const serverBoot = "obsidian";' in page

def test_app_csp_nonce_is_emitted_and_applied_to_inline_scripts(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/app")

    assert response.status_code == 200
    csp = response.headers.get("Content-Security-Policy", "")
    nonce_match = re.search(r"script-src[^;]*'nonce-([^']+)'", csp)
    assert nonce_match, csp

    nonce = nonce_match.group(1)
    page = response.get_data(as_text=True)
    assert f'nonce="{nonce}"' in page

def test_app_csp_script_src_keeps_telegram_origin_and_nonce(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/app")

    assert response.status_code == 200
    csp = response.headers.get("Content-Security-Policy", "")
    assert "script-src" in csp
    assert "https://telegram.org" in csp
    assert "'nonce-" in csp

def test_app_template_uses_server_message_length_limit(monkeypatch, tmp_path) -> None:
    _, client = _client(monkeypatch, tmp_path, max_message_len=123)
    page = _app_page(client)
    assert 'maxlength="123"' in page

def test_app_includes_quote_selection_controls(monkeypatch, tmp_path) -> None:
    _, client = _client(monkeypatch, tmp_path)
    page = _app_page(client)
    assert 'id="selection-quote-button"' in page
    assert 'id="composer-quote-preview"' not in page
    assert 'id="composer-quote-apply"' not in page

def test_app_includes_per_message_copy_button(monkeypatch, tmp_path) -> None:
    _, client = _client(monkeypatch, tmp_path)
    page = _app_page(client)
    assert 'class="message__copy"' in page
    assert 'aria-label="Copy message"' in page


def test_app_uses_independent_js_asset_versions(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    def fake_asset_version(filename: str) -> str:
        return {
            "app.css": "css-v",
            "runtime_helpers.js": "helpers-v",
            "app_shared_utils.js": "shared-v",
            "chat_ui_helpers.js": "chat-ui-v",
            "chat_tabs_helpers.js": "chat-tabs-v",
            "message_actions_helpers.js": "actions-v",
            "stream_state_helpers.js": "stream-state-v",
            "stream_controller.js": "stream-controller-v",
            "composer_state_helpers.js": "composer-v",
            "keyboard_shortcuts_helpers.js": "keyboard-v",
            "interaction_helpers.js": "interaction-v",
            "bootstrap_auth_helpers.js": "bootstrap-auth-v",
            "chat_history_helpers.js": "chat-history-v",
            "chat_admin_helpers.js": "chat-admin-v",
            "shell_ui_helpers.js": "shell-ui-v",
            "composer_viewport_helpers.js": "composer-viewport-v",
            "visibility_skin_helpers.js": "visibility-skin-v",
            "startup_bindings_helpers.js": "startup-bindings-v",
            "render_trace_helpers.js": "render-trace-v",
            "file_preview_helpers.js": "file-preview-v",
            "app.js": "app-v",
        }[filename]

    monkeypatch.setattr(server, "_asset_version", fake_asset_version)
    response = client.get("/app")

    assert response.status_code == 200
    page = response.get_data(as_text=True)
    runtime_src = '/static/runtime_helpers.js?v=helpers-v'
    shared_src = '/static/app_shared_utils.js?v=shared-v'
    chat_ui_src = '/static/chat_ui_helpers.js?v=chat-ui-v'
    chat_tabs_src = '/static/chat_tabs_helpers.js?v=chat-tabs-v'
    actions_src = '/static/message_actions_helpers.js?v=actions-v'
    stream_state_src = '/static/stream_state_helpers.js?v=stream-state-v'
    stream_controller_src = '/static/stream_controller.js?v=stream-controller-v'
    composer_src = '/static/composer_state_helpers.js?v=composer-v'
    keyboard_src = '/static/keyboard_shortcuts_helpers.js?v=keyboard-v'
    interaction_src = '/static/interaction_helpers.js?v=interaction-v'
    bootstrap_auth_src = '/static/bootstrap_auth_helpers.js?v=bootstrap-auth-v'
    chat_history_src = '/static/chat_history_helpers.js?v=chat-history-v'
    chat_admin_src = '/static/chat_admin_helpers.js?v=chat-admin-v'
    shell_ui_src = '/static/shell_ui_helpers.js?v=shell-ui-v'
    composer_viewport_src = '/static/composer_viewport_helpers.js?v=composer-viewport-v'
    visibility_skin_src = '/static/visibility_skin_helpers.js?v=visibility-skin-v'
    startup_bindings_src = '/static/startup_bindings_helpers.js?v=startup-bindings-v'
    render_trace_src = '/static/render_trace_helpers.js?v=render-trace-v'
    file_preview_src = '/static/file_preview_helpers.js?v=file-preview-v'
    app_src = '/static/app.js?v=app-v'
    assert runtime_src in page
    assert shared_src in page
    assert chat_ui_src in page
    assert chat_tabs_src in page
    assert actions_src in page
    assert stream_state_src in page
    assert stream_controller_src in page
    assert composer_src in page
    assert keyboard_src in page
    assert interaction_src in page
    assert bootstrap_auth_src in page
    assert chat_history_src in page
    assert chat_admin_src in page
    assert shell_ui_src in page
    assert composer_viewport_src in page
    assert visibility_skin_src in page
    assert startup_bindings_src in page
    assert render_trace_src in page
    assert file_preview_src in page
    assert app_src in page
    assert page.index(runtime_src) < page.index(shared_src) < page.index(chat_ui_src) < page.index(chat_tabs_src) < page.index(actions_src) < page.index(stream_state_src) < page.index(stream_controller_src) < page.index(composer_src) < page.index(keyboard_src) < page.index(interaction_src) < page.index(bootstrap_auth_src) < page.index(chat_history_src) < page.index(chat_admin_src) < page.index(shell_ui_src) < page.index(composer_viewport_src) < page.index(visibility_skin_src) < page.index(startup_bindings_src) < page.index(render_trace_src) < page.index(file_preview_src) < page.index(app_src)


def test_app_hides_dev_stream_and_source_pills_from_main_ui(monkeypatch, tmp_path) -> None:
    _server, client = _client(monkeypatch, tmp_path)

    response = client.get("/app")

    assert response.status_code == 200
    page = response.get_data(as_text=True)
    assert 'id="latency-chip"' in page
    assert 'id="source-chip"' not in page
    assert 'id="stream-chip"' not in page
    assert 'id="dev-mode-badge"' not in page


def test_runtime_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/runtime_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_shared_utils_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/app_shared_utils.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_chat_ui_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/chat_ui_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_chat_tabs_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/chat_tabs_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_message_actions_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/message_actions_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_stream_state_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/stream_state_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_stream_controller_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/stream_controller.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_composer_state_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/composer_state_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_keyboard_shortcuts_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/keyboard_shortcuts_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_interaction_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/interaction_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_bootstrap_auth_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/bootstrap_auth_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_chat_history_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/chat_history_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_chat_admin_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/chat_admin_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_shell_ui_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/shell_ui_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_composer_viewport_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/composer_viewport_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_visibility_skin_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/visibility_skin_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_startup_bindings_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/startup_bindings_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_render_trace_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/render_trace_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_file_preview_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/file_preview_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_request_debug_logging_disabled_by_default(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("MINI_APP_OPERATOR_DEBUG", raising=False)
    monkeypatch.delenv("MINIAPP_OPERATOR_DEBUG", raising=False)
    monkeypatch.delenv("MINI_APP_REQUEST_DEBUG", raising=False)
    monkeypatch.delenv("MINIAPP_REQUEST_DEBUG", raising=False)
    server = load_server(monkeypatch, tmp_path)

    calls = _capture_request_debug_calls(server, monkeypatch)

    with server.app.test_request_context("/health", method="GET", headers={"User-Agent": "UA"}):
        server._log_request_debug()

    assert calls == []


def test_request_debug_logging_enabled_via_canonical_env(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_OPERATOR_DEBUG", "1")
    monkeypatch.setenv("MINI_APP_REQUEST_DEBUG", "1")
    monkeypatch.delenv("MINIAPP_REQUEST_DEBUG", raising=False)
    server = load_server(monkeypatch, tmp_path)

    calls = _capture_request_debug_calls(server, monkeypatch)

    with server.app.test_request_context("/health", method="GET", headers={"User-Agent": "UA"}):
        server._log_request_debug()

    assert len(calls) == 1
    assert calls[0][0] == "miniapp req method=%s path=%s host=%s ua=%s"


def test_request_debug_logging_enabled_via_legacy_env(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("MINI_APP_REQUEST_DEBUG", raising=False)
    monkeypatch.setenv("MINIAPP_OPERATOR_DEBUG", "1")
    monkeypatch.setenv("MINIAPP_REQUEST_DEBUG", "1")
    server = load_server(monkeypatch, tmp_path)

    calls = _capture_request_debug_calls(server, monkeypatch)

    with server.app.test_request_context("/health", method="GET", headers={"User-Agent": "UA"}):
        server._log_request_debug()

    assert len(calls) == 1
    assert calls[0][0] == "miniapp req method=%s path=%s host=%s ua=%s"


def test_request_debug_redacts_sensitive_query_params(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_OPERATOR_DEBUG", "1")
    monkeypatch.setenv("MINI_APP_REQUEST_DEBUG", "1")
    server = load_server(monkeypatch, tmp_path)

    calls = _capture_request_debug_calls(server, monkeypatch)

    with server.app.test_request_context("/app?dev_secret=supersecret&safe=1", method="GET", headers={"User-Agent": "UA"}):
        server._log_request_debug()

    assert len(calls) == 1
    assert calls[0][2] == "/app?dev_secret=%5Bredacted%5D&safe=1"


def test_app_dev_config_exposes_request_debug_flag(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_OPERATOR_DEBUG", "1")
    monkeypatch.setenv("MINI_APP_REQUEST_DEBUG", "1")
    monkeypatch.delenv("MINIAPP_REQUEST_DEBUG", raising=False)
    _, client = _client(monkeypatch, tmp_path)

    page = _app_page(client)

    assert "window.__HERMES_DEV__" in page
    assert "requestDebug: true" in page
    assert 'id="render-trace-badge"' in page


def test_app_hides_dev_auth_controls_when_dev_features_are_disabled(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("MINI_APP_OPERATOR_DEBUG", raising=False)
    monkeypatch.delenv("MINI_APP_REQUEST_DEBUG", raising=False)
    monkeypatch.delenv("MINIAPP_REQUEST_DEBUG", raising=False)
    monkeypatch.delenv("MINIAPP_DEV_BYPASS", raising=False)
    monkeypatch.delenv("MINIAPP_DEV_BYPASS_EXPIRES_AT", raising=False)
    _, client = _client(monkeypatch, tmp_path)

    page = _app_page(client)

    assert 'id="render-trace-badge"' in page
    assert 'id="dev-auth-controls"' not in page
    assert 'id="dev-signin-button"' not in page


def test_app_dev_config_exposes_dev_auth_flag(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINIAPP_DEV_BYPASS", "1")
    _, client = _client(monkeypatch, tmp_path)

    page = _app_page(client)

    assert "devAuthEnabled: true" in page
    assert 'devAuthRevealHash: "#dev-auth"' in page
    assert 'id="dev-auth-controls"' not in page
    assert 'id="dev-signin-button"' in page
    assert 'id="dev-auth-modal"' in page
    assert 'id="dev-auth-secret"' in page


def test_app_dev_config_hides_expired_dev_auth_flag(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINIAPP_DEV_BYPASS", "1")
    monkeypatch.setenv("MINIAPP_DEV_BYPASS_EXPIRES_AT", "1")
    _, client = _client(monkeypatch, tmp_path)

    page = _app_page(client)

    assert "devAuthEnabled: false" in page
    assert 'devAuthRevealHash: "#dev-auth"' in page


def test_app_dev_config_exposes_bootstrap_version(monkeypatch, tmp_path) -> None:
    _, client = _client(monkeypatch, tmp_path)

    page = _app_page(client)

    assert "window.__HERMES_BOOTSTRAP_VERSION__ = \"" in page


def test_api_state_exposes_bootstrap_version(monkeypatch, tmp_path) -> None:
    _, client = _client(monkeypatch, tmp_path)

    response = client.get("/api/state")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert isinstance(payload.get("bootstrap_version"), str)
    assert payload["bootstrap_version"]


def test_startup_auth_allows_empty_chat_state() -> None:
    app_script = _read_repo_file("static", "app.js")

    assert 'body: JSON.stringify({ init_data: initData, allow_empty: true })' in app_script



def test_desktop_dev_auth_bootstrap_guards_present() -> None:
    app_script = _read_repo_file("static", "app.js")
    template = _read_repo_file("templates", "app.html")
    bootstrap_auth_script = _read_repo_file("static", "bootstrap_auth_helpers.js")
    chat_tabs_script = _read_repo_file("static", "chat_tabs_helpers.js")
    chat_history_script = _read_repo_file("static", "chat_history_helpers.js")
    chat_admin_script = _read_repo_file("static", "chat_admin_helpers.js")
    shell_ui_script = _read_repo_file("static", "shell_ui_helpers.js")
    composer_viewport_script = _read_repo_file("static", "composer_viewport_helpers.js")
    visibility_skin_script = _read_repo_file("static", "visibility_skin_helpers.js")
    startup_bindings_script = _read_repo_file("static", "startup_bindings_helpers.js")
    render_trace_script = _read_repo_file("static", "render_trace_helpers.js")
    file_preview_script = _read_repo_file("static", "file_preview_helpers.js")

    assert "HermesMiniappBootstrapAuth" in bootstrap_auth_script
    assert "function createController(deps)" in bootstrap_auth_script
    assert "function authPayload(extra = {})" in bootstrap_auth_script
    assert "async function safeReadJson(response)" in bootstrap_auth_script
    assert "function summarizeUiFailure(rawBody" in bootstrap_auth_script
    assert "function parseStreamErrorPayload(rawBody)" in bootstrap_auth_script
    assert "async function askForDevAuth" in bootstrap_auth_script
    assert 'fetchImpl("/api/dev/auth"' in bootstrap_auth_script
    assert 'const devAuthRevealHash = String(devConfig.devAuthRevealHash || "#dev-auth").trim() || "#dev-auth";' in app_script
    assert 'const currentLocationHash = typeof window?.location?.hash === "string" ? window.location.hash : "";' in app_script
    assert 'const desktopTestingRequested = currentLocationHash === devAuthRevealHash || currentLocationHash.startsWith(`${devAuthRevealHash}:`);' in app_script
    assert 'const desktopTestingEnabled = Boolean(devConfig.devAuthEnabled) && desktopTestingRequested;' in app_script
    assert 'const devAuthHashSecret = desktopTestingRequested && currentLocationHash.startsWith(`${devAuthRevealHash}:`)' in app_script
    assert 'appendSystemMessage("Dev auth is currently disabled. Enable the bypass flag, then reload /app#dev-auth.");' in app_script
    assert "bootstrapAuthHelpers.createController({" in app_script
    assert "bootstrapAuthController.authPayload(extra)" in app_script
    assert "bootstrapAuthController.safeReadJson(response)" in app_script
    assert "bootstrapAuthController.summarizeUiFailure(rawBody, { status, fallback })" in app_script
    assert "bootstrapAuthController.parseStreamErrorPayload(rawBody)" in app_script
    assert "function getMissingBootstrapBindings()" in app_script
    assert "function fetchAuthBootstrapWithRetry()" in app_script
    assert "function maybeRefreshForBootstrapVersionMismatch()" in app_script
    assert 'throw new Error("HermesMiniappBootstrapAuth is required before app.js")' in app_script
    assert "HermesMiniappChatTabs" in chat_tabs_script
    assert "function createController(deps)" in chat_tabs_script
    assert "chatTabsHelpers.createController({" in app_script
    assert 'throw new Error("HermesMiniappChatTabs is required before app.js")' in app_script
    assert "HermesMiniappChatHistory" in chat_history_script
    assert "function createController(deps)" in chat_history_script
    assert "function createMetaController(deps)" in chat_history_script
    assert "function addLocalMessage(chatId, message)" in chat_history_script
    assert "function updatePendingAssistant(chatId, nextBody, pendingState = true)" in chat_history_script
    assert "function syncActiveMessageView(chatId, options = {})" in chat_history_script
    assert "function scheduleActiveMessageView(chatId)" in chat_history_script
    assert "function maybeMarkRead(chatId, { force = false } = {})" in chat_history_script
    assert "chatHistoryHelpers.createController({" in app_script
    assert "chatHistoryHelpers.createMetaController({" in app_script
    assert "activeChatMetaController.setActiveChatMeta(chatId, options)" in app_script
    assert "activeChatMetaController.setNoActiveChatMeta()" in app_script
    assert "chatHistoryController.addLocalMessage(chatId, message)" in app_script
    assert "chatHistoryController.updatePendingAssistant(chatId, nextBody, pendingState)" in app_script
    assert "chatHistoryController.syncActiveMessageView(chatId, options)" in app_script
    assert "chatHistoryController.scheduleActiveMessageView(chatId)" in app_script
    assert "chatHistoryController.maybeMarkRead(chatId, options)" in app_script
    assert 'throw new Error("HermesMiniappChatHistory is required before app.js")' in app_script
    assert "HermesMiniappChatAdmin" in chat_admin_script
    assert "function createController(deps)" in chat_admin_script
    assert "async function askForChatTitle" in chat_admin_script
    assert "function closeChatTabContextMenu()" in chat_admin_script
    assert "function openChatTabContextMenu(chatId, clientX, clientY)" in chat_admin_script
    assert "function handleTabOverflowTriggerClick(event)" in chat_admin_script
    assert "function handleGlobalChatContextMenuDismiss(event)" in chat_admin_script
    assert "async function handleTabContextForkClick(event)" in chat_admin_script
    assert "chatAdminHelpers.createController({" in app_script
    assert "chatAdminController.closeChatTabContextMenu()" in app_script
    assert "chatAdminController.openChatTabContextMenu(chatId, clientX, clientY)" in app_script
    assert "chatAdminController.handleTabOverflowTriggerClick(event)" in app_script
    assert "chatAdminController.handleGlobalChatContextMenuDismiss(event)" in app_script
    assert "chatAdminController.handleTabContextForkClick(event)" in app_script
    assert 'throw new Error("HermesMiniappChatAdmin is required before app.js")' in app_script
    assert "HermesMiniappShellUI" in shell_ui_script
    assert "function createController(deps)" in shell_ui_script
    assert "function syncFullscreenControlState()" in shell_ui_script
    assert "shellUiHelpers.createController({" in app_script
    assert 'throw new Error("HermesMiniappShellUI is required before app.js")' in app_script
    assert "HermesMiniappComposerViewport" in composer_viewport_script
    assert "function createController(deps)" in composer_viewport_script
    assert "function ensureComposerVisible" in composer_viewport_script
    assert "composerViewportHelpers.createController({" in app_script
    assert 'throw new Error("HermesMiniappComposerViewport is required before app.js")' in app_script
    assert "HermesMiniappVisibilitySkin" in visibility_skin_script
    assert "function createController(deps)" in visibility_skin_script
    assert "function handleVisibilityChange()" in visibility_skin_script
    assert "visibilitySkinHelpers.createController({" in app_script
    assert 'throw new Error("HermesMiniappVisibilitySkin is required before app.js")' in app_script
    assert "HermesMiniappStartupBindings" in startup_bindings_script
    assert "function createController(deps)" in startup_bindings_script
    assert "function installCoreEventBindings()" in startup_bindings_script
    assert "startupBindingsHelpers.createController({" in app_script
    assert 'throw new Error("HermesMiniappStartupBindings is required before app.js")' in app_script
    assert "HermesMiniappRenderTrace" in render_trace_script
    assert "function createController(deps)" in render_trace_script
    assert "function renderBody(container, rawText" in render_trace_script
    assert "function renderToolTraceBody(container, message" in render_trace_script
    assert "function roleLabelForMessage(message" in render_trace_script
    assert "function messageVariantForRole(role)" in render_trace_script
    assert "function shouldSkipMessageRender({ role, renderedBody, pending })" in render_trace_script
    assert "function applyMessageMeta(node, message" in render_trace_script
    assert "function renderMessageContent(node, message, renderedBody" in render_trace_script
    assert "function messageStableKey(message, index = 0)" in render_trace_script
    assert "function messageStableKeyForPendingState(message, index = 0, pendingState = false)" in render_trace_script
    assert "function upsertMessageNode(node, message" in render_trace_script
    assert "function createMessageNode(message," in render_trace_script
    assert "function appendMessages(fragment, messages" in render_trace_script
    assert "function findMessageNodeByKey(container, selector, messageKey, alternateMessageKey = \"\")" in render_trace_script
    assert "function findLatestHistoryMessageByRole(history, role" in render_trace_script
    assert "function findLatestAssistantHistoryMessage(history," in render_trace_script
    assert "function patchVisiblePendingAssistant({" in render_trace_script
    assert "function patchVisibleToolTrace({" in render_trace_script
    assert "function renderTraceLog(eventName, details = null)" in render_trace_script
    assert "renderTraceHelpers.createController({" in app_script
    assert "renderTraceHelpers.renderBody(container, rawText" in app_script
    assert "renderTraceHelpers.renderToolTraceBody(container, message" in app_script
    assert "renderTraceHelpers.messageVariantForRole(role)" in app_script
    assert "renderTraceHelpers.shouldSkipMessageRender({ role, renderedBody, pending })" in app_script
    assert "renderTraceHelpers.applyMessageMeta(node, message" in app_script
    assert "renderTraceHelpers.renderMessageContent(node, message, renderedBody" in app_script
    assert "renderTraceHelpers.messageStableKey(message, index)" in app_script
    assert "renderTraceHelpers.messageStableKeyForPendingState(message, index, pendingState)" in app_script
    assert "renderTraceHelpers.upsertMessageNode(node, message" in app_script
    assert "renderTraceHelpers.createMessageNode(message, {" in app_script
    assert "renderTraceHelpers.appendMessages(fragment, messages, {" in app_script
    assert "renderTraceHelpers.findMessageNodeByKey(messagesEl, selector, messageKey, alternateMessageKey)" in app_script
    assert "renderTraceHelpers.findLatestHistoryMessageByRole(histories.get(Number(chatId)) || [], role" in app_script
    assert "renderTraceHelpers.findLatestAssistantHistoryMessage(histories.get(Number(chatId)) || [], {" in app_script
    assert "renderTraceHelpers.patchVisiblePendingAssistant({" in app_script
    assert "renderTraceHelpers.patchVisibleToolTrace({" in app_script
    assert 'throw new Error("HermesMiniappRenderTrace is required before app.js")' in app_script
    assert "HermesMiniappFilePreview" in file_preview_script
    assert "function createController(deps)" in file_preview_script
    assert "async function openFilePreview" in file_preview_script
    assert "function handleMessageFileRefClick(event)" in file_preview_script
    assert "filePreviewHelpers.createController({" in app_script
    assert 'throw new Error("HermesMiniappFilePreview is required before app.js")' in app_script
    assert "chat-title-modal" in template
    assert '{% if dev_auth_enabled %}' in template
    assert "dev-auth-modal" in template
    assert "dev-auth-secret" in template
    assert "tg?.initData || \"\"" in app_script
    assert "Telegram connection missing" not in app_script
    assert "dev_secret" not in app_script


def test_resume_keeps_existing_latency_value_instead_of_recalculating_flash() -> None:
    app_script = _read_repo_file("static", "app.js")

    assert 'syncActiveLatencyChip();' in app_script
    assert 'setActivityChip(latencyChip, "latency: recalculating...");' not in app_script
    assert 'setChatLatency(key, "recalculating...");' not in app_script


def test_stream_resume_and_graceful_completion_helpers_are_centralized() -> None:
    app_script = _read_repo_file("static", "app.js")

    assert "async function hydrateChatAfterGracefulResumeCompletion" in app_script
    assert "async function consumeStreamWithReconnect" in app_script
    assert 'await hydrateChatAfterGracefulResumeCompletion(key);' in app_script
    assert 'const resumed = await consumeStreamWithReconnect(chatId, response, builtReplyRef' in app_script
    assert 'const resumed = await consumeStreamWithReconnect(key, response, builtReplyRef' in app_script


def test_mobile_viewport_and_composer_zoom_guards_present() -> None:
    template = _read_repo_file("templates", "app.html")
    css = _read_repo_file("static", "app.css")

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
    app_script = _read_repo_file("static", "app.js")
    interaction_script = _read_repo_file("static", "interaction_helpers.js")

    assert "function scheduleSelectionQuoteSync" in app_script
    assert "function scheduleSelectionQuoteClear" in app_script
    assert "function cancelSelectionQuoteSettle" in app_script
    assert "selectionQuoteSettleTimer" in app_script
    assert "const mobileQuoteMode = isCoarsePointer();" in app_script
    assert "selection-quote-button--docked" not in app_script
    assert "interactionHelpers.showSelectionQuoteAction(" in app_script
    assert "mobileToolbarUnsafeTop" in interaction_script
    assert "composerTop" in interaction_script
    assert "composer-quote-apply" not in app_script
    assert "function formatQuoteBlock" in app_script
    assert "function unwrapLegacyQuoteBlock" in app_script
    assert "return `┌ Quote\\n${lines.join(\"\\n\")}\\n└\\n\\n\\n`;" in interaction_script
    assert "lines.push(line ? `│ ${line}` : \"│\");" in interaction_script
    assert "looksLikeLegacyFrame" in interaction_script
    assert "╭─ Quote ─" not in app_script
    assert "╰────────" not in app_script
    assert "\\n\\n\\n" in interaction_script

    assert "HermesMiniappInteraction" in interaction_script
    assert "function createSelectionQuoteController" in interaction_script
    assert "function showSelectionQuoteAction" in interaction_script
    assert "function syncSelectionQuoteAction" in interaction_script
    assert "function clearSelectionQuoteState" in interaction_script
    assert "function cancelSelectionQuoteTimer" in interaction_script
    assert "function scheduleSelectionQuoteClear" in interaction_script
    assert "function scheduleSelectionQuoteSync" in interaction_script
    assert "function applyQuoteIntoPrompt" in interaction_script
    assert "scheduleSelectionQuoteSync(140);" in interaction_script
    assert "scheduleSelectionQuoteSync(220);" in interaction_script
    assert "scheduleSelectionQuoteClear(220);" in interaction_script
    assert "cancelSelectionQuoteSync();" in interaction_script
    assert "handleComposerSubmitShortcut" in interaction_script


def test_pinned_chat_mvp_ui_wiring_present_in_client_script() -> None:
    template = _read_repo_file("templates", "app.html")
    script = _read_repo_file("static", "app.js")
    chat_ui_script = _read_repo_file("static", "chat_ui_helpers.js")
    chat_tabs_script = _read_repo_file("static", "chat_tabs_helpers.js")
    chat_admin_script = _read_repo_file("static", "chat_admin_helpers.js")

    assert 'id="pin-chat"' in template
    assert 'id="pinned-chats-wrap"' in template
    assert 'id="pinned-chats"' in template
    assert 'id="pinned-chats-toggle"' in template
    assert "chat-tab__pin" in template

    assert "HermesMiniappChatUI" in chat_ui_script
    assert "function renderPinnedChats" in chat_ui_script
    assert "HermesMiniappChatTabs" in chat_tabs_script
    assert "function syncChats" in chat_tabs_script
    assert "function syncPinnedChatsCollapseUi" in chat_tabs_script
    assert "HermesMiniappChatAdmin" in chat_admin_script
    assert "function syncPinnedChats" in script
    assert "function renderPinnedChats" in script
    assert "function toggleActiveChatPin" in script
    assert "function openPinnedChat" in script
    assert "function handlePinnedChatClick" in script
    assert "function syncPinnedChatsCollapseUi" in script
    assert "function togglePinnedChatsCollapsed" in script
    assert "function installActionButtonBindings()" in script
    assert "function installCoreEventBindings()" in script
    assert "startupBindingsController.installActionButtonBindings();" in script
    assert "startupBindingsController.installCoreEventBindings();" in script
    assert 'node.classList.toggle("is-pinned", Boolean(chat.is_pinned));' in chat_ui_script
    assert 'const pinEl = node.querySelector(".chat-tab__pin");' in chat_ui_script
    assert 'if (pinEl) {' in chat_ui_script
    assert 'pinEl.textContent = chat.is_pinned ? "📌" : "";' in chat_ui_script
    assert "pinChatButton.textContent = chat?.is_pinned ? 'Unpin chat' : 'Pin chat';" in chat_tabs_script

    # Close tab should be silent (no confirm helper UX); it only removes from active tabs via API.
    # Pinned chats should remain visible in the pinned section after close.
    assert 'const ok = await confirmAction(`Close chat' not in script
    assert "async function removeActiveChat()" in chat_admin_script
    assert 'const data = await apiPost(\'/api/chats/remove\', { chat_id: activeChatId, allow_empty: true });' in chat_admin_script
    assert 'const removedChatSnapshot = chats.get(activeChatId) || pinnedChats.get(activeChatId) || null;' in chat_admin_script
    assert 'if (removedWasPinned && !pinnedChats.has(activeChatId) && removedChatSnapshot) {' in chat_admin_script


def test_message_action_copy_helpers_are_split_to_module() -> None:
    template = _read_repo_file("templates", "app.html")
    script = _read_repo_file("static", "app.js")
    actions_script = _read_repo_file("static", "message_actions_helpers.js")
    keyboard_script = _read_repo_file("static", "keyboard_shortcuts_helpers.js")
    interaction_script = _read_repo_file("static", "interaction_helpers.js")

    assert "HermesMiniappMessageActions" in actions_script
    assert "function bindMessageCopyHandler" in actions_script
    assert "createMessageCopyState" in actions_script
    assert "bindMessageCopyHandler({" in script
    assert "messageActionsHelpers.createMessageCopyState()" in script
    assert "HermesMiniappKeyboardShortcuts" in keyboard_script
    assert "function createController(deps)" in keyboard_script
    assert "function handleGlobalTabCycle" in keyboard_script
    assert "keyboardShortcutsHelpers.createController({" in script
    assert "keyboardShortcutsController.handleGlobalTabCycle(event)" in script
    assert "HermesMiniappInteraction" in interaction_script
    assert "function createSelectionQuoteController" in interaction_script
    assert "interactionHelpers.createSelectionQuoteController" in script
    assert "interactionHelpers.handleComposerSubmitShortcut" in script
    assert 'window.__HERMES_BOOTSTRAP_VERSION__ = "{{ bootstrap_version }}";' in template
    assert '/static/chat_tabs_helpers.js?v={{ chat_tabs_helpers_version }}' in template
    assert '/static/message_actions_helpers.js?v={{ message_actions_helpers_version }}' in template
    assert '/static/stream_controller.js?v={{ stream_controller_version }}' in template
    assert '/static/composer_state_helpers.js?v={{ composer_state_helpers_version }}' in template
    assert '/static/keyboard_shortcuts_helpers.js?v={{ keyboard_shortcuts_helpers_version }}' in template
    assert '/static/interaction_helpers.js?v={{ interaction_helpers_version }}' in template
    assert '/static/shell_ui_helpers.js?v={{ shell_ui_helpers_version }}' in template
    assert '/static/composer_viewport_helpers.js?v={{ composer_viewport_helpers_version }}' in template
    assert '/static/visibility_skin_helpers.js?v={{ visibility_skin_helpers_version }}' in template
    assert '/static/startup_bindings_helpers.js?v={{ startup_bindings_helpers_version }}' in template
    assert '/static/render_trace_helpers.js?v={{ render_trace_helpers_version }}' in template
    assert '/static/file_preview_helpers.js?v={{ file_preview_helpers_version }}' in template
    assert 'id="file-preview-modal"' in template
    assert 'id="file-preview-lines"' in template
    assert 'id="file-preview-expand-up"' in template
    assert 'id="file-preview-load-full"' in template
    assert 'id="file-preview-expand-down"' in template
    assert 'id="file-preview-close"' in template
    assert 'window.__HERMES_FILE_PREVIEW__ = {' in template
    assert "enabled: {{ 'true' if file_preview_enabled else 'false' }}" in template
    assert 'allowedRoots: {{ file_preview_allowed_roots_json|safe }}' in template
    assert 'const filePreviewFeatureEnabled = Boolean(filePreviewConfig.enabled);' in script
    assert 'const filePreviewAllowedRoots = filePreviewFeatureEnabled && Array.isArray(filePreviewConfig.allowedRoots)' in script
    assert 'messagesEl?.addEventListener("click", handleMessageFileRefClick);' in script
    assert 'filePreviewController.handleMessageFileRefClick(event)' in script
    assert 'filePreviewController.openFilePreview(previewRequest, options)' in script
    assert 'filePreviewController.requestFilePreviewExpansion(direction)' in script
    assert 'filePreviewController.requestFullFilePreview()' in script
    assert 'filePreviewHelpers.createController({' in script
    assert 'async function openFilePreview(previewRequest = {}, options = {})' in script
    assert 'filePreviewLoadFull?.addEventListener("click", requestFullFilePreview);' in script
    assert 'async function openFilePreview' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'captureFilePreviewViewportAnchor()' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'restoreFilePreviewViewportAnchor(viewportAnchor)' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'apiPost(\'/api/chats/file-preview\', {' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'full_file: true,' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'window_start: nextWindowStart,' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'window_end: nextWindowEnd,' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'filePreviewLines.scrollTop = 0;' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'filePreviewLines.scrollTop = Math.max(0, anchorNode.offsetTop - offsetTopDelta);' in _read_repo_file("static", "file_preview_helpers.js")
