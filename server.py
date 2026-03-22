from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import queue
import threading
import time
from pathlib import Path

from flask import Flask, Response, g, jsonify, make_response, render_template, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix
from routes_auth import register_auth_routes
from routes_chat import register_chat_routes
from routes_jobs_runtime import register_jobs_runtime_routes
from routes_meta import register_meta_routes

from auth import TelegramAuthError, TelegramUser, VerifiedTelegramInitData, verify_telegram_init_data
from blueprints import create_api_blueprint, create_public_blueprint
from hermes_client import HermesClient
from job_runtime import JobRuntime
from miniapp_config import MiniAppConfig, normalize_origin
from rate_limiter import SlidingWindowRateLimiter
from request_logging import build_job_log, build_request_log, new_request_id, now_ms
from store import ChatThread, SessionStore

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
JOB_EVENT_HISTORY_MAX_JOBS = CONFIG.job_event_history_max_jobs
JOB_EVENT_HISTORY_TTL_SECONDS = CONFIG.job_event_history_ttl_seconds
DEV_RELOAD_WATCH_PATHS = CONFIG.dev_reload_watch_paths

app = Flask(__name__, template_folder=str(BASE_DIR / "templates"), static_folder=str(BASE_DIR / "static"))
public_bp = create_public_blueprint()
api_bp = create_api_blueprint()
if TRUST_PROXY_HEADERS:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)  # type: ignore[assignment]
app.config["MAX_CONTENT_LENGTH"] = CONFIG.max_content_length
app.config["TEMPLATES_AUTO_RELOAD"] = DEBUG or DEV_RELOAD
app.jinja_env.auto_reload = DEBUG or DEV_RELOAD
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

    nonce = base64.urlsafe_b64encode(os.urandom(18)).decode("ascii").rstrip("=")
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


def _check_rate_limit(*, key: str, limit: int, window_seconds: int) -> bool:
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


def _session_secret_key() -> bytes:
    return hmac.new(b"HermesMiniAppSession", BOT_TOKEN.encode("utf-8"), hashlib.sha256).digest()


