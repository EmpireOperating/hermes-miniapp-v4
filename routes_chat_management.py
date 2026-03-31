from __future__ import annotations

from dataclasses import asdict
from typing import Any

from routes_chat_context import ChatRouteContext
from routes_chat_resolution import (
    guard_json_payload_user_chat_route,
    guard_json_payload_user_route,
    guard_key_error_as_route_error,
    user_and_chat_id_or_error,
)


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
    file_preview_allowed_roots = context.file_preview_allowed_roots
    file_preview_max_lines = context.file_preview_max_lines
    file_preview_max_file_bytes = context.file_preview_max_file_bytes

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
        return user_and_chat_id_or_error(
            payload,
            user_id_from_payload_or_error_fn=_require_json_user_id,
            chat_id_from_payload_or_error_fn=chat_id_from_payload_or_error_fn,
            map_chat_id_payload_error_fn=lambda payload_error: payload_error,
        )

    def _chat_history_payload(user_id: str, chat_id: int, *, activate: bool) -> dict[str, object]:
        store = store_getter()
        if activate:
            store.mark_chat_read(user_id=user_id, chat_id=chat_id)
            store.set_active_chat(user_id=user_id, chat_id=chat_id)
        history = [asdict(turn) for turn in store.get_history(user_id=user_id, chat_id=chat_id, limit=120)]
        chat = store.get_chat(user_id=user_id, chat_id=chat_id)
        return {"ok": True, "chat": serialize_chat_fn(chat), "history": history}

    def _json_not_found(exc: Exception) -> tuple[dict[str, object], int]:
        return json_error_fn(str(exc), 404)

    def _is_chat_not_found_key_error(exc: KeyError) -> bool:
        message = str(exc).strip().lower()
        return "chat" in message and "not found" in message

    def _parse_activate_flag(payload: dict[str, object]) -> tuple[bool | None, tuple[dict[str, object], int] | None]:
        raw_activate = payload.get("activate", False)
        if isinstance(raw_activate, bool):
            return raw_activate, None
        if raw_activate is None:
            return False, None
        return None, json_error_fn("Invalid activate flag. Expected boolean.", 400)

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
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def rename_chat(payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        try:
            title = validated_title_fn(payload.get("title"), "Untitled")
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

        chat = store_getter().rename_chat(user_id=user_id, chat_id=chat_id, title=title)
        return {"ok": True, "chat": serialize_chat_fn(chat)}, 200

    @api_bp.post("/chats/open")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def open_chat(_payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        return _chat_history_payload(user_id=user_id, chat_id=chat_id, activate=True), 200

    @api_bp.post("/chats/history")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def chat_history(payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        activate, activate_error = _parse_activate_flag(payload)
        if activate_error:
            return activate_error
        return _chat_history_payload(user_id=user_id, chat_id=chat_id, activate=bool(activate)), 200

    @api_bp.post("/chats/file-preview")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def file_preview(payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        ref_id = str(payload.get("ref_id") or "").strip()
        if not ref_id:
            return json_error_fn("ref_id is required", 400)

        try:
            preview = store_getter().resolve_file_ref_preview(
                user_id=user_id,
                chat_id=chat_id,
                ref_id=ref_id,
                allowed_roots=list(file_preview_allowed_roots),
                max_lines=file_preview_max_lines,
                max_file_bytes=file_preview_max_file_bytes,
            )
        except PermissionError as exc:
            return json_error_fn(str(exc), 403)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)

        return {"ok": True, "preview": preview}, 200

    @api_bp.post("/chats/mark-read")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def mark_chat_read(_payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        store = store_getter()
        store.mark_chat_read(user_id=user_id, chat_id=chat_id)
        chat = store.get_chat(user_id=user_id, chat_id=chat_id)
        return {"ok": True, "chat": serialize_chat_fn(chat)}, 200

    @api_bp.post("/chats/pin")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def pin_chat(_payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        chat = store_getter().set_chat_pinned(user_id=user_id, chat_id=chat_id, is_pinned=True)
        return {
            "ok": True,
            "chat": serialize_chat_fn(chat),
            "pinned_chats": _serialize_pinned_chats(user_id=user_id),
        }, 200

    @api_bp.post("/chats/unpin")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def unpin_chat(_payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        chat = store_getter().set_chat_pinned(user_id=user_id, chat_id=chat_id, is_pinned=False)
        return {
            "ok": True,
            "chat": serialize_chat_fn(chat),
            "pinned_chats": _serialize_pinned_chats(user_id=user_id),
        }, 200

    @api_bp.post("/chats/reopen")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def reopen_chat(_payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        store = store_getter()
        chat_record = store.reopen_chat(user_id=user_id, chat_id=chat_id)
        store.mark_chat_read(user_id=user_id, chat_id=chat_id)
        store.set_active_chat(user_id=user_id, chat_id=chat_id)
        history = _chat_history(user_id=user_id, chat_id=chat_id, limit=120)
        chats = _serialize_chats(user_id=user_id)
        pinned_chats = _serialize_pinned_chats(user_id=user_id)

        return {
            "ok": True,
            "chat": serialize_chat_fn(chat_record),
            "active_chat_id": chat_id,
            "history": history,
            "chats": chats,
            "pinned_chats": pinned_chats,
        }, 200

    @api_bp.post("/chats/fork")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def fork_chat(payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        raw_title = payload.get("title")
        requested_title: str | None = None
        if raw_title is not None:
            if not isinstance(raw_title, str):
                return json_error_fn("Invalid title. Expected string.", 400)
            cleaned = raw_title.strip()
            if cleaned:
                try:
                    requested_title = validated_title_fn(cleaned, cleaned)
                except ValueError as exc:
                    return json_error_fn(str(exc), 400)

        store = store_getter()
        forked_chat = store.fork_chat(user_id=user_id, source_chat_id=chat_id, title=requested_title)
        store.set_active_chat(user_id=user_id, chat_id=forked_chat.id)
        store.mark_chat_read(user_id=user_id, chat_id=forked_chat.id)

        history = _chat_history(user_id=user_id, chat_id=forked_chat.id, limit=120)
        chats = _serialize_chats(user_id=user_id)
        pinned_chats = _serialize_pinned_chats(user_id=user_id)

        return {
            "ok": True,
            "chat": serialize_chat_fn(forked_chat),
            "active_chat_id": forked_chat.id,
            "forked_from_chat_id": chat_id,
            "history": history,
            "chats": chats,
            "pinned_chats": pinned_chats,
        }, 201

    @api_bp.post("/chats/clear")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def clear_chat(_payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        store = store_getter()
        store.clear_chat(user_id=user_id, chat_id=chat_id)
        chat_record = store.get_chat(user_id=user_id, chat_id=chat_id)
        _evict_chat_runtime(user_id=user_id, chat_id=chat_id)
        return {"ok": True, "chat": serialize_chat_fn(chat_record), "history": []}, 200

    @api_bp.post("/chats/remove")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def remove_chat(_payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        store = store_getter()
        _evict_chat_runtime(user_id=user_id, chat_id=chat_id)
        next_chat_id = store.remove_chat(user_id=user_id, chat_id=chat_id)
        history = _chat_history(user_id=user_id, chat_id=next_chat_id, limit=120)
        store.mark_chat_read(user_id=user_id, chat_id=next_chat_id)
        store.set_active_chat(user_id=user_id, chat_id=next_chat_id)
        active_chat = store.get_chat(user_id=user_id, chat_id=next_chat_id)
        chats = _serialize_chats(user_id=user_id)
        pinned_chats = _serialize_pinned_chats(user_id=user_id)

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
    @guard_json_payload_user_route(
        request_payload_fn=request_payload_fn,
        user_id_from_payload_or_error_fn=_require_json_user_id,
    )
    def chats_status(_payload: dict[str, object], user_id: str) -> tuple[dict[str, object], int]:
        runtime_getter().ensure_pending_jobs(user_id)
        chats = _serialize_chats(user_id=user_id)
        pinned_chats = _serialize_pinned_chats(user_id=user_id)
        return {"ok": True, "chats": chats, "pinned_chats": pinned_chats}, 200
