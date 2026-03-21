from __future__ import annotations

import hashlib
import hmac
import json
import os
import queue
import threading
import time
from collections import defaultdict, deque
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from urllib.parse import urlparse

from flask import Flask, Response, jsonify, make_response, render_template, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

from auth import TelegramAuthError, TelegramUser, VerifiedTelegramInitData, verify_telegram_init_data
from hermes_client import HermesClient, HermesClientError
from job_runtime import JobRuntime
from store import ChatThread, SessionStore

BASE_DIR = Path(__file__).resolve().parent
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
PORT = int(os.environ.get("PORT", "8080"))
DEBUG = os.environ.get("FLASK_DEBUG", "0") == "1"
DEV_RELOAD = os.environ.get("MINI_APP_DEV_RELOAD", "0") == "1"
ALLOWED_SKINS = {"terminal", "oracle", "obsidian"}
SKIN_COOKIE_NAME = "hermes_skin"
AUTH_COOKIE_NAME = "hermes_session"
AUTH_SESSION_MAX_AGE_SECONDS = int(os.environ.get("MINI_APP_AUTH_SESSION_MAX_AGE_SECONDS", str(60 * 60 * 24 * 7)))
MAX_MESSAGE_LEN = int(os.environ.get("MAX_MESSAGE_LEN", "4000"))
MAX_TITLE_LEN = int(os.environ.get("MAX_TITLE_LEN", "120"))
ASSISTANT_CHUNK_LEN = int(os.environ.get("MAX_ASSISTANT_CHUNK_LEN", "12000"))
ASSISTANT_HARD_LIMIT = int(os.environ.get("MAX_ASSISTANT_HARD_LIMIT", "256000"))
DEV_RELOAD_INTERVAL_MS = int(os.environ.get("MINI_APP_DEV_RELOAD_INTERVAL_MS", "1200"))
JOB_MAX_ATTEMPTS = int(os.environ.get("MINI_APP_JOB_MAX_ATTEMPTS", "4"))
JOB_RETRY_BASE_SECONDS = int(os.environ.get("MINI_APP_JOB_RETRY_BASE_SECONDS", "2"))
JOB_WORKER_CONCURRENCY = max(1, int(os.environ.get("MINI_APP_JOB_WORKER_CONCURRENCY", "6")))
JOB_STALL_TIMEOUT_SECONDS = max(60, int(os.environ.get("MINI_APP_JOB_STALL_TIMEOUT_SECONDS", "240")))
TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = int(os.environ.get("TELEGRAM_INIT_DATA_MAX_AGE_SECONDS", "21600"))
TRUST_PROXY_HEADERS = os.environ.get("MINI_APP_TRUST_PROXY_HEADERS", "1") == "1"
FORCE_SECURE_COOKIES = os.environ.get("MINI_APP_FORCE_SECURE_COOKIES", "1") == "1"
ALLOWED_ORIGINS = {
    value.strip().lower().rstrip("/")
    for value in os.environ.get("MINI_APP_ALLOWED_ORIGINS", "").split(",")
    if value.strip()
}
ENFORCE_ORIGIN_CHECK = os.environ.get("MINI_APP_ENFORCE_ORIGIN_CHECK", "0") == "1"
RATE_LIMIT_WINDOW_SECONDS = max(5, int(os.environ.get("MINI_APP_RATE_LIMIT_WINDOW_SECONDS", "60")))
RATE_LIMIT_API_REQUESTS = max(10, int(os.environ.get("MINI_APP_RATE_LIMIT_API_REQUESTS", "180")))
RATE_LIMIT_STREAM_REQUESTS = max(3, int(os.environ.get("MINI_APP_RATE_LIMIT_STREAM_REQUESTS", "24")))
ENABLE_HSTS = os.environ.get("MINI_APP_ENABLE_HSTS", "0") == "1"
JOB_EVENT_HISTORY_MAX_JOBS = max(32, int(os.environ.get("MINI_APP_JOB_EVENT_HISTORY_MAX_JOBS", "256")))
JOB_EVENT_HISTORY_TTL_SECONDS = max(60, int(os.environ.get("MINI_APP_JOB_EVENT_HISTORY_TTL_SECONDS", "1800")))
DEV_RELOAD_WATCH_PATHS = (
    BASE_DIR / "server.py",
    BASE_DIR / "templates" / "app.html",
    BASE_DIR / "static" / "app.css",
    BASE_DIR / "static" / "app.js",
)

