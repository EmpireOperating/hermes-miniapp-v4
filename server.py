from __future__ import annotations

import hashlib
import hmac
import json
import os
import queue
import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Iterator

from flask import Flask, Response, jsonify, make_response, render_template, request, send_from_directory

from auth import TelegramAuthError, TelegramUser, VerifiedTelegramInitData, verify_telegram_init_data
from hermes_client import HermesClient, HermesClientError
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
DEV_RELOAD_WATCH_PATHS = (
    BASE_DIR / "server.py",
    BASE_DIR / "templates" / "app.html",
    BASE_DIR / "static" / "app.css",
    BASE_DIR / "static" / "app.js",
)

app = Flask(__name__, template_folder=str(BASE_DIR / "templates"), static_folder=str(BASE_DIR / "static"))
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_CONTENT_LENGTH", "1048576"))
app.config["TEMPLATES_AUTO_RELOAD"] = DEBUG or DEV_RELOAD
app.jinja_env.auto_reload = DEBUG or DEV_RELOAD
client = HermesClient()
store = SessionStore(BASE_DIR / "sessions.db")

_JOB_EVENT_LOCK = threading.Lock()
_JOB_EVENT_QUEUES: dict[int, list[queue.Queue[dict[str, object]]]] = {}
_JOB_EVENT_HISTORY: dict[int, list[dict[str, object]]] = {}
_JOB_WAKE_EVENT = threading.Event()
_JOB_WORKER_THREADS: list[threading.Thread] = []
_JOB_WORKER_START_LOCK = threading.Lock()
_JOB_WATCHDOG_STARTED = False
_JOB_WATCHDOG_LOCK = threading.Lock()


class JobRetryableError(Exception):
    pass


class JobNonRetryableError(Exception):
    pass


def _publish_job_event(job_id: int, event_name: str, payload: dict[str, object]) -> None:
    event = {"event": event_name, "payload": payload}
    if event_name not in {"done", "error"}:
        try:
            store.touch_job(job_id)
        except Exception:
            pass
    with _JOB_EVENT_LOCK:
        history = _JOB_EVENT_HISTORY.setdefault(job_id, [])
        history.append(event)
        if len(history) > 512:
            del history[: len(history) - 512]
        subscribers = list(_JOB_EVENT_QUEUES.get(job_id, []))

    for subscriber in subscribers:
        try:
            subscriber.put_nowait(event)
        except queue.Full:
            continue


def _subscribe_job_events(job_id: int) -> queue.Queue[dict[str, object]]:
    subscriber: queue.Queue[dict[str, object]] = queue.Queue(maxsize=512)
    with _JOB_EVENT_LOCK:
        history = list(_JOB_EVENT_HISTORY.get(job_id, []))
        _JOB_EVENT_QUEUES.setdefault(job_id, []).append(subscriber)

    for event in history:
        try:
            subscriber.put_nowait(event)
        except queue.Full:
            break
    return subscriber


def _unsubscribe_job_events(job_id: int, subscriber: queue.Queue[dict[str, object]]) -> None:
    with _JOB_EVENT_LOCK:
        listeners = _JOB_EVENT_QUEUES.get(job_id, [])
        if subscriber in listeners:
            listeners.remove(subscriber)
        if not listeners:
            _JOB_EVENT_QUEUES.pop(job_id, None)
            terminal_events = {"done", "error"}
            history = _JOB_EVENT_HISTORY.get(job_id, [])
            if history and str(history[-1].get("event") or "") in terminal_events:
                _JOB_EVENT_HISTORY.pop(job_id, None)


def _chunk_assistant_reply(text: str, chunk_len: int) -> list[str]:
    cleaned = str(text or "").strip()
    if not cleaned:
        return []

    safe_chunk_len = max(800, int(chunk_len or ASSISTANT_CHUNK_LEN))
    parts: list[str] = []
    cursor = 0
    text_len = len(cleaned)

    while cursor < text_len:
        end = min(text_len, cursor + safe_chunk_len)
        if end < text_len:
            split_candidates = ["\n\n", "\n", " "]
            best = -1
            for token in split_candidates:
                idx = cleaned.rfind(token, cursor, end)
                if idx > best:
                    best = idx
            if best > cursor:
                end = best + 1
        piece = cleaned[cursor:end].strip()
        if piece:
            parts.append(piece)
        cursor = end

    return parts


