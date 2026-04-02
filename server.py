from __future__ import annotations

import json
import os
import queue
import time
from pathlib import Path

from flask import Flask, Response, g, request

from app_factory import create_flask_app, create_runtime_dependencies
from assets import asset_version, dev_reload_version
from auth import TelegramAuthError, verify_telegram_init_data
from auth_session import verify_from_payload as auth_verify_from_payload
from blueprints import create_api_blueprint, create_public_blueprint
from hermes_client import HermesClient
from miniapp_config import MiniAppConfig, normalize_origin
from request_context import (
    json_user_id_or_error as request_json_user_id_or_error,
    verify_for_json as request_verify_for_json,
    verify_for_sse as request_verify_for_sse,
    sse_user_id_or_error as request_sse_user_id_or_error,
)
from request_guards import enforce_api_request_guards
from request_logging import build_job_log, build_request_log, new_request_id, now_ms, sanitized_request_target
from routes_auth import register_auth_routes
from routes_chat import register_chat_routes
from routes_chat_context import ChatRouteContext
from routes_jobs_runtime import register_jobs_runtime_routes
from routes_meta import register_meta_routes
from security_headers import apply_security_headers, generate_csp_nonce
from server_public_routes import register_public_routes
from server_request_adapters import build_server_request_adapters
from server_startup import log_startup_diagnostics, startup_diagnostics_payload
from store import ChatThread, SessionStore
from validators import parse_chat_id, validate_message, validate_title

BASE_DIR = Path(__file__).resolve().parent
CONFIG = MiniAppConfig.from_env()
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
PORT = CONFIG.port
DEBUG = CONFIG.debug
DEV_RELOAD = CONFIG.dev_reload
ALLOWED_SKINS = {"terminal", "oracle", "obsidian"}
SKIN_COOKIE_NAME = "hermes_skin"
AUTH_COOKIE_NAME = "hermes_auth_session"
AUTH_SESSION_MAX_AGE_SECONDS = CONFIG.auth_session_max_age_seconds
MAX_MESSAGE_LEN = CONFIG.max_message_len
MAX_TITLE_LEN = CONFIG.max_title_len
ASSISTANT_CHUNK_LEN = CONFIG.assistant_chunk_len
ASSISTANT_HARD_LIMIT = CONFIG.assistant_hard_limit
DEV_RELOAD_INTERVAL_MS = CONFIG.dev_reload_interval_ms
JOB_MAX_ATTEMPTS = CONFIG.job_max_attempts
JOB_RETRY_BASE_SECONDS = CONFIG.job_retry_base_seconds
JOB_WORKER_CONCURRENCY = CONFIG.job_worker_concurrency
JOB_STALL_TIMEOUT_SECONDS = CONFIG.job_stall_timeout_seconds
TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = CONFIG.telegram_init_data_max_age_seconds
TRUST_PROXY_HEADERS = CONFIG.trust_proxy_headers
FORCE_SECURE_COOKIES = CONFIG.force_secure_cookies
ALLOWED_ORIGINS = CONFIG.allowed_origins
ENFORCE_ORIGIN_CHECK = CONFIG.enforce_origin_check
RATE_LIMIT_WINDOW_SECONDS = CONFIG.rate_limit_window_seconds
RATE_LIMIT_API_REQUESTS = CONFIG.rate_limit_api_requests
RATE_LIMIT_STREAM_REQUESTS = CONFIG.rate_limit_stream_requests
ENABLE_HSTS = CONFIG.enable_hsts
REQUEST_DEBUG = CONFIG.request_debug
DEV_AUTH_ENABLED = CONFIG.dev_auth_enabled
DEV_AUTH_SECRET = CONFIG.dev_auth_secret
JOB_EVENT_HISTORY_MAX_JOBS = CONFIG.job_event_history_max_jobs
JOB_EVENT_HISTORY_TTL_SECONDS = CONFIG.job_event_history_ttl_seconds
DEV_RELOAD_WATCH_PATHS = CONFIG.dev_reload_watch_paths
STATIC_NO_STORE_FILENAMES = {
    "app.js",
    "app.css",
    "runtime_helpers.js",
    "app_shared_utils.js",
    "chat_ui_helpers.js",
    "chat_tabs_helpers.js",
    "message_actions_helpers.js",
    "stream_state_helpers.js",
    "stream_controller.js",
    "composer_state_helpers.js",
    "keyboard_shortcuts_helpers.js",
    "interaction_helpers.js",
    "bootstrap_auth_helpers.js",
    "chat_history_helpers.js",
    "chat_admin_helpers.js",
    "shell_ui_helpers.js",
    "composer_viewport_helpers.js",
    "visibility_skin_helpers.js",
    "startup_bindings_helpers.js",
    "render_trace_helpers.js",
}
STATIC_NO_STORE_PATHS = {f"/static/{name}" for name in STATIC_NO_STORE_FILENAMES}