app = Flask(__name__, template_folder=str(BASE_DIR / "templates"), static_folder=str(BASE_DIR / "static"))
if TRUST_PROXY_HEADERS:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)  # type: ignore[assignment]
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_CONTENT_LENGTH", "1048576"))
app.config["TEMPLATES_AUTO_RELOAD"] = DEBUG or DEV_RELOAD
app.jinja_env.auto_reload = DEBUG or DEV_RELOAD
client = HermesClient()
store = SessionStore(BASE_DIR / "sessions.db")

_JOB_WAKE_EVENT = threading.Event()

_RATE_LIMIT_LOCK = threading.Lock()
_RATE_LIMIT_BUCKETS: dict[str, deque[float]] = defaultdict(deque)


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


def _normalized_origin(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}".rstrip("/")


def _origin_allowed() -> bool:
    if not ALLOWED_ORIGINS or not ENFORCE_ORIGIN_CHECK:
        return True

    origin = _normalized_origin(request.headers.get("Origin"))
    if origin:
        return origin in ALLOWED_ORIGINS

    referer = _normalized_origin(request.headers.get("Referer"))
    if referer:
        return referer in ALLOWED_ORIGINS

    return False


def _check_rate_limit(*, key: str, limit: int, window_seconds: int) -> bool:
    now = time.monotonic()
    cutoff = now - max(1, int(window_seconds))
    with _RATE_LIMIT_LOCK:
        bucket = _RATE_LIMIT_BUCKETS[key]
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= max(1, int(limit)):
            return False
        bucket.append(now)
        return True


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


def _create_auth_session_token(user_id: str) -> str:
    expires_at = int(time.time()) + max(60, AUTH_SESSION_MAX_AGE_SECONDS)
    nonce = os.urandom(8).hex()
    payload = f"{user_id}:{expires_at}:{nonce}"
    signature = hmac.new(_session_secret_key(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}:{signature}"


def _verify_auth_session_token(token: str) -> str | None:
    value = str(token or "").strip()
    if not value:
        return None

    parts = value.split(":")
    if len(parts) != 4:
        return None

    user_id, expires_raw, nonce, signature = parts
    if not user_id or not expires_raw or not nonce or not signature:
        return None

    payload = f"{user_id}:{expires_raw}:{nonce}"
    expected_sig = hmac.new(_session_secret_key(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected_sig):
        return None

    try:
        expires_at = int(expires_raw)
    except ValueError:
        return None

    if expires_at < int(time.time()):
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
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: https:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org; "
        "base-uri 'self'; form-action 'self'",
    )
    if ENABLE_HSTS:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


@app.get("/")
def root() -> tuple[dict[str, str], int]:
    return {"status": "ok", "service": "hermes-miniapp"}, 200


@app.get("/app")
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
        )
    )
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


@app.get("/health")
def health() -> tuple[dict[str, str], int]:
    return {"status": "ok"}, 200


@app.get("/dev/reload-state")
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


@app.get("/static/<path:filename>")
def static_files(filename: str):
    response = send_from_directory(app.static_folder, filename)
    if filename in {"app.js", "app.css"}:
        response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


