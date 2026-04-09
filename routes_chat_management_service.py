from __future__ import annotations

from dataclasses import asdict
import os
from pathlib import Path
from typing import Any, Callable

from file_refs import extract_file_refs


class ChatManagementService:
    def __init__(
        self,
        *,
        store_getter: Callable[[], Any],
        client_getter: Callable[[], Any],
        runtime_getter: Callable[[], Any],
        serialize_chat_fn: Callable[[Any], dict[str, object]],
        session_id_builder_fn: Callable[[str, int], str],
        json_error_fn: Callable[[str, int], tuple[dict[str, object], int]],
    ) -> None:
        self._store_getter = store_getter
        self._client_getter = client_getter
        self._runtime_getter = runtime_getter
        self._serialize_chat_fn = serialize_chat_fn
        self._session_id_builder_fn = session_id_builder_fn
        self._json_error_fn = json_error_fn

    def serialize_turn(self, turn: Any) -> dict[str, object]:
        payload = asdict(turn)
        refs = extract_file_refs(payload.get("body") or "", message_id=int(payload.get("id") or 0))
        if refs:
            payload["file_refs"] = refs
        return payload

    def chat_history(self, user_id: str, chat_id: int, *, limit: int = 120) -> list[dict[str, object]]:
        return [self.serialize_turn(turn) for turn in self._store_getter().get_history(user_id=user_id, chat_id=chat_id, limit=limit)]

    def serialize_chats(self, user_id: str) -> list[dict[str, object]]:
        return [self._serialize_chat_fn(chat) for chat in self._store_getter().list_chats(user_id=user_id)]

    def serialize_pinned_chats(self, user_id: str) -> list[dict[str, object]]:
        return [self._serialize_chat_fn(chat) for chat in self._store_getter().list_pinned_chats(user_id=user_id)]

    def evict_chat_runtime(self, user_id: str, chat_id: int, *, reason: str = "chat_runtime_eviction") -> None:
        session_id = self._session_id_builder_fn(user_id, chat_id)
        self._client_getter().evict_session(session_id, reason=reason)
        self._store_getter().delete_runtime_checkpoint(session_id)

    def chat_history_payload(self, user_id: str, chat_id: int, *, activate: bool) -> dict[str, object]:
        store = self._store_getter()
        if activate:
            store.mark_chat_read(user_id=user_id, chat_id=chat_id)
            store.set_active_chat(user_id=user_id, chat_id=chat_id)
        history = [self.serialize_turn(turn) for turn in store.get_history(user_id=user_id, chat_id=chat_id, limit=120)]
        chat = store.get_chat(user_id=user_id, chat_id=chat_id)
        return {"ok": True, "chat": self._serialize_chat_fn(chat), "history": history}

    def create_chat_response(self, *, user_id: str, title: str) -> tuple[dict[str, object], int]:
        store = self._store_getter()
        chat = store.create_chat(user_id=user_id, title=title)
        store.set_active_chat(user_id=user_id, chat_id=chat.id)
        history = self.chat_history(user_id=user_id, chat_id=chat.id, limit=120)
        return {"ok": True, "chat": self._serialize_chat_fn(chat), "history": history}, 201

    def rename_chat_response(self, *, user_id: str, chat_id: int, title: str) -> tuple[dict[str, object], int]:
        chat = self._store_getter().rename_chat(user_id=user_id, chat_id=chat_id, title=title)
        return {"ok": True, "chat": self._serialize_chat_fn(chat)}, 200

    def mark_chat_read_response(self, *, user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        store = self._store_getter()
        store.mark_chat_read(user_id=user_id, chat_id=chat_id)
        chat = store.get_chat(user_id=user_id, chat_id=chat_id)
        return {"ok": True, "chat": self._serialize_chat_fn(chat)}, 200

    def set_chat_pinned_response(self, *, user_id: str, chat_id: int, is_pinned: bool) -> tuple[dict[str, object], int]:
        chat = self._store_getter().set_chat_pinned(user_id=user_id, chat_id=chat_id, is_pinned=is_pinned)
        return {
            "ok": True,
            "chat": self._serialize_chat_fn(chat),
            "pinned_chats": self.serialize_pinned_chats(user_id=user_id),
        }, 200

    def reopen_chat_response(self, *, user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        store = self._store_getter()
        chat_record = store.reopen_chat(user_id=user_id, chat_id=chat_id)
        store.mark_chat_read(user_id=user_id, chat_id=chat_id)
        store.set_active_chat(user_id=user_id, chat_id=chat_id)
        history = self.chat_history(user_id=user_id, chat_id=chat_id, limit=120)
        chats = self.serialize_chats(user_id=user_id)
        pinned_chats = self.serialize_pinned_chats(user_id=user_id)
        return {
            "ok": True,
            "chat": self._serialize_chat_fn(chat_record),
            "active_chat_id": chat_id,
            "history": history,
            "chats": chats,
            "pinned_chats": pinned_chats,
        }, 200

    def branch_chat_response(
        self,
        *,
        user_id: str,
        chat_id: int,
        requested_title: str | None,
    ) -> tuple[dict[str, object], int]:
        store = self._store_getter()
        if store.has_open_job(user_id=user_id, chat_id=chat_id):
            return self._json_error_fn("Wait for Hermes to finish before branching this chat.", 409)
        forked_chat = store.fork_chat(user_id=user_id, source_chat_id=chat_id, title=requested_title)
        store.set_active_chat(user_id=user_id, chat_id=forked_chat.id)
        store.mark_chat_read(user_id=user_id, chat_id=forked_chat.id)

        history = self.chat_history(user_id=user_id, chat_id=forked_chat.id, limit=120)
        chats = self.serialize_chats(user_id=user_id)
        pinned_chats = self.serialize_pinned_chats(user_id=user_id)

        return {
            "ok": True,
            "chat": self._serialize_chat_fn(forked_chat),
            "active_chat_id": forked_chat.id,
            "branched_from_chat_id": chat_id,
            "forked_from_chat_id": chat_id,
            "history": history,
            "chats": chats,
            "pinned_chats": pinned_chats,
        }, 201

    def clear_chat_response(self, *, user_id: str, chat_id: int) -> tuple[dict[str, object], int]:
        store = self._store_getter()
        store.clear_chat(user_id=user_id, chat_id=chat_id)
        chat_record = store.get_chat(user_id=user_id, chat_id=chat_id)
        self.evict_chat_runtime(user_id=user_id, chat_id=chat_id, reason="invalidated_by_clear")
        return {"ok": True, "chat": self._serialize_chat_fn(chat_record), "history": []}, 200

    def remove_chat_response(
        self,
        *,
        user_id: str,
        chat_id: int,
        allow_empty: bool,
    ) -> tuple[dict[str, object], int]:
        store = self._store_getter()
        self.evict_chat_runtime(user_id=user_id, chat_id=chat_id, reason="invalidated_by_remove")
        next_chat_id = store.remove_chat(user_id=user_id, chat_id=chat_id, allow_empty=allow_empty)

        if not next_chat_id:
            chats = self.serialize_chats(user_id=user_id)
            pinned_chats = self.serialize_pinned_chats(user_id=user_id)
            return {
                "ok": True,
                "removed_chat_id": chat_id,
                "active_chat_id": None,
                "active_chat": None,
                "history": [],
                "chats": chats,
                "pinned_chats": pinned_chats,
            }, 200

        history = self.chat_history(user_id=user_id, chat_id=next_chat_id, limit=120)
        store.mark_chat_read(user_id=user_id, chat_id=next_chat_id)
        store.set_active_chat(user_id=user_id, chat_id=next_chat_id)
        active_chat = store.get_chat(user_id=user_id, chat_id=next_chat_id)
        chats = self.serialize_chats(user_id=user_id)
        pinned_chats = self.serialize_pinned_chats(user_id=user_id)

        return {
            "ok": True,
            "removed_chat_id": chat_id,
            "active_chat_id": next_chat_id,
            "active_chat": self._serialize_chat_fn(active_chat),
            "history": history,
            "chats": chats,
            "pinned_chats": pinned_chats,
        }, 200

    def chats_status_response(self, *, user_id: str) -> tuple[dict[str, object], int]:
        self._runtime_getter().ensure_pending_jobs(user_id)
        chats = self.serialize_chats(user_id=user_id)
        pinned_chats = self.serialize_pinned_chats(user_id=user_id)
        return {"ok": True, "chats": chats, "pinned_chats": pinned_chats}, 200

    def file_preview_response(
        self,
        *,
        user_id: str,
        chat_id: int,
        ref_id: str,
        path_text: str,
        line_start: int,
        line_end: int,
        window_start: int,
        window_end: int,
        full_file: bool,
    ) -> tuple[dict[str, object], int]:
        self._store_getter().get_chat(user_id=user_id, chat_id=chat_id)

        allowed_roots = self._file_preview_allowed_roots()
        if not self._file_preview_enabled(allowed_roots):
            return self._json_error_fn("File preview feature is disabled", 403)
        if not allowed_roots:
            return self._json_error_fn("File preview is disabled: no allowed roots configured", 403)

        if ref_id:
            try:
                ref_path, ref_line_start, ref_line_end = self.resolve_ref_preview_request(
                    user_id=user_id,
                    chat_id=chat_id,
                    ref_id=ref_id,
                )
            except KeyError as exc:
                return self._json_error_fn(str(exc), 404)
            path_text = ref_path
            if line_start <= 0:
                line_start = ref_line_start
            if line_end <= 0:
                line_end = ref_line_end

        try:
            target_path = self.resolve_preview_path(path_text, allowed_roots=allowed_roots)
        except ValueError as exc:
            return self._json_error_fn(str(exc), 400)

        if not self.path_under_allowed_roots(target_path, allowed_roots):
            return self._json_error_fn("File is outside allowed roots.", 403)

        try:
            preview = self.build_file_preview(
                target_path,
                line_start=line_start,
                line_end=line_end,
                window_start_override=window_start,
                window_end_override=window_end,
                full_file=full_file,
            )
        except FileNotFoundError as exc:
            return self._json_error_fn(str(exc), 404)
        except ValueError as exc:
            return self._json_error_fn(str(exc), 400)
        except OSError:
            return self._json_error_fn("Unable to read file preview", 500)

        return {"ok": True, "preview": preview}, 200

    def _file_preview_allowed_roots(self) -> list[Path]:
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

    def _file_preview_enabled(self, allowed_roots: list[Path]) -> bool:
        raw = os.environ.get("MINI_APP_FILE_PREVIEW_ENABLED")
        if raw is None:
            return bool(allowed_roots)
        return str(raw).strip().lower() in {"1", "true", "yes", "on"}

    def resolve_preview_path(self, path_text: str, *, allowed_roots: list[Path]) -> Path:
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

    def path_under_allowed_roots(self, target: Path, roots: list[Path]) -> bool:
        for root in roots:
            try:
                target.relative_to(root)
                return True
            except ValueError:
                continue
        return False

    def build_file_preview(
        self,
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

    def resolve_ref_preview_request(self, *, user_id: str, chat_id: int, ref_id: str) -> tuple[str, int, int]:
        history = self._store_getter().get_history(user_id=user_id, chat_id=chat_id, limit=400)
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


def build_chat_management_service(
    *,
    store_getter: Callable[[], Any],
    client_getter: Callable[[], Any],
    runtime_getter: Callable[[], Any],
    serialize_chat_fn: Callable[[Any], dict[str, object]],
    session_id_builder_fn: Callable[[str, int], str],
    json_error_fn: Callable[[str, int], tuple[dict[str, object], int]],
) -> ChatManagementService:
    return ChatManagementService(
        store_getter=store_getter,
        client_getter=client_getter,
        runtime_getter=runtime_getter,
        serialize_chat_fn=serialize_chat_fn,
        session_id_builder_fn=session_id_builder_fn,
        json_error_fn=json_error_fn,
    )