def _miniapp_session_id(user_id: str, chat_id: int) -> str:
    return f"miniapp-{user_id}-{chat_id}"


def _build_recent_context_brief(history: list[dict[str, object]], max_items: int = 8, max_chars: int = 1200) -> str:
    if not history:
        return ""

    lines: list[str] = []
    for turn in history:
        role = str(turn.get("role") or "").strip().lower()
        if role not in {"operator", "hermes", "system"}:
            continue

        body = str(turn.get("body") or turn.get("content") or "").strip()
        if not body:
            continue

        body_single = " ".join(body.split())
        if len(body_single) > 180:
            body_single = body_single[:177].rstrip() + "..."

        if role == "operator":
            label = "user"
        elif role == "hermes":
            label = "assistant"
        else:
            label = "system"

        lines.append(f"- {label}: {body_single}")

    if not lines:
        return ""

    selected = lines[-max_items:]
    brief = "\n".join(selected)
    if len(brief) > max_chars:
        brief = brief[-max_chars:]
        newline = brief.find("\n")
        if newline > 0:
            brief = brief[newline + 1 :]
    return brief


def _run_chat_job(job: dict[str, object]) -> None:
    job_id = int(job["id"])
    user_id = str(job["user_id"])
    chat_id = int(job["chat_id"])
    operator_message_id = int(job["operator_message_id"])

    try:
        operator_turn = store.get_message(user_id=user_id, chat_id=chat_id, message_id=operator_message_id)
    except KeyError as exc:
        raise JobNonRetryableError(f"Missing operator turn: {exc}") from exc

    message = operator_turn.body
    session_id = _miniapp_session_id(user_id, chat_id)
    include_history = client.should_include_conversation_history(session_id=session_id)
    history: list[dict[str, object]] = []

    if include_history:
        checkpoint_history = store.get_runtime_checkpoint(session_id)
        if checkpoint_history:
            history = list(checkpoint_history)
        else:
            history = [
                asdict(turn)
                for turn in store.get_history_before(
                    user_id=user_id,
                    chat_id=chat_id,
                    before_message_id=operator_message_id,
                    limit=120,
                )
            ]

            context_brief = _build_recent_context_brief(history)
            if context_brief:
                history.append(
                    {
                        "role": "system",
                        "body": (
                            "Recent thread context (most recent first-order turns). "
                            "Use this to resolve references like 'that', 'it', 'again', or 'last couple messages':\n"
                            f"{context_brief}"
                        ),
                    }
                )

    started = time.perf_counter()
    reply_text = ""
    latency_ms = 0
    tool_trace_lines: list[str] = []
    runtime_checkpoint: list[dict[str, str]] = []

    runtime_stats = client.persistent_stats()
    _publish_job_event(
        job_id,
        "meta",
        {
            "skin": store.get_skin(user_id),
            "source": "stream",
            "chat_id": chat_id,
            "persistent_mode": "bootstrap" if include_history else "live",
            "persistent_enabled": bool(runtime_stats.get("enabled")),
            "persistent_runtime_total": int(runtime_stats.get("total", 0)),
        },
    )

    try:
        for event in client.stream_events(
            user_id=user_id,
            message=message,
            conversation_history=history,
            session_id=session_id,
        ):
            event_type = str(event.get("type") or "")
            if event_type == "meta":
                payload = {"chat_id": chat_id, **{k: v for k, v in event.items() if k != "type"}}
                _publish_job_event(job_id, "meta", payload)
            elif event_type == "tool":
                payload = {"chat_id": chat_id, **{k: v for k, v in event.items() if k != "type"}}
                display = str(payload.get("display") or payload.get("preview") or payload.get("tool_name") or "Tool running").strip()
                if display:
                    tool_trace_lines.append(display)
                _publish_job_event(job_id, "tool", payload)
            elif event_type == "chunk":
                chunk = str(event.get("text") or "")
                if chunk:
                    reply_text += chunk
                    _publish_job_event(job_id, "chunk", {"text": chunk, "chat_id": chat_id})
            elif event_type == "done":
                reply_text = str(event.get("reply") or reply_text).strip()
                latency_ms = int(event.get("latency_ms") or 0)
                checkpoint_payload = event.get("runtime_checkpoint")
                if isinstance(checkpoint_payload, list):
                    runtime_checkpoint = [item for item in checkpoint_payload if isinstance(item, dict)]
            elif event_type == "error":
                raise HermesClientError(str(event.get("error") or "Hermes stream failed."))
    except HermesClientError as exc:
        raise JobRetryableError(str(exc)) from exc

    state = store.get_job_state(job_id)
    if not state or state.get("status") != "running":
        # Job was externally timed-out/cancelled while this worker was blocked.
        # Drop late output to avoid resurrecting stale responses.
        return

    if not reply_text:
        raise JobRetryableError("Empty response from Hermes.")

    was_hard_truncated = False
    if len(reply_text) > ASSISTANT_HARD_LIMIT:
        trunc_notice = "\n\n[response truncated by miniapp hard limit]"
        keep = max(0, ASSISTANT_HARD_LIMIT - len(trunc_notice))
        reply_text = (reply_text[:keep]).rstrip() + trunc_notice
        was_hard_truncated = True

    reply_parts = _chunk_assistant_reply(reply_text, ASSISTANT_CHUNK_LEN)
    if not reply_parts:
        raise JobRetryableError("Hermes response could not be chunked.")

    if latency_ms <= 0:
        latency_ms = int((time.perf_counter() - started) * 1000)

    if tool_trace_lines:
        tool_trace_text = "\n".join(tool_trace_lines)
        max_tool_trace_len = 15000
        if len(tool_trace_text) > max_tool_trace_len:
            suffix = "\n… [tool trace truncated]"
            keep = max(0, max_tool_trace_len - len(suffix))
            tool_trace_text = tool_trace_text[:keep].rstrip() + suffix
        store.add_message(user_id=user_id, chat_id=chat_id, role="tool", body=tool_trace_text)

    if len(reply_parts) == 1:
        store.add_message(user_id=user_id, chat_id=chat_id, role="hermes", body=reply_parts[0])
    else:
        total = len(reply_parts)
        for index, part in enumerate(reply_parts, start=1):
            chunk_body = f"[part {index}/{total}]\n{part}"
            store.add_message(user_id=user_id, chat_id=chat_id, role="hermes", body=chunk_body)

    if runtime_checkpoint:
        store.set_runtime_checkpoint(
            session_id=session_id,
            user_id=user_id,
            chat_id=chat_id,
            history=runtime_checkpoint,
        )

    store.complete_job(job_id)
    _publish_job_event(
        job_id,
        "done",
        {
            "reply": reply_text,
            "latency_ms": latency_ms,
            "turn_count": store.get_turn_count(user_id, chat_id=chat_id),
            "chat_id": chat_id,
            "hard_truncated": was_hard_truncated,
            "parts": len(reply_parts),
        },
    )