app: Flask = create_flask_app(
    base_dir=BASE_DIR,
    trust_proxy_headers=TRUST_PROXY_HEADERS,
    max_content_length=CONFIG.max_content_length,
    debug=DEBUG,
    dev_reload=DEV_RELOAD,
)
app.logger.setLevel("INFO")


@app.before_request
def _log_request_debug() -> None:
    if not REQUEST_DEBUG:
        return
    try:
        app.logger.info(
            "miniapp req method=%s path=%s host=%s ua=%s",
            request.method,
            sanitized_request_target(request),
            request.host,
            request.headers.get("User-Agent", "")[:160],
        )
    except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log debug instrumentation must never block requests
        pass


public_bp = create_public_blueprint()
api_bp = create_api_blueprint()
client = HermesClient()
store = SessionStore(BASE_DIR / "sessions.db")



def _session_id_for(user_id: str, chat_id: int) -> str:
    return f"miniapp-{user_id}-{chat_id}"


_RUNTIME_DEPS = create_runtime_dependencies(
    store_getter=lambda: store,
    client_getter=lambda: client,
    job_max_attempts=JOB_MAX_ATTEMPTS,
    job_retry_base_seconds=JOB_RETRY_BASE_SECONDS,
    job_worker_concurrency=JOB_WORKER_CONCURRENCY,
    job_stall_timeout_seconds=JOB_STALL_TIMEOUT_SECONDS,
    assistant_chunk_len=ASSISTANT_CHUNK_LEN,
    assistant_hard_limit=ASSISTANT_HARD_LIMIT,
    job_event_history_max_jobs=JOB_EVENT_HISTORY_MAX_JOBS,
    job_event_history_ttl_seconds=JOB_EVENT_HISTORY_TTL_SECONDS,
    session_id_builder=_session_id_for,
)
runtime = _RUNTIME_DEPS.runtime
_JOB_WAKE_EVENT = runtime.wake_event
_RATE_LIMITER = _RUNTIME_DEPS.rate_limiter


def _cookie_secure() -> bool:
    if FORCE_SECURE_COOKIES:
        return True
    return bool(request.is_secure)


def _ensure_csp_nonce() -> str:
    existing = getattr(g, "csp_nonce", None)
    if isinstance(existing, str) and existing:
        return existing

    nonce = generate_csp_nonce()
    g.csp_nonce = nonce
    return nonce


def _origin_allowed() -> bool:
    if not ALLOWED_ORIGINS or not ENFORCE_ORIGIN_CHECK:
        return True

    origin = normalize_origin(request.headers.get("Origin"))
    if origin:
        return origin in ALLOWED_ORIGINS

    referer = normalize_origin(request.headers.get("Referer"))
    if referer:
        return referer in ALLOWED_ORIGINS

    return False


def _check_rate_limit(key: str, limit: int, window_seconds: int) -> bool:
    return _RATE_LIMITER.allow(key=key, limit=limit, window_seconds=window_seconds)


