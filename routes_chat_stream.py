from __future__ import annotations

import os
import queue
import time
from datetime import datetime, timezone
from typing import Callable, Iterator, TypeVar

from flask import Response, g, request

from job_status import JOB_EVENT_DONE, JOB_EVENT_ERROR, JOB_EVENT_TERMINAL, JOB_STATUS_DONE, JOB_STATUS_QUEUED, is_terminal_job_status
from routes_chat_context import ChatRouteContext
from routes_chat_error_mapping import map_chat_id_payload_error_to_sse
from routes_chat_resolution import active_chat_id_or_error, user_and_chat_id_or_error, verified_user_id_or_error


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
    stream_timing_debug = bool(context.stream_timing_debug)
    stream_efficiency_mode = bool(context.stream_efficiency_mode)
    stream_metrics_refresh_seconds = max(1, int(context.stream_metrics_refresh_seconds or 1))
    logger = context.logger
    client_getter = context.client_getter
    session_id_builder_fn = context.session_id_builder_fn

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

    def _sse_verified_user_and_chat_id(
        payload: dict[str, object], *, activate_chat: bool = True
    ) -> tuple[str | None, int | None, Response | None]:
        user_id, auth_error = verified_user_id_or_error(payload, verify_fn=verify_for_sse_fn)
        if auth_error:
            return None, None, auth_error

        if activate_chat:
            chat_id, chat_id_error = _resolve_active_chat_or_error(payload, user_id=user_id)
            if chat_id_error:
                return None, None, chat_id_error
            return user_id, chat_id, None

        verified_user_id, chat_id, chat_id_error = user_and_chat_id_or_error(
            payload,
            user_id_from_payload_or_error_fn=lambda _payload: (str(user_id), None),
            chat_id_from_payload_or_error_fn=chat_id_from_payload_or_error_fn,
            map_chat_id_payload_error_fn=lambda payload_error: map_chat_id_payload_error_to_sse(
                payload_error,
                sse_error_fn=sse_error_fn,
            ),
        )
        if chat_id_error:
            return None, None, chat_id_error

        try:
            store_getter().get_chat(user_id=str(verified_user_id), chat_id=int(chat_id))
        except KeyError as exc:
            if not _is_chat_not_found_key_error(exc):
                raise
            return None, None, _sse_not_found(exc)

        return verified_user_id, chat_id, None

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

    def _recover_stale_open_job_if_needed(*, user_id: str, chat_id: int) -> dict[str, object] | None:
        timeout_seconds = int(getattr(runtime_getter(), "job_stall_timeout_seconds", 0) or 0)
        stale = store_getter().dead_letter_stale_open_job_for_chat(
            user_id=user_id,
            chat_id=chat_id,
            timeout_seconds=max(30, timeout_seconds),
            error="E_STALE_OPEN_JOB_AFTER_RESTART: stale open job dead-lettered before new stream",
        )
        if not stale:
            return None
        stale_job_id = int(stale.get("id") or 0)
        if stale_job_id:
            _log_stream_job_event(
                event="stream_stale_open_job_dead_lettered",
                user_id=user_id,
                chat_id=chat_id,
                job_id=stale_job_id,
            )
        return stale

    def _stream_segment_seconds_for_request() -> float:
        def _parse_env_float(name: str, default: float) -> float:
            raw = str(os.environ.get(name, "") or "").strip()
            if not raw:
                return default
            try:
                value = float(raw)
            except (TypeError, ValueError):
                return default
            return value if value > 0 else 0.0

        default_segment = _parse_env_float("MINI_APP_STREAM_SEGMENT_SECONDS", 0.0)
        mobile_segment = _parse_env_float("MINI_APP_STREAM_SEGMENT_SECONDS_MOBILE", default_segment)
        user_agent = (request.headers.get("User-Agent") or "").lower()
        is_mobile_webview = "iphone" in user_agent or "android" in user_agent or "mobile" in user_agent
        return mobile_segment if is_mobile_webview else default_segment

    def _after_event_id_from_payload(payload: dict[str, object]) -> int:
        raw_value = payload.get("after_event_id")
        try:
            parsed = int(raw_value or 0)
        except (TypeError, ValueError):
            return 0
        return max(0, parsed)

    def _stream_job_response(
        *, user_id: str, chat_id: int, job_id: int, segment_seconds: float = 0.0, after_event_id: int = 0
    ) -> Response:
        heartbeat_seconds = 1.5
        request_id = str(getattr(g, "request_id", "")) or None

        def _with_emit_timing(payload: dict[str, object]) -> dict[str, object]:
            next_payload = dict(payload or {})
            if not stream_timing_debug:
                return next_payload
            timing_payload = next_payload.get("_timing")
            if isinstance(timing_payload, dict):
                merged_timing = dict(timing_payload)
            else:
                merged_timing = {}
            merged_timing["sse_emit_monotonic_ms"] = int(time.monotonic() * 1000)
            next_payload["_timing"] = merged_timing
            return next_payload

        def generate() -> Iterator[str]:
            runtime = runtime_getter()
            store = store_getter()
            subscriber = runtime.subscribe_job_events(job_id, after_event_id=max(0, int(after_event_id or 0)))
            terminal = False
            last_queue_heartbeat = 0.0
            last_polled_state: dict[str, object] | None = None
            next_state_refresh_at = 0.0
            segment_deadline = (time.monotonic() + segment_seconds) if segment_seconds > 0 else 0.0

            def _emit_segment_rollover() -> Iterator[str]:
                state = last_polled_state
                if state is None:
                    state = store.get_job_state(job_id)
                job_status = str((state or {}).get("status") or "")
                if is_terminal_job_status(job_status):
                    return
                rollover_payload: dict[str, object] = {
                    "chat_id": chat_id,
                    "source": "queue",
                    "detail": "stream segment rollover",
                    "stream_segment_end": True,
                    "resume_recommended": True,
                }
                if job_status:
                    rollover_payload["job_status"] = job_status
                yield sse_event_fn("meta", _with_emit_timing(rollover_payload))

            try:
                # SSE prelude comments help prevent intermediary buffering in some WebView/proxy paths.
                yield ": stream-open\n"
                yield f": {' ' * 2048}\n\n"
                yield sse_event_fn("meta", _with_emit_timing({"skin": store.get_skin(user_id), "source": "queue", "chat_id": chat_id}))
                while not terminal:
                    try:
                        event = subscriber.get(timeout=0.6)
                    except queue.Empty:
                        now = time.monotonic()
                        if (now - last_queue_heartbeat) >= heartbeat_seconds:
                            # Keep SSE connection actively flushing through intermediaries.
                            yield f": hb {int(now * 1000)}\n\n"

                            should_refresh_state = (
                                (not stream_efficiency_mode)
                                or last_polled_state is None
                                or now >= next_state_refresh_at
                            )
                            if should_refresh_state:
                                last_polled_state = store.get_job_state(job_id)
                                next_state_refresh_at = now + stream_metrics_refresh_seconds
                            state = last_polled_state

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
                                    recovery_event = JOB_EVENT_DONE if job_status == JOB_STATUS_DONE else JOB_EVENT_ERROR
                                    recovery_payload["detail"] = "stream recovered from terminal db state"
                                    if job_status == "dead" and not state_error:
                                        session_id = session_id_builder_fn(user_id, chat_id)
                                        warm_candidate = None
                                        try:
                                            warm_candidate = client_getter().select_warm_session_candidate(session_id)
                                        except Exception:
                                            warm_candidate = None
                                        if isinstance(warm_candidate, dict) and str(warm_candidate.get("state") or "") == "attachable_running":
                                            recovery_event = JOB_EVENT_DONE
                                            recovery_payload["detail"] = "stream detached to warm owner"
                                            recovery_payload["warm_handoff"] = True
                                            recovery_payload["session_id"] = session_id
                                            recovery_payload["persistent_mode"] = "warm-detached"
                                    yield sse_event_fn(
                                        recovery_event,
                                        _with_emit_timing(recovery_payload),
                                    )
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
                                yield sse_event_fn("meta", _with_emit_timing(heartbeat_payload))
                            last_queue_heartbeat = now
                        if segment_deadline and now >= segment_deadline:
                            if stream_timing_debug:
                                logger.info(
                                    build_job_log_fn(
                                        event="stream_segment_rollover",
                                        request_id=request_id,
                                        chat_id=chat_id,
                                        job_id=job_id,
                                        extra={"user_id": user_id, "segment_seconds": segment_seconds},
                                    )
                                )
                            yield from _emit_segment_rollover()
                            break
                        continue

                    event_name = str(event.get("event") or "message")
                    payload = dict(event.get("payload") or {})
                    if "chat_id" not in payload:
                        payload["chat_id"] = chat_id
                    event_id = event.get("event_id")
                    if "_event_id" not in payload and isinstance(event_id, int) and event_id > 0:
                        payload["_event_id"] = event_id
                    yield sse_event_fn(event_name, _with_emit_timing(payload))
                    if event_name in JOB_EVENT_TERMINAL:
                        terminal = True
                    elif segment_deadline and time.monotonic() >= segment_deadline:
                        if stream_timing_debug:
                            logger.info(
                                build_job_log_fn(
                                    event="stream_segment_rollover",
                                    request_id=request_id,
                                    chat_id=chat_id,
                                    job_id=job_id,
                                    extra={"user_id": user_id, "segment_seconds": segment_seconds},
                                )
                            )
                        yield from _emit_segment_rollover()
                        break
            finally:
                runtime.unsubscribe_job_events(job_id, subscriber)

        headers = {
            "Cache-Control": "no-cache, no-transform",
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
        open_job = store.get_open_job(user_id=user_id, chat_id=chat_id)
        if open_job:
            _recover_stale_open_job_if_needed(user_id=user_id, chat_id=chat_id)
            open_job = store.get_open_job(user_id=user_id, chat_id=chat_id)
            if open_job:
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
        return _stream_job_response(
            user_id=user_id,
            chat_id=chat_id,
            job_id=job_id,
            segment_seconds=_stream_segment_seconds_for_request(),
            after_event_id=_after_event_id_from_payload(payload),
        )

    @api_bp.post("/chat/stream/resume")
    def stream_chat_resume() -> Response:
        payload = request_payload_fn()
        user_id, chat_id, payload_error = _sse_verified_user_and_chat_id(payload, activate_chat=False)
        if payload_error:
            return payload_error

        _recover_stale_open_job_if_needed(user_id=user_id, chat_id=chat_id)
        open_job = store_getter().get_open_job(user_id=user_id, chat_id=chat_id)
        if not open_job:
            return sse_error_fn("No active Hermes job for this chat.", 409, chat_id=chat_id)

        job_wake_event_getter().set()
        resumed_job_id = int(open_job["id"])
        _log_stream_job_event(event="stream_job_resumed", user_id=user_id, chat_id=chat_id, job_id=resumed_job_id)
        return _stream_job_response(
            user_id=user_id,
            chat_id=chat_id,
            job_id=resumed_job_id,
            segment_seconds=_stream_segment_seconds_for_request(),
            after_event_id=_after_event_id_from_payload(payload),
        )
