from __future__ import annotations

import os
from typing import Any, Callable, TypeVar

from flask import Response

from routes_chat_error_mapping import map_chat_id_payload_error_to_sse
from routes_chat_resolution import active_chat_id_or_error, user_and_chat_id_or_error, verified_user_id_or_error
from routes_chat_stream_generator import StreamResponseFactory


T = TypeVar("T")


class StreamRouteService:
    def __init__(
        self,
        *,
        store_getter: Callable[[], Any],
        runtime_getter: Callable[[], Any],
        client_getter: Callable[[], Any],
        verify_for_sse_fn: Callable[[dict[str, object]], tuple[Any | None, Response | None]],
        chat_id_from_payload_or_error_fn: Callable[[dict[str, object], str], tuple[int | None, tuple[dict[str, object], int] | None]],
        sse_error_fn: Callable[..., Response],
        session_id_builder_fn: Callable[[str, int], str],
        build_job_log_fn: Callable[..., str],
        logger: Any,
        response_factory: StreamResponseFactory,
        stale_job_timeout_getter: Callable[[], int],
    ) -> None:
        self._store_getter = store_getter
        self._runtime_getter = runtime_getter
        self._client_getter = client_getter
        self._verify_for_sse_fn = verify_for_sse_fn
        self._chat_id_from_payload_or_error_fn = chat_id_from_payload_or_error_fn
        self._sse_error_fn = sse_error_fn
        self._session_id_builder_fn = session_id_builder_fn
        self._build_job_log_fn = build_job_log_fn
        self._logger = logger
        self._response_factory = response_factory
        self._stale_job_timeout_getter = stale_job_timeout_getter

    def sse_not_found(self, exc: Exception) -> Response:
        return self._sse_error_fn(str(exc), 404)

    def is_chat_not_found_key_error(self, exc: KeyError) -> bool:
        message = str(exc).strip().lower()
        return "chat" in message and "not found" in message

    def sse_try_not_found(self, action: Callable[[], T]) -> tuple[T | None, Response | None]:
        try:
            return action(), None
        except KeyError as exc:
            return None, self.sse_not_found(exc)

    def resolve_active_chat_or_error(
        self,
        payload: dict[str, object],
        *,
        user_id: str,
    ) -> tuple[int | None, Response | None]:
        return active_chat_id_or_error(
            payload,
            user_id=user_id,
            chat_id_from_payload_or_error_fn=self._chat_id_from_payload_or_error_fn,
            map_chat_id_payload_error_fn=lambda payload_error: map_chat_id_payload_error_to_sse(
                payload_error,
                sse_error_fn=self._sse_error_fn,
            ),
            set_active_chat_fn=lambda chat_id: self._store_getter().set_active_chat(user_id=user_id, chat_id=chat_id),
            not_found_error_fn=self.sse_not_found,
            should_map_key_error_fn=self.is_chat_not_found_key_error,
        )

    def add_operator_message(self, *, user_id: str, chat_id: int, message: str) -> int:
        return self._store_getter().add_message(user_id=user_id, chat_id=chat_id, role="operator", body=message)

    def verified_user_and_chat_id(
        self,
        payload: dict[str, object],
        *,
        activate_chat: bool = True,
    ) -> tuple[str | None, int | None, Response | None]:
        user_id, auth_error = verified_user_id_or_error(payload, verify_fn=self._verify_for_sse_fn)
        if auth_error:
            return None, None, auth_error

        if activate_chat:
            chat_id, chat_id_error = self.resolve_active_chat_or_error(payload, user_id=user_id)
            if chat_id_error:
                return None, None, chat_id_error
            return user_id, chat_id, None

        verified_user_id, chat_id, chat_id_error = user_and_chat_id_or_error(
            payload,
            user_id_from_payload_or_error_fn=lambda _payload: (str(user_id), None),
            chat_id_from_payload_or_error_fn=self._chat_id_from_payload_or_error_fn,
            map_chat_id_payload_error_fn=lambda payload_error: map_chat_id_payload_error_to_sse(
                payload_error,
                sse_error_fn=self._sse_error_fn,
            ),
        )
        if chat_id_error:
            return None, None, chat_id_error

        try:
            self._store_getter().get_chat(user_id=str(verified_user_id), chat_id=int(chat_id))
        except KeyError as exc:
            if not self.is_chat_not_found_key_error(exc):
                raise
            return None, None, self.sse_not_found(exc)

        return verified_user_id, chat_id, None

    def recover_stale_open_job_if_needed(self, *, user_id: str, chat_id: int, request_id: str | None) -> dict[str, object] | None:
        stale = self._store_getter().dead_letter_stale_open_job_for_chat(
            user_id=user_id,
            chat_id=chat_id,
            timeout_seconds=max(30, int(self._stale_job_timeout_getter() or 0)),
            error="E_STALE_OPEN_JOB_AFTER_RESTART: stale open job dead-lettered before new stream",
        )
        if not stale:
            return None
        stale_job_id = int(stale.get("id") or 0)
        if stale_job_id:
            self.log_stream_job_event(
                event="stream_stale_open_job_dead_lettered",
                user_id=user_id,
                chat_id=chat_id,
                job_id=stale_job_id,
                request_id=request_id,
            )
        return stale

    def interrupt_requested(self, payload: dict[str, object]) -> bool:
        raw_value = payload.get("interrupt")
        if isinstance(raw_value, bool):
            return raw_value
        if raw_value is None:
            return False
        return str(raw_value).strip().lower() in {"1", "true", "yes", "on"}

    def interrupt_open_job_for_replacement(
        self,
        *,
        user_id: str,
        chat_id: int,
        open_job: dict[str, object],
        request_id: str | None,
        reason: str = "interrupted_by_new_message",
    ) -> dict[str, object] | None:
        store = self._store_getter()
        runtime = self._runtime_getter()
        client = self._client_getter()
        interrupted_jobs = store.interrupt_open_jobs_for_chat(user_id=user_id, chat_id=chat_id, reason=reason)
        interrupted_job = next((job for job in interrupted_jobs if int(job.get("id") or 0) == int(open_job.get("id") or 0)), None)
        if interrupted_job is None:
            interrupted_job = dict(open_job)

        job_id = int(interrupted_job.get("id") or 0)
        if job_id:
            terminate_job_children = getattr(runtime, "_terminate_job_children", None)
            if callable(terminate_job_children):
                terminate_job_children(job_id=job_id, reason=reason)
            finish_job_runner = getattr(runtime, "_finish_job_runner", None)
            if callable(finish_job_runner):
                finish_job_runner(job_id, outcome=reason)

        session_id = str(self._session_id_builder_fn(user_id, int(chat_id)) or "")
        evict_session = getattr(client, "evict_session", None)
        if session_id and callable(evict_session):
            evict_session(session_id, reason=reason)

        if job_id:
            self.log_stream_job_event(
                event="stream_job_interrupted_for_replacement",
                user_id=user_id,
                chat_id=chat_id,
                job_id=job_id,
                request_id=request_id,
            )
        return interrupted_job

    def log_stream_job_event(
        self,
        *,
        event: str,
        user_id: str,
        chat_id: int,
        job_id: int,
        request_id: str | None,
    ) -> None:
        self._logger.info(
            self._build_job_log_fn(
                event=event,
                request_id=request_id,
                chat_id=chat_id,
                job_id=job_id,
                extra={"user_id": user_id},
            )
        )

    def stream_response(
        self,
        *,
        user_id: str,
        chat_id: int,
        job_id: int,
        request_id: str | None,
        segment_seconds: float = 0.0,
        after_event_id: int = 0,
    ) -> Response:
        return self._response_factory.build_response(
            user_id=user_id,
            chat_id=chat_id,
            job_id=job_id,
            request_id=request_id,
            segment_seconds=segment_seconds,
            after_event_id=after_event_id,
        )



