from __future__ import annotations

import json
import os
import queue
import threading
import time
from pathlib import Path

from flask import Flask, Response, g, jsonify, make_response, render_template, request, send_from_directory

from app_factory import create_flask_app
from assets import asset_version, dev_reload_version
from auth import TelegramAuthError, VerifiedTelegramInitData, verify_telegram_init_data
from auth_session import (
    create_auth_session_token,
    verified_from_session_cookie,
    verify_auth_session_token,
    verify_from_payload,
)
from blueprints import create_api_blueprint, create_public_blueprint
from hermes_client import HermesClient
from job_runtime import JobRuntime
from miniapp_config import MiniAppConfig, normalize_origin
from rate_limiter import SlidingWindowRateLimiter
from request_context import (
    chat_id_from_payload_or_error,
    json_error,
    json_user_id_or_error,
    request_payload,
    sse_error,
    sse_user_id_or_error,
    verify_for_json,
    verify_for_sse,
)
from request_guards import enforce_api_request_guards
from request_logging import build_job_log, build_request_log, new_request_id, now_ms
from routes_auth import register_auth_routes
from routes_chat import register_chat_routes
from routes_jobs_runtime import register_jobs_runtime_routes
from routes_meta import register_meta_routes
from security_headers import apply_security_headers, generate_csp_nonce
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
JOB_EVENT_HISTORY_MAX_JOBS = CONFIG.job_event_history_max_jobs
JOB_EVENT_HISTORY_TTL_SECONDS = CONFIG.job_event_history_ttl_seconds
DEV_RELOAD_WATCH_PATHS = CONFIG.dev_reload_watch_paths

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
        app.logger.info("miniapp req method=%s path=%s host=%s ua=%s", request.method, request.path, request.host, request.headers.get("User-Agent", "")[:160])
    except Exception:
        pass


public_bp = create_public_blueprint()
api_bp = create_api_blueprint()
client = HermesClient()
store = SessionStore(BASE_DIR / "sessions.db")

_JOB_WAKE_EVENT = threading.Event()
_RATE_LIMITER = SlidingWindowRateLimiter()


def _session_id_for(user_id: str, chat_id: int) -> str:
    return f"miniapp-{user_id}-{chat_id}"


runtime = JobRuntime(
    store=store,
    client=client,
    job_max_attempts=JOB_MAX_ATTEMPTS,
    job_retry_base_seconds=JOB_RETRY_BASE_SECONDS,
    job_worker_concurrency=JOB_WORKER_CONCURRENCY,
    job_stall_timeout_seconds=JOB_STALL_TIMEOUT_SECONDS,
    assistant_chunk_len=ASSISTANT_CHUNK_LEN,
    assistant_hard_limit=ASSISTANT_HARD_LIMIT,
    job_event_history_max_jobs=JOB_EVENT_HISTORY_MAX_JOBS,
    job_event_history_ttl_seconds=JOB_EVENT_HISTORY_TTL_SECONDS,
    session_id_builder=lambda user_id, chat_id: _session_id_for(user_id, chat_id),
)
_JOB_WAKE_EVENT = runtime.wake_event


def _sync_runtime_bindings() -> None:
    # Tests monkeypatch module globals (`store`, `client`) after import.
    # Keep runtime wired to current globals so wrappers stay back-compat.
    runtime.store = store
    runtime.client = client


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
    runtime.publish_job_event(job_id, event_name, payload)


def _subscribe_job_events(job_id: int) -> queue.Queue[dict[str, object]]:
    return runtime.subscribe_job_events(job_id)


def _unsubscribe_job_events(job_id: int, subscriber: queue.Queue[dict[str, object]]) -> None:
    runtime.unsubscribe_job_events(job_id, subscriber)


def _run_chat_job(job: dict[str, object]) -> None:
    _sync_runtime_bindings()
    runtime.run_chat_job(job)


def _is_stale_chat_job_error(exc: Exception) -> bool:
    return runtime.is_stale_chat_job_error(exc)


def _create_auth_session_token(user_id: str) -> str:
    return create_auth_session_token(
        user_id,
        bot_token=BOT_TOKEN,
        auth_session_max_age_seconds=AUTH_SESSION_MAX_AGE_SECONDS,
        upsert_auth_session_fn=store.upsert_auth_session,
    )


def _verify_auth_session_token(token: str) -> str | None:
    return verify_auth_session_token(
        token,
        bot_token=BOT_TOKEN,
        is_auth_session_active_fn=store.is_auth_session_active,
    )


def _verified_from_session_cookie() -> VerifiedTelegramInitData | None:
    token = request.cookies.get(AUTH_COOKIE_NAME, "")
    return verified_from_session_cookie(
        token=token,
        verify_auth_session_token_fn=_verify_auth_session_token,
    )


def _verify_from_payload(payload: dict[str, object]) -> VerifiedTelegramInitData:
    return verify_from_payload(
        payload,
        bot_token=BOT_TOKEN,
        telegram_init_data_max_age_seconds=TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
        verified_from_session_cookie_fn=_verified_from_session_cookie,
        verify_telegram_init_data_fn=verify_telegram_init_data,
    )


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
    return parse_chat_id(payload, default_chat_id=store.ensure_default_chat(user_id))


