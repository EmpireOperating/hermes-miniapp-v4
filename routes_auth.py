from __future__ import annotations

import hmac
from typing import Any, Callable

from flask import Response, g, jsonify, request

from routes_auth_service import AuthBootstrapService


def register_auth_routes(
    api_bp,
    *,
    store_getter: Callable[[], Any],
    runtime_getter: Callable[[], Any],
    request_payload_fn: Callable[[], dict[str, object]],
    verify_for_json_fn: Callable[[dict[str, object]], tuple[Any | None, tuple[dict[str, object], int] | None]],
    serialize_chat_fn: Callable[[Any], dict[str, object]],
    session_id_builder_fn: Callable[[str, int], str],
    cookie_secure_fn: Callable[[], bool],
    create_auth_session_token_fn: Callable[..., str],
    allowed_skins: set[str],
    skin_cookie_name: str,
    auth_cookie_name: str,
    auth_session_max_age_seconds: int,
    build_job_log_fn: Callable[..., str],
    logger,
    presence_tracker=None,
    presence_lease_ttl_seconds: int = 45,
    dev_auth_enabled_fn: Callable[[], bool] = lambda: False,
    dev_auth_secret: str = "",
) -> None:
    auth_service = AuthBootstrapService(
        store_getter=store_getter,
        runtime_getter=runtime_getter,
        serialize_chat_fn=serialize_chat_fn,
        session_id_builder_fn=session_id_builder_fn,
    )

    def _set_skin_cookie(response: Response, skin: str) -> None:
        response.set_cookie(
            skin_cookie_name,
            skin,
            max_age=60 * 60 * 24 * 365,
            samesite="Lax",
            secure=cookie_secure_fn(),
        )

    def _set_auth_cookie(response: Response, *, user_id: str, display_name: str, username: str | None) -> None:
        response.set_cookie(
            auth_cookie_name,
            create_auth_session_token_fn(user_id, display_name=display_name, username=username),
            max_age=max(60, auth_session_max_age_seconds),
            httponly=True,
            samesite="Lax",
            secure=cookie_secure_fn(),
        )

    def build_auth_success_response(
        verified_user,
        *,
        auth_mode: str,
        allow_empty: bool = False,
        preferred_chat_id: int | None = None,
    ) -> Response:
        state = auth_service.auth_success_state(
            verified_user,
            auth_mode=auth_mode,
            allow_empty=allow_empty,
            preferred_chat_id=preferred_chat_id,
        )
        payload = dict(state["payload"])
        response = jsonify(payload)
        _set_skin_cookie(response, str(payload.get("skin") or "terminal"))
        _set_auth_cookie(
            response,
            user_id=str(verified_user.id),
            display_name=str(state["display_name"]),
            username=verified_user.username,
        )
        return response

    @api_bp.post("/auth")
    def auth() -> Response | tuple[dict[str, object], int]:
        payload = request_payload_fn()
        allow_empty, allow_empty_error = auth_service.parse_allow_empty_flag(payload)
        if allow_empty_error:
            return allow_empty_error
        preferred_chat_id, preferred_chat_error = auth_service.parse_preferred_chat_id(payload)
        if preferred_chat_error:
            return preferred_chat_error
        verified, auth_error = verify_for_json_fn(payload)
        if auth_error:
            return auth_error
        return build_auth_success_response(
            verified.user,
            auth_mode="telegram",
            allow_empty=bool(allow_empty),
            preferred_chat_id=preferred_chat_id,
        )

    @api_bp.post("/dev/auth")
    def dev_auth() -> Response | tuple[dict[str, object], int]:
        if not dev_auth_enabled_fn() or not dev_auth_secret:
            return {"ok": False, "error": "Not found."}, 404

        payload = request_payload_fn()
        allow_empty, allow_empty_error = auth_service.parse_allow_empty_flag(payload)
        if allow_empty_error:
            return allow_empty_error
        preferred_chat_id, preferred_chat_error = auth_service.parse_preferred_chat_id(payload)
        if preferred_chat_error:
            return preferred_chat_error
        provided_secret = str(request.headers.get("X-Dev-Auth") or payload.get("secret") or "").strip()
        if not hmac.compare_digest(provided_secret, dev_auth_secret):
            return {"ok": False, "error": "Invalid dev auth secret."}, 401

        verified, dev_user_error = auth_service.build_dev_verified_user(payload)
        if dev_user_error:
            return dev_user_error

        logger.info(
            build_job_log_fn(
                event="dev_auth_login",
                request_id=str(getattr(g, "request_id", "")) or None,
                chat_id=0,
                extra={"user_id": str(verified.user.id), "username": verified.user.username},
            )
        )
        return build_auth_success_response(
            verified.user,
            auth_mode="dev",
            allow_empty=bool(allow_empty),
            preferred_chat_id=preferred_chat_id,
        )

    @api_bp.post("/auth/logout-all")
    def logout_all_sessions() -> Response | tuple[dict[str, object], int]:
        store = store_getter()
        payload = request_payload_fn()
        verified, auth_error = verify_for_json_fn(payload)
        if auth_error:
            return auth_error

        user_id = str(verified.user.id)
        revoked_count = store.revoke_all_auth_sessions(user_id)
        response = jsonify({"ok": True, "revoked": revoked_count})
        response.set_cookie(
            auth_cookie_name,
            "",
            max_age=0,
            httponly=True,
            samesite="Lax",
            secure=cookie_secure_fn(),
        )
        logger.info(
            build_job_log_fn(
                event="auth_logout_all",
                request_id=str(getattr(g, "request_id", "")) or None,
                chat_id=0,
                extra={"user_id": user_id, "revoked": revoked_count},
            )
        )
        return response

    @api_bp.post("/preferences/skin")
    def set_skin() -> Response | tuple[dict[str, object], int]:
        store = store_getter()
        payload = request_payload_fn()
        skin = str(payload.get("skin", "")).strip().lower()
        if skin not in allowed_skins:
            return {"ok": False, "error": f"Unsupported skin: {skin or 'unknown'}"}, 400

        verified, auth_error = verify_for_json_fn(payload)
        if auth_error:
            return auth_error

        store.set_skin(user_id=str(verified.user.id), skin=skin)
        response = jsonify({"ok": True, "skin": skin})
        _set_skin_cookie(response, skin)
        return response

    @api_bp.post("/preferences/telegram-unread-notifications")
    def set_telegram_unread_notifications() -> Response | tuple[dict[str, object], int]:
        store = store_getter()
        payload = request_payload_fn()
        enabled = payload.get("enabled")
        if not isinstance(enabled, bool):
            return {"ok": False, "error": "Invalid enabled flag. Expected boolean."}, 400

        verified, auth_error = verify_for_json_fn(payload)
        if auth_error:
            return auth_error

        store.set_telegram_unread_notifications_enabled(user_id=str(verified.user.id), enabled=enabled)
        return jsonify({"ok": True, "telegram_unread_notifications_enabled": enabled})

    @api_bp.post("/presence/state")
    def set_presence_state() -> Response | tuple[dict[str, object], int]:
        payload = request_payload_fn()
        visible = payload.get("visible")
        if not isinstance(visible, bool):
            return {"ok": False, "error": "Invalid visible flag. Expected boolean."}, 400
        instance_id = str(payload.get("instance_id") or "").strip() or None

        verified, auth_error = verify_for_json_fn(payload)
        if auth_error:
            return auth_error

        user_id = str(verified.user.id)
        if presence_tracker is None:
            return jsonify({"ok": True, "visible": visible, "chat_id": None, "instance_id": instance_id})

        if not visible:
            presence_tracker.mark_hidden(user_id=user_id, instance_id=instance_id)
            return jsonify({"ok": True, "visible": False, "chat_id": None, "instance_id": instance_id})

        chat_id_raw = payload.get("chat_id")
        try:
            chat_id = int(chat_id_raw)
        except (TypeError, ValueError):
            return {"ok": False, "error": "Invalid chat_id. Expected integer."}, 400
        if chat_id <= 0:
            return {"ok": False, "error": "Invalid chat_id. Expected positive integer."}, 400

        presence_tracker.mark_visible(
            user_id=user_id,
            chat_id=chat_id,
            instance_id=instance_id,
            ttl_seconds=presence_lease_ttl_seconds,
        )
        return jsonify({"ok": True, "visible": True, "chat_id": chat_id, "instance_id": instance_id})
