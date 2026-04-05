from __future__ import annotations

from dataclasses import asdict
import os
from pathlib import Path
from typing import Any

from file_refs import extract_file_refs
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

    def _serialize_turn(turn) -> dict[str, object]:
        payload = asdict(turn)
        refs = extract_file_refs(payload.get("body") or "", message_id=int(payload.get("id") or 0))
        if refs:
            payload["file_refs"] = refs
        return payload

    def _chat_history(user_id: str, chat_id: int, *, limit: int = 120) -> list[dict[str, object]]:
        return [_serialize_turn(turn) for turn in store_getter().get_history(user_id=user_id, chat_id=chat_id, limit=limit)]

    def _serialize_chats(user_id: str) -> list[dict[str, object]]:
        return [serialize_chat_fn(chat) for chat in store_getter().list_chats(user_id=user_id)]

    def _serialize_pinned_chats(user_id: str) -> list[dict[str, object]]:
        return [serialize_chat_fn(chat) for chat in store_getter().list_pinned_chats(user_id=user_id)]

    def _evict_chat_runtime(user_id: str, chat_id: int, *, reason: str = "chat_runtime_eviction") -> None:
        session_id = session_id_builder_fn(user_id, chat_id)
        client_getter().evict_session(session_id, reason=reason)
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
        history = [_serialize_turn(turn) for turn in store.get_history(user_id=user_id, chat_id=chat_id, limit=120)]
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

    def _parse_allow_empty_flag(payload: dict[str, object]) -> tuple[bool | None, tuple[dict[str, object], int] | None]:
        raw_allow_empty = payload.get("allow_empty", False)
        if isinstance(raw_allow_empty, bool):
            return raw_allow_empty, None
        if raw_allow_empty is None:
            return False, None
        return None, json_error_fn("Invalid allow_empty flag. Expected boolean.", 400)

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

    def _file_preview_allowed_roots() -> list[Path]:
        raw = str(os.environ.get("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", "")).strip()
        if not raw:
            return []
        roots: list[Path] = []
        for candidate in raw.split(":"):
            cleaned = candidate.strip()
            if not cleaned:
                continue
            try:
                root = Path(cleaned).expanduser().resolve(strict=False)
            except OSError:
                continue
            roots.append(root)
        return roots

    def _file_preview_enabled(allowed_roots: list[Path]) -> bool:
        raw = os.environ.get("MINI_APP_FILE_PREVIEW_ENABLED")
        if raw is None:
            # Backward-compatible default: keep preview enabled when allowed roots are configured.
            return bool(allowed_roots)
        return str(raw).strip().lower() in {"1", "true", "yes", "on"}

    def _resolve_preview_path(path_text: str, *, allowed_roots: list[Path]) -> Path:
        cleaned = str(path_text or "").strip()
        if not cleaned:
            raise ValueError("Missing file path")

        if cleaned.lower().startswith("file://"):
            cleaned = cleaned[7:]

        try:
            candidate = Path(cleaned).expanduser()
        except OSError as exc:
            raise ValueError("Invalid file path") from exc

        if candidate.is_absolute():
            try:
                return candidate.resolve(strict=False)
            except OSError as exc:
                raise ValueError("Invalid file path") from exc

        for root in allowed_roots:
            try:
                resolved = (root / candidate).resolve(strict=False)
            except OSError:
                continue
            try:
                resolved.relative_to(root)
                return resolved
            except ValueError:
                continue

        raise ValueError("Path must be absolute or relative to an allowed root")

    def _path_under_allowed_roots(target: Path, roots: list[Path]) -> bool:
        for root in roots:
            try:
                target.relative_to(root)
                return True
            except ValueError:
                continue
        return False

    def _build_file_preview(
        path_value: Path,
        *,
        line_start: int,
        line_end: int,
        window_start_override: int = 0,
        window_end_override: int = 0,
        full_file: bool = False,
    ) -> dict[str, object]:
        if not path_value.exists():
            raise FileNotFoundError("File not found")
        if not path_value.is_file():
            raise ValueError("Path is not a regular file")

        max_bytes = 1_000_000
        max_lines = 400
        context = 40
        full_file_max_bytes = 250_000
        full_file_max_lines = 2_000
        file_size = path_value.stat().st_size
        if file_size > max_bytes:
            raise ValueError("File too large for preview")

        raw_bytes = path_value.read_bytes()
        if b"\x00" in raw_bytes:
            raise ValueError("Binary file preview is not supported")

        text = raw_bytes.decode("utf-8", errors="replace")
        all_lines = text.splitlines()
        total_lines = max(len(all_lines), 1)
        can_load_full_file = file_size <= full_file_max_bytes and total_lines <= full_file_max_lines

        focus_start = line_start if line_start > 0 else 1
        focus_end = line_end if line_end >= focus_start else focus_start

        if full_file:
            if not can_load_full_file:
                raise ValueError("File too large to load fully; use excerpt mode")
            window_start = 1
            window_end = total_lines
        else:
            requested_start = window_start_override if window_start_override > 0 else focus_start - context
            requested_end = window_end_override if window_end_override > 0 else focus_end + context
            window_start = max(1, min(focus_start, requested_start))
            window_end = min(total_lines, max(focus_end, requested_end, focus_start))

            if window_end - window_start + 1 > max_lines:
                if window_start <= focus_start <= window_start + max_lines - 1:
                    window_end = min(total_lines, window_start + max_lines - 1)
                else:
                    window_end = min(total_lines, max(focus_end, requested_end))
                    window_start = max(1, window_end - max_lines + 1)
                    if focus_start < window_start:
                        window_start = max(1, focus_start)
                        window_end = min(total_lines, window_start + max_lines - 1)

        preview_lines = []
        for line_no in range(window_start, window_end + 1):
            text_value = all_lines[line_no - 1] if line_no - 1 < len(all_lines) else ""
            preview_lines.append({"line": line_no, "text": text_value})

        return {
            "path": str(path_value),
            "line_start": focus_start,
            "line_end": focus_end,
            "window_start": window_start,
            "window_end": window_end,
            "total_lines": total_lines,
            "is_truncated": window_start > 1 or window_end < total_lines,
            "can_expand_up": window_start > 1,
            "can_expand_down": window_end < total_lines,
            "can_load_full_file": can_load_full_file and not full_file,
            "full_file_loaded": bool(full_file),
            "lines": preview_lines,
        }

    def _resolve_ref_preview_request(
        *, user_id: str, chat_id: int, ref_id: str
    ) -> tuple[str, int, int]:
        history = store_getter().get_history(user_id=user_id, chat_id=chat_id, limit=400)
        for turn in history:
            refs = extract_file_refs(turn.body, message_id=int(turn.id))
            for ref in refs:
                if str(ref.get("ref_id") or "") != ref_id:
                    continue
                path = str(ref.get("path") or "").strip()
                if not path:
                    break
                line_start = int(ref.get("line_start") or 0)
                line_end = int(ref.get("line_end") or 0)
                return path, line_start, line_end
        raise KeyError("File reference not found")

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
    def chat_file_preview(payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        # Validate chat access first via store lookup.
        store_getter().get_chat(user_id=user_id, chat_id=chat_id)

        allowed_roots = _file_preview_allowed_roots()
        if not _file_preview_enabled(allowed_roots):
            return json_error_fn("File preview feature is disabled", 403)
        if not allowed_roots:
            return json_error_fn("File preview is disabled: no allowed roots configured", 403)

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

        if ref_id:
            try:
                ref_path, ref_line_start, ref_line_end = _resolve_ref_preview_request(
                    user_id=user_id,
                    chat_id=chat_id,
                    ref_id=ref_id,
                )
            except KeyError as exc:
                return json_error_fn(str(exc), 404)
            path_text = ref_path
            if line_start <= 0:
                line_start = ref_line_start
            if line_end <= 0:
                line_end = ref_line_end

        try:
            target_path = _resolve_preview_path(path_text, allowed_roots=allowed_roots)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

        if not _path_under_allowed_roots(target_path, allowed_roots):
            return json_error_fn("File is outside allowed roots.", 403)

        try:
            preview = _build_file_preview(
                target_path,
                line_start=line_start,
                line_end=line_end,
                window_start_override=window_start,
                window_end_override=window_end,
                full_file=bool(full_file),
            )
        except FileNotFoundError as exc:
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        except OSError:
            return json_error_fn("Unable to read file preview", 500)

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
        if store.has_open_job(user_id=user_id, chat_id=chat_id):
            return json_error_fn("Wait for Hermes to finish before forking this chat.", 409)
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
        _evict_chat_runtime(user_id=user_id, chat_id=chat_id, reason="invalidated_by_clear")
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
    def remove_chat(payload: dict[str, object], user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        allow_empty, allow_empty_error = _parse_allow_empty_flag(payload)
        if allow_empty_error:
            return allow_empty_error

        store = store_getter()
        _evict_chat_runtime(user_id=user_id, chat_id=chat_id, reason="invalidated_by_remove")
        next_chat_id = store.remove_chat(user_id=user_id, chat_id=chat_id, allow_empty=bool(allow_empty))

        if not next_chat_id:
            chats = _serialize_chats(user_id=user_id)
            pinned_chats = _serialize_pinned_chats(user_id=user_id)
            return {
                "ok": True,
                "removed_chat_id": chat_id,
                "active_chat_id": None,
                "active_chat": None,
                "history": [],
                "chats": chats,
                "pinned_chats": pinned_chats,
            }, 200

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