def _publish_job_event(job_id: int, event_name: str, payload: dict[str, object]) -> None:
    _RUNTIME_DEPS.bind_runtime().publish_job_event(job_id, event_name, payload)


def _subscribe_job_events(job_id: int) -> queue.Queue[dict[str, object]]:
    return _RUNTIME_DEPS.bind_runtime().subscribe_job_events(job_id)


def _unsubscribe_job_events(job_id: int, subscriber: queue.Queue[dict[str, object]]) -> None:
    _RUNTIME_DEPS.bind_runtime().unsubscribe_job_events(job_id, subscriber)


def _run_chat_job(job: dict[str, object]) -> None:
    _RUNTIME_DEPS.bind_runtime().run_chat_job(job)


def _is_stale_chat_job_error(exc: Exception) -> bool:
    return runtime.is_stale_chat_job_error(exc)


def _serialize_chat(chat: ChatThread) -> dict[str, object]:
    return {
        "id": chat.id,
        "title": chat.title,
        "unread_count": chat.unread_count,
        "pending": chat.pending,
        "is_pinned": chat.is_pinned,
        "updated_at": chat.updated_at,
        "created_at": chat.created_at,
    }


def _chat_id_from_payload(payload: dict[str, object], user_id: str) -> int:
    raw_chat_id = payload.get("chat_id")
    if raw_chat_id not in (None, "", 0, "0"):
        return parse_chat_id(payload, default_chat_id=0)

    active_chat_id = store.get_active_chat(user_id)
    if active_chat_id is not None:
        try:
            store.get_chat(user_id=user_id, chat_id=active_chat_id)
        except KeyError:
            active_chat_id = None
    if active_chat_id is not None:
        return active_chat_id

    if store.has_explicit_empty_chat_state(user_id):
        raise KeyError("Chat not found.")

    return store.ensure_default_chat(user_id)


_REQUEST_ADAPTERS = build_server_request_adapters(
    bot_token=BOT_TOKEN,
    auth_cookie_name=AUTH_COOKIE_NAME,
    auth_session_max_age_seconds=AUTH_SESSION_MAX_AGE_SECONDS,
    telegram_init_data_max_age_seconds=TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
    upsert_auth_session_fn=lambda **kwargs: store.upsert_auth_session(**kwargs),
    is_auth_session_active_fn=lambda **kwargs: store.is_auth_session_active(**kwargs),
    auth_session_profile_fn=lambda user_id: store.get_latest_auth_session_profile(user_id),
    verify_telegram_init_data_fn=lambda **kwargs: verify_telegram_init_data(**kwargs),
    chat_id_from_payload_fn=lambda payload, user_id: _chat_id_from_payload(payload, user_id=user_id),
)


def _validated_title(raw_title: object, *, default: str) -> str:
    return validate_title(raw_title, default=default, max_length=MAX_TITLE_LEN)


def _validated_message(raw_message: object) -> str:
    return validate_message(raw_message, max_length=MAX_MESSAGE_LEN)


# Bind adapter-backed implementations after local helper definitions so exported symbols stay stable.
_create_auth_session_token = _REQUEST_ADAPTERS.create_auth_session_token_fn
_verify_auth_session_token = _REQUEST_ADAPTERS.verify_auth_session_token_fn


def _verified_from_session_cookie():
    return _REQUEST_ADAPTERS.verified_from_session_cookie_fn()


def _verify_from_payload(payload: dict[str, object]):
    return auth_verify_from_payload(
        payload,
        bot_token=BOT_TOKEN,
        telegram_init_data_max_age_seconds=TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
        verified_from_session_cookie_fn=_verified_from_session_cookie,
        verify_telegram_init_data_fn=lambda **kwargs: verify_telegram_init_data(**kwargs),
    )

