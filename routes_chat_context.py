from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from flask import Response


@dataclass(frozen=True, slots=True)
class ChatRouteContext:
    store_getter: Callable[[], Any]
    client_getter: Callable[[], Any]
    runtime_getter: Callable[[], Any]
    job_wake_event_getter: Callable[[], Any]
    request_payload_fn: Callable[[], dict[str, object]]
    json_user_id_or_error_fn: Callable[[dict[str, object]], tuple[str | None, tuple[dict[str, object], int] | None]]
    verify_for_json_fn: Callable[[dict[str, object]], tuple[Any | None, tuple[dict[str, object], int] | None]]
    verify_for_sse_fn: Callable[[dict[str, object]], tuple[Any | None, Response | None]]
    chat_id_from_payload_or_error_fn: Callable[[dict[str, object]], tuple[int | None, tuple[dict[str, object], int] | None]]
    chat_id_from_payload_fn: Callable[[dict[str, object], str], int]
    validated_title_fn: Callable[[object, str], str]
    validated_message_fn: Callable[[object], str]
    json_error_fn: Callable[[str, int], tuple[dict[str, object], int]]
    sse_error_fn: Callable[..., Response]
    sse_event_fn: Callable[[str, dict[str, object]], str]
    serialize_chat_fn: Callable[[Any], dict[str, object]]
    session_id_builder_fn: Callable[[str, int], str]
    job_max_attempts: int
    build_job_log_fn: Callable[..., str]
    logger: Any