def _nonce_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _create_auth_session_token(user_id: str) -> str:
    expires_at = int(time.time()) + max(60, AUTH_SESSION_MAX_AGE_SECONDS)
    session_id = os.urandom(8).hex()
    nonce = os.urandom(8).hex()
    payload = f"{user_id}:{session_id}:{expires_at}:{nonce}"
    signature = hmac.new(_session_secret_key(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    store.upsert_auth_session(
        session_id=session_id,
        user_id=user_id,
        nonce_hash=_nonce_hash(nonce),
        expires_at=expires_at,
    )
    return f"{payload}:{signature}"


def _verify_auth_session_token(token: str) -> str | None:
    value = str(token or "").strip()
    if not value:
        return None

    parts = value.split(":")
    if len(parts) != 5:
        return None

    user_id, session_id, expires_raw, nonce, signature = parts
    if not user_id or not session_id or not expires_raw or not nonce or not signature:
        return None

    payload = f"{user_id}:{session_id}:{expires_raw}:{nonce}"
    expected_sig = hmac.new(_session_secret_key(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected_sig):
        return None

    try:
        expires_at = int(expires_raw)
    except ValueError:
        return None

    now_epoch = int(time.time())
    if expires_at < now_epoch:
        return None

    if not store.is_auth_session_active(
        session_id=session_id,
        user_id=user_id,
        nonce_hash=_nonce_hash(nonce),
        now_epoch=now_epoch,
    ):
        return None

    return user_id


def _verified_from_session_cookie() -> VerifiedTelegramInitData | None:
    token = request.cookies.get(AUTH_COOKIE_NAME, "")
    user_id = _verify_auth_session_token(token)
    if not user_id:
        return None

    try:
        numeric_user_id = int(user_id)
    except ValueError:
        return None

    now = int(time.time())
    return VerifiedTelegramInitData(
        auth_date=now,
        query_id=None,
        user=TelegramUser(
            id=numeric_user_id,
            first_name=None,
            last_name=None,
            username=None,
            language_code=None,
            is_premium=None,
        ),
        raw="cookie-session",
    )


def _verify_from_payload(payload: dict[str, object]) -> VerifiedTelegramInitData:
    if not BOT_TOKEN:
        raise TelegramAuthError("Server is missing TELEGRAM_BOT_TOKEN.")

    init_data = str(payload.get("init_data", ""))
    if init_data.strip():
        return verify_telegram_init_data(
            init_data=init_data,
            bot_token=BOT_TOKEN,
            max_age_seconds=TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
        )

    cached = _verified_from_session_cookie()
    if cached is not None:
        return cached

    return verify_telegram_init_data(
        init_data=init_data,
        bot_token=BOT_TOKEN,
        max_age_seconds=TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
    )


def _serialize_chat(chat: ChatThread) -> dict[str, object]:
    return {
        "id": chat.id,
        "title": chat.title,
        "unread_count": chat.unread_count,
        "pending": chat.pending,
        "updated_at": chat.updated_at,
        "created_at": chat.created_at,
    }


def _chat_id_from_payload(payload: dict[str, object], user_id: str) -> int:
    raw_chat_id = payload.get("chat_id")
    if raw_chat_id in (None, "", 0):
        return store.ensure_default_chat(user_id)
    try:
        return int(raw_chat_id)
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid chat_id.") from exc


def _validated_title(raw_title: object, *, default: str) -> str:
    title = str(raw_title or "").strip() or default
    if len(title) > MAX_TITLE_LEN:
        raise ValueError(f"Title exceeds {MAX_TITLE_LEN} characters.")
    return title


def _validated_message(raw_message: object) -> str:
    message = str(raw_message or "").strip()
    if not message:
        raise ValueError("Message cannot be empty.")
    if len(message) > MAX_MESSAGE_LEN:
        raise ValueError(f"Message exceeds {MAX_MESSAGE_LEN} characters.")
    return message


def _json_error(message: str, status: int) -> tuple[dict[str, object], int]:
    return {"ok": False, "error": message}, status


def _sse_error(message: str, status: int, *, chat_id: int | None = None) -> Response:
    payload: dict[str, object] = {"error": message}
    if chat_id is not None:
        payload["chat_id"] = chat_id
    return Response(_sse_event("error", payload), mimetype="text/event-stream", status=status)


def _verify_for_json(payload: dict[str, object]) -> tuple[VerifiedTelegramInitData | None, tuple[dict[str, object], int] | None]:
    try:
        return _verify_from_payload(payload), None
    except TelegramAuthError as exc:
        return None, _json_error(str(exc), 401)


def _verify_for_sse(payload: dict[str, object]) -> tuple[VerifiedTelegramInitData | None, Response | None]:
    try:
        return _verify_from_payload(payload), None
    except TelegramAuthError as exc:
        return None, _sse_error(str(exc), 401)


def _request_payload() -> dict[str, object]:
    return request.get_json(silent=True) or {}


def _json_user_id_or_error(payload: dict[str, object]) -> tuple[str | None, tuple[dict[str, object], int] | None]:
    verified, auth_error = _verify_for_json(payload)
    if auth_error:
        return None, auth_error
    return str(verified.user.id), None


def _sse_user_id_or_error(payload: dict[str, object]) -> tuple[str | None, Response | None]:
    verified, auth_error = _verify_for_sse(payload)
    if auth_error:
        return None, auth_error
    return str(verified.user.id), None


def _chat_id_from_payload_or_error(payload: dict[str, object], *, user_id: str) -> tuple[int | None, tuple[dict[str, object], int] | None]:
    try:
        return _chat_id_from_payload(payload, user_id=user_id), None
    except ValueError as exc:
        return None, _json_error(str(exc), 400)
    except KeyError as exc:
        return None, _json_error(str(exc), 404)


def _asset_version(filename: str) -> str:
    asset_path = BASE_DIR / "static" / filename
    try:
        return str(asset_path.stat().st_mtime_ns)
    except FileNotFoundError:
        return "0"


def _dev_reload_version() -> str:
    digest = hashlib.sha1()
    for path in DEV_RELOAD_WATCH_PATHS:
        try:
            stat = path.stat()
            digest.update(str(path.relative_to(BASE_DIR)).encode("utf-8"))
            digest.update(str(stat.st_mtime_ns).encode("utf-8"))
            digest.update(str(stat.st_size).encode("utf-8"))
        except FileNotFoundError:
            digest.update(str(path).encode("utf-8"))
            digest.update(b"missing")
    return digest.hexdigest()[:12]


_sync_runtime_bindings()
runtime.start_once()


@app.before_request
def enforce_request_guards() -> Response | None:
    g.request_id = new_request_id()
    g.request_started_ms = now_ms()

    if request.path.startswith("/api") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if request.mimetype != "application/json":
            return jsonify({"ok": False, "error": "Content-Type must be application/json."}), 415
        if not _origin_allowed():
            return jsonify({"ok": False, "error": "Origin not allowed."}), 403

    if not request.path.startswith("/api"):
        return None

    remote = (request.remote_addr or "unknown").strip()
    if request.path in {"/api/chat/stream", "/api/chat/stream/resume"}:
        ok = _check_rate_limit(
            key=f"stream:{remote}",
            limit=RATE_LIMIT_STREAM_REQUESTS,
            window_seconds=RATE_LIMIT_WINDOW_SECONDS,
        )
    else:
        ok = _check_rate_limit(
            key=f"api:{remote}",
            limit=RATE_LIMIT_API_REQUESTS,
            window_seconds=RATE_LIMIT_WINDOW_SECONDS,
        )

    if not ok:
        return jsonify({"ok": False, "error": "Rate limit exceeded. Please slow down."}), 429

    return None


@app.after_request
def add_security_headers(response: Response) -> Response:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
    script_src = "script-src 'self' https://telegram.org"
    csp_nonce = getattr(g, "csp_nonce", None)
    if isinstance(csp_nonce, str) and csp_nonce:
        script_src = f"{script_src} 'nonce-{csp_nonce}'"

    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        f"{script_src}; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: https:; "
        "connect-src 'self'; "
        "frame-ancestors https://web.telegram.org https://*.telegram.org; "
        "base-uri 'self'; "
        "form-action 'self'",
    )
    if ENABLE_HSTS:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

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
            js_version=_asset_version("app.js"),
            dev_reload=DEV_RELOAD,
            dev_reload_interval_ms=DEV_RELOAD_INTERVAL_MS,
            dev_reload_version=_dev_reload_version(),
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
    if filename in {"app.js", "app.css"}:
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


def _sse_event(event: str, data: dict[str, object]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


app.register_blueprint(public_bp)
app.register_blueprint(api_bp)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=DEBUG, threaded=True)