def _validated_title(raw_title: object, *, default: str) -> str:
    return validate_title(raw_title, default=default, max_length=MAX_TITLE_LEN)


def _validated_message(raw_message: object) -> str:
    return validate_message(raw_message, max_length=MAX_MESSAGE_LEN)


def _json_error(message: str, status: int) -> tuple[dict[str, object], int]:
    return json_error(message, status)


def _sse_event(event: str, data: dict[str, object]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def _sse_error(message: str, status: int, *, chat_id: int | None = None) -> Response:
    return sse_error(message, status, chat_id=chat_id, sse_event_fn=_sse_event)


def _verify_for_json(payload: dict[str, object]) -> tuple[VerifiedTelegramInitData | None, tuple[dict[str, object], int] | None]:
    return verify_for_json(payload, verify_from_payload_fn=_verify_from_payload)


def _verify_for_sse(payload: dict[str, object]) -> tuple[VerifiedTelegramInitData | None, Response | None]:
    return verify_for_sse(payload, verify_from_payload_fn=_verify_from_payload, sse_event_fn=_sse_event)


def _request_payload() -> dict[str, object]:
    return request_payload()


def _json_user_id_or_error(payload: dict[str, object]) -> tuple[str | None, tuple[dict[str, object], int] | None]:
    return json_user_id_or_error(payload, verify_for_json_fn=_verify_for_json)


def _sse_user_id_or_error(payload: dict[str, object]) -> tuple[str | None, Response | None]:
    return sse_user_id_or_error(payload, verify_for_sse_fn=_verify_for_sse)


def _chat_id_from_payload_or_error(payload: dict[str, object], *, user_id: str) -> tuple[int | None, tuple[dict[str, object], int] | None]:
    return chat_id_from_payload_or_error(
        payload,
        user_id=user_id,
        chat_id_from_payload_fn=_chat_id_from_payload,
    )


def _asset_version(filename: str) -> str:
    return asset_version(BASE_DIR, filename)


def _dev_reload_version() -> str:
    return dev_reload_version(BASE_DIR, DEV_RELOAD_WATCH_PATHS)


_sync_runtime_bindings()
runtime.start_once()


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
    if request.path in {"/static/app.js", "/static/app.css", "/static/runtime_helpers.js", "/static/app_shared_utils.js", "/static/chat_ui_helpers.js", "/static/message_actions_helpers.js"}:
        response.headers["Cache-Control"] = "no-store, max-age=0"
    if request_id:
        response.headers.setdefault("X-Request-Id", request_id)
    return response


@public_bp.get("/")
def root() -> tuple[dict[str, str], int]:
    return {"status": "ok", "service": "hermes-miniapp"}, 200


@public_bp.get("/app")
def mini_app() -> Response:
    boot_skin = str(request.cookies.get(SKIN_COOKIE_NAME, "terminal")).strip().lower()
    if boot_skin not in ALLOWED_SKINS:
        boot_skin = "terminal"

    response = make_response(
        render_template(
            "app.html",
            css_version=_asset_version("app.css"),
            helpers_version=_asset_version("runtime_helpers.js"),
            shared_utils_version=_asset_version("app_shared_utils.js"),
            chat_ui_helpers_version=_asset_version("chat_ui_helpers.js"),
            message_actions_helpers_version=_asset_version("message_actions_helpers.js"),
            app_js_version=_asset_version("app.js"),
            dev_reload=DEV_RELOAD,
            dev_reload_interval_ms=DEV_RELOAD_INTERVAL_MS,
            dev_reload_version=_dev_reload_version(),
            request_debug=REQUEST_DEBUG,
            boot_skin=boot_skin,
            csp_nonce=_ensure_csp_nonce(),
            max_message_len=MAX_MESSAGE_LEN,
        )
    )
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


@public_bp.get("/health")
def health() -> tuple[dict[str, str], int]:
    return {"status": "ok"}, 200


@public_bp.get("/dev/reload-state")
def dev_reload_state() -> Response | tuple[dict[str, object], int]:
    if not DEV_RELOAD:
        return {"ok": False, "enabled": False}, 404
    response = jsonify(
        {
            "ok": True,
            "enabled": True,
            "version": _dev_reload_version(),
            "interval_ms": DEV_RELOAD_INTERVAL_MS,
        }
    )
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


@public_bp.get("/static/<path:filename>")
def static_files(filename: str):
    response = send_from_directory(app.static_folder, filename)
    if filename in {"app.js", "app.css", "runtime_helpers.js", "app_shared_utils.js", "chat_ui_helpers.js", "message_actions_helpers.js"}:
        response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


register_auth_routes(
    api_bp,
    store_getter=lambda: store,
    runtime_getter=lambda: runtime,
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
)


register_chat_routes(
    api_bp,
    store_getter=lambda: store,
    client_getter=lambda: client,
    runtime_getter=lambda: runtime,
    job_wake_event_getter=lambda: _JOB_WAKE_EVENT,
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
)


register_jobs_runtime_routes(
    api_bp,
    store_getter=lambda: store,
    client_getter=lambda: client,
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
    app.run(host="0.0.0.0", port=PORT, debug=DEBUG, threaded=True)
