from __future__ import annotations

from flask import request, send_file

from miniapp_attachments import normalize_attachment_record, save_upload
from routes_chat_context import ChatRouteContext
from routes_chat_management_service import build_chat_management_service
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
    request_payload_fn = context.request_payload_fn
    json_user_id_or_error_fn = context.json_user_id_or_error_fn
    chat_id_from_payload_or_error_fn = context.chat_id_from_payload_or_error_fn
    validated_title_fn = context.validated_title_fn
    json_error_fn = context.json_error_fn

    service = build_chat_management_service(
        store_getter=context.store_getter,
        client_getter=context.client_getter,
        runtime_getter=context.runtime_getter,
        serialize_chat_fn=context.serialize_chat_fn,
        session_id_builder_fn=context.session_id_builder_fn,
        json_error_fn=json_error_fn,
    )

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

    def _parse_allow_empty_flag(payload: dict[str, object]) -> tuple[bool | None, tuple[dict[str, object], int] | None]:
        raw_allow_empty = payload.get("allow_empty", False)
        if isinstance(raw_allow_empty, bool):
            return raw_allow_empty, None
        if raw_allow_empty is None:
            return False, None
        return None, json_error_fn("Invalid allow_empty flag. Expected boolean.", 400)

    def _parse_preferred_chat_id(payload: dict[str, object]) -> tuple[int | None, tuple[dict[str, object], int] | None]:
        if "preferred_chat_id" not in payload or payload.get("preferred_chat_id") in (None, ""):
            return None, None
        try:
            preferred_chat_id = int(payload.get("preferred_chat_id"))
        except (TypeError, ValueError):
            return None, json_error_fn("Invalid preferred_chat_id. Expected positive integer.", 400)
        if preferred_chat_id <= 0:
            return None, json_error_fn("Invalid preferred_chat_id. Expected positive integer.", 400)
        return preferred_chat_id, None

    def _parse_bool_flag(
        payload: dict[str, object],
        key: str,
        *,
        default: bool = False,
        error_message: str,
    ) -> tuple[bool | None, tuple[dict[str, object], int] | None]:
        raw_value = payload.get(key, default)
        if isinstance(raw_value, bool):
            return raw_value, None
        if raw_value is None:
            return default, None
        return None, json_error_fn(error_message, 400)

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
        return service.create_chat_response(user_id=user_id, title=title)

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
        return service.rename_chat_response(user_id=user_id, chat_id=chat_id, title=title)

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
        return service.chat_history_payload(user_id=user_id, chat_id=chat_id, activate=True), 200

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
        return service.chat_history_payload(user_id=user_id, chat_id=chat_id, activate=bool(activate)), 200

    @api_bp.post("/chats/file-preview")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def chat_file_preview(payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        ref_id = str(payload.get("ref_id") or "").strip()
        path_text = str(payload.get("path") or "").strip()
        try:
            line_start = int(payload.get("line_start") or 0)
            line_end = int(payload.get("line_end") or 0)
            window_start = int(payload.get("window_start") or 0)
            window_end = int(payload.get("window_end") or 0)
        except (TypeError, ValueError):
            return json_error_fn("Invalid file preview range values.", 400)

        full_file, full_file_error = _parse_bool_flag(
            payload,
            "full_file",
            default=False,
            error_message="Invalid full_file flag. Expected boolean.",
        )
        if full_file_error:
            return full_file_error

        return service.file_preview_response(
            user_id=user_id,
            chat_id=chat_id,
            ref_id=ref_id,
            path_text=path_text,
            line_start=line_start,
            line_end=line_end,
            window_start=window_start,
            window_end=window_end,
            full_file=bool(full_file),
        )

    @api_bp.post("/chats/upload")
    def upload_chat_attachment() -> tuple[dict[str, object], int]:
        form_payload = {key: request.form.get(key) for key in request.form.keys()}
        user_id, auth_error = _require_json_user_id(form_payload)
        if auth_error:
            return auth_error
        chat_id, chat_error = chat_id_from_payload_or_error_fn(form_payload, user_id=user_id)
        if chat_error:
            return chat_error
        try:
            record = save_upload(
                file_storage=request.files.get("file"),
                user_id=user_id,
                chat_id=int(chat_id),
            )
            created = context.store_getter().create_attachment(user_id=user_id, chat_id=int(chat_id), record=record)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        except KeyError as exc:
            return _json_not_found(exc)
        attachment = normalize_attachment_record(created)
        assert attachment is not None
        return {"ok": True, "attachment": attachment}, 201

    @api_bp.get("/chats/attachments/<attachment_id>/content")
    def download_chat_attachment(attachment_id: str):
        auth_payload = dict(request.args)
        user_id, auth_error = _require_json_user_id(auth_payload)
        if auth_error:
            return auth_error
        try:
            attachment = context.store_getter().get_attachment(user_id=user_id, attachment_id=attachment_id)
        except KeyError as exc:
            return _json_not_found(exc)
        except FileNotFoundError:
            return json_error_fn("Attachment content not found.", 404)
        return send_file(
            str(attachment["storage_path"]),
            mimetype=str(attachment.get("content_type") or "application/octet-stream"),
            as_attachment=False,
            download_name=str(attachment.get("filename") or "attachment"),
            conditional=True,
        )

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
        return service.mark_chat_read_response(user_id=user_id, chat_id=chat_id)

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
        return service.set_chat_pinned_response(user_id=user_id, chat_id=chat_id, is_pinned=True)

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
        return service.set_chat_pinned_response(user_id=user_id, chat_id=chat_id, is_pinned=False)

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
        return service.reopen_chat_response(user_id=user_id, chat_id=chat_id)

    @api_bp.post("/chats/branch")
    @api_bp.post("/chats/fork")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def branch_chat(payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
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
        return service.branch_chat_response(user_id=user_id, chat_id=chat_id, requested_title=requested_title)

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
        return service.clear_chat_response(user_id=user_id, chat_id=chat_id)

    @api_bp.post("/chats/remove")
    @guard_json_payload_user_chat_route(
        request_payload_fn=request_payload_fn,
        user_and_chat_id_from_payload_or_error_fn=_require_json_user_and_chat_id,
    )
    @guard_key_error_as_route_error(
        not_found_error_fn=_json_not_found,
        should_map_fn=_is_chat_not_found_key_error,
    )
    def remove_chat(payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        allow_empty, allow_empty_error = _parse_allow_empty_flag(payload)
        if allow_empty_error:
            return allow_empty_error
        preferred_chat_id, preferred_chat_id_error = _parse_preferred_chat_id(payload)
        if preferred_chat_id_error:
            return preferred_chat_id_error
        include_full_state, include_full_state_error = _parse_bool_flag(
            payload,
            "include_full_state",
            default=True,
            error_message="Invalid include_full_state flag. Expected boolean.",
        )
        if include_full_state_error:
            return include_full_state_error
        return service.remove_chat_response(
            user_id=user_id,
            chat_id=chat_id,
            allow_empty=bool(allow_empty),
            include_full_state=bool(include_full_state),
            preferred_chat_id=preferred_chat_id,
        )

    @api_bp.post("/chats/status")
    @guard_json_payload_user_route(
        request_payload_fn=request_payload_fn,
        user_id_from_payload_or_error_fn=_require_json_user_id,
    )
    def chats_status(_payload: dict[str, object], user_id: str) -> tuple[dict[str, object], int]:
        return service.chats_status_response(user_id=user_id)
