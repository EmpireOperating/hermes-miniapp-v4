from __future__ import annotations

import re
import time
from pathlib import Path

import pytest

from server_test_utils import load_server


@pytest.fixture(autouse=True)
def _clear_ambient_dev_auth_env(monkeypatch):
    for key in (
        "MINIAPP_DEV_BYPASS",
        "MINI_APP_DEV_BYPASS",
        "MINIAPP_DEV_BYPASS_EXPIRES_AT",
        "MINI_APP_DEV_BYPASS_EXPIRES_AT",
    ):
        monkeypatch.delenv(key, raising=False)


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
            "runtime_attention_effects.js": "runtime-attention-v",
            "runtime_read_state.js": "runtime-read-state-v",
            "runtime_chat_history_sync.js": "runtime-chat-history-sync-v",
            "runtime_visible_history_sync.js": "runtime-visible-history-sync-v",
            "runtime_hydration_state.js": "runtime-hydration-state-v",
            "runtime_hydration_apply.js": "runtime-hydration-apply-v",
            "runtime_visible_hydration.js": "runtime-visible-hydration-v",
            "runtime_hydration_flow.js": "runtime-hydration-flow-v",
            "runtime_open_flow.js": "runtime-open-flow-v",
            "runtime_chat_meta.js": "runtime-chat-meta-v",
            "runtime_local_mutation.js": "runtime-local-mutation-v",
            "runtime_unread_helpers.js": "runtime-unread-v",
            "runtime_latency_helpers.js": "runtime-latency-v",
            "runtime_history_helpers.js": "runtime-history-v",
            "runtime_helpers.js": "helpers-v",
            "app_shared_utils.js": "shared-v",
            "chat_ui_helpers.js": "chat-ui-v",
            "chat_tabs_helpers.js": "chat-tabs-v",
            "message_actions_helpers.js": "actions-v",
            "stream_state_helpers.js": "stream-state-v",
            "runtime_transcript_authority.js": "runtime-transcript-v",
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
            "startup_metrics_helpers.js": "startup-metrics-v",
            "render_trace_text_helpers.js": "render-trace-text-v",
            "render_trace_debug_helpers.js": "render-trace-debug-v",
            "render_trace_message_helpers.js": "render-trace-message-v",
            "render_trace_history_helpers.js": "render-trace-history-v",
            "render_trace_helpers.js": "render-trace-v",
            "file_preview_helpers.js": "file-preview-v",
            "app.js": "app-v",
        }[filename]

    monkeypatch.setattr(server, "_asset_version", fake_asset_version)
    response = client.get("/app")

    assert response.status_code == 200
    page = response.get_data(as_text=True)
    runtime_attention_src = '/static/runtime_attention_effects.js?v=runtime-attention-v'
    runtime_read_state_src = '/static/runtime_read_state.js?v=runtime-read-state-v'
    runtime_chat_history_sync_src = '/static/runtime_chat_history_sync.js?v=runtime-chat-history-sync-v'
    runtime_visible_history_sync_src = '/static/runtime_visible_history_sync.js?v=runtime-visible-history-sync-v'
    runtime_hydration_state_src = '/static/runtime_hydration_state.js?v=runtime-hydration-state-v'
    runtime_hydration_apply_src = '/static/runtime_hydration_apply.js?v=runtime-hydration-apply-v'
    runtime_visible_hydration_src = '/static/runtime_visible_hydration.js?v=runtime-visible-hydration-v'
    runtime_hydration_flow_src = '/static/runtime_hydration_flow.js?v=runtime-hydration-flow-v'
    runtime_open_flow_src = '/static/runtime_open_flow.js?v=runtime-open-flow-v'
    runtime_chat_meta_src = '/static/runtime_chat_meta.js?v=runtime-chat-meta-v'
    runtime_local_mutation_src = '/static/runtime_local_mutation.js?v=runtime-local-mutation-v'
    runtime_unread_src = '/static/runtime_unread_helpers.js?v=runtime-unread-v'
    runtime_latency_src = '/static/runtime_latency_helpers.js?v=runtime-latency-v'
    runtime_history_src = '/static/runtime_history_helpers.js?v=runtime-history-v'
    runtime_src = '/static/runtime_helpers.js?v=helpers-v'
    shared_src = '/static/app_shared_utils.js?v=shared-v'
    chat_ui_src = '/static/chat_ui_helpers.js?v=chat-ui-v'
    chat_tabs_src = '/static/chat_tabs_helpers.js?v=chat-tabs-v'
    actions_src = '/static/message_actions_helpers.js?v=actions-v'
    stream_state_src = '/static/stream_state_helpers.js?v=stream-state-v'
    runtime_transcript_src = '/static/runtime_transcript_authority.js?v=runtime-transcript-v'
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
    startup_metrics_src = '/static/startup_metrics_helpers.js?v=startup-metrics-v'
    render_trace_text_src = '/static/render_trace_text_helpers.js?v=render-trace-text-v'
    render_trace_debug_src = '/static/render_trace_debug_helpers.js?v=render-trace-debug-v'
    render_trace_message_src = '/static/render_trace_message_helpers.js?v=render-trace-message-v'
    render_trace_history_src = '/static/render_trace_history_helpers.js?v=render-trace-history-v'
    render_trace_src = '/static/render_trace_helpers.js?v=render-trace-v'
    file_preview_src = '/static/file_preview_helpers.js?v=file-preview-v'
    app_src = '/static/app.js?v=app-v'
    assert runtime_attention_src in page
    assert runtime_read_state_src in page
    assert runtime_chat_history_sync_src in page
    assert runtime_visible_history_sync_src in page
    assert runtime_hydration_state_src in page
    assert runtime_hydration_apply_src in page
    assert runtime_visible_hydration_src in page
    assert runtime_hydration_flow_src in page
    assert runtime_open_flow_src in page
    assert runtime_chat_meta_src in page
    assert runtime_local_mutation_src in page
    assert runtime_unread_src in page
    assert runtime_latency_src in page
    assert runtime_history_src in page
    assert runtime_src in page
    assert shared_src in page
    assert chat_ui_src in page
    assert chat_tabs_src in page
    assert actions_src in page
    assert stream_state_src in page
    assert runtime_transcript_src in page
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
    assert startup_metrics_src in page
    assert render_trace_text_src in page
    assert render_trace_debug_src in page
    assert render_trace_message_src in page
    assert render_trace_history_src in page
    assert render_trace_src in page
    assert file_preview_src in page
    assert app_src in page
    runtime_chat_history_sync_pos = page.rindex(runtime_chat_history_sync_src)
    runtime_visible_history_sync_pos = page.rindex(runtime_visible_history_sync_src)
    runtime_hydration_state_pos = page.rindex(runtime_hydration_state_src)
    runtime_hydration_apply_pos = page.rindex(runtime_hydration_apply_src)
    runtime_visible_hydration_pos = page.rindex(runtime_visible_hydration_src)
    runtime_hydration_flow_pos = page.rindex(runtime_hydration_flow_src)
    runtime_open_flow_pos = page.rindex(runtime_open_flow_src)
    runtime_chat_meta_pos = page.rindex(runtime_chat_meta_src)
    runtime_local_mutation_pos = page.rindex(runtime_local_mutation_src)
    runtime_unread_pos = page.rindex(runtime_unread_src)
    runtime_latency_pos = page.rindex(runtime_latency_src)
    runtime_history_pos = page.rindex(runtime_history_src)
    runtime_pos = page.rindex(runtime_src)
    shared_pos = page.rindex(shared_src)
    chat_ui_pos = page.rindex(chat_ui_src)
    chat_tabs_pos = page.rindex(chat_tabs_src)
    stream_state_pos = page.rindex(stream_state_src)
    stream_controller_pos = page.rindex(stream_controller_src)
    composer_pos = page.rindex(composer_src)
    bootstrap_auth_pos = page.rindex(bootstrap_auth_src)
    chat_history_pos = page.rindex(chat_history_src)
    startup_bindings_pos = page.rindex(startup_bindings_src)
    startup_metrics_pos = page.rindex(startup_metrics_src)
    render_trace_text_pos = page.rindex(render_trace_text_src)
    render_trace_debug_pos = page.rindex(render_trace_debug_src)
    render_trace_message_pos = page.rindex(render_trace_message_src)
    render_trace_history_pos = page.rindex(render_trace_history_src)
    render_trace_pos = page.rindex(render_trace_src)
    app_pos = page.rindex(app_src)
    chat_admin_pos = page.rindex(chat_admin_src)
    interaction_pos = page.rindex(interaction_src)
    actions_pos = page.rindex(actions_src)
    keyboard_pos = page.rindex(keyboard_src)
    shell_ui_pos = page.rindex(shell_ui_src)
    composer_viewport_pos = page.rindex(composer_viewport_src)
    file_preview_pos = page.rindex(file_preview_src)
    visibility_skin_pos = page.rindex(visibility_skin_src)

    assert shared_pos < chat_ui_pos < chat_tabs_pos < stream_state_pos < runtime_chat_history_sync_pos < runtime_visible_history_sync_pos < runtime_hydration_state_pos < runtime_hydration_apply_pos < runtime_visible_hydration_pos < runtime_hydration_flow_pos < runtime_open_flow_pos < runtime_chat_meta_pos < runtime_local_mutation_pos < stream_controller_pos < composer_pos < bootstrap_auth_pos < chat_history_pos < startup_metrics_pos < render_trace_text_pos < render_trace_debug_pos < render_trace_message_pos < render_trace_history_pos < render_trace_pos < interaction_pos < runtime_unread_pos < runtime_latency_pos < runtime_history_pos < runtime_pos < startup_bindings_pos < app_pos < chat_admin_pos < actions_pos < keyboard_pos < shell_ui_pos < composer_viewport_pos < file_preview_pos < visibility_skin_pos


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


