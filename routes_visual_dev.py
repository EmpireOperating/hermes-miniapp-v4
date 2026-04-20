from __future__ import annotations

from typing import Any, Callable

from flask import request

from routes_visual_dev_service import build_visual_dev_service


def register_visual_dev_routes(
    api_bp,
    *,
    store_getter: Callable[[], Any],
    visual_dev_runtime_getter: Callable[[], Any],
    request_payload_fn: Callable[[], dict[str, object]],
    json_user_id_or_error_fn: Callable[[dict[str, object]], tuple[str | None, tuple[dict[str, object], int] | None]],
    chat_id_from_payload_or_error_fn: Callable[[dict[str, object], str], tuple[int | None, tuple[dict[str, object], int] | None]],
    json_error_fn: Callable[[str, int], tuple[dict[str, object], int]],
    visual_dev_enabled: bool,
    visual_dev_operator_only: bool,
    allowed_preview_origins: set[str],
    allowed_bridge_parents: set[str],
    artifact_dir,
    max_console_events: int,
    screenshot_max_bytes: int,
    operator_token: str = "",
) -> None:
    service = build_visual_dev_service(
        store_getter=store_getter,
        runtime_getter=visual_dev_runtime_getter,
        allowed_preview_origins=allowed_preview_origins,
        allowed_bridge_parents=allowed_bridge_parents,
        artifact_dir=artifact_dir,
        max_console_events=max_console_events,
        screenshot_max_bytes=screenshot_max_bytes,
    )

    def _payload() -> dict[str, object]:
        payload = request_payload_fn()
        if request.method == "GET":
            merged = dict(payload or {})
            merged.update({key: value for key, value in request.args.items()})
            return merged
        return dict(payload or {})

    def _guard_enabled(payload: dict[str, object] | None = None) -> tuple[dict[str, object], int] | None:
        if not visual_dev_enabled:
            return {"ok": False, "error": "Not found."}, 404
        if not visual_dev_operator_only:
            return None
        token = str(operator_token or "").strip()
        presented = str(request.headers.get("X-Hermes-Operator-Token") or "").strip()
        if token and presented == token:
            return None
        request_payload = payload if isinstance(payload, dict) else {}
        user_id, auth_error = _user_id_or_error(request_payload)
        if user_id and not auth_error:
            return None
        return {"ok": False, "error": "Not found."}, 404

    def _user_id_or_error(payload: dict[str, object]) -> tuple[str | None, tuple[dict[str, object], int] | None]:
        return json_user_id_or_error_fn(payload)

    def _chat_id_or_error(
        payload: dict[str, object],
        *,
        user_id: str,
    ) -> tuple[int | None, tuple[dict[str, object], int] | None]:
        return chat_id_from_payload_or_error_fn(payload, user_id)

    @api_bp.get("/visual-dev/state")
    def visual_dev_state() -> tuple[dict[str, object], int]:
        payload = _payload()
        guarded = _guard_enabled(payload)
        if guarded:
            return guarded
        user_id, auth_error = _user_id_or_error(payload)
        if auth_error:
            return auth_error
        return service.state_payload(user_id=user_id), 200

    @api_bp.post("/visual-dev/session/attach")
    def visual_dev_attach() -> tuple[dict[str, object], int]:
        payload = _payload()
        guarded = _guard_enabled(payload)
        if guarded:
            return guarded
        user_id, auth_error = _user_id_or_error(payload)
        if auth_error:
            return auth_error
        chat_id, chat_error = _chat_id_or_error(payload, user_id=user_id)
        if chat_error:
            return chat_error
        try:
            session = service.attach_session(
                user_id=user_id,
                chat_id=int(chat_id),
                session_id=str(payload.get("session_id") or ""),
                preview_url=str(payload.get("preview_url") or ""),
                preview_title=str(payload.get("preview_title") or ""),
                bridge_parent_origin=str(payload.get("bridge_parent_origin") or ""),
                metadata=payload.get("metadata") if isinstance(payload.get("metadata"), dict) else None,
            )
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        return {"ok": True, "session": session}, 200

    @api_bp.post("/visual-dev/session/detach")
    def visual_dev_detach() -> tuple[dict[str, object], int]:
        payload = _payload()
        guarded = _guard_enabled(payload)
        if guarded:
            return guarded
        user_id, auth_error = _user_id_or_error(payload)
        if auth_error:
            return auth_error
        try:
            service.detach_session(user_id=user_id, session_id=str(payload.get("session_id") or ""))
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        return {"ok": True, "session_id": str(payload.get("session_id") or "").strip()}, 200

    @api_bp.get("/visual-dev/session/<int:chat_id>")
    def visual_dev_session(chat_id: int) -> tuple[dict[str, object], int]:
        payload = _payload()
        guarded = _guard_enabled(payload)
        if guarded:
            return guarded
        user_id, auth_error = _user_id_or_error(payload)
        if auth_error:
            return auth_error
        try:
            return service.get_session_details(user_id=user_id, chat_id=chat_id), 200
        except KeyError as exc:
            return json_error_fn(str(exc), 404)

    @api_bp.post("/visual-dev/session/select")
    def visual_dev_select() -> tuple[dict[str, object], int]:
        payload = _payload()
        guarded = _guard_enabled(payload)
        if guarded:
            return guarded
        user_id, auth_error = _user_id_or_error(payload)
        if auth_error:
            return auth_error
        try:
            selection = service.record_selection(
                user_id=user_id,
                session_id=str(payload.get("session_id") or ""),
                selection_type=str(payload.get("selection_type") or ""),
                payload=payload.get("payload") if isinstance(payload.get("payload"), dict) else None,
            )
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        return {"ok": True, "selection": selection}, 200

    @api_bp.post("/visual-dev/session/console")
    def visual_dev_console() -> tuple[dict[str, object], int]:
        payload = _payload()
        guarded = _guard_enabled(payload)
        if guarded:
            return guarded
        user_id, auth_error = _user_id_or_error(payload)
        if auth_error:
            return auth_error
        try:
            runtime_state = service.record_console_event(
                user_id=user_id,
                session_id=str(payload.get("session_id") or ""),
                event_type=str(payload.get("event_type") or "console"),
                level=str(payload.get("level") or "info"),
                message=str(payload.get("message") or ""),
                metadata=payload.get("metadata") if isinstance(payload.get("metadata"), dict) else None,
            )
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        return {
            "ok": True,
            "accepted": bool(runtime_state.get("accepted", True)),
            "runtime": runtime_state,
        }, 200

    @api_bp.post("/visual-dev/session/screenshot")
    def visual_dev_screenshot() -> tuple[dict[str, object], int]:
        payload = _payload()
        guarded = _guard_enabled(payload)
        if guarded:
            return guarded
        user_id, auth_error = _user_id_or_error(payload)
        if auth_error:
            return auth_error
        try:
            artifact = service.record_screenshot(
                user_id=user_id,
                session_id=str(payload.get("session_id") or ""),
                content_type=str(payload.get("content_type") or ""),
                bytes_b64=str(payload.get("bytes_b64") or ""),
                metadata=payload.get("metadata") if isinstance(payload.get("metadata"), dict) else None,
            )
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        return {"ok": True, "artifact": artifact}, 201

    @api_bp.post("/visual-dev/session/command")
    def visual_dev_command() -> tuple[dict[str, object], int]:
        payload = _payload()
        guarded = _guard_enabled(payload)
        if guarded:
            return guarded
        user_id, auth_error = _user_id_or_error(payload)
        if auth_error:
            return auth_error
        try:
            runtime_state = service.record_runtime_command(
                user_id=user_id,
                session_id=str(payload.get("session_id") or ""),
                command=str(payload.get("command") or ""),
                payload=payload.get("payload") if isinstance(payload.get("payload"), dict) else None,
            )
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        return {"ok": True, "runtime": runtime_state}, 200