@app.post("/api/auth")
def auth() -> Response | tuple[dict[str, object], int]:
    payload = _request_payload()
    verified, auth_error = _verify_for_json(payload)
    if auth_error:
        return auth_error

    user_id = str(verified.user.id)
    runtime.ensure_pending_jobs(user_id)
    display_name = verified.user.first_name or verified.user.username or "Operator"
    default_chat_id = store.ensure_default_chat(user_id)
    active_chat_id = store.get_active_chat(user_id) or default_chat_id
    try:
        store.get_chat(user_id=user_id, chat_id=active_chat_id)
    except KeyError:
        active_chat_id = default_chat_id

    history = [asdict(turn) for turn in store.get_history(user_id=user_id, chat_id=active_chat_id, limit=120)]
    store.mark_chat_read(user_id=user_id, chat_id=active_chat_id)
    store.set_active_chat(user_id=user_id, chat_id=active_chat_id)
    chats = [_serialize_chat(chat) for chat in store.list_chats(user_id=user_id)]
    skin = store.get_skin(user_id=user_id)
    response = jsonify(
        {
            "ok": True,
            "user": {
                "id": verified.user.id,
                "display_name": display_name,
                "username": verified.user.username,
            },
            "skin": skin,
            "active_chat_id": active_chat_id,
            "history": history,
            "chats": chats,
            "stats": {"turn_count": store.get_turn_count(user_id)},
        }
    )
    response.set_cookie(
        SKIN_COOKIE_NAME,
        skin,
        max_age=60 * 60 * 24 * 365,
        samesite="Lax",
        secure=_cookie_secure(),
    )
    response.set_cookie(
        AUTH_COOKIE_NAME,
        _create_auth_session_token(user_id),
        max_age=max(60, AUTH_SESSION_MAX_AGE_SECONDS),
        httponly=True,
        samesite="Lax",
        secure=_cookie_secure(),
    )
    return response


@app.post("/api/preferences/skin")
def set_skin() -> Response | tuple[dict[str, object], int]:
    payload = _request_payload()
    skin = str(payload.get("skin", "")).strip().lower()
    if skin not in ALLOWED_SKINS:
        return {"ok": False, "error": f"Unsupported skin: {skin or 'unknown'}"}, 400

    verified, auth_error = _verify_for_json(payload)
    if auth_error:
        return auth_error

    store.set_skin(user_id=str(verified.user.id), skin=skin)
    response = jsonify({"ok": True, "skin": skin})
    response.set_cookie(
        SKIN_COOKIE_NAME,
        skin,
        max_age=60 * 60 * 24 * 365,
        samesite="Lax",
        secure=_cookie_secure(),
    )
    return response


@app.post("/api/chats")
def create_chat() -> tuple[dict[str, object], int]:
    payload = _request_payload()
    try:
        title = _validated_title(payload.get("title"), default="New chat")
    except ValueError as exc:
        return _json_error(str(exc), 400)

    user_id, auth_error = _json_user_id_or_error(payload)
    if auth_error:
        return auth_error

    chat = store.create_chat(user_id=user_id, title=title)
    store.set_active_chat(user_id=user_id, chat_id=chat.id)
    history = _chat_history(user_id=user_id, chat_id=chat.id, limit=120)
    return {"ok": True, "chat": _serialize_chat(chat), "history": history}, 201


@app.post("/api/chats/rename")
def rename_chat() -> tuple[dict[str, object], int]:
    payload = _request_payload()
    user_id, auth_error = _json_user_id_or_error(payload)
    if auth_error:
        return auth_error

    chat_id, chat_id_error = _chat_id_from_payload_or_error(payload, user_id=user_id)
    if chat_id_error:
        return chat_id_error

    try:
        title = _validated_title(payload.get("title"), default="Untitled")
        chat = store.rename_chat(user_id=user_id, chat_id=chat_id, title=title)
    except ValueError as exc:
        return _json_error(str(exc), 400)
    except KeyError as exc:
        return _json_error(str(exc), 404)
    return {"ok": True, "chat": _serialize_chat(chat)}, 200


def _chat_history_payload(user_id: str, chat_id: int, *, activate: bool) -> dict[str, object]:
    if activate:
        store.mark_chat_read(user_id=user_id, chat_id=chat_id)
        store.set_active_chat(user_id=user_id, chat_id=chat_id)
    history = [asdict(turn) for turn in store.get_history(user_id=user_id, chat_id=chat_id, limit=120)]
    chat = store.get_chat(user_id=user_id, chat_id=chat_id)
    return {"ok": True, "chat": _serialize_chat(chat), "history": history}


@app.post("/api/chats/open")
def open_chat() -> tuple[dict[str, object], int]:
    payload = _request_payload()
    user_id, auth_error = _json_user_id_or_error(payload)
    if auth_error:
        return auth_error

    chat_id, chat_id_error = _chat_id_from_payload_or_error(payload, user_id=user_id)
    if chat_id_error:
        return chat_id_error

    try:
        response_payload = _chat_history_payload(user_id=user_id, chat_id=chat_id, activate=True)
    except KeyError as exc:
        return _json_error(str(exc), 404)

    return response_payload, 200