def _safe_add_system_message(user_id: str, chat_id: int, text: str) -> None:
    try:
        store.add_message(user_id=user_id, chat_id=chat_id, role="system", body=text)
    except Exception:
        return


def _sweep_stale_running_jobs() -> None:
    stale_jobs = store.dead_letter_stale_running_jobs(
        timeout_seconds=JOB_STALL_TIMEOUT_SECONDS,
        error=f"Job timed out after {JOB_STALL_TIMEOUT_SECONDS}s without progress",
    )
    for stale in stale_jobs:
        stale_job_id = int(stale.get("id") or 0)
        stale_chat_id = int(stale.get("chat_id") or 0)
        stale_user_id = str(stale.get("user_id") or "")
        if stale_job_id:
            _publish_job_event(
                stale_job_id,
                "error",
                {
                    "chat_id": stale_chat_id,
                    "error": f"Job timed out after {JOB_STALL_TIMEOUT_SECONDS}s without progress",
                    "retrying": False,
                },
            )
        if stale_user_id and stale_chat_id:
            _safe_add_system_message(
                user_id=stale_user_id,
                chat_id=stale_chat_id,
                text=f"Hermes timed out after {JOB_STALL_TIMEOUT_SECONDS}s with no progress. Please retry.",
            )


def _job_watchdog_loop() -> None:
    while True:
        time.sleep(5)
        _sweep_stale_running_jobs()


def _is_stale_chat_job_error(exc: Exception) -> bool:
    if not isinstance(exc, KeyError):
        return False
    text = str(exc)
    return "Chat" in text and "not found" in text


