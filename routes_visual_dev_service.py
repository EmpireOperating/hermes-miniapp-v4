from __future__ import annotations

import base64
import binascii
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from visual_dev_origin_policy import assert_parent_origin_allowed, assert_preview_url_allowed, preview_url_origin


class VisualDevService:
    def __init__(
        self,
        *,
        store_getter: Callable[[], Any],
        runtime_getter: Callable[[], Any],
        allowed_preview_origins: set[str],
        allowed_bridge_parents: set[str],
        artifact_dir: Path,
        max_console_events: int,
        screenshot_max_bytes: int,
        time_fn: Callable[[], float] | None = None,
    ) -> None:
        self._store_getter = store_getter
        self._runtime_getter = runtime_getter
        self._allowed_preview_origins = set(allowed_preview_origins or set())
        self._allowed_bridge_parents = set(allowed_bridge_parents or set())
        self._artifact_dir = Path(artifact_dir)
        self._max_console_events = max(int(max_console_events), 1)
        self._screenshot_max_bytes = max(int(screenshot_max_bytes), 1)
        self._time_fn = time_fn or time.time

    def state_payload(self, *, user_id: str) -> dict[str, Any]:
        sessions = [self._merge_runtime(session) for session in self._store_getter().list_visual_dev_sessions(user_id=user_id)]
        return {
            "ok": True,
            "enabled": True,
            "sessions": sessions,
            "runtime_summary": self._runtime_getter().summarize(),
        }

    def attach_session(
        self,
        *,
        user_id: str,
        chat_id: int,
        session_id: str,
        preview_url: str,
        preview_title: str,
        bridge_parent_origin: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            raise ValueError("Missing session_id")
        trusted_preview_url = assert_preview_url_allowed(preview_url, self._allowed_preview_origins)
        trusted_parent_origin = assert_parent_origin_allowed(bridge_parent_origin, self._allowed_bridge_parents)
        self._store_getter().upsert_visual_dev_session(
            session_id=normalized_session_id,
            user_id=str(user_id),
            chat_id=int(chat_id),
            preview_url=trusted_preview_url,
            preview_origin=preview_url_origin(trusted_preview_url),
            preview_title=str(preview_title or "").strip(),
            bridge_parent_origin=trusted_parent_origin,
            status="attached",
            metadata=self._normalize_dict(metadata),
        )
        self._runtime_getter().attach_session(
            session_id=normalized_session_id,
            user_id=str(user_id),
            chat_id=int(chat_id),
            preview_url=trusted_preview_url,
        )
        return self.get_session_by_id(user_id=user_id, session_id=normalized_session_id)

    def detach_session(self, *, user_id: str, session_id: str) -> None:
        session = self.get_session_by_id(user_id=user_id, session_id=session_id)
        self._store_getter().detach_visual_dev_session(session["session_id"])
        self._runtime_getter().detach_session(session["session_id"])

    def get_session_details(self, *, user_id: str, chat_id: int) -> dict[str, Any]:
        session = self._find_session_for_chat(user_id=user_id, chat_id=chat_id)
        return {
            "ok": True,
            "session": self._merge_runtime(session),
            "latest_selection": self._store_getter().get_latest_visual_dev_selection(session["session_id"]),
            "artifacts": self._store_getter().list_visual_dev_artifacts(session["session_id"]),
            "console_events": self._store_getter().list_visual_dev_console_events(session["session_id"]),
        }

    def record_selection(
        self,
        *,
        user_id: str,
        session_id: str,
        selection_type: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        session = self.get_session_by_id(user_id=user_id, session_id=session_id)
        normalized_selection_type = str(selection_type or "").strip()
        if not normalized_selection_type:
            raise ValueError("Missing selection_type")
        self._store_getter().record_visual_dev_selection(
            session_id=session["session_id"],
            selection_type=normalized_selection_type,
            payload=self._normalize_dict(payload),
        )
        return self._store_getter().get_latest_visual_dev_selection(session["session_id"])

    def record_console_event(
        self,
        *,
        user_id: str,
        session_id: str,
        event_type: str,
        level: str,
        message: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        session = self.get_session_by_id(user_id=user_id, session_id=session_id)
        normalized_event_type = str(event_type or "console").strip() or "console"
        normalized_level = str(level or "info").strip().lower() or "info"
        normalized_message = str(message or "").strip()
        if not normalized_message:
            raise ValueError("Missing console message")
        runtime_state = self._runtime_getter().record_event(
            session["session_id"],
            "console",
            {
                "level": normalized_level,
                "message": normalized_message,
                **self._normalize_dict(metadata),
            },
        )
        accepted = bool(runtime_state.get("accepted", True))
        if accepted:
            self._store_getter().record_visual_dev_console_event(
                session_id=session["session_id"],
                event_type=normalized_event_type,
                level=normalized_level,
                message=normalized_message,
                metadata=self._normalize_dict(metadata),
                max_events=self._max_console_events,
            )
        return runtime_state

    def record_screenshot(
        self,
        *,
        user_id: str,
        session_id: str,
        content_type: str,
        bytes_b64: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        session = self.get_session_by_id(user_id=user_id, session_id=session_id)
        normalized_content_type = str(content_type or "application/octet-stream").strip().lower()
        if not normalized_content_type:
            normalized_content_type = "application/octet-stream"
        raw_bytes = self._decode_bytes(bytes_b64)
        extension = self._content_extension(normalized_content_type)
        target_dir = self._artifact_dir / str(user_id) / session["session_id"]
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / f"screenshot-{int(self._time_fn() * 1000)}-{uuid.uuid4().hex[:8]}{extension}"
        target_path.write_bytes(raw_bytes)
        self._store_getter().record_visual_dev_artifact(
            session_id=session["session_id"],
            artifact_kind="screenshot",
            storage_path=str(target_path),
            content_type=normalized_content_type,
            byte_size=len(raw_bytes),
            metadata=self._normalize_dict(metadata),
        )
        artifacts = self._store_getter().list_visual_dev_artifacts(session["session_id"], limit=1)
        return artifacts[0]

    def record_runtime_command(
        self,
        *,
        user_id: str,
        session_id: str,
        command: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        session = self.get_session_by_id(user_id=user_id, session_id=session_id)
        normalized_command = str(command or "").strip().lower()
        if normalized_command not in {"heartbeat", "bridge-ready", "disconnect", "restart-required", "build-state"}:
            raise ValueError("Unsupported visual dev command")
        return self._runtime_getter().record_event(session["session_id"], normalized_command, self._normalize_dict(payload))

    def get_session_by_id(self, *, user_id: str, session_id: str) -> dict[str, Any]:
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            raise ValueError("Missing session_id")
        session = self._store_getter().get_visual_dev_session(normalized_session_id)
        if not session or str(session.get("user_id")) != str(user_id):
            raise KeyError("Visual dev session not found")
        return self._merge_runtime(session)

    def _find_session_for_chat(self, *, user_id: str, chat_id: int) -> dict[str, Any]:
        for session in self._store_getter().list_visual_dev_sessions(user_id=user_id):
            if int(session.get("chat_id") or 0) == int(chat_id):
                return session
        raise KeyError("Visual dev session not found")

    def _merge_runtime(self, session: dict[str, Any]) -> dict[str, Any]:
        merged = dict(session or {})
        runtime_state = self._runtime_getter().get_session_state(str(merged.get("session_id") or ""))
        merged["runtime"] = runtime_state or {
            "session_id": str(merged.get("session_id") or ""),
            "state": "detached" if merged.get("status") == "detached" else "disconnected",
            "stale": False,
        }
        return merged

    def _decode_bytes(self, encoded: str) -> bytes:
        try:
            raw = base64.b64decode(str(encoded or ""), validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("Invalid screenshot bytes") from exc
        if not raw:
            raise ValueError("Missing screenshot bytes")
        if len(raw) > self._screenshot_max_bytes:
            raise ValueError("Screenshot exceeds max bytes")
        return raw

    @staticmethod
    def _normalize_dict(value: dict[str, Any] | None) -> dict[str, Any]:
        return dict(value or {}) if isinstance(value, dict) else {}

    @staticmethod
    def _content_extension(content_type: str) -> str:
        mapping = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/webp": ".webp",
        }
        return mapping.get(content_type, ".bin")


def build_visual_dev_service(**kwargs: Any) -> VisualDevService:
    return VisualDevService(**kwargs)