@app.post("/api/chats/history")
def chat_history() -> tuple[dict[str, object], int]:
    payload = _request_payload()
    user_id, auth_error = _json_user_id_or_error(payload)
    if auth_error:
        return auth_error

    chat_id, chat_id_error = _chat_id_from_payload_or_error(payload, user_id=user_id)
    if chat_id_error:
        return chat_id_error

    try:
        activate = bool(payload.get("activate", False))
        response_payload = _chat_history_payload(user_id=user_id, chat_id=chat_id, activate=activate)
    except KeyError as exc:
        return _json_error(str(exc), 404)

    return response_payload, 200


@app.post("/api/chats/mark-read")
def mark_chat_read() -> tuple[dict[str, object], int]:
    payload = _request_payload()
    user_id, auth_error = _json_user_id_or_error(payload)
    if auth_error:
        return auth_error

    chat_id, chat_id_error = _chat_id_from_payload_or_error(payload, user_id=user_id)
    if chat_id_error:
        return chat_id_error

    try:
        store.mark_chat_read(user_id=user_id, chat_id=chat_id)
        chat = store.get_chat(user_id=user_id, chat_id=chat_id)
    except KeyError as exc:
        return _json_error(str(exc), 404)
    return {"ok": True, "chat": _serialize_chat(chat)}, 200


@app.post("/api/chats/clear")
def clear_chat() -> tuple[dict[str, object], int]:
    payload = _request_payload()
    user_id, auth_error = _json_user_id_or_error(payload)
    if auth_error:
        return auth_error

    chat_id, chat_id_error = _chat_id_from_payload_or_error(payload, user_id=user_id)
    if chat_id_error:
        return chat_id_error

    try:
        store.clear_chat(user_id=user_id, chat_id=chat_id)
        chat = store.get_chat(user_id=user_id, chat_id=chat_id)
        _evict_chat_runtime(user_id=user_id, chat_id=chat_id)
    except KeyError as exc:
        return _json_error(str(exc), 404)
    return {"ok": True, "chat": _serialize_chat(chat), "history": []}, 200


@app.post("/api/chats/remove")
def remove_chat() -> tuple[dict[str, object], int]:
    payload = _request_payload()
    user_id, auth_error = _json_user_id_or_error(payload)
    if auth_error:
        return auth_error

    chat_id, chat_id_error = _chat_id_from_payload_or_error(payload, user_id=user_id)
    if chat_id_error:
        return chat_id_error

    try:
        _evict_chat_runtime(user_id=user_id, chat_id=chat_id)
        next_chat_id = store.remove_chat(user_id=user_id, chat_id=chat_id)
        history = _chat_history(user_id=user_id, chat_id=next_chat_id, limit=120)
        store.mark_chat_read(user_id=user_id, chat_id=next_chat_id)
        store.set_active_chat(user_id=user_id, chat_id=next_chat_id)
        active_chat = store.get_chat(user_id=user_id, chat_id=next_chat_id)
        chats = _serialize_chats(user_id=user_id)
    except KeyError as exc:
        return _json_error(str(exc), 404)
    return {
        "ok": True,
        "removed_chat_id": chat_id,
        "active_chat_id": next_chat_id,
        "active_chat": _serialize_chat(active_chat),
        "history": history,
        "chats": chats,
    }, 200


@app.post("/api/chats/status")
def chats_status() -> tuple[dict[str, object], int]:
    payload = _request_payload()
    user_id, auth_error = _json_user_id_or_error(payload)
    if auth_error:
        return auth_error
    runtime.ensure_pending_jobs(user_id)
    chats = _serialize_chats(user_id=user_id)
    return {"ok": True, "chats": chats}, 200