def _job_worker_loop() -> None:
    while True:
        _JOB_WAKE_EVENT.wait(timeout=0.6)
        _JOB_WAKE_EVENT.clear()

        _sweep_stale_running_jobs()

        while True:
            job = store.claim_next_job()
            if not job:
                break

            job_id = int(job["id"])
            user_id = str(job["user_id"])
            chat_id = int(job["chat_id"])
            attempts = int(job.get("attempts") or 0)
            max_attempts = int(job.get("max_attempts") or 1)

            try:
                _run_chat_job(job)
            except JobNonRetryableError as exc:
                error_text = str(exc)
                store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0)
                _safe_add_system_message(user_id=user_id, chat_id=chat_id, text=f"Hermes failed permanently: {error_text}")
                _publish_job_event(job_id, "error", {"error": error_text, "chat_id": chat_id, "retrying": False})
            except JobRetryableError as exc:
                error_text = str(exc)
                retrying = store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=JOB_RETRY_BASE_SECONDS)
                if retrying:
                    _publish_job_event(
                        job_id,
                        "meta",
                        {
                            "chat_id": chat_id,
                            "source": "retry",
                            "attempt": attempts,
                            "max_attempts": max_attempts,
                            "detail": f"retrying after error: {error_text}",
                        },
                    )
                    _JOB_WAKE_EVENT.set()
                else:
                    _safe_add_system_message(user_id=user_id, chat_id=chat_id, text=f"Hermes failed after {attempts} attempts: {error_text}")
                    _publish_job_event(job_id, "error", {"error": error_text, "chat_id": chat_id, "retrying": False})
            except Exception as exc:  # noqa: BLE001
                if _is_stale_chat_job_error(exc):
                    error_text = f"Stale chat job dropped: {exc}"
                    store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0)
                    _publish_job_event(job_id, "meta", {"chat_id": chat_id, "source": "stale-chat", "detail": str(exc)})
                    continue
                error_text = f"Unexpected worker failure: {exc}"
                store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0)
                _safe_add_system_message(user_id=user_id, chat_id=chat_id, text=error_text)
                _publish_job_event(job_id, "error", {"error": error_text, "chat_id": chat_id, "retrying": False})


def _start_job_worker_once() -> None:
    global _JOB_WATCHDOG_STARTED

    with _JOB_WATCHDOG_LOCK:
        if not _JOB_WATCHDOG_STARTED:
            watchdog = threading.Thread(target=_job_watchdog_loop, name="miniapp-job-watchdog", daemon=True)
            watchdog.start()
            _JOB_WATCHDOG_STARTED = True

    with _JOB_WORKER_START_LOCK:
        alive_workers = [worker for worker in _JOB_WORKER_THREADS if worker.is_alive()]
        _JOB_WORKER_THREADS[:] = alive_workers

        missing = max(0, JOB_WORKER_CONCURRENCY - len(alive_workers))
        if missing <= 0:
            return

        for _ in range(missing):
            worker_index = len(_JOB_WORKER_THREADS) + 1
            worker = threading.Thread(target=_job_worker_loop, name=f"miniapp-job-worker-{worker_index}", daemon=True)
            worker.start()
            _JOB_WORKER_THREADS.append(worker)

        _JOB_WAKE_EVENT.set()


def _ensure_pending_jobs(user_id: str) -> None:
    for chat_id, operator_message_id in store.list_recoverable_pending_turns(user_id):
        job_id = store.enqueue_chat_job(
            user_id=user_id,
            chat_id=chat_id,
            operator_message_id=operator_message_id,
            max_attempts=JOB_MAX_ATTEMPTS,
        )
        _publish_job_event(job_id, "meta", {"chat_id": chat_id, "source": "recovered"})
        _JOB_WAKE_EVENT.set()


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


_start_job_worker_once()


@app.after_request
def add_security_headers(response: Response) -> Response:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
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
    payload = request.get_json(silent=True) or {}
    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    user_id = str(verified.user.id)
    _ensure_pending_jobs(user_id)
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
        secure=request.is_secure,
    )
    response.set_cookie(
        AUTH_COOKIE_NAME,
        _create_auth_session_token(user_id),
        max_age=max(60, AUTH_SESSION_MAX_AGE_SECONDS),
        httponly=True,
        samesite="Lax",
        secure=request.is_secure,
    )
    return response


