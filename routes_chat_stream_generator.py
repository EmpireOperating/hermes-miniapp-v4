from __future__ import annotations

import queue
import time
from datetime import datetime, timezone
from typing import Any, Callable, Iterator

from flask import Response

from job_status import JOB_EVENT_DONE, JOB_EVENT_ERROR, JOB_EVENT_TERMINAL, JOB_STATUS_DONE, JOB_STATUS_QUEUED, is_terminal_job_status


class StreamResponseFactory:
    def __init__(
        self,
        *,
        runtime_getter: Callable[[], Any],
        store_getter: Callable[[], Any],
        client_getter: Callable[[], Any],
        session_id_builder_fn: Callable[[str, int], str],
        sse_event_fn: Callable[[str, dict[str, object]], str],
        logger: Any,
        build_job_log_fn: Callable[..., str],
        stream_timing_debug: bool,
        stream_efficiency_mode: bool,
        stream_metrics_refresh_seconds: int,
        time_module: Any = time,
    ) -> None:
        self._runtime_getter = runtime_getter
        self._store_getter = store_getter
        self._client_getter = client_getter
        self._session_id_builder_fn = session_id_builder_fn
        self._sse_event_fn = sse_event_fn
        self._logger = logger
        self._build_job_log_fn = build_job_log_fn
        self._stream_timing_debug = bool(stream_timing_debug)
        self._stream_efficiency_mode = bool(stream_efficiency_mode)
        self._stream_metrics_refresh_seconds = max(1, int(stream_metrics_refresh_seconds or 1))
        self._time = time_module

    def build_response(
        self,
        *,
        user_id: str,
        chat_id: int,
        job_id: int,
        request_id: str | None,
        segment_seconds: float = 0.0,
        after_event_id: int = 0,
    ) -> Response:
        headers = {
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        }
        return Response(
            self.generate(
                user_id=user_id,
                chat_id=chat_id,
                job_id=job_id,
                request_id=request_id,
                segment_seconds=segment_seconds,
                after_event_id=after_event_id,
            ),
            mimetype="text/event-stream",
            headers=headers,
        )

    def generate(
        self,
        *,
        user_id: str,
        chat_id: int,
        job_id: int,
        request_id: str | None,
        segment_seconds: float = 0.0,
        after_event_id: int = 0,
    ) -> Iterator[str]:
        heartbeat_seconds = 1.5
        runtime = self._runtime_getter()
        store = self._store_getter()
        subscriber = runtime.subscribe_job_events(job_id, after_event_id=max(0, int(after_event_id or 0)))
        terminal = False
        last_queue_heartbeat = 0.0
        last_polled_state: dict[str, object] | None = None
        next_state_refresh_at = 0.0
        segment_deadline = (self._time.monotonic() + segment_seconds) if segment_seconds > 0 else 0.0

        def _with_emit_timing(payload: dict[str, object]) -> dict[str, object]:
            next_payload = dict(payload or {})
            if not self._stream_timing_debug:
                return next_payload
            timing_payload = next_payload.get("_timing")
            merged_timing = dict(timing_payload) if isinstance(timing_payload, dict) else {}
            merged_timing["sse_emit_monotonic_ms"] = int(self._time.monotonic() * 1000)
            next_payload["_timing"] = merged_timing
            return next_payload

        def _terminal_recovery_event_from_state(state: dict[str, object]) -> tuple[str, dict[str, object]] | None:
            job_status = str((state or {}).get("status") or "")
            if not is_terminal_job_status(job_status):
                return None
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
                session_id = self._session_id_builder_fn(user_id, chat_id)
                warm_candidate = None
                try:
                    warm_candidate = self._client_getter().select_warm_session_candidate(session_id)
                except Exception:
                    warm_candidate = None
                if (
                    isinstance(warm_candidate, dict)
                    and str(warm_candidate.get("state") or "") == "attachable_running"
                ):
                    recovery_event = JOB_EVENT_DONE
                    recovery_payload["detail"] = "stream detached to warm owner"
                    recovery_payload["warm_handoff"] = True
                    recovery_payload["session_id"] = session_id
                    recovery_payload["persistent_mode"] = "warm-detached"
            return recovery_event, recovery_payload

        def _emit_segment_boundary() -> tuple[list[str], bool]:
            nonlocal last_polled_state
            state = last_polled_state
            if state is None:
                state = store.get_job_state(job_id)
                last_polled_state = state
            terminal_recovery = _terminal_recovery_event_from_state(state or {})
            if terminal_recovery:
                recovery_event, recovery_payload = terminal_recovery
                return [self._sse_event_fn(recovery_event, _with_emit_timing(recovery_payload))], True
            job_status = str((state or {}).get("status") or "")
            rollover_payload: dict[str, object] = {
                "chat_id": chat_id,
                "source": "queue",
                "detail": "stream segment rollover",
                "stream_segment_end": True,
                "resume_recommended": True,
            }
            if job_status:
                rollover_payload["job_status"] = job_status
            return [self._sse_event_fn("meta", _with_emit_timing(rollover_payload))], False

        try:
            # SSE prelude comments help prevent intermediary buffering in some WebView/proxy paths.
            yield ": stream-open\n"
            yield f": {' ' * 2048}\n\n"
            yield self._sse_event_fn(
                "meta",
                _with_emit_timing({"skin": store.get_skin(user_id), "source": "queue", "chat_id": chat_id}),
            )
            while not terminal:
                try:
                    event = subscriber.get(timeout=0.6)
                except queue.Empty:
                    now = self._time.monotonic()
                    if (now - last_queue_heartbeat) >= heartbeat_seconds:
                        yield f": hb {int(now * 1000)}\n\n"

                        should_refresh_state = (
                            (not self._stream_efficiency_mode)
                            or last_polled_state is None
                            or now >= next_state_refresh_at
                        )
                        if should_refresh_state:
                            last_polled_state = store.get_job_state(job_id)
                            next_state_refresh_at = now + self._stream_metrics_refresh_seconds
                        state = last_polled_state

                        if state:
                            terminal_recovery = _terminal_recovery_event_from_state(state)
                            if terminal_recovery:
                                recovery_event, recovery_payload = terminal_recovery
                                yield self._sse_event_fn(recovery_event, _with_emit_timing(recovery_payload))
                                terminal = True
                                last_queue_heartbeat = now
                                continue

                            yield self._sse_event_fn("meta", _with_emit_timing(build_heartbeat_payload(chat_id=chat_id, state=state)))
                        last_queue_heartbeat = now
                    if segment_deadline and now >= segment_deadline:
                        segment_events, ended_terminally = _emit_segment_boundary()
                        if not ended_terminally:
                            self._log_segment_rollover(
                                user_id=user_id,
                                chat_id=chat_id,
                                job_id=job_id,
                                request_id=request_id,
                                segment_seconds=segment_seconds,
                            )
                        for chunk in segment_events:
                            yield chunk
                        break
                    continue

                event_name = str(event.get("event") or "message")
                payload = dict(event.get("payload") or {})
                if "chat_id" not in payload:
                    payload["chat_id"] = chat_id
                event_id = event.get("event_id")
                if "_event_id" not in payload and isinstance(event_id, int) and event_id > 0:
                    payload["_event_id"] = event_id
                yield self._sse_event_fn(event_name, _with_emit_timing(payload))
                if event_name in JOB_EVENT_TERMINAL:
                    terminal = True
                elif segment_deadline and self._time.monotonic() >= segment_deadline:
                    segment_events, ended_terminally = _emit_segment_boundary()
                    if not ended_terminally:
                        self._log_segment_rollover(
                            user_id=user_id,
                            chat_id=chat_id,
                            job_id=job_id,
                            request_id=request_id,
                            segment_seconds=segment_seconds,
                        )
                    for chunk in segment_events:
                        yield chunk
                    break
        finally:
            runtime.unsubscribe_job_events(job_id, subscriber)

    def _log_segment_rollover(
        self,
        *,
        user_id: str,
        chat_id: int,
        job_id: int,
        request_id: str | None,
        segment_seconds: float,
    ) -> None:
        if not self._stream_timing_debug:
            return
        self._logger.info(
            self._build_job_log_fn(
                event="stream_segment_rollover",
                request_id=request_id,
                chat_id=chat_id,
                job_id=job_id,
                extra={"user_id": user_id, "segment_seconds": segment_seconds},
            )
        )


def build_heartbeat_payload(*, chat_id: int, state: dict[str, object]) -> dict[str, object]:
    return {
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
        "elapsed_ms": parse_started_elapsed_ms(state.get("started_at")),
    }



def parse_started_elapsed_ms(started_at: object) -> int | None:
    started_at_raw = str(started_at or "").strip()
    if not started_at_raw:
        return None
    try:
        started_dt = datetime.strptime(started_at_raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return max(0, int((datetime.now(timezone.utc) - started_dt).total_seconds() * 1000))
