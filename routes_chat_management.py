from __future__ import annotations

from dataclasses import asdict
from typing import Any, Callable, TypeVar

from routes_chat_context import ChatRouteContext


T = TypeVar("T")


def register_chat_management_routes(
    api_bp,
    *,
    context: ChatRouteContext,
) -> None:
    store_getter = context.store_getter
    client_getter = context.client_getter
    runtime_getter = context.runtime_getter
    request_payload_fn = context.request_payload_fn
    json_user_id_or_error_fn = context.json_user_id_or_error_fn
    chat_id_from_payload_or_error_fn = context.chat_id_from_payload_or_error_fn
    validated_title_fn = context.validated_title_fn
    json_error_fn = context.json_error_fn
    serialize_chat_fn = context.serialize_chat_fn
    session_id_builder_fn = context.session_id_builder_fn

    def _chat_history(user_id: str, chat_id: int, *, limit: int = 120) -> list[dict[str, object]]:
        return [asdict(turn) for turn in store_getter().get_history(user_id=user_id, chat_id=chat_id, limit=limit)]

    def _serialize_chats(user_id: str) -> list[dict[str, object]]:
        return [serialize_chat_fn(chat) for chat in store_getter().list_chats(user_id=user_id)]

    def _serialize_pinned_chats(user_id: str) -> list[dict[str, object]]:
        return [serialize_chat_fn(chat) for chat in store_getter().list_pinned_chats(user_id=user_id)]

    def _evict_chat_runtime(user_id: str, chat_id: int) -> None:
        session_id = session_id_builder_fn(user_id, chat_id)
        client_getter().evict_session(session_id)
        store_getter().delete_runtime_checkpoint(session_id)

    def _require_json_user_id(
        payload: dict[str, object],
    ) -> tuple[str | None, tuple[dict[str, object], int] | None]:
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return None, auth_error
        return user_id, None

    def _require_json_user_and_chat_id(
        payload: dict[str, object],
    ) -> tuple[str | None, int | None, tuple[dict[str, object], int] | None]:
        user_id, auth_error = _require_json_user_id(payload)
        if auth_error:
            return None, None, auth_error

        chat_id, chat_id_error = chat_id_from_payload_or_error_fn(payload, user_id=user_id)
        if chat_id_error:
            return None, None, chat_id_error

        return user_id, chat_id, None

    def _json_user_from_request(
    ) -> tuple[dict[str, object], str | None, tuple[dict[str, object], int] | None]:
        payload = request_payload_fn()
        user_id, auth_error = _require_json_user_id(payload)
        if auth_error:
            return payload, None, auth_error
        return payload, user_id, None

    def _json_user_and_chat_from_request(
    ) -> tuple[dict[str, object], str | None, int | None, tuple[dict[str, object], int] | None]:
        payload = request_payload_fn()
        user_id, chat_id, payload_error = _require_json_user_and_chat_id(payload)
        if payload_error:
            return payload, None, None, payload_error
        return payload, user_id, chat_id, None

    def _chat_history_payload(user_id: str, chat_id: int, *, activate: bool) -> dict[str, object]:
        store = store_getter()
        if activate:
            store.mark_chat_read(user_id=user_id, chat_id=chat_id)
            store.set_active_chat(user_id=user_id, chat_id=chat_id)
        history = [asdict(turn) for turn in store.get_history(user_id=user_id, chat_id=chat_id, limit=120)]
        chat = store.get_chat(user_id=user_id, chat_id=chat_id)
        return {"ok": True, "chat": serialize_chat_fn(chat), "history": history}

    def _json_not_found(exc: KeyError) -> tuple[dict[str, object], int]:
        return json_error_fn(str(exc), 404)

    def _json_try_not_found(
        action: Callable[[], T],
    ) -> tuple[T | None, tuple[dict[str, object], int] | None]:
        try:
            return action(), None
        except KeyError as exc:
            return None, _json_not_found(exc)

    @api_bp.post("/chats")
    def create_chat() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        try:
            title = validated_title_fn(payload.get("title"), "New chat")
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

        user_id, auth_error = _require_json_user_id(payload)
        if auth_error:
            return auth_error

        store = store_getter()
        chat = store.create_chat(user_id=user_id, title=title)
        store.set_active_chat(user_id=user_id, chat_id=chat.id)
        history = _chat_history(user_id=user_id, chat_id=chat.id, limit=120)
        return {"ok": True, "chat": serialize_chat_fn(chat), "history": history}, 201

    @api_bp.post("/chats/rename")
    def rename_chat() -> tuple[dict[str, object], int]:
        payload, user_id, chat_id, payload_error = _json_user_and_chat_from_request()
        if payload_error:
            return payload_error

        try:
            title = validated_title_fn(payload.get("title"), "Untitled")
            chat = store_getter().rename_chat(user_id=user_id, chat_id=chat_id, title=title)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        except KeyError as exc:
            return _json_not_found(exc)
        return {"ok": True, "chat": serialize_chat_fn(chat)}, 200

    @api_bp.post("/chats/open")
    def open_chat() -> tuple[dict[str, object], int]:
        _, user_id, chat_id, payload_error = _json_user_and_chat_from_request()
        if payload_error:
            return payload_error

        response_payload, not_found_error = _json_try_not_found(
            lambda: _chat_history_payload(user_id=user_id, chat_id=chat_id, activate=True)
        )
        if not_found_error:
            return not_found_error

        return response_payload, 200

    @api_bp.post("/chats/history")
    def chat_history() -> tuple[dict[str, object], int]:
        payload, user_id, chat_id, payload_error = _json_user_and_chat_from_request()
        if payload_error:
            return payload_error

        activate = bool(payload.get("activate", False))
        response_payload, not_found_error = _json_try_not_found(
            lambda: _chat_history_payload(user_id=user_id, chat_id=chat_id, activate=activate)
        )
        if not_found_error:
            return not_found_error

        return response_payload, 200

    @api_bp.post("/chats/mark-read")
    def mark_chat_read() -> tuple[dict[str, object], int]:
        _, user_id, chat_id, payload_error = _json_user_and_chat_from_request()
        if payload_error:
            return payload_error

        def _action() -> Any:
            store = store_getter()
            store.mark_chat_read(user_id=user_id, chat_id=chat_id)
            return store.get_chat(user_id=user_id, chat_id=chat_id)

        chat, not_found_error = _json_try_not_found(_action)
        if not_found_error:
            return not_found_error
        return {"ok": True, "chat": serialize_chat_fn(chat)}, 200

    @api_bp.post("/chats/pin")
    def pin_chat() -> tuple[dict[str, object], int]:
        _, user_id, chat_id, payload_error = _json_user_and_chat_from_request()
        if payload_error:
            return payload_error

        def _action() -> Any:
            store = store_getter()
            return store.set_chat_pinned(user_id=user_id, chat_id=chat_id, is_pinned=True)

        chat, not_found_error = _json_try_not_found(_action)
        if not_found_error:
            return not_found_error

        return {
            "ok": True,
            "chat": serialize_chat_fn(chat),
            "pinned_chats": _serialize_pinned_chats(user_id=user_id),
        }, 200

    @api_bp.post("/chats/unpin")
    def unpin_chat() -> tuple[dict[str, object], int]:
        _, user_id, chat_id, payload_error = _json_user_and_chat_from_request()
        if payload_error:
            return payload_error

        def _action() -> Any:
            store = store_getter()
            return store.set_chat_pinned(user_id=user_id, chat_id=chat_id, is_pinned=False)

        chat, not_found_error = _json_try_not_found(_action)
        if not_found_error:
            return not_found_error

        return {
            "ok": True,
            "chat": serialize_chat_fn(chat),
            "pinned_chats": _serialize_pinned_chats(user_id=user_id),
        }, 200

    @api_bp.post("/chats/reopen")
    def reopen_chat() -> tuple[dict[str, object], int]:
        _, user_id, chat_id, payload_error = _json_user_and_chat_from_request()
        if payload_error:
            return payload_error

        def _action() -> tuple[Any, list[dict[str, object]], list[dict[str, object]], list[dict[str, object]]]:
            store = store_getter()
            chat_record = store.reopen_chat(user_id=user_id, chat_id=chat_id)
            store.mark_chat_read(user_id=user_id, chat_id=chat_id)
            store.set_active_chat(user_id=user_id, chat_id=chat_id)
            history = _chat_history(user_id=user_id, chat_id=chat_id, limit=120)
            chats = _serialize_chats(user_id=user_id)
            pinned_chats = _serialize_pinned_chats(user_id=user_id)
            return chat_record, history, chats, pinned_chats

        action_result, not_found_error = _json_try_not_found(_action)
        if not_found_error:
            return not_found_error

        chat_record, history, chats, pinned_chats = action_result
        return {
            "ok": True,
            "chat": serialize_chat_fn(chat_record),
            "active_chat_id": chat_id,
            "history": history,
            "chats": chats,
            "pinned_chats": pinned_chats,
        }, 200

    @api_bp.post("/chats/clear")
    def clear_chat() -> tuple[dict[str, object], int]:
        _, user_id, chat_id, payload_error = _json_user_and_chat_from_request()
        if payload_error:
            return payload_error

        def _action() -> Any:
            store = store_getter()
            store.clear_chat(user_id=user_id, chat_id=chat_id)
            chat_record = store.get_chat(user_id=user_id, chat_id=chat_id)
            _evict_chat_runtime(user_id=user_id, chat_id=chat_id)
            return chat_record

        chat, not_found_error = _json_try_not_found(_action)
        if not_found_error:
            return not_found_error
        return {"ok": True, "chat": serialize_chat_fn(chat), "history": []}, 200

    @api_bp.post("/chats/remove")
    def remove_chat() -> tuple[dict[str, object], int]:
        _, user_id, chat_id, payload_error = _json_user_and_chat_from_request()
        if payload_error:
            return payload_error

        def _action() -> tuple[int, list[dict[str, object]], Any, list[dict[str, object]], list[dict[str, object]]]:
            store = store_getter()
            _evict_chat_runtime(user_id=user_id, chat_id=chat_id)
            next_chat_id = store.remove_chat(user_id=user_id, chat_id=chat_id)
            history = _chat_history(user_id=user_id, chat_id=next_chat_id, limit=120)
            store.mark_chat_read(user_id=user_id, chat_id=next_chat_id)
            store.set_active_chat(user_id=user_id, chat_id=next_chat_id)
            active_chat = store.get_chat(user_id=user_id, chat_id=next_chat_id)
            chats = _serialize_chats(user_id=user_id)
            pinned_chats = _serialize_pinned_chats(user_id=user_id)
            return next_chat_id, history, active_chat, chats, pinned_chats

        action_result, not_found_error = _json_try_not_found(_action)
        if not_found_error:
            return not_found_error

        next_chat_id, history, active_chat, chats, pinned_chats = action_result
        return {
            "ok": True,
            "removed_chat_id": chat_id,
            "active_chat_id": next_chat_id,
            "active_chat": serialize_chat_fn(active_chat),
            "history": history,
            "chats": chats,
            "pinned_chats": pinned_chats,
        }, 200

    @api_bp.post("/chats/status")
    def chats_status() -> tuple[dict[str, object], int]:
        _, user_id, auth_error = _json_user_from_request()
        if auth_error:
            return auth_error

        runtime_getter().ensure_pending_jobs(user_id)
        chats = _serialize_chats(user_id=user_id)
        pinned_chats = _serialize_pinned_chats(user_id=user_id)
        return {"ok": True, "chats": chats, "pinned_chats": pinned_chats}, 200