@app.post("/api/preferences/skin")
def set_skin() -> Response | tuple[dict[str, object], int]:
    payload = request.get_json(silent=True) or {}
    skin = str(payload.get("skin", "")).strip().lower()
    if skin not in ALLOWED_SKINS:
        return {"ok": False, "error": f"Unsupported skin: {skin or 'unknown'}"}, 400

    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    store.set_skin(user_id=str(verified.user.id), skin=skin)
    response = jsonify({"ok": True, "skin": skin})
    response.set_cookie(
        SKIN_COOKIE_NAME,
        skin,
        max_age=60 * 60 * 24 * 365,
        samesite="Lax",
        secure=request.is_secure,
    )
    return response


@app.post("/api/chats")
def create_chat() -> tuple[dict[str, object], int]:
    payload = request.get_json(silent=True) or {}
    try:
        title = _validated_title(payload.get("title"), default="New chat")
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400

    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    user_id = str(verified.user.id)
    chat = store.create_chat(user_id=user_id, title=title)
    store.set_active_chat(user_id=user_id, chat_id=chat.id)
    history = [asdict(turn) for turn in store.get_history(user_id=user_id, chat_id=chat.id, limit=120)]
    return {"ok": True, "chat": _serialize_chat(chat), "history": history}, 201


@app.post("/api/chats/rename")
def rename_chat() -> tuple[dict[str, object], int]:
    payload = request.get_json(silent=True) or {}
    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    try:
        chat_id = _chat_id_from_payload(payload, user_id=str(verified.user.id))
        title = _validated_title(payload.get("title"), default="Untitled")
        chat = store.rename_chat(user_id=str(verified.user.id), chat_id=chat_id, title=title)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400
    except KeyError as exc:
        return {"ok": False, "error": str(exc)}, 404
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
    payload = request.get_json(silent=True) or {}
    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    try:
        user_id = str(verified.user.id)
        chat_id = _chat_id_from_payload(payload, user_id=user_id)
        response_payload = _chat_history_payload(user_id=user_id, chat_id=chat_id, activate=True)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400
    except KeyError as exc:
        return {"ok": False, "error": str(exc)}, 404

    return response_payload, 200


@app.post("/api/chats/history")
def chat_history() -> tuple[dict[str, object], int]:
    payload = request.get_json(silent=True) or {}
    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    try:
        user_id = str(verified.user.id)
        chat_id = _chat_id_from_payload(payload, user_id=user_id)
        activate = bool(payload.get("activate", False))
        response_payload = _chat_history_payload(user_id=user_id, chat_id=chat_id, activate=activate)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400
    except KeyError as exc:
        return {"ok": False, "error": str(exc)}, 404

    return response_payload, 200


@app.post("/api/chats/mark-read")
def mark_chat_read() -> tuple[dict[str, object], int]:
    payload = request.get_json(silent=True) or {}
    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    try:
        chat_id = _chat_id_from_payload(payload, user_id=str(verified.user.id))
        store.mark_chat_read(user_id=str(verified.user.id), chat_id=chat_id)
        chat = store.get_chat(user_id=str(verified.user.id), chat_id=chat_id)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400
    except KeyError as exc:
        return {"ok": False, "error": str(exc)}, 404
    return {"ok": True, "chat": _serialize_chat(chat)}, 200


@app.post("/api/chats/clear")
def clear_chat() -> tuple[dict[str, object], int]:
    payload = request.get_json(silent=True) or {}
    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    try:
        user_id = str(verified.user.id)
        chat_id = _chat_id_from_payload(payload, user_id=user_id)
        store.clear_chat(user_id=user_id, chat_id=chat_id)
        chat = store.get_chat(user_id=user_id, chat_id=chat_id)
        session_id = _miniapp_session_id(user_id, chat_id)
        client.evict_session(session_id)
        store.delete_runtime_checkpoint(session_id)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400
    except KeyError as exc:
        return {"ok": False, "error": str(exc)}, 404
    return {"ok": True, "chat": _serialize_chat(chat), "history": []}, 200


