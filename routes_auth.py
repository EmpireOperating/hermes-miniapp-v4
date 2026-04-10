from __future__ import annotations

import hmac
import time
from dataclasses import asdict
from types import SimpleNamespace
from typing import Any, Callable

from flask import Response, g, jsonify, request

from file_refs import extract_file_refs


_AUTH_PRUNE_INTERVAL_SECONDS = 300
_last_pruned_auth_sessions_at = 0


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

    def _maybe_prune_expired_auth_sessions(store, *, now_ts: int) -> None:
        global _last_pruned_auth_sessions_at
        if now_ts - _last_pruned_auth_sessions_at < _AUTH_PRUNE_INTERVAL_SECONDS:
            return
        store.prune_expired_auth_sessions(now_ts)
        _last_pruned_auth_sessions_at = now_ts

    def _augment_history_with_runtime_pending(
        *,
        user_id: str,
        chat_id: int,
        history: list[dict[str, object]],
        chat_pending: bool = False,
    ) -> list[dict[str, object]]:
        if not bool(chat_pending):
            return history
        store = store_getter()
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
        now_ts = int(time.time())
        _maybe_prune_expired_auth_sessions(store, now_ts=now_ts)
        display_name = verified_user.first_name or verified_user.username or "Operator"

        chats = [serialize_chat_fn(chat) for chat in store.list_chats(user_id=user_id)]
        visible_chat_ids = {int(chat["id"]) for chat in chats}
        pending_visible_chat = any(bool(chat.get("pending")) for chat in chats)
        if pending_visible_chat:
            runtime.ensure_pending_jobs(user_id)

        active_chat_id = store.get_active_chat(user_id)
        if active_chat_id and int(active_chat_id) not in visible_chat_ids:
            active_chat_id = None

        if not active_chat_id and not allow_empty:
            if chats:
                active_chat_id = int(chats[0]["id"])
            else:
                explicit_empty_chat_state = store.has_explicit_empty_chat_state(user_id)
                if not explicit_empty_chat_state:
                    active_chat_id = store.ensure_default_chat(user_id)
                    try:
                        ensured_chat = serialize_chat_fn(store.get_chat(user_id=user_id, chat_id=int(active_chat_id)))
                    except KeyError:
                        ensured_chat = None
                    if ensured_chat:
                        chats.append(ensured_chat)
                        visible_chat_ids.add(int(ensured_chat["id"]))

        if active_chat_id and int(active_chat_id) in visible_chat_ids:
            serialized_active_chat = next((chat for chat in chats if int(chat["id"]) == int(active_chat_id)), None)
            history = [_serialize_turn(turn) for turn in store.get_history(user_id=user_id, chat_id=active_chat_id, limit=120)]
            history = _augment_history_with_runtime_pending(
                user_id=user_id,
                chat_id=int(active_chat_id),
                history=history,
                chat_pending=bool(serialized_active_chat and serialized_active_chat.get("pending")),
            )
            if serialized_active_chat and int(serialized_active_chat.get("unread_count") or 0) > 0:
                latest_history_message_id = max((int(item.get("id") or 0) for item in history), default=0)
                if latest_history_message_id > 0 and hasattr(store, "mark_chat_read_through"):
                    store.mark_chat_read_through(user_id=user_id, chat_id=active_chat_id, message_id=latest_history_message_id)
                else:
                    store.mark_chat_read(user_id=user_id, chat_id=active_chat_id)
                serialized_active_chat["unread_count"] = 0
            if store.get_active_chat(user_id) != int(active_chat_id):
                store.set_active_chat(user_id=user_id, chat_id=active_chat_id)
        else:
            active_chat_id = None
            history = []
            if store.get_active_chat(user_id) is not None:
                store.clear_active_chat(user_id=user_id)

        pinned_chats = [chat for chat in chats if bool(chat.get("is_pinned"))]
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