_json_error = _REQUEST_ADAPTERS.json_error_fn
_sse_event = _REQUEST_ADAPTERS.sse_event_fn
_sse_error = _REQUEST_ADAPTERS.sse_error_fn
_request_payload = _REQUEST_ADAPTERS.request_payload_fn
_chat_id_from_payload_or_error = lambda payload, *, user_id: _REQUEST_ADAPTERS.chat_id_from_payload_or_error_fn(payload, user_id)


def _verify_for_json(payload: dict[str, object]):
    return request_verify_for_json(payload, verify_from_payload_fn=_verify_from_payload)


def _verify_for_sse(payload: dict[str, object]):
    return request_verify_for_sse(payload, verify_from_payload_fn=_verify_from_payload, sse_event_fn=_sse_event)


def _json_user_id_or_error(payload: dict[str, object]):
    return request_json_user_id_or_error(payload, verify_for_json_fn=_verify_for_json)


def _sse_user_id_or_error(payload: dict[str, object]):
    return request_sse_user_id_or_error(payload, verify_for_sse_fn=_verify_for_sse)


def _asset_version(filename: str) -> str:
    return asset_version(BASE_DIR, filename)


def _dev_reload_version() -> str:
    return dev_reload_version(BASE_DIR, DEV_RELOAD_WATCH_PATHS)


def _startup_diagnostics_payload() -> dict[str, object]:
    return startup_diagnostics_payload(
        client=client,
        session_store_path=str(store.db_path),
        bot_token_configured=bool(BOT_TOKEN),
        debug=DEBUG,
        dev_reload=DEV_RELOAD,
        request_debug=REQUEST_DEBUG,
        force_secure_cookies=FORCE_SECURE_COOKIES,
        trust_proxy_headers=TRUST_PROXY_HEADERS,
        enforce_origin_check=ENFORCE_ORIGIN_CHECK,
        allowed_origins_count=len(ALLOWED_ORIGINS),
        rate_limit_window_seconds=RATE_LIMIT_WINDOW_SECONDS,
        rate_limit_api_requests=RATE_LIMIT_API_REQUESTS,
        rate_limit_stream_requests=RATE_LIMIT_STREAM_REQUESTS,
        assistant_chunk_len=ASSISTANT_CHUNK_LEN,
        assistant_hard_limit=ASSISTANT_HARD_LIMIT,
    )


def _log_startup_diagnostics() -> None:
    payload = _startup_diagnostics_payload()
    log_startup_diagnostics(logger=app.logger, payload=payload)


runtime.start_once()
_log_startup_diagnostics()


@app.before_request
def enforce_request_guards() -> Response | None:
    return enforce_api_request_guards(
        origin_allowed_fn=_origin_allowed,
        check_rate_limit_fn=_check_rate_limit,
        rate_limit_window_seconds=RATE_LIMIT_WINDOW_SECONDS,
        rate_limit_api_requests=RATE_LIMIT_API_REQUESTS,
        rate_limit_stream_requests=RATE_LIMIT_STREAM_REQUESTS,
        new_request_id_fn=new_request_id,
        now_ms_fn=now_ms,
        auth_cookie_name=AUTH_COOKIE_NAME,
        verify_auth_session_token_fn=_verify_auth_session_token,
    )


@app.after_request
def add_security_headers(response: Response) -> Response:
    response = apply_security_headers(
        response,
        csp_nonce=str(getattr(g, "csp_nonce", "") or ""),
        enable_hsts=ENABLE_HSTS,
    )

    request_started_ms = float(getattr(g, "request_started_ms", now_ms()))
    elapsed_ms = max(0, int(now_ms() - request_started_ms))
    request_id = str(getattr(g, "request_id", ""))
    app.logger.info(
        build_request_log(
            request=request,
            request_id=request_id,
            status_code=response.status_code,
            elapsed_ms=elapsed_ms,
        )
    )
    if request.path in STATIC_NO_STORE_PATHS:
        response.headers["Cache-Control"] = "no-store, max-age=0"
    if request_id:
        response.headers.setdefault("X-Request-Id", request_id)
    return response