@app.post("/api/chats/remove")
def remove_chat() -> tuple[dict[str, object], int]:
    payload = request.get_json(silent=True) or {}
    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    user_id = str(verified.user.id)
    try:
        chat_id = _chat_id_from_payload(payload, user_id=user_id)
        session_id = _miniapp_session_id(user_id, chat_id)
        client.evict_session(session_id)
        store.delete_runtime_checkpoint(session_id)
        next_chat_id = store.remove_chat(user_id=user_id, chat_id=chat_id)
        history = [asdict(turn) for turn in store.get_history(user_id=user_id, chat_id=next_chat_id, limit=120)]
        store.mark_chat_read(user_id=user_id, chat_id=next_chat_id)
        store.set_active_chat(user_id=user_id, chat_id=next_chat_id)
        active_chat = store.get_chat(user_id=user_id, chat_id=next_chat_id)
        chats = [_serialize_chat(chat) for chat in store.list_chats(user_id=user_id)]
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400
    except KeyError as exc:
        return {"ok": False, "error": str(exc)}, 404
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
    payload = request.get_json(silent=True) or {}
    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401
    user_id = str(verified.user.id)
    _ensure_pending_jobs(user_id)
    chats = [_serialize_chat(chat) for chat in store.list_chats(user_id=user_id)]
    return {"ok": True, "chats": chats}, 200


@app.post("/api/jobs/status")
def jobs_status() -> tuple[dict[str, object], int]:
    payload = request.get_json(silent=True) or {}
    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    user_id = str(verified.user.id)
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
    payload = request.get_json(silent=True) or {}
    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    user_id = str(verified.user.id)
    limit = int(payload.get("limit") or 200)
    cleaned = store.cleanup_stale_jobs(user_id=user_id, limit=limit)
    return {
        "ok": True,
        "cleaned_count": len(cleaned),
        "cleaned": cleaned,
    }, 200


@app.post("/api/runtime/status")
def runtime_status() -> tuple[dict[str, object], int]:
    payload = request.get_json(silent=True) or {}
    try:
        _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    runtime = client.runtime_status()
    return {
        "ok": True,
        "persistent": runtime.get("persistent") or {},
        "routing": runtime.get("routing") or {},
    }, 200


@app.post("/api/chat")
def chat() -> tuple[object, int]:
    payload = request.get_json(silent=True) or {}
    try:
        message = _validated_message(payload.get("message"))
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400

    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return {"ok": False, "error": str(exc)}, 401

    user_id = str(verified.user.id)
    try:
        chat_id = _chat_id_from_payload(payload, user_id=user_id)
        store.set_active_chat(user_id=user_id, chat_id=chat_id)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400

    history = [asdict(turn) for turn in store.get_history(user_id=user_id, chat_id=chat_id, limit=120)]
    try:
        store.add_message(user_id=user_id, chat_id=chat_id, role="operator", body=message)
    except (KeyError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}, 400

    started = time.perf_counter()
    try:
        reply = client.ask(user_id=user_id, message=message, conversation_history=history)
    except HermesClientError as exc:
        return {"ok": False, "error": str(exc)}, 502

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


@app.post("/api/chat/stream")
def stream_chat() -> Response:
    payload = request.get_json(silent=True) or {}
    try:
        message = _validated_message(payload.get("message"))
    except ValueError as exc:
        return Response(_sse_event("error", {"error": str(exc)}), mimetype="text/event-stream", status=400)

    try:
        verified = _verify_from_payload(payload)
    except TelegramAuthError as exc:
        return Response(_sse_event("error", {"error": str(exc)}), mimetype="text/event-stream", status=401)

    user_id = str(verified.user.id)
    try:
        chat_id = _chat_id_from_payload(payload, user_id=user_id)
        store.set_active_chat(user_id=user_id, chat_id=chat_id)
        if store.has_open_job(user_id=user_id, chat_id=chat_id):
            return Response(
                _sse_event("error", {"error": "Hermes is already working on this chat.", "chat_id": chat_id}),
                mimetype="text/event-stream",
                status=409,
            )
        operator_message_id = store.add_message(user_id=user_id, chat_id=chat_id, role="operator", body=message)
        job_id = store.enqueue_chat_job(
            user_id=user_id,
            chat_id=chat_id,
            operator_message_id=operator_message_id,
            max_attempts=JOB_MAX_ATTEMPTS,
        )
        _JOB_WAKE_EVENT.set()
    except (KeyError, ValueError) as exc:
        return Response(_sse_event("error", {"error": str(exc)}), mimetype="text/event-stream", status=400)

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


@app.get("/api/state")
def state() -> tuple[dict[str, object], int]:
    return {"ok": True, "skins": sorted(ALLOWED_SKINS)}, 200


def _sse_event(event: str, data: dict[str, object]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=DEBUG, threaded=True)
