from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable

from flask import Response, request

from auth import VerifiedTelegramInitData
from auth_session import (
    create_auth_session_token,
    verified_from_session_cookie,
    verify_auth_session_token,
    verify_from_payload,
)
from request_context import (
    chat_id_from_payload_or_error,
    json_error,
    json_user_id_or_error,
    request_payload,
    sse_error,
    sse_user_id_or_error,
    verify_for_json,
    verify_for_sse,
)


@dataclass(frozen=True)
class ServerRequestAdapters:
    create_auth_session_token_fn: Callable[[str], str]
    verify_auth_session_token_fn: Callable[[str], str | None]
    verified_from_session_cookie_fn: Callable[[], VerifiedTelegramInitData | None]
    verify_from_payload_fn: Callable[[dict[str, object]], VerifiedTelegramInitData]
    sse_event_fn: Callable[[str, dict[str, object]], str]
    sse_error_fn: Callable[..., Response]
    verify_for_json_fn: Callable[[dict[str, object]], tuple[VerifiedTelegramInitData | None, tuple[dict[str, object], int] | None]]
    verify_for_sse_fn: Callable[[dict[str, object]], tuple[VerifiedTelegramInitData | None, Response | None]]
    request_payload_fn: Callable[[], dict[str, object]]
    json_user_id_or_error_fn: Callable[[dict[str, object]], tuple[str | None, tuple[dict[str, object], int] | None]]
    sse_user_id_or_error_fn: Callable[[dict[str, object]], tuple[str | None, Response | None]]
    chat_id_from_payload_or_error_fn: Callable[[dict[str, object], str], tuple[int | None, tuple[dict[str, object], int] | None]]
    json_error_fn: Callable[[str, int], tuple[dict[str, object], int]]


def build_server_request_adapters(
    *,
    bot_token: str,
    auth_cookie_name: str,
    auth_session_max_age_seconds: int,
    telegram_init_data_max_age_seconds: int,
    upsert_auth_session_fn: Callable[[str, str], None],
    is_auth_session_active_fn: Callable[[str], bool],
    verify_telegram_init_data_fn: Callable[..., VerifiedTelegramInitData],
    chat_id_from_payload_fn: Callable[[dict[str, object], str], int],
) -> ServerRequestAdapters:
    def _create_auth_session_token(user_id: str) -> str:
        return create_auth_session_token(
            user_id,
            bot_token=bot_token,
            auth_session_max_age_seconds=auth_session_max_age_seconds,
            upsert_auth_session_fn=upsert_auth_session_fn,
        )

    def _verify_auth_session_token(token: str) -> str | None:
        return verify_auth_session_token(
            token,
            bot_token=bot_token,
            is_auth_session_active_fn=is_auth_session_active_fn,
        )

    def _verified_from_session_cookie() -> VerifiedTelegramInitData | None:
        token = request.cookies.get(auth_cookie_name, "")
        return verified_from_session_cookie(
            token=token,
            verify_auth_session_token_fn=_verify_auth_session_token,
        )

    def _verify_from_payload(payload: dict[str, object]) -> VerifiedTelegramInitData:
        return verify_from_payload(
            payload,
            bot_token=bot_token,
            telegram_init_data_max_age_seconds=telegram_init_data_max_age_seconds,
            verified_from_session_cookie_fn=_verified_from_session_cookie,
            verify_telegram_init_data_fn=verify_telegram_init_data_fn,
        )

    def _json_error(message: str, status: int) -> tuple[dict[str, object], int]:
        return json_error(message, status)

    def _sse_event(event: str, data: dict[str, object]) -> str:
        payload = json.dumps(data, ensure_ascii=False)
        return f"event: {event}\\ndata: {payload}\\n\\n"

    def _sse_error(message: str, status: int, *, chat_id: int | None = None) -> Response:
        return sse_error(message, status, chat_id=chat_id, sse_event_fn=_sse_event)

    def _verify_for_json(payload: dict[str, object]) -> tuple[VerifiedTelegramInitData | None, tuple[dict[str, object], int] | None]:
        return verify_for_json(payload, verify_from_payload_fn=_verify_from_payload)

    def _verify_for_sse(payload: dict[str, object]) -> tuple[VerifiedTelegramInitData | None, Response | None]:
        return verify_for_sse(payload, verify_from_payload_fn=_verify_from_payload, sse_event_fn=_sse_event)

    def _request_payload() -> dict[str, object]:
        return request_payload()

    def _json_user_id_or_error(payload: dict[str, object]) -> tuple[str | None, tuple[dict[str, object], int] | None]:
        return json_user_id_or_error(payload, verify_for_json_fn=_verify_for_json)

    def _sse_user_id_or_error(payload: dict[str, object]) -> tuple[str | None, Response | None]:
        return sse_user_id_or_error(payload, verify_for_sse_fn=_verify_for_sse)

    def _chat_id_from_payload_or_error(payload: dict[str, object], *, user_id: str) -> tuple[int | None, tuple[dict[str, object], int] | None]:
        return chat_id_from_payload_or_error(
            payload,
            user_id=user_id,
            chat_id_from_payload_fn=lambda data, uid: chat_id_from_payload_fn(data, uid),
        )

    return ServerRequestAdapters(
        create_auth_session_token_fn=_create_auth_session_token,
        verify_auth_session_token_fn=_verify_auth_session_token,
        verified_from_session_cookie_fn=_verified_from_session_cookie,
        verify_from_payload_fn=_verify_from_payload,
        sse_event_fn=_sse_event,
        sse_error_fn=lambda message, status, **kwargs: _sse_error(message, status, chat_id=kwargs.get("chat_id")),
        verify_for_json_fn=_verify_for_json,
        verify_for_sse_fn=_verify_for_sse,
        request_payload_fn=_request_payload,
        json_user_id_or_error_fn=_json_user_id_or_error,
        sse_user_id_or_error_fn=_sse_user_id_or_error,
        chat_id_from_payload_or_error_fn=lambda payload, user_id: _chat_id_from_payload_or_error(payload, user_id=user_id),
        json_error_fn=_json_error,
    )