register_public_routes(
    public_bp,
    app=app,
    allowed_skins=ALLOWED_SKINS,
    skin_cookie_name=SKIN_COOKIE_NAME,
    max_message_len=MAX_MESSAGE_LEN,
    dev_reload=DEV_RELOAD,
    dev_reload_interval_ms=DEV_RELOAD_INTERVAL_MS,
    request_debug=REQUEST_DEBUG,
    dev_auth_enabled=DEV_AUTH_ENABLED,
    static_no_store_filenames=STATIC_NO_STORE_FILENAMES,
    asset_version_fn=lambda filename: _asset_version(filename),
    dev_reload_version_fn=lambda: _dev_reload_version(),
    ensure_csp_nonce_fn=_ensure_csp_nonce,
)


register_auth_routes(
    api_bp,
    store_getter=_RUNTIME_DEPS.store_getter,
    runtime_getter=_RUNTIME_DEPS.runtime_getter,
    request_payload_fn=_request_payload,
    verify_for_json_fn=_verify_for_json,
    serialize_chat_fn=_serialize_chat,
    cookie_secure_fn=_cookie_secure,
    create_auth_session_token_fn=_create_auth_session_token,
    allowed_skins=ALLOWED_SKINS,
    skin_cookie_name=SKIN_COOKIE_NAME,
    auth_cookie_name=AUTH_COOKIE_NAME,
    auth_session_max_age_seconds=AUTH_SESSION_MAX_AGE_SECONDS,
    build_job_log_fn=build_job_log,
    logger=app.logger,
    dev_auth_enabled=DEV_AUTH_ENABLED,
    dev_auth_secret=DEV_AUTH_SECRET,
)


register_chat_routes(
    api_bp,
    context=ChatRouteContext(
        store_getter=_RUNTIME_DEPS.store_getter,
        client_getter=_RUNTIME_DEPS.client_getter,
        runtime_getter=_RUNTIME_DEPS.runtime_getter,
        job_wake_event_getter=_RUNTIME_DEPS.job_wake_event_getter,
        request_payload_fn=_request_payload,
        json_user_id_or_error_fn=_json_user_id_or_error,
        verify_for_json_fn=_verify_for_json,
        verify_for_sse_fn=_verify_for_sse,
        chat_id_from_payload_or_error_fn=_chat_id_from_payload_or_error,
        chat_id_from_payload_fn=lambda payload, user_id: _chat_id_from_payload(payload, user_id=user_id),
        validated_title_fn=lambda raw_title, default: _validated_title(raw_title, default=default),
        validated_message_fn=_validated_message,
        json_error_fn=_json_error,
        sse_error_fn=_sse_error,
        sse_event_fn=lambda event, data: _sse_event(event, data),
        serialize_chat_fn=_serialize_chat,
        session_id_builder_fn=_session_id_for,
        job_max_attempts=JOB_MAX_ATTEMPTS,
        build_job_log_fn=build_job_log,
        logger=app.logger,
    ),
)


register_jobs_runtime_routes(
    api_bp,
    store_getter=_RUNTIME_DEPS.store_getter,
    client_getter=_RUNTIME_DEPS.client_getter,
    runtime_getter=_RUNTIME_DEPS.runtime_getter,
    request_payload_fn=_request_payload,
    json_user_id_or_error_fn=_json_user_id_or_error,
    verify_for_json_fn=_verify_for_json,
)


register_meta_routes(
    api_bp,
    allowed_skins=ALLOWED_SKINS,
)


app.register_blueprint(public_bp)
app.register_blueprint(api_bp)


def create_app() -> Flask:
    return app


if __name__ == "__main__":
    bind_host = os.environ.get("MINI_APP_BIND_HOST", "127.0.0.1").strip() or "127.0.0.1"
    app.run(host=bind_host, port=PORT, debug=DEBUG, threaded=True)
