from __future__ import annotations

import queue
import time
from datetime import datetime, timezone
from typing import Callable, Iterator, TypeVar

from flask import Response, g

from job_status import JOB_EVENT_DONE, JOB_EVENT_ERROR, JOB_EVENT_TERMINAL, JOB_STATUS_DONE, JOB_STATUS_QUEUED, is_terminal_job_status
from routes_chat_context import ChatRouteContext
from routes_chat_error_mapping import map_chat_id_payload_error_to_sse
from routes_chat_resolution import active_chat_id_or_error, verified_user_id_or_error


T = TypeVar("T")


def register_stream_routes(
    api_bp,
    *,
    context: ChatRouteContext,
) -> None:
    store_getter = context.store_getter
    runtime_getter = context.runtime_getter
    job_wake_event_getter = context.job_wake_event_getter
    request_payload_fn = context.request_payload_fn
    verify_for_sse_fn = context.verify_for_sse_fn
    chat_id_from_payload_or_error_fn = context.chat_id_from_payload_or_error_fn
    validated_message_fn = context.validated_message_fn
    sse_error_fn = context.sse_error_fn
    sse_event_fn = context.sse_event_fn
    job_max_attempts = context.job_max_attempts
    build_job_log_fn = context.build_job_log_fn
    logger = context.logger

    def _sse_not_found(exc: Exception) -> Response:
        return sse_error_fn(str(exc), 404)

    def _is_chat_not_found_key_error(exc: KeyError) -> bool:
        message = str(exc).strip().lower()
        return "chat" in message and "not found" in message

    def _sse_try_not_found(action: Callable[[], T]) -> tuple[T | None, Response | None]:
        try:
            return action(), None
        except KeyError as exc:
            return None, _sse_not_found(exc)

    def _resolve_active_chat_or_error(
        payload: dict[str, object],
        *,
        user_id: str,
    ) -> tuple[int | None, Response | None]:
        return active_chat_id_or_error(
            payload,
            user_id=user_id,
            chat_id_from_payload_or_error_fn=chat_id_from_payload_or_error_fn,
            map_chat_id_payload_error_fn=lambda payload_error: map_chat_id_payload_error_to_sse(
                payload_error,
                sse_error_fn=sse_error_fn,
            ),
            set_active_chat_fn=lambda chat_id: store_getter().set_active_chat(user_id=user_id, chat_id=chat_id),
            not_found_error_fn=_sse_not_found,
            should_map_key_error_fn=_is_chat_not_found_key_error,
        )

    def _add_operator_message(user_id: str, chat_id: int, message: str) -> int:
        return store_getter().add_message(user_id=user_id, chat_id=chat_id, role="operator", body=message)

    def _sse_verified_user_and_chat_id(payload: dict[str, object]) -> tuple[str | None, int | None, Response | None]:
        user_id, auth_error = verified_user_id_or_error(payload, verify_fn=verify_for_sse_fn)
        if auth_error:
            return None, None, auth_error

        chat_id, chat_id_error = _resolve_active_chat_or_error(payload, user_id=user_id)
        if chat_id_error:
            return None, None, chat_id_error

        return user_id, chat_id, None

    def _log_stream_job_event(*, event: str, user_id: str, chat_id: int, job_id: int) -> None:
        logger.info(
            build_job_log_fn(
                event=event,
                request_id=str(getattr(g, "request_id", "")) or None,
                chat_id=chat_id,
                job_id=job_id,
                extra={"user_id": user_id},
            )
        )

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
                                job_status = str(state.get("status") or "")
                                if is_terminal_job_status(job_status):
                                    recovery_payload: dict[str, object] = {
                                        "chat_id": chat_id,
                                        "source": "queue",
                                        "job_status": job_status,
                                        "synthetic": True,
                                    }
                                    state_error = str(state.get("error") or "").strip()
                                    if state_error:
                                        recovery_payload["error"] = state_error
                                    recovery_payload["detail"] = "stream recovered from terminal db state"
                                    yield sse_event_fn(JOB_EVENT_DONE if job_status == JOB_STATUS_DONE else JOB_EVENT_ERROR, recovery_payload)
                                    terminal = True
                                    last_queue_heartbeat = now
                                    continue

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
                                        if state.get("status") == JOB_STATUS_QUEUED
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
                    if event_name in JOB_EVENT_TERMINAL:
                        terminal = True
            finally:
                runtime.unsubscribe_job_events(job_id, subscriber)

        headers = {
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        }
        return Response(generate(), mimetype="text/event-stream", headers=headers)

    @api_bp.post("/chat/stream")
    def stream_chat() -> Response:
        payload = request_payload_fn()
        try:
            message = validated_message_fn(payload.get("message"))
        except ValueError as exc:
            return sse_error_fn(str(exc), 400)

        user_id, chat_id, payload_error = _sse_verified_user_and_chat_id(payload)
        if payload_error:
            return payload_error

        store = store_getter()
        if store.has_open_job(user_id=user_id, chat_id=chat_id):
            return sse_error_fn("Hermes is already working on this chat.", 409, chat_id=chat_id)

        operator_message_id, not_found_error = _sse_try_not_found(
            lambda: _add_operator_message(user_id=user_id, chat_id=chat_id, message=message)
        )
        if not_found_error:
            return not_found_error

        job_id, not_found_error = _sse_try_not_found(
            lambda: store.enqueue_chat_job(
                user_id=user_id,
                chat_id=chat_id,
                operator_message_id=operator_message_id,
                max_attempts=job_max_attempts,
            )
        )
        if not_found_error:
            return not_found_error

        job_wake_event_getter().set()
        _log_stream_job_event(event="stream_job_enqueued", user_id=user_id, chat_id=chat_id, job_id=job_id)
        return _stream_job_response(user_id=user_id, chat_id=chat_id, job_id=job_id)

    @api_bp.post("/chat/stream/resume")
    def stream_chat_resume() -> Response:
        payload = request_payload_fn()
        user_id, chat_id, payload_error = _sse_verified_user_and_chat_id(payload)
        if payload_error:
            return payload_error

        open_job = store_getter().get_open_job(user_id=user_id, chat_id=chat_id)
        if not open_job:
            return sse_error_fn("No active Hermes job for this chat.", 409, chat_id=chat_id)

        job_wake_event_getter().set()
        resumed_job_id = int(open_job["id"])
        _log_stream_job_event(event="stream_job_resumed", user_id=user_id, chat_id=chat_id, job_id=resumed_job_id)
        return _stream_job_response(user_id=user_id, chat_id=chat_id, job_id=resumed_job_id)