def test_startup_metrics_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/startup_metrics_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_render_trace_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/render_trace_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_render_trace_text_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/render_trace_text_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_render_trace_debug_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/render_trace_debug_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_render_trace_message_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/render_trace_message_helpers.js")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "no-store, max-age=0"


def test_render_trace_history_helpers_static_asset_is_no_store(monkeypatch, tmp_path) -> None:
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/static/render_trace_history_helpers.js")

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
    _, client = _client(monkeypatch, tmp_path, isolate_dev_env=False)

    page = _app_page(client)

    assert re.search(r"devAuthEnabled:\s*true", page)
    assert re.search(r'devAuthRevealHash:\s*"#dev-auth"', page)
    assert 'id="dev-auth-controls"' not in page
    assert 'id="dev-signin-button"' in page
    assert 'id="dev-auth-modal"' in page
    assert 'id="dev-auth-secret"' in page


def test_app_dev_config_hides_expired_dev_auth_flag(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINIAPP_DEV_BYPASS", "1")
    monkeypatch.setenv("MINIAPP_DEV_BYPASS_EXPIRES_AT", "1")
    _, client = _client(monkeypatch, tmp_path, isolate_dev_env=False)

    page = _app_page(client)

    assert re.search(r"devAuthEnabled:\s*false", page)
    assert re.search(r'devAuthRevealHash:\s*"#dev-auth"', page)


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


def test_operator_runtime_endpoint_hidden_without_token(monkeypatch, tmp_path) -> None:
    _, client = _client(monkeypatch, tmp_path)

    response = client.get("/api/_operator/runtime")

    assert response.status_code == 404


def test_operator_runtime_endpoint_returns_runtime_status_with_valid_token(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_OPERATOR_API_TOKEN", "operator-secret")
    server, client = _client(monkeypatch, tmp_path)

    response = client.get("/api/_operator/runtime", headers={"X-Hermes-Operator-Token": "operator-secret"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert "warm_sessions" in payload
    assert "retirement_summary" in payload["warm_sessions"]
    assert isinstance(payload.get("recent_client_boot_summaries"), list)
    assert response.headers["Cache-Control"] == "no-store, max-age=0"


def test_boot_telemetry_records_summary_and_exposes_it_via_operator_runtime(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_OPERATOR_API_TOKEN", "operator-secret")
    _, client = _client(monkeypatch, tmp_path)

    post_response = client.post(
        "/api/telemetry/boot",
        json={
            "totalOpenMs": 3210,
            "dominantPhase": "authWaitMs",
            "telegramUserId": 9001,
            "telegramUsername": "tester",
            "ignored": {"nested": True},
        },
        headers={"User-Agent": "MiniappTest/1.0", "X-Forwarded-For": "203.0.113.9"},
    )

    assert post_response.status_code == 200
    assert post_response.get_json() == {"ok": True}
    assert post_response.headers["Cache-Control"] == "no-store, max-age=0"

    runtime_response = client.get("/api/_operator/runtime", headers={"X-Hermes-Operator-Token": "operator-secret"})

    assert runtime_response.status_code == 200
    payload = runtime_response.get_json()
    recent = payload["recent_client_boot_summaries"]
    assert len(recent) >= 1
    latest = recent[0]
    assert latest["totalOpenMs"] == 3210
    assert latest["dominantPhase"] == "authWaitMs"
    assert latest["telegramUserId"] == 9001
    assert latest["telegramUsername"] == "tester"
    assert latest["remoteAddr"] == "203.0.113.9"
    assert latest["userAgent"] == "MiniappTest/1.0"
    assert "ignored" not in latest
    assert isinstance(latest["serverRecordedAtMs"], int)


def test_boot_telemetry_accepts_text_plain_beacon_payload(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_OPERATOR_API_TOKEN", "operator-secret")
    _, client = _client(monkeypatch, tmp_path)

    response = client.post(
        "/api/telemetry/boot",
        data='{"totalOpenMs": 1111, "dominantPhase": "shellToAppScriptMs"}',
        headers={"Content-Type": "text/plain;charset=UTF-8"},
    )

    assert response.status_code == 200
    runtime_response = client.get("/api/_operator/runtime", headers={"X-Hermes-Operator-Token": "operator-secret"})
    payload = runtime_response.get_json()
    assert payload["recent_client_boot_summaries"][0]["totalOpenMs"] == 1111
    assert payload["recent_client_boot_summaries"][0]["dominantPhase"] == "shellToAppScriptMs"


def test_boot_telemetry_bypasses_origin_and_content_type_guards(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_OPERATOR_API_TOKEN", "operator-secret")
    monkeypatch.setenv("MINI_APP_ALLOWED_ORIGINS", "https://allowed.example")
    monkeypatch.setenv("MINI_APP_ENFORCE_ORIGIN_CHECK", "1")
    _, client = _client(monkeypatch, tmp_path, isolate_security_env=False)

    response = client.post(
        "/api/telemetry/boot",
        data='{"totalOpenMs": 987, "dominantPhase": "totalOpenMs"}',
        headers={"Content-Type": "text/plain;charset=UTF-8"},
    )

    assert response.status_code == 200
    runtime_response = client.get("/api/_operator/runtime", headers={"X-Hermes-Operator-Token": "operator-secret"})
    payload = runtime_response.get_json()
    assert payload["recent_client_boot_summaries"][0]["totalOpenMs"] == 987


def test_boot_telemetry_dedupes_repeated_boot_summary_ids(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_OPERATOR_API_TOKEN", "operator-secret")
    _, client = _client(monkeypatch, tmp_path)

    first = client.post(
        "/api/telemetry/boot",
        json={"bootSummaryId": "boot-123", "totalOpenMs": 2100, "dominantPhase": "authWaitMs"},
    )
    second = client.post(
        "/api/telemetry/boot",
        json={"bootSummaryId": "boot-123", "totalOpenMs": 2100, "dominantPhase": "authWaitMs"},
    )

    assert first.status_code == 200
    assert second.status_code == 200
    runtime_response = client.get("/api/_operator/runtime", headers={"X-Hermes-Operator-Token": "operator-secret"})
    payload = runtime_response.get_json()
    matches = [entry for entry in payload["recent_client_boot_summaries"] if entry.get("bootSummaryId") == "boot-123"]
    assert len(matches) == 1


def test_boot_telemetry_survives_server_reload_via_log(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_OPERATOR_API_TOKEN", "operator-secret")
    server, client = _client(monkeypatch, tmp_path)

    response = client.post(
        "/api/telemetry/boot",
        json={"bootSummaryId": "boot-reload", "totalOpenMs": 1666, "dominantPhase": "shellToAppScriptMs"},
    )

    assert response.status_code == 200
    log_path = server.CLIENT_BOOT_SUMMARY_LOG_PATH
    assert log_path.exists()
    reloaded = load_server(monkeypatch, tmp_path)
    runtime_response = reloaded.app.test_client().get(
        "/api/_operator/runtime",
        headers={"X-Hermes-Operator-Token": "operator-secret"},
    )
    payload = runtime_response.get_json()
    matches = [entry for entry in payload["recent_client_boot_summaries"] if entry.get("bootSummaryId") == "boot-reload"]
    assert len(matches) == 1
    assert matches[0]["totalOpenMs"] == 1666


def test_boot_telemetry_rejects_invalid_payload(monkeypatch, tmp_path) -> None:
    _, client = _client(monkeypatch, tmp_path)

    response = client.post("/api/telemetry/boot", json={"nested": {"nope": True}})

    assert response.status_code == 400
    assert response.get_json()["error"] == "Invalid boot summary."


def test_startup_auth_allows_empty_chat_state() -> None:
    app_script = _read_repo_file("static", "bootstrap_auth_helpers.js")

    assert 'init_data: initData' in app_script
    assert 'allow_empty: true' in app_script



def test_desktop_dev_auth_bootstrap_guards_present() -> None:
    app_script = _read_repo_file("static", "app.js")
    template = _read_repo_file("templates", "app.html")
    bootstrap_auth_script = _read_repo_file("static", "bootstrap_auth_helpers.js")
    chat_tabs_script = _read_repo_file("static", "chat_tabs_helpers.js")
    chat_history_script = _read_repo_file("static", "chat_history_helpers.js")
    chat_admin_script = _read_repo_file("static", "chat_admin_helpers.js")
    shell_ui_script = _read_repo_file("static", "shell_ui_helpers.js")
    composer_viewport_script = _read_repo_file("static", "composer_viewport_helpers.js")
    runtime_helpers_script = _read_repo_file("static", "runtime_helpers.js")
    runtime_latency_script = _read_repo_file("static", "runtime_latency_helpers.js")
    visibility_skin_script = _read_repo_file("static", "visibility_skin_helpers.js")
    startup_bindings_script = _read_repo_file("static", "startup_bindings_helpers.js")
    startup_metrics_script = _read_repo_file("static", "startup_metrics_helpers.js")
    render_trace_text_script = _read_repo_file("static", "render_trace_text_helpers.js")
    render_trace_debug_script = _read_repo_file("static", "render_trace_debug_helpers.js")
    render_trace_message_script = _read_repo_file("static", "render_trace_message_helpers.js")
    render_trace_history_script = _read_repo_file("static", "render_trace_history_helpers.js")
    render_trace_script = _read_repo_file("static", "render_trace_helpers.js")
    file_preview_script = _read_repo_file("static", "file_preview_helpers.js")

    assert "HermesMiniappBootstrapAuth" in bootstrap_auth_script
    assert "HermesMiniappStartupMetrics" in startup_metrics_script
    assert "function createController(deps = {})" in startup_metrics_script
    assert "function createController(deps)" in bootstrap_auth_script
    assert "function normalizeHandle(value)" in bootstrap_auth_script
    assert "function fallbackHandleFromDisplayName(value)" in bootstrap_auth_script
    assert "function refreshOperatorRoleLabels()" in bootstrap_auth_script
    assert "function authPayload(extra = {})" in bootstrap_auth_script
    assert "async function safeReadJson(response)" in bootstrap_auth_script
    assert "function summarizeUiFailure(rawBody" in bootstrap_auth_script
    assert "function parseStreamErrorPayload(rawBody)" in bootstrap_auth_script
    assert "async function apiPost(url, payload)" in bootstrap_auth_script
    assert "async function askForDevAuth" in bootstrap_auth_script
    assert "async function fetchAuthBootstrapWithRetry()" in bootstrap_auth_script
    assert "async function maybeRefreshForBootstrapVersionMismatch()" in bootstrap_auth_script
    assert 'fetchImpl("/api/dev/auth"' in bootstrap_auth_script
    assert 'fetchImpl("/api/auth"' in bootstrap_auth_script
    assert 'fetchImpl("/api/state"' in bootstrap_auth_script
    assert 'const devAuthRevealHash = String(devConfig.devAuthRevealHash || "#dev-auth").trim() || "#dev-auth";' in app_script
    assert 'const currentLocationHash = typeof window?.location?.hash === "string" ? window.location.hash : "";' in app_script
    assert 'const desktopTestingRequested = currentLocationHash === devAuthRevealHash || currentLocationHash.startsWith(`${devAuthRevealHash}:`);' in app_script
    assert 'const desktopTestingEnabled = Boolean(devConfig.devAuthEnabled) && desktopTestingRequested;' in app_script
    assert 'const devAuthHashSecret = desktopTestingRequested && currentLocationHash.startsWith(`${devAuthRevealHash}:`)' in app_script
    assert "appendSystemMessage('Dev auth is currently disabled. Enable the bypass flag, then reload /app#dev-auth.');" in startup_bindings_script
    assert "function createBootstrapAuthController()" in app_script
    assert "bootstrapAuthHelpers.createController(createBootstrapAuthControllerDeps({" in app_script
    assert "bootstrapAuthController.normalizeHandle(value)" in app_script
    assert "bootstrapAuthController.fallbackHandleFromDisplayName(value)" in app_script
    assert "bootstrapAuthController.refreshOperatorRoleLabels()" in app_script
    assert "bootstrapAuthController.authPayload(extra)" in app_script
    assert "bootstrapAuthController.safeReadJson(response)" in app_script
    assert "bootstrapAuthController.summarizeUiFailure(rawBody, { status, fallback })" in app_script
    assert "bootstrapAuthController.parseStreamErrorPayload(rawBody)" in app_script
    assert "bootstrapAuthController.apiPost(url, payload)" in app_script
    assert "bootstrapAuthController.fetchAuthBootstrapWithRetry()" in app_script
    assert "bootstrapAuthController.maybeRefreshForBootstrapVersionMismatch()" in app_script
    assert "startupBindingsController.getMissingBootstrapBindings()" in app_script
    assert "function normalizeHandle(value)" in app_script
    assert "function fallbackHandleFromDisplayName(value)" in app_script
    assert "function refreshOperatorRoleLabels()" in app_script
    assert "function apiPost(url, payload)" in app_script
    assert "function fetchAuthBootstrapWithRetry()" in app_script
    assert "function maybeRefreshForBootstrapVersionMismatch()" in app_script
    assert "bootstrapAuthHelpers: requireHelperGlobal(windowObject, 'HermesMiniappBootstrapAuth')" in app_script
    assert "HermesMiniappChatTabs" in chat_tabs_script
    assert "function createController(deps)" in chat_tabs_script
    assert "function createChatTabsController()" in app_script
    assert "chatTabsHelpers.createController(createChatTabsControllerDeps({" in app_script
    assert "chatTabsHelpers: requireHelperGlobal(windowObject, 'HermesMiniappChatTabs')" in app_script
    assert "HermesMiniappChatHistory" in chat_history_script
    assert "function createController(deps)" in chat_history_script
    assert "function createMetaController(deps)" in chat_history_script
    assert "return chatMetaHelpers.createMetaController(deps);" in chat_history_script
    assert "function createLocalMutationController(deps)" in chat_history_script
    assert "return localMutationHelpers.createLocalMutationController({" in chat_history_script
    assert "normalizeChatId," in chat_history_script
    assert "reconcilePendingAssistantUpdate," in chat_history_script
    assert "maybeMarkRead: readSyncController.maybeMarkRead," in chat_history_script or "function maybeMarkRead(chatId, { force = false } = {})" in chat_history_script
    assert "chatHistoryHelpers.createController({" in app_script
    assert "chatHistoryHelpers.createMetaController({" in app_script
    assert "activeChatMetaController.setActiveChatMeta(chatId, options)" in app_script
    assert "activeChatMetaController.setNoActiveChatMeta()" in app_script
    assert "chatHistoryController.addLocalMessage(chatId, message)" in app_script
    assert "chatHistoryController.appendSystemMessage(text, chatIdOverride)" in app_script
    assert "chatHistoryController.updatePendingAssistant(chatId, nextBody, pendingState)" in app_script
    assert "chatHistoryController.syncActiveMessageView(chatId, options)" in app_script
    assert "chatHistoryController.scheduleActiveMessageView(chatId)" in app_script
    assert "chatHistoryController.maybeMarkRead(chatId, options)" in app_script
    assert "chatHistoryHelpers: requireHelperGlobal(windowObject, 'HermesMiniappChatHistory')" in app_script
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
    assert "createDeferredControllerHelper('HermesMiniappChatAdmin')" in app_script
    assert "HermesMiniappShellUI" in shell_ui_script
    assert "function createController(deps)" in shell_ui_script
    assert "function syncDebugOnlyPillVisibility()" in shell_ui_script
    assert "function syncFullscreenControlState()" in shell_ui_script
    assert "shellUiHelpers.createController({" in app_script
    assert "shellUiController.setElementHidden(element, hidden)" in app_script
    assert "shellUiController.syncDebugOnlyPillVisibility()" in app_script
    assert "createDeferredControllerHelper('HermesMiniappShellUI')" in app_script
    assert "HermesMiniappComposerViewport" in composer_viewport_script
    assert "function createController(deps)" in composer_viewport_script
    assert "function ensureComposerVisible" in composer_viewport_script
    assert "composerViewportHelpers.createController({" in app_script
    assert "createDeferredControllerHelper('HermesMiniappComposerViewport')" in app_script
    assert "function resolveRuntimeLatencyHelpers()" in runtime_helpers_script
    assert "function createLatencyPersistenceController({" in runtime_latency_script
    assert "function createLatencyController({" in runtime_latency_script
    assert "runtimeHelpers.createLatencyPersistenceController({" in app_script
    assert "function loadLatencyByChatFromStorage()" in app_script
    assert "getLatencyPersistenceController().persistLatencyByChatToStorage()" in app_script
    assert "getLatencyViewController().setChatLatency(chatId, text)" in app_script
    assert "HermesMiniappVisibilitySkin" in visibility_skin_script
    assert "function createController(deps)" in visibility_skin_script
    assert "async function saveSkinPreference(skin)" in visibility_skin_script
    assert "function handleVisibilityChange()" in visibility_skin_script
    assert "visibilitySkinHelpers.createController({" in app_script
    assert "return visibilitySkinController.saveSkinPreference(skin);" in app_script
    assert "createDeferredControllerHelper('HermesMiniappVisibilitySkin')" in app_script
    assert "function createController(deps)" in startup_bindings_script

    assert "function installCoreEventBindings()" in startup_bindings_script
    assert "function getMissingBootstrapBindings()" in startup_bindings_script
    assert "function reportBootstrapMismatch(reason, details = [])" in startup_bindings_script
    assert "async function bootstrap()" in startup_bindings_script
    assert "function installPendingCompletionWatchdog()" in startup_bindings_script
    assert "function createStartupBindingsController()" in app_script
    assert "startupBindingsHelpers.createController(createStartupBindingsControllerDeps({" in app_script
    assert "startupBindingsHelpers: windowObject.HermesMiniappStartupBindings || createDeferredApiHelper('HermesMiniappStartupBindings')" in app_script
    assert "HermesMiniappRenderTraceText" in render_trace_text_script
    assert "function parseInlinePathRef(rawText)" in render_trace_text_script
    assert "function renderBody(container, rawText" in render_trace_text_script
    assert "HermesMiniappRenderTraceDebug" in render_trace_debug_script
    assert "function parseBooleanFlag(rawValue)" in render_trace_debug_script
    assert "function createController(deps)" in render_trace_debug_script
    assert "HermesMiniappRenderTraceMessage" in render_trace_message_script
    assert "function renderToolTraceBody(container, message" in render_trace_message_script
    assert "function patchVisiblePendingAssistant({" in render_trace_message_script
    assert "function createController({" in render_trace_message_script
    assert "HermesMiniappRenderTraceHistory" in render_trace_history_script
    assert "function createHistoryRenderController(deps)" in render_trace_history_script
    assert "HermesMiniappRenderTrace" in render_trace_script
    assert "function createController(deps)" in render_trace_script
    assert "function createMessageRenderController(deps)" in render_trace_script
    assert "function renderBody(container, rawText" in render_trace_script
    assert "function renderToolTraceBody(container, message" in render_trace_script
    assert "function roleLabelForMessage(message" in render_trace_script
    assert "function messageVariantForRole(role)" in render_trace_script
    assert "function shouldSkipMessageRender(" in render_trace_script
    assert "function applyMessageMeta(" in render_trace_script
    assert "function renderMessageContent(" in render_trace_script
    assert "function messageStableKey(message, index = 0)" in render_trace_script
    assert "function messageStableKeyForPendingState(" in render_trace_script
    assert "function upsertMessageNode(" in render_trace_script
    assert "function createMessageNode(message," in render_trace_script
    assert "function appendMessages(fragment, messages" in render_trace_script
    assert "function findMessageNodeByKey(container, selector, messageKey, alternateMessageKey = \"\")" in render_trace_script
    assert "function findLatestHistoryMessageByRole(history, role" in render_trace_script
    assert "function findLatestAssistantHistoryMessage(history," in render_trace_script
    assert "function patchVisiblePendingAssistant(" in render_trace_script
    assert "function patchVisibleToolTrace(" in render_trace_script
    assert "resolveRenderTraceTextHelpers()" in render_trace_script
    assert "resolveRenderTraceDebugHelpers()" in render_trace_script
    assert "renderTraceHelpers.createController({" in app_script
    assert "renderTraceHelpers.createMessageRenderController({" in app_script
    assert "createDeferredRenderTraceApiHelper('HermesMiniappRenderTrace')" in app_script
    assert "createMessageRenderController(...args)" in app_script
    assert "createHistoryRenderController(...args)" in app_script
    assert "startupBindingsController.bootstrap()" in app_script
    assert "startupBindingsController.installPendingCompletionWatchdog()" in app_script
    assert "messageRenderController.renderBody(container, rawText, { fileRefs })" in app_script
    assert "messageRenderController.renderToolTraceBody(container, message)" in app_script
    assert "messageRenderController.messageVariantForRole(role)" in app_script
    assert "messageRenderController.shouldSkipMessageRender({ role, renderedBody, pending })" in app_script
    assert "messageRenderController.applyMessageMeta(node, message, options)" in app_script
    assert "messageRenderController.renderMessageContent(node, message, renderedBody)" in app_script
    assert "messageRenderController.messageStableKey(message, index)" in app_script
    assert "messageRenderController.messageStableKeyForPendingState(message, index, pendingState)" in app_script
    assert "messageRenderController.upsertMessageNode(node, message)" in app_script
    assert "messageRenderController.createMessageNode(message, { index })" in app_script
    assert "messageRenderController.appendMessages(fragment, messages, options)" in app_script
    assert "messageRenderController.findMessageNodeByKey(selector, messageKey, alternateMessageKey)" in app_script
    assert "messageRenderController.findLatestHistoryMessageByRole(chatId, role, { pendingOnly })" in app_script
    assert "messageRenderController.findLatestAssistantHistoryMessage(chatId, { pendingOnly })" in app_script
    assert "messageRenderController.patchVisiblePendingAssistant(chatId, nextBody, pendingState)" in app_script
    assert "messageRenderController.patchVisibleToolTrace(chatId)" in app_script
    assert "HermesMiniappFilePreview" in file_preview_script
    assert "function createController(deps)" in file_preview_script
    assert "async function openFilePreview" in file_preview_script
    assert "function handleMessageFileRefClick(event)" in file_preview_script
    assert "filePreviewHelpers.createController({" in app_script
    assert "createDeferredControllerHelper('HermesMiniappFilePreview')" in app_script
    assert "chat-title-modal" in template
    assert '{% if dev_auth_enabled %}' in template
    assert "dev-auth-modal" in template
    assert "dev-auth-secret" in template
    assert "setInitData?.(tg?.initData || '')" in startup_bindings_script
    assert "Telegram connection missing" not in app_script
    assert "dev_secret" not in app_script


def test_resume_keeps_existing_latency_value_instead_of_recalculating_flash() -> None:
    app_script = _read_repo_file("static", "app.js")

    assert 'syncActiveLatencyChip();' in app_script
    assert 'setActivityChip(latencyChip, "latency: recalculating...");' not in app_script
    assert 'setChatLatency(key, "recalculating...");' not in app_script


def test_stream_resume_and_graceful_completion_helpers_are_centralized() -> None:
    app_script = _read_repo_file("static", "app.js")
    stream_controller_script = _read_repo_file("static", "stream_controller.js")

    assert "function createResumeRecoveryPolicy" in stream_controller_script
    assert "const resumeRecoveryPolicy = streamControllerHelpers.createResumeRecoveryPolicy({" in app_script
    assert "RESUME_RECOVERY_MAX_ATTEMPTS: resumeRecoveryPolicy.RESUME_RECOVERY_MAX_ATTEMPTS" in app_script
    assert "isTransientResumeRecoveryError: resumeRecoveryPolicy.isTransientResumeRecoveryError" in app_script
    assert "async function hydrateChatAfterGracefulResumeCompletion" in app_script
    assert "async function consumeStreamWithReconnect" in app_script
    assert 'await hydrateChatAfterGracefulResumeCompletion(key, { forceCompleted: true });' in stream_controller_script
    assert 'const resumed = await consumeStreamWithReconnect(chatId, response, builtReplyRef' in stream_controller_script
    assert 'const resumed = await consumeStreamWithReconnect(key, response, builtReplyRef' in stream_controller_script



def test_mobile_viewport_and_composer_zoom_guards_present() -> None:
    template = _read_repo_file("templates", "app.html")
    css = _read_repo_file("static", "app.css")
    app_script = _read_repo_file("static", "app.js")
    composer_viewport_script = _read_repo_file("static", "composer_viewport_helpers.js")

    assert "maximum-scale=1" in template
    assert "user-scalable=no" in template
    assert "@media (max-width: 860px)" in css
    assert "Keep mobile composer focus from triggering viewport zoom" in css
    assert "font-size: 16px;" in css
    assert "-webkit-text-size-adjust: none;" in css
    assert "text-size-adjust: none;" in css
    assert "margin-left: auto;" in css
    assert "margin-left: auto !important;" in css
    assert "function focusComposerForNewChat(chatId) {" in app_script
    assert "return composerViewportController.focusComposerForNewChat(chatId);" in app_script
    assert "let focusComposerForNewChatRequestId = 0;" in composer_viewport_script
    assert "const shouldKeepRetryingFocus = () => {" in composer_viewport_script
    assert 'documentObject.querySelector?.(\'dialog[open]\')' in composer_viewport_script
    assert "promptEl.focus();" in composer_viewport_script
    assert "promptEl.focus({ preventScroll: true });" in composer_viewport_script

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
    assert "function createController(deps = {})" in chat_ui_script
    assert "function renderPinnedChats" in chat_ui_script
    assert "HermesMiniappChatTabs" in chat_tabs_script
    assert "function syncChats" in chat_tabs_script
    assert "function syncOrderedChatIds" in chat_tabs_script
    assert "function moveChatToEnd" in chat_tabs_script
    assert "function syncPinnedChatsCollapseUi" in chat_tabs_script
    assert "HermesMiniappChatAdmin" in chat_admin_script
    assert "function syncPinnedChats" in script
    assert "function renderPinnedChats" in script
    assert "return chatTabsController.renderPinnedChats();" in script
    assert "return chatTabsController.renderTabs();" in script
    assert "return chatTabsController.syncActiveTabSelection(previousChatId, nextChatId);" in script
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
    assert 'id="chat-tabs-overview"' in template
    assert 'id="chat-tabs-hidden-unread"' in template
    assert 'window.__HERMES_FEATURES__ = {' in template
    assert 'mobileTabCarousel: {{ \'true\' if mobile_tab_carousel_enabled else \'false\' }}' in template
    assert 'tabActionsMenu: {{ \'true\' if tab_actions_menu_enabled else \'false\' }}' in template
    assert '<body data-skin="{{ boot_skin }}" data-tab-actions-menu="{{ \'true\' if tab_actions_menu_enabled else \'false\' }}">' in template
    assert 'chat-tabs--mobile-carousel' in chat_tabs_script
    assert 'renderMobileTabOverview' in chat_tabs_script
    assert 'orderedChats: getOrderedChats(),' in chat_tabs_script
    assert 'moveChatToEnd?.(targetChatId);' in chat_admin_script
    assert 'openChat = async () => {}' in chat_tabs_script

    # Close tab should be silent (no confirm helper UX); it only removes from active tabs via API.
    # Closed chats should disappear from the current pinned list.
    assert 'const ok = await confirmAction(`Close chat' not in script
    assert "async function removeActiveChat()" in chat_admin_script
    assert "async function removeChatById(chatId)" in chat_admin_script
    assert "async function renameChatById(chatId)" in chat_admin_script
    assert "async function toggleChatPin(chatId)" in chat_admin_script
    assert "data = await apiPost('/api/chats/remove', {" in chat_admin_script
    assert 'chat_id: activeChatId,' in chat_admin_script
    assert 'allow_empty: true,' in chat_admin_script
    assert "chatTabContextPin.textContent = isPinned ? 'Unpin chat' : 'Pin chat';" in chat_admin_script
    assert 'overflowTrigger.hidden = false;' in chat_ui_script


def test_message_action_copy_helpers_are_split_to_module() -> None:
    template = _read_repo_file("templates", "app.html")
    script = _read_repo_file("static", "app.js")
    actions_script = _read_repo_file("static", "message_actions_helpers.js")
    keyboard_script = _read_repo_file("static", "keyboard_shortcuts_helpers.js")
    interaction_script = _read_repo_file("static", "interaction_helpers.js")

    assert "HermesMiniappMessageActions" in actions_script
    assert "function bindMessageCopyHandler" in actions_script
    assert "function createController({" in actions_script
    assert "createMessageCopyState" in actions_script
    assert "messageActionsHelpers.createController({" in script
    assert "messageActionsController.bindMessageCopyBindings()" in script
    assert "function installMessageActionBindings()" in script
    assert "HermesMiniappKeyboardShortcuts" in keyboard_script
    assert "function createController(deps)" in keyboard_script
    assert "function handleGlobalTabCycle" in keyboard_script
    assert "keyboardShortcutsHelpers.createController({" in script
    assert "keyboardShortcutsController.handleGlobalTabCycle(event)" in script
    assert "HermesMiniappInteraction" in interaction_script
    assert "function createSelectionQuoteController" in interaction_script
    assert "function createController({" in interaction_script
    assert "function createInteractionControllerDeps({" in script
    assert "interactionHelpers.createController(createInteractionControllerDeps({" in script
    assert "interactionController.handleComposerSubmitShortcut(event)" in script
    assert "function installSelectionQuoteBindings()" in script
    assert "interactionController.bindSelectionQuoteBindings()" in script
    assert 'window.__HERMES_BOOTSTRAP_VERSION__ = "{{ bootstrap_version }}";' in template
    assert '/static/chat_tabs_helpers.js?v={{ chat_tabs_helpers_version }}' in template
    assert '/static/message_actions_helpers.js?v={{ message_actions_helpers_version }}' in template
    assert '/static/runtime_transcript_authority.js?v={{ runtime_transcript_authority_version }}' in template
    assert '/static/runtime_attention_effects.js?v={{ runtime_attention_effects_version }}' in template
    assert '/static/runtime_read_state.js?v={{ runtime_read_state_version }}' in template
    assert '/static/runtime_chat_history_sync.js?v={{ runtime_chat_history_sync_version }}' in template
    assert '/static/runtime_visible_history_sync.js?v={{ runtime_visible_history_sync_version }}' in template
    assert '/static/runtime_hydration_state.js?v={{ runtime_hydration_state_version }}' in template
    assert '/static/runtime_hydration_apply.js?v={{ runtime_hydration_apply_version }}' in template
    assert '/static/runtime_visible_hydration.js?v={{ runtime_visible_hydration_version }}' in template
    assert '/static/runtime_hydration_flow.js?v={{ runtime_hydration_flow_version }}' in template
    assert '/static/runtime_open_flow.js?v={{ runtime_open_flow_version }}' in template
    assert '/static/runtime_chat_meta.js?v={{ runtime_chat_meta_version }}' in template
    assert '/static/runtime_local_mutation.js?v={{ runtime_local_mutation_version }}' in template
    assert '/static/stream_controller.js?v={{ stream_controller_version }}' in template
    assert '/static/composer_state_helpers.js?v={{ composer_state_helpers_version }}' in template
    assert '/static/keyboard_shortcuts_helpers.js?v={{ keyboard_shortcuts_helpers_version }}' in template
    assert '/static/interaction_helpers.js?v={{ interaction_helpers_version }}' in template
    assert '/static/shell_ui_helpers.js?v={{ shell_ui_helpers_version }}' in template
    assert 'id="keyboard-shortcuts-top-button"' in template
    assert 'id="keyboard-shortcuts-button"' in template
    assert 'id="keyboard-shortcuts-modal"' in template
    assert 'id="keyboard-shortcuts-close"' in template
    assert template.count('aria-controls="keyboard-shortcuts-modal"') >= 2
    assert '/static/composer_viewport_helpers.js?v={{ composer_viewport_helpers_version }}' in template
    assert '/static/visibility_skin_helpers.js?v={{ visibility_skin_helpers_version }}' in template
    assert '/static/startup_bindings_helpers.js?v={{ startup_bindings_helpers_version }}' in template
    assert '/static/startup_metrics_helpers.js?v={{ startup_metrics_helpers_version }}' in template
    assert '/static/render_trace_text_helpers.js?v={{ render_trace_text_helpers_version }}' in template
    assert '/static/render_trace_debug_helpers.js?v={{ render_trace_debug_helpers_version }}' in template
    assert '/static/render_trace_message_helpers.js?v={{ render_trace_message_helpers_version }}' in template
    assert '/static/render_trace_history_helpers.js?v={{ render_trace_history_helpers_version }}' in template
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
    assert 'filePreviewHelpers.createController({' in script
    assert 'filePreviewClose,' in script
    assert 'messagesEl,' in script
    assert 'filePreviewController.handleMessageFileRefClick(event)' in script
    assert 'function requestFilePreviewExpansion(direction)' in script
    assert 'function requestFullFilePreview()' in script
    assert 'function closeFilePreviewModal()' in script
    assert 'filePreviewController.handleMessageFileRefClick(event)' in script
    assert 'filePreviewController.openFilePreview(previewRequest, options)' in script
    assert 'filePreviewController.requestFilePreviewExpansion(direction)' in script
    assert 'filePreviewController.requestFullFilePreview()' in script
    assert 'const startupMetricsHelpers = window.HermesMiniappStartupMetrics;' in script
    assert 'const startupMetricsController = startupMetricsHelpers.createController({' in script
    assert 'recordBootMetric = startupMetricsController.recordBootMetric;' in script
    assert 'filePreviewHelpers.createController({' in script
    assert 'async function openFilePreview(previewRequest = {}, options = {})' in script
    assert 'function bindFilePreviewBindings()' in _read_repo_file("static", "file_preview_helpers.js")
    assert "bind(filePreviewLoadFull, 'click', requestFullFilePreview);" in _read_repo_file("static", "file_preview_helpers.js")
    assert 'async function openFilePreview' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'captureFilePreviewViewportAnchor()' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'restoreFilePreviewViewportAnchor(viewportAnchor)' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'apiPost(\'/api/chats/file-preview\', {' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'full_file: true,' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'window_start: nextWindowStart,' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'window_end: nextWindowEnd,' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'filePreviewLines.scrollTop = 0;' in _read_repo_file("static", "file_preview_helpers.js")
    assert 'filePreviewLines.scrollTop = Math.max(0, anchorNode.offsetTop - offsetTopDelta);' in _read_repo_file("static", "file_preview_helpers.js")
