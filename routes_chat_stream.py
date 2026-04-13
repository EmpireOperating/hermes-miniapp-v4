from __future__ import annotations

import time

from flask import Response, g, request

from routes_chat_context import ChatRouteContext
from routes_chat_stream_service import after_event_id_from_payload, build_stream_route_service, stream_segment_seconds_for_headers


def register_stream_routes(
    api_bp,
    *,
    context: ChatRouteContext,
) -> None:
    request_payload_fn = context.request_payload_fn
    validated_message_fn = context.validated_message_fn
    sse_error_fn = context.sse_error_fn
    job_wake_event_getter = context.job_wake_event_getter
    job_max_attempts = context.job_max_attempts

    service = build_stream_route_service(
        store_getter=context.store_getter,
        runtime_getter=context.runtime_getter,
        client_getter=context.client_getter,
        verify_for_sse_fn=context.verify_for_sse_fn,
        chat_id_from_payload_or_error_fn=context.chat_id_from_payload_or_error_fn,
        sse_error_fn=sse_error_fn,
        sse_event_fn=context.sse_event_fn,
        session_id_builder_fn=context.session_id_builder_fn,
        build_job_log_fn=context.build_job_log_fn,
        logger=context.logger,
        stream_timing_debug=bool(context.stream_timing_debug),
        stream_efficiency_mode=bool(context.stream_efficiency_mode),
        stream_metrics_refresh_seconds=max(1, int(context.stream_metrics_refresh_seconds or 1)),
        time_module=time,
    )

    @api_bp.post("/chat/stream")
    def stream_chat() -> Response:
        payload = request_payload_fn()
        try:
            message = validated_message_fn(payload.get("message"))
        except ValueError as exc:
            return sse_error_fn(str(exc), 400)

        user_id, chat_id, payload_error = service.verified_user_and_chat_id(payload)
        if payload_error:
            return payload_error

        request_id = str(getattr(g, "request_id", "")) or None
        store = context.store_getter()
        interrupt_requested = service.interrupt_requested(payload)
        open_job = store.get_open_job(user_id=user_id, chat_id=chat_id)
        if open_job and not interrupt_requested:
            service.recover_stale_open_job_if_needed(user_id=user_id, chat_id=chat_id, request_id=request_id)
            open_job = store.get_open_job(user_id=user_id, chat_id=chat_id)
        if open_job:
            if interrupt_requested:
                service.interrupt_open_job_for_replacement(
                    user_id=user_id,
                    chat_id=chat_id,
                    open_job=open_job,
                    request_id=request_id,
                )
            else:
                return sse_error_fn("Hermes is already working on this chat.", 409, chat_id=chat_id)

        start_result, not_found_error = service.sse_try_not_found(
            lambda: store.start_chat_job(
                user_id=user_id,
                chat_id=chat_id,
                message=message,
                max_attempts=job_max_attempts,
            )
        )
        if not_found_error:
            return not_found_error

        if not start_result.get("created"):
            return sse_error_fn("Hermes is already working on this chat.", 409, chat_id=chat_id)

        job_id = int(start_result.get("job_id") or 0)

        job_wake_event_getter().set()
        service.log_stream_job_event(
            event="stream_job_enqueued",
            user_id=user_id,
            chat_id=chat_id,
            job_id=job_id,
            request_id=request_id,
        )
        return service.stream_response(
            user_id=user_id,
            chat_id=chat_id,
            job_id=job_id,
            request_id=request_id,
            segment_seconds=stream_segment_seconds_for_headers(request.headers),
            after_event_id=after_event_id_from_payload(payload),
        )

    @api_bp.post("/chat/stream/resume")
    def stream_chat_resume() -> Response:
        payload = request_payload_fn()
        user_id, chat_id, payload_error = service.verified_user_and_chat_id(payload, activate_chat=False)
        if payload_error:
            return payload_error

        request_id = str(getattr(g, "request_id", "")) or None
        service.recover_stale_open_job_if_needed(user_id=user_id, chat_id=chat_id, request_id=request_id)
        open_job = context.store_getter().get_open_job(user_id=user_id, chat_id=chat_id)
        if not open_job:
            return sse_error_fn("No active Hermes job for this chat.", 409, chat_id=chat_id)

        job_wake_event_getter().set()
        resumed_job_id = int(open_job["id"])
        service.log_stream_job_event(
            event="stream_job_resumed",
            user_id=user_id,
            chat_id=chat_id,
            job_id=resumed_job_id,
            request_id=request_id,
        )
        return service.stream_response(
            user_id=user_id,
            chat_id=chat_id,
            job_id=resumed_job_id,
            request_id=request_id,
            segment_seconds=stream_segment_seconds_for_headers(request.headers),
            after_event_id=after_event_id_from_payload(payload),
        )
