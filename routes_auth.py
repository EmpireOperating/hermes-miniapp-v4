from __future__ import annotations

import hmac
import time
from dataclasses import asdict
from types import SimpleNamespace
from typing import Any, Callable

from flask import Response, g, jsonify, request

from file_refs import extract_file_refs


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
    dev_auth_enabled_fn: Callable[[], bool] = lambda: False,
    dev_auth_secret: str = "",
) -> None:
    def _serialize_turn(turn) -> dict[str, object]:
        payload = asdict(turn)
        refs = extract_file_refs(payload.get("body") or "", message_id=int(payload.get("id") or 0))
        if refs:
            payload["file_refs"] = refs
        return payload

    def _parse_allow_empty_flag(payload: dict[str, object]) -> tuple[bool | None, tuple[dict[str, object], int] | None]:
        raw_allow_empty = payload.get("allow_empty", False)
        if isinstance(raw_allow_empty, bool):
            return raw_allow_empty, None
        if raw_allow_empty is None:
            return False, None
        return None, ({"ok": False, "error": "Invalid allow_empty flag. Expected boolean."}, 400)

    def _augment_history_with_runtime_pending(*, user_id: str, chat_id: int, history: list[dict[str, object]]) -> list[dict[str, object]]:
        store = store_getter()
        try:
            chat = store.get_chat(user_id=user_id, chat_id=chat_id)
        except KeyError:
            return history
        if not bool(getattr(chat, 'pending', False)):
            return history
        checkpoint_state = store.get_runtime_checkpoint_state(session_id_builder_fn(user_id, chat_id))
        if not checkpoint_state:
            return history
        next_history = list(history)
        checkpoint_updated_at = str(checkpoint_state.get('updated_at') or '')
        pending_tool_lines = [str(line).strip() for line in (checkpoint_state.get('pending_tool_lines') or []) if str(line).strip()]
        pending_assistant = str(checkpoint_state.get('pending_assistant') or '').strip()
        if pending_tool_lines and not any(item.get('pending') and str(item.get('role') or '').lower() == 'tool' for item in next_history):
            next_history.append({
                'id': 0,
                'chat_id': int(chat_id),
                'role': 'tool',
                'body': '\n'.join(pending_tool_lines),
                'created_at': checkpoint_updated_at,
                'pending': True,
            })
        if pending_assistant and not any(item.get('pending') and str(item.get('role') or '').lower() in {'assistant', 'hermes'} for item in next_history):
            next_history.append({
                'id': 0,
                'chat_id': int(chat_id),
                'role': 'assistant',
                'body': pending_assistant,
                'created_at': checkpoint_updated_at,
                'pending': True,
            })
        return next_history

    def build_auth_success_response(verified_user, *, auth_mode: str, allow_empty: bool = False) -> Response:
        store = store_getter()
        runtime = runtime_getter()
        user_id = str(verified_user.id)
        store.prune_expired_auth_sessions(int(time.time()))
        runtime.ensure_pending_jobs(user_id)
        display_name = verified_user.first_name or verified_user.username or "Operator"

        chats = [serialize_chat_fn(chat) for chat in store.list_chats(user_id=user_id)]
        visible_chat_ids = {int(chat["id"]) for chat in chats}

        active_chat_id = store.get_active_chat(user_id)
        if active_chat_id and int(active_chat_id) not in visible_chat_ids:
            active_chat_id = None

        explicit_empty_chat_state = store.has_explicit_empty_chat_state(user_id)
        if not active_chat_id and not allow_empty and not explicit_empty_chat_state:
            active_chat_id = store.ensure_default_chat(user_id)
            chats = [serialize_chat_fn(chat) for chat in store.list_chats(user_id=user_id)]
            visible_chat_ids = {int(chat["id"]) for chat in chats}

        if active_chat_id and int(active_chat_id) in visible_chat_ids:
            history = [_serialize_turn(turn) for turn in store.get_history(user_id=user_id, chat_id=active_chat_id, limit=120)]
            history = _augment_history_with_runtime_pending(user_id=user_id, chat_id=int(active_chat_id), history=history)
            store.mark_chat_read(user_id=user_id, chat_id=active_chat_id)
            store.set_active_chat(user_id=user_id, chat_id=active_chat_id)
        else:
            active_chat_id = None
            history = []
            store.clear_active_chat(user_id=user_id)

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
            create_auth_session_token_fn(user_id, display_name=display_name, username=verified_user.username),
            max_age=max(60, auth_session_max_age_seconds),
            httponly=True,
            samesite="Lax",
            secure=cookie_secure_fn(),
        )
        return response

    @api_bp.post("/auth")
    def auth() -> Response | tuple[dict[str, object], int]:
        payload = request_payload_fn()
        allow_empty, allow_empty_error = _parse_allow_empty_flag(payload)
        if allow_empty_error:
            return allow_empty_error
        verified, auth_error = verify_for_json_fn(payload)
        if auth_error:
            return auth_error
        return build_auth_success_response(verified.user, auth_mode="telegram", allow_empty=bool(allow_empty))

    @api_bp.post("/dev/auth")
    def dev_auth() -> Response | tuple[dict[str, object], int]:
        if not dev_auth_enabled_fn() or not dev_auth_secret:
            return {"ok": False, "error": "Not found."}, 404

        payload = request_payload_fn()
        allow_empty, allow_empty_error = _parse_allow_empty_flag(payload)
        if allow_empty_error:
            return allow_empty_error
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
        return build_auth_success_response(verified.user, auth_mode="dev", allow_empty=bool(allow_empty))

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
