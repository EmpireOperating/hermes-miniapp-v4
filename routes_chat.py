from __future__ import annotations

import queue
import time
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Callable, Iterator

from flask import Response, g, jsonify

from hermes_client import HermesClientError


def register_chat_routes(
    api_bp,
    *,
    store_getter: Callable[[], Any],
    client_getter: Callable[[], Any],
    runtime_getter: Callable[[], Any],
    job_wake_event_getter: Callable[[], Any],
    request_payload_fn: Callable[[], dict[str, object]],
    json_user_id_or_error_fn: Callable[[dict[str, object]], tuple[str | None, tuple[dict[str, object], int] | None]],
    verify_for_json_fn: Callable[[dict[str, object]], tuple[Any | None, tuple[dict[str, object], int] | None]],
    verify_for_sse_fn: Callable[[dict[str, object]], tuple[Any | None, Response | None]],
    chat_id_from_payload_or_error_fn: Callable[
        [dict[str, object]], tuple[int | None, tuple[dict[str, object], int] | None]
    ],
    chat_id_from_payload_fn: Callable[[dict[str, object], str], int],
    validated_title_fn: Callable[[object, str], str],
    validated_message_fn: Callable[[object], str],
    json_error_fn: Callable[[str, int], tuple[dict[str, object], int]],
    sse_error_fn: Callable[..., Response],
    sse_event_fn: Callable[[str, dict[str, object]], str],
    serialize_chat_fn: Callable[[Any], dict[str, object]],
    session_id_builder_fn: Callable[[str, int], str],
    job_max_attempts: int,
    build_job_log_fn: Callable[..., str],
    logger,
) -> None:
    def _chat_history(user_id: str, chat_id: int, *, limit: int = 120) -> list[dict[str, object]]:
        store = store_getter()
        return [asdict(turn) for turn in store.get_history(user_id=user_id, chat_id=chat_id, limit=limit)]

    def _serialize_chats(user_id: str) -> list[dict[str, object]]:
        store = store_getter()
        return [serialize_chat_fn(chat) for chat in store.list_chats(user_id=user_id)]

    def _evict_chat_runtime(user_id: str, chat_id: int) -> None:
        session_id = session_id_builder_fn(user_id, chat_id)
        client_getter().evict_session(session_id)
        store_getter().delete_runtime_checkpoint(session_id)

    def _resolve_active_chat(payload: dict[str, object], *, user_id: str) -> int:
        chat_id = chat_id_from_payload_fn(payload, user_id)
        store_getter().set_active_chat(user_id=user_id, chat_id=chat_id)
        return chat_id

    def _add_operator_message(user_id: str, chat_id: int, message: str) -> int:
        return store_getter().add_message(user_id=user_id, chat_id=chat_id, role="operator", body=message)

    def _chat_history_payload(user_id: str, chat_id: int, *, activate: bool) -> dict[str, object]:
        store = store_getter()
        if activate:
            store.mark_chat_read(user_id=user_id, chat_id=chat_id)
            store.set_active_chat(user_id=user_id, chat_id=chat_id)
        history = [asdict(turn) for turn in store.get_history(user_id=user_id, chat_id=chat_id, limit=120)]
        chat = store.get_chat(user_id=user_id, chat_id=chat_id)
        return {"ok": True, "chat": serialize_chat_fn(chat), "history": history}

    def _stream_job_response(*, user_id: str, chat_id: int, job_id: int) -> Response:
        def generate() -> Iterator[str]:
            runtime = runtime_getter()
            subscriber = runtime.subscribe_job_events(job_id)
            terminal = False
            last_queue_heartbeat = 0.0

            try:
                yield sse_event_fn("meta", {"skin": store_getter().get_skin(user_id), "source": "queue", "chat_id": chat_id})
                while not terminal:
                    try:
                        event = subscriber.get(timeout=0.6)
                    except queue.Empty:
                        now = time.monotonic()
                        if (now - last_queue_heartbeat) >= 4.0:
                            state = store_getter().get_job_state(job_id)
                            if state:
                                elapsed_ms = None
                                started_at_raw = str(state.get("started_at") or "").strip()
                                if started_at_raw:
                                    try:
                                        started_dt = datetime.strptime(started_at_raw, "%Y-%m-%d %H:%M:%S").replace(
                                            tzinfo=timezone.utc
                                        )
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
                                yield sse_event_fn("meta", heartbeat_payload)
                            last_queue_heartbeat = now
                        continue

                    event_name = str(event.get("event") or "message")
                    payload = dict(event.get("payload") or {})
                    if "chat_id" not in payload:
                        payload["chat_id"] = chat_id
                    yield sse_event_fn(event_name, payload)
                    if event_name in {"done", "error"}:
                        terminal = True
            finally:
                runtime.unsubscribe_job_events(job_id, subscriber)

        headers = {
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        }
        return Response(generate(), mimetype="text/event-stream", headers=headers)

    @api_bp.post("/chats")
    def create_chat() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        try:
            title = validated_title_fn(payload.get("title"), "New chat")
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error

        store = store_getter()
        chat = store.create_chat(user_id=user_id, title=title)
        store.set_active_chat(user_id=user_id, chat_id=chat.id)
        history = _chat_history(user_id=user_id, chat_id=chat.id, limit=120)
        return {"ok": True, "chat": serialize_chat_fn(chat), "history": history}, 201

    @api_bp.post("/chats/rename")
    def rename_chat() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error

        chat_id, chat_id_error = chat_id_from_payload_or_error_fn(payload, user_id=user_id)
        if chat_id_error:
            return chat_id_error

        try:
            title = validated_title_fn(payload.get("title"), "Untitled")
            chat = store_getter().rename_chat(user_id=user_id, chat_id=chat_id, title=title)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        return {"ok": True, "chat": serialize_chat_fn(chat)}, 200

    @api_bp.post("/chats/open")
    def open_chat() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error

        chat_id, chat_id_error = chat_id_from_payload_or_error_fn(payload, user_id=user_id)
        if chat_id_error:
            return chat_id_error

        try:
            response_payload = _chat_history_payload(user_id=user_id, chat_id=chat_id, activate=True)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)

        return response_payload, 200

    @api_bp.post("/chats/history")
    def chat_history() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error

        chat_id, chat_id_error = chat_id_from_payload_or_error_fn(payload, user_id=user_id)
        if chat_id_error:
            return chat_id_error

        try:
            activate = bool(payload.get("activate", False))
            response_payload = _chat_history_payload(user_id=user_id, chat_id=chat_id, activate=activate)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)

        return response_payload, 200

    @api_bp.post("/chats/mark-read")
    def mark_chat_read() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error

        chat_id, chat_id_error = chat_id_from_payload_or_error_fn(payload, user_id=user_id)
        if chat_id_error:
            return chat_id_error

        try:
            store = store_getter()
            store.mark_chat_read(user_id=user_id, chat_id=chat_id)
            chat = store.get_chat(user_id=user_id, chat_id=chat_id)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        return {"ok": True, "chat": serialize_chat_fn(chat)}, 200

    @api_bp.post("/chats/clear")
    def clear_chat() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error

        chat_id, chat_id_error = chat_id_from_payload_or_error_fn(payload, user_id=user_id)
        if chat_id_error:
            return chat_id_error

        try:
            store = store_getter()
            store.clear_chat(user_id=user_id, chat_id=chat_id)
            chat = store.get_chat(user_id=user_id, chat_id=chat_id)
            _evict_chat_runtime(user_id=user_id, chat_id=chat_id)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        return {"ok": True, "chat": serialize_chat_fn(chat), "history": []}, 200

    @api_bp.post("/chats/remove")
    def remove_chat() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error

        chat_id, chat_id_error = chat_id_from_payload_or_error_fn(payload, user_id=user_id)
        if chat_id_error:
            return chat_id_error

        try:
            store = store_getter()
            _evict_chat_runtime(user_id=user_id, chat_id=chat_id)
            next_chat_id = store.remove_chat(user_id=user_id, chat_id=chat_id)
            history = _chat_history(user_id=user_id, chat_id=next_chat_id, limit=120)
            store.mark_chat_read(user_id=user_id, chat_id=next_chat_id)
            store.set_active_chat(user_id=user_id, chat_id=next_chat_id)
            active_chat = store.get_chat(user_id=user_id, chat_id=next_chat_id)
            chats = _serialize_chats(user_id=user_id)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        return {
            "ok": True,
            "removed_chat_id": chat_id,
            "active_chat_id": next_chat_id,
            "active_chat": serialize_chat_fn(active_chat),
            "history": history,
            "chats": chats,
        }, 200

    @api_bp.post("/chats/status")
    def chats_status() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        runtime_getter().ensure_pending_jobs(user_id)
        chats = _serialize_chats(user_id=user_id)
        return {"ok": True, "chats": chats}, 200

    @api_bp.post("/chat")
    def chat() -> tuple[object, int]:
        payload = request_payload_fn()
        try:
            message = validated_message_fn(payload.get("message"))
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

        verified, auth_error = verify_for_json_fn(payload)
        if auth_error:
            return auth_error

        user_id = str(verified.user.id)
        try:
            chat_id = _resolve_active_chat(payload, user_id=user_id)
            _add_operator_message(user_id=user_id, chat_id=chat_id, message=message)
        except (KeyError, ValueError) as exc:
            return json_error_fn(str(exc), 400)

        history = _chat_history(user_id=user_id, chat_id=chat_id, limit=120)

        started = time.perf_counter()
        try:
            reply = client_getter().ask(user_id=user_id, message=message, conversation_history=history)
        except HermesClientError as exc:
            return json_error_fn(str(exc), 502)

        latency_ms = int((time.perf_counter() - started) * 1000) if not reply.latency_ms else reply.latency_ms
        store = store_getter()
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

    @api_bp.post("/chat/stream")
    def stream_chat() -> Response:
        payload = request_payload_fn()
        try:
            message = validated_message_fn(payload.get("message"))
        except ValueError as exc:
            return sse_error_fn(str(exc), 400)

        verified, auth_error = verify_for_sse_fn(payload)
        if auth_error:
            return auth_error

        user_id = str(verified.user.id)
        try:
            store = store_getter()
            chat_id = _resolve_active_chat(payload, user_id=user_id)
            if store.has_open_job(user_id=user_id, chat_id=chat_id):
                return sse_error_fn("Hermes is already working on this chat.", 409, chat_id=chat_id)
            operator_message_id = _add_operator_message(user_id=user_id, chat_id=chat_id, message=message)
            job_id = store.enqueue_chat_job(
                user_id=user_id,
                chat_id=chat_id,
                operator_message_id=operator_message_id,
                max_attempts=job_max_attempts,
            )
            job_wake_event_getter().set()
        except (KeyError, ValueError) as exc:
            return sse_error_fn(str(exc), 400)

        logger.info(
            build_job_log_fn(
                event="stream_job_enqueued",
                request_id=str(getattr(g, "request_id", "")) or None,
                chat_id=chat_id,
                job_id=job_id,
                extra={"user_id": user_id},
            )
        )
        return _stream_job_response(user_id=user_id, chat_id=chat_id, job_id=job_id)

    @api_bp.post("/chat/stream/resume")
    def stream_chat_resume() -> Response:
        payload = request_payload_fn()

        verified, auth_error = verify_for_sse_fn(payload)
        if auth_error:
            return auth_error

        user_id = str(verified.user.id)
        try:
            chat_id = _resolve_active_chat(payload, user_id=user_id)
        except (KeyError, ValueError) as exc:
            return sse_error_fn(str(exc), 400)

        open_job = store_getter().get_open_job(user_id=user_id, chat_id=chat_id)
        if not open_job:
            return sse_error_fn("No active Hermes job for this chat.", 409, chat_id=chat_id)

        job_wake_event_getter().set()
        resumed_job_id = int(open_job["id"])
        logger.info(
            build_job_log_fn(
                event="stream_job_resumed",
                request_id=str(getattr(g, "request_id", "")) or None,
                chat_id=chat_id,
                job_id=resumed_job_id,
                extra={"user_id": user_id},
            )
        )
        return _stream_job_response(user_id=user_id, chat_id=chat_id, job_id=resumed_job_id)