@app.post("/api/jobs/status")
def jobs_status() -> tuple[dict[str, object], int]:
    payload = _request_payload()
    user_id, auth_error = _json_user_id_or_error(payload)
    if auth_error:
        return auth_error

    limit = int(payload.get("limit") or 25)
    jobs = store.list_jobs(user_id=user_id, limit=limit)
    dead_letters = store.list_dead_letters(user_id=user_id, limit=limit)
    summary = {
        "queued": sum(1 for job in jobs if job["status"] == "queued"),
        "running": sum(1 for job in jobs if job["status"] == "running"),
        "done": sum(1 for job in jobs if job["status"] == "done"),
        "error": sum(1 for job in jobs if job["status"] == "error"),
        "dead": sum(1 for job in jobs if job["status"] == "dead"),
        "dead_letter_count": len(dead_letters),
    }
    return {"ok": True, "summary": summary, "jobs": jobs, "dead_letters": dead_letters}, 200


@app.post("/api/jobs/cleanup")
def jobs_cleanup() -> tuple[dict[str, object], int]:
    payload = _request_payload()
    user_id, auth_error = _json_user_id_or_error(payload)
    if auth_error:
        return auth_error

    limit = int(payload.get("limit") or 200)
    cleaned = store.cleanup_stale_jobs(user_id=user_id, limit=limit)
    return {
        "ok": True,
        "cleaned_count": len(cleaned),
        "cleaned": cleaned,
    }, 200


@app.post("/api/runtime/status")
def runtime_status() -> tuple[dict[str, object], int]:
    payload = _request_payload()
    _, auth_error = _verify_for_json(payload)
    if auth_error:
        return auth_error

    runtime = client.runtime_status()
    return {
        "ok": True,
        "persistent": runtime.get("persistent") or {},
        "routing": runtime.get("routing") or {},
    }, 200


def _resolve_active_chat(payload: dict[str, object], *, user_id: str) -> int:
    chat_id = _chat_id_from_payload(payload, user_id=user_id)
    store.set_active_chat(user_id=user_id, chat_id=chat_id)
    return chat_id


def _chat_history(user_id: str, chat_id: int, *, limit: int = 120) -> list[dict[str, object]]:
    return [asdict(turn) for turn in store.get_history(user_id=user_id, chat_id=chat_id, limit=limit)]


def _serialize_chats(user_id: str) -> list[dict[str, object]]:
    return [_serialize_chat(chat) for chat in store.list_chats(user_id=user_id)]


def _evict_chat_runtime(user_id: str, chat_id: int) -> None:
    session_id = _session_id_for(user_id, chat_id)
    client.evict_session(session_id)
    store.delete_runtime_checkpoint(session_id)


def _add_operator_message(user_id: str, chat_id: int, message: str) -> int:
    return store.add_message(user_id=user_id, chat_id=chat_id, role="operator", body=message)


@app.post("/api/chat")
def chat() -> tuple[object, int]:
    payload = _request_payload()
    try:
        message = _validated_message(payload.get("message"))
    except ValueError as exc:
        return _json_error(str(exc), 400)

    verified, auth_error = _verify_for_json(payload)
    if auth_error:
        return auth_error

    user_id = str(verified.user.id)
    try:
        chat_id = _resolve_active_chat(payload, user_id=user_id)
        _add_operator_message(user_id=user_id, chat_id=chat_id, message=message)
    except (KeyError, ValueError) as exc:
        return _json_error(str(exc), 400)

    history = _chat_history(user_id=user_id, chat_id=chat_id, limit=120)

    started = time.perf_counter()
    try:
        reply = client.ask(user_id=user_id, message=message, conversation_history=history)
    except HermesClientError as exc:
        return _json_error(str(exc), 502)

    latency_ms = int((time.perf_counter() - started) * 1000) if not reply.latency_ms else reply.latency_ms
    store.add_message(user_id=user_id, chat_id=chat_id, role="hermes", body=reply.text)

    return jsonify(
        {
            "ok": True,
            "reply": reply.text,
            "source": reply.source,
            "skin": store.get_skin(user_id),
            "latency_ms": latency_ms,
            "turn_count": store.get_turn_count(user_id, chat_id=chat_id),
            "chat_id": chat_id,
        }
    )


