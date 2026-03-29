from __future__ import annotations

import hmac
import time
from dataclasses import asdict
from types import SimpleNamespace
from typing import Any, Callable

from flask import Response, g, jsonify, request


def register_auth_routes(
    api_bp,
    *,
    store_getter: Callable[[], Any],
    runtime_getter: Callable[[], Any],
    request_payload_fn: Callable[[], dict[str, object]],
    verify_for_json_fn: Callable[[dict[str, object]], tuple[Any | None, tuple[dict[str, object], int] | None]],
    serialize_chat_fn: Callable[[Any], dict[str, object]],
    cookie_secure_fn: Callable[[], bool],
    create_auth_session_token_fn: Callable[[str], str],
    allowed_skins: set[str],
    skin_cookie_name: str,
    auth_cookie_name: str,
    auth_session_max_age_seconds: int,
    build_job_log_fn: Callable[..., str],
    logger,
    dev_auth_enabled: bool = False,
    dev_auth_secret: str = "",
) -> None:
    def build_auth_success_response(verified_user, *, auth_mode: str) -> Response:
        store = store_getter()
        runtime = runtime_getter()
        user_id = str(verified_user.id)
        store.prune_expired_auth_sessions(int(time.time()))
        runtime.ensure_pending_jobs(user_id)
        display_name = verified_user.first_name or verified_user.username or "Operator"
        default_chat_id = store.ensure_default_chat(user_id)
        active_chat_id = store.get_active_chat(user_id) or default_chat_id
        try:
            store.get_chat(user_id=user_id, chat_id=active_chat_id)
        except KeyError:
            active_chat_id = default_chat_id

        history = [asdict(turn) for turn in store.get_history(user_id=user_id, chat_id=active_chat_id, limit=120)]
        store.mark_chat_read(user_id=user_id, chat_id=active_chat_id)
        store.set_active_chat(user_id=user_id, chat_id=active_chat_id)
        chats = [serialize_chat_fn(chat) for chat in store.list_chats(user_id=user_id)]
        pinned_chats = [serialize_chat_fn(chat) for chat in store.list_pinned_chats(user_id=user_id)]
        skin = store.get_skin(user_id=user_id)
        response = jsonify(
            {
                "ok": True,
                "auth_mode": auth_mode,
                "user": {
                    "id": verified_user.id,
                    "display_name": display_name,
                    "username": verified_user.username,
                },
                "skin": skin,
                "active_chat_id": active_chat_id,
                "history": history,
                "chats": chats,
                "pinned_chats": pinned_chats,
                "stats": {"turn_count": store.get_turn_count(user_id)},
            }
        )
        response.set_cookie(
            skin_cookie_name,
            skin,
            max_age=60 * 60 * 24 * 365,
            samesite="Lax",
            secure=cookie_secure_fn(),
        )
        response.set_cookie(
            auth_cookie_name,
            create_auth_session_token_fn(user_id),
            max_age=max(60, auth_session_max_age_seconds),
            httponly=True,
            samesite="Lax",
            secure=cookie_secure_fn(),
        )
        return response

    @api_bp.post("/auth")
    def auth() -> Response | tuple[dict[str, object], int]:
        payload = request_payload_fn()
        verified, auth_error = verify_for_json_fn(payload)
        if auth_error:
            return auth_error
        return build_auth_success_response(verified.user, auth_mode="telegram")

    @api_bp.post("/dev/auth")
    def dev_auth() -> Response | tuple[dict[str, object], int]:
        if not dev_auth_enabled or not dev_auth_secret:
            return {"ok": False, "error": "Not found."}, 404

        payload = request_payload_fn()
        provided_secret = str(request.headers.get("X-Dev-Auth") or payload.get("secret") or "").strip()
        if not hmac.compare_digest(provided_secret, dev_auth_secret):
            return {"ok": False, "error": "Invalid dev auth secret."}, 401

        raw_user_id = payload.get("user_id", 9001)
        try:
            user_id = int(raw_user_id)
        except (TypeError, ValueError):
            return {"ok": False, "error": "Invalid dev user id."}, 400
        if user_id <= 0:
            return {"ok": False, "error": "Invalid dev user id."}, 400

        display_name = str(payload.get("display_name") or "Desktop Tester").strip() or "Desktop Tester"
        username = str(payload.get("username") or "desktop").strip() or None
        verified = SimpleNamespace(
            user=SimpleNamespace(
                id=user_id,
                first_name=display_name,
                username=username,
            )
        )
        logger.info(
            build_job_log_fn(
                event="dev_auth_login",
                request_id=str(getattr(g, "request_id", "")) or None,
                chat_id=0,
                extra={"user_id": str(user_id), "username": username},
            )
        )
        return build_auth_success_response(verified.user, auth_mode="dev")

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
        response.set_cookie(
            skin_cookie_name,
            skin,
            max_age=60 * 60 * 24 * 365,
            samesite="Lax",
            secure=cookie_secure_fn(),
        )
        return response
