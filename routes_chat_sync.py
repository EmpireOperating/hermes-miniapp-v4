from __future__ import annotations

import time
from dataclasses import asdict
from typing import Any, Callable, TypeVar

from flask import jsonify

from hermes_client import HermesClientError
from routes_chat_context import ChatRouteContext


T = TypeVar("T")


def register_sync_chat_routes(
    api_bp,
    *,
    context: ChatRouteContext,
) -> None:
    store_getter = context.store_getter
    client_getter = context.client_getter
    request_payload_fn = context.request_payload_fn
    verify_for_json_fn = context.verify_for_json_fn
    chat_id_from_payload_fn = context.chat_id_from_payload_fn
    validated_message_fn = context.validated_message_fn
    json_error_fn = context.json_error_fn

    def _chat_history(user_id: str, chat_id: int, *, limit: int = 120) -> list[dict[str, object]]:
        return [asdict(turn) for turn in store_getter().get_history(user_id=user_id, chat_id=chat_id, limit=limit)]

    def _resolve_active_chat(payload: dict[str, object], *, user_id: str) -> int:
        chat_id = chat_id_from_payload_fn(payload, user_id)
        store_getter().set_active_chat(user_id=user_id, chat_id=chat_id)
        return chat_id

    def _add_operator_message(user_id: str, chat_id: int, message: str) -> int:
        return store_getter().add_message(user_id=user_id, chat_id=chat_id, role="operator", body=message)

    def _require_verified_json(payload: dict[str, object]) -> tuple[Any | None, tuple[dict[str, object], int] | None]:
        verified, auth_error = verify_for_json_fn(payload)
        if auth_error:
            return None, auth_error
        return verified, None

    def _json_bad_request(exc: Exception) -> tuple[dict[str, object], int]:
        return json_error_fn(str(exc), 400)

    def _verified_user_id(verified: Any) -> str:
        return str(verified.user.id)

    def _json_try_bad_request(
        action: Callable[[], T],
    ) -> tuple[T | None, tuple[dict[str, object], int] | None]:
        try:
            return action(), None
        except (KeyError, ValueError) as exc:
            return None, _json_bad_request(exc)

    @api_bp.post("/chat")
    def chat() -> tuple[object, int]:
        payload = request_payload_fn()
        try:
            message = validated_message_fn(payload.get("message"))
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

        verified, auth_error = _require_verified_json(payload)
        if auth_error:
            return auth_error

        user_id = _verified_user_id(verified)

        def _action() -> int:
            chat_id = _resolve_active_chat(payload, user_id=user_id)
            _add_operator_message(user_id=user_id, chat_id=chat_id, message=message)
            return chat_id

        chat_id, bad_request_error = _json_try_bad_request(_action)
        if bad_request_error:
            return bad_request_error

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
