from __future__ import annotations

from typing import Callable

from flask import Response, request

from auth import TelegramAuthError, VerifiedTelegramInitData


def request_payload() -> dict[str, object]:
    return request.get_json(silent=True) or {}


def json_error(message: str, status: int) -> tuple[dict[str, object], int]:
    return {"ok": False, "error": message}, status


def sse_error(
    message: str,
    status: int,
    *,
    chat_id: int | None = None,
    sse_event_fn: Callable[[str, dict[str, object]], str],
) -> Response:
    payload: dict[str, object] = {"error": message}
    if chat_id is not None:
        payload["chat_id"] = chat_id
    return Response(sse_event_fn("error", payload), mimetype="text/event-stream", status=status)


def verify_for_json(
    payload: dict[str, object],
    *,
    verify_from_payload_fn: Callable[[dict[str, object]], VerifiedTelegramInitData],
) -> tuple[VerifiedTelegramInitData | None, tuple[dict[str, object], int] | None]:
    try:
        return verify_from_payload_fn(payload), None
    except TelegramAuthError as exc:
        return None, json_error(str(exc), 401)


def verify_for_sse(
    payload: dict[str, object],
    *,
    verify_from_payload_fn: Callable[[dict[str, object]], VerifiedTelegramInitData],
    sse_event_fn: Callable[[str, dict[str, object]], str],
) -> tuple[VerifiedTelegramInitData | None, Response | None]:
    try:
        return verify_from_payload_fn(payload), None
    except TelegramAuthError as exc:
        return None, sse_error(str(exc), 401, sse_event_fn=sse_event_fn)


def json_user_id_or_error(
    payload: dict[str, object],
    *,
    verify_for_json_fn: Callable[
        [dict[str, object]], tuple[VerifiedTelegramInitData | None, tuple[dict[str, object], int] | None]
    ],
) -> tuple[str | None, tuple[dict[str, object], int] | None]:
    verified, auth_error = verify_for_json_fn(payload)
    if auth_error:
        return None, auth_error
    return str(verified.user.id), None


def sse_user_id_or_error(
    payload: dict[str, object],
    *,
    verify_for_sse_fn: Callable[[dict[str, object]], tuple[VerifiedTelegramInitData | None, Response | None]],
) -> tuple[str | None, Response | None]:
    verified, auth_error = verify_for_sse_fn(payload)
    if auth_error:
        return None, auth_error
    return str(verified.user.id), None


def chat_id_from_payload_or_error(
    payload: dict[str, object],
    *,
    user_id: str,
    chat_id_from_payload_fn: Callable[[dict[str, object], str], int],
) -> tuple[int | None, tuple[dict[str, object], int] | None]:
    try:
        return chat_id_from_payload_fn(payload, user_id), None
    except ValueError as exc:
        return None, json_error(str(exc), 400)
    except KeyError as exc:
        return None, json_error(str(exc), 404)
