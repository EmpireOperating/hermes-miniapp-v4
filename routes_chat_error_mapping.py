from __future__ import annotations

from flask import Response


def _chat_id_payload_message(payload_error: tuple[dict[str, object], int] | None) -> str:
    if not payload_error:
        return "Invalid chat_id."
    payload, _status = payload_error
    message = str(payload.get("error") or "").strip()
    return message or "Invalid chat_id."


def _chat_id_payload_status(payload_error: tuple[dict[str, object], int] | None) -> int:
    if not payload_error:
        return 400
    _payload, status = payload_error
    return 404 if int(status or 400) == 404 else 400


def map_chat_id_payload_error_to_json(
    payload_error: tuple[dict[str, object], int] | None,
    *,
    json_error_fn,
) -> tuple[dict[str, object], int]:
    return json_error_fn(_chat_id_payload_message(payload_error), _chat_id_payload_status(payload_error))


def map_chat_id_payload_error_to_sse(
    payload_error: tuple[dict[str, object], int] | None,
    *,
    sse_error_fn,
) -> Response:
    return sse_error_fn(_chat_id_payload_message(payload_error), _chat_id_payload_status(payload_error))