def _stream_job_response(*, user_id: str, chat_id: int, job_id: int) -> Response:
    def generate() -> Iterator[str]:
        subscriber = _subscribe_job_events(job_id)
        terminal = False
        last_queue_heartbeat = 0.0

        try:
            yield _sse_event("meta", {"skin": store.get_skin(user_id), "source": "queue", "chat_id": chat_id})
            while not terminal:
                try:
                    event = subscriber.get(timeout=0.6)
                except queue.Empty:
                    now = time.monotonic()
                    if (now - last_queue_heartbeat) >= 4.0:
                        state = store.get_job_state(job_id)
                        if state:
                            elapsed_ms = None
                            started_at_raw = str(state.get("started_at") or "").strip()
                            if started_at_raw:
                                try:
                                    started_dt = datetime.strptime(started_at_raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                                    elapsed_ms = max(
                                        0,
                                        int((datetime.now(timezone.utc) - started_dt).total_seconds() * 1000),
                                    )
                                except ValueError:
                                    elapsed_ms = None

                            heartbeat_payload = {
                                "chat_id": chat_id,
                                "source": "queue",
                                "detail": (
                                    f"queued (ahead: {state.get('queued_ahead', 0)})"
                                    if state.get("status") == "queued"
                                    else "running"
                                ),
                                "job_status": state.get("status"),
                                "queued_ahead": state.get("queued_ahead"),
                                "running_total": state.get("running_total"),
                                "attempt": state.get("attempts"),
                                "max_attempts": state.get("max_attempts"),
                                "started_at": state.get("started_at"),
                                "created_at": state.get("created_at"),
                                "elapsed_ms": elapsed_ms,
                            }
                            yield _sse_event("meta", heartbeat_payload)
                        last_queue_heartbeat = now
                    continue
                event_name = str(event.get("event") or "message")
                payload = dict(event.get("payload") or {})
                if "chat_id" not in payload:
                    payload["chat_id"] = chat_id
                yield _sse_event(event_name, payload)
                if event_name in {"done", "error"}:
                    terminal = True
        finally:
            _unsubscribe_job_events(job_id, subscriber)

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return Response(generate(), mimetype="text/event-stream", headers=headers)


@app.post("/api/chat/stream")
def stream_chat() -> Response:
    payload = _request_payload()
    try:
        message = _validated_message(payload.get("message"))
    except ValueError as exc:
        return _sse_error(str(exc), 400)

    verified, auth_error = _verify_for_sse(payload)
    if auth_error:
        return auth_error

    user_id = str(verified.user.id)
    try:
        chat_id = _resolve_active_chat(payload, user_id=user_id)
        if store.has_open_job(user_id=user_id, chat_id=chat_id):
            return _sse_error("Hermes is already working on this chat.", 409, chat_id=chat_id)
        operator_message_id = _add_operator_message(user_id=user_id, chat_id=chat_id, message=message)
        job_id = store.enqueue_chat_job(
            user_id=user_id,
            chat_id=chat_id,
            operator_message_id=operator_message_id,
            max_attempts=JOB_MAX_ATTEMPTS,
        )
        _JOB_WAKE_EVENT.set()
    except (KeyError, ValueError) as exc:
        return _sse_error(str(exc), 400)

    return _stream_job_response(user_id=user_id, chat_id=chat_id, job_id=job_id)


@app.post("/api/chat/stream/resume")
def stream_chat_resume() -> Response:
    payload = _request_payload()

    verified, auth_error = _verify_for_sse(payload)
    if auth_error:
        return auth_error

    user_id = str(verified.user.id)
    try:
        chat_id = _resolve_active_chat(payload, user_id=user_id)
    except (KeyError, ValueError) as exc:
        return _sse_error(str(exc), 400)

    open_job = store.get_open_job(user_id=user_id, chat_id=chat_id)
    if not open_job:
        return _sse_error("No active Hermes job for this chat.", 409, chat_id=chat_id)

    _JOB_WAKE_EVENT.set()
    return _stream_job_response(user_id=user_id, chat_id=chat_id, job_id=int(open_job["id"]))

@app.get("/api/state")
def state() -> tuple[dict[str, object], int]:
    return {"ok": True, "skins": sorted(ALLOWED_SKINS)}, 200


def _sse_event(event: str, data: dict[str, object]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=DEBUG, threaded=True)