def stream_segment_seconds_for_headers(headers: Any) -> float:
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
    user_agent = str(getattr(headers, "get", lambda *_args, **_kwargs: "")("User-Agent") or "").lower()
    is_mobile_webview = "iphone" in user_agent or "android" in user_agent or "mobile" in user_agent
    return mobile_segment if is_mobile_webview else default_segment



def after_event_id_from_payload(payload: dict[str, object]) -> int:
    raw_value = payload.get("after_event_id")
    try:
        parsed = int(raw_value or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)



def build_stream_route_service(
    *,
    store_getter: Callable[[], Any],
    runtime_getter: Callable[[], Any],
    client_getter: Callable[[], Any],
    verify_for_sse_fn: Callable[[dict[str, object]], tuple[Any | None, Response | None]],
    chat_id_from_payload_or_error_fn: Callable[[dict[str, object], str], tuple[int | None, tuple[dict[str, object], int] | None]],
    sse_error_fn: Callable[..., Response],
    sse_event_fn: Callable[[str, dict[str, object]], str],
    session_id_builder_fn: Callable[[str, int], str],
    build_job_log_fn: Callable[..., str],
    logger: Any,
    stream_timing_debug: bool,
    stream_efficiency_mode: bool,
    stream_metrics_refresh_seconds: int,
    time_module: Any,
) -> StreamRouteService:
    return StreamRouteService(
        store_getter=store_getter,
        runtime_getter=runtime_getter,
        client_getter=client_getter,
        verify_for_sse_fn=verify_for_sse_fn,
        chat_id_from_payload_or_error_fn=chat_id_from_payload_or_error_fn,
        sse_error_fn=sse_error_fn,
        session_id_builder_fn=session_id_builder_fn,
        build_job_log_fn=build_job_log_fn,
        logger=logger,
        response_factory=StreamResponseFactory(
            runtime_getter=runtime_getter,
            store_getter=store_getter,
            client_getter=client_getter,
            session_id_builder_fn=session_id_builder_fn,
            sse_event_fn=sse_event_fn,
            logger=logger,
            build_job_log_fn=build_job_log_fn,
            stream_timing_debug=stream_timing_debug,
            stream_efficiency_mode=stream_efficiency_mode,
            stream_metrics_refresh_seconds=stream_metrics_refresh_seconds,
            time_module=time_module,
        ),
        stale_job_timeout_getter=lambda: int(getattr(runtime_getter(), "job_stall_timeout_seconds", 0) or 0),
    )
