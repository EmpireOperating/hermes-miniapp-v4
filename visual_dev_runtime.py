from __future__ import annotations

import time
from typing import Any, Callable


_RUNTIME_STATES = {
    "connecting",
    "live",
    "reloading",
    "build_failed",
    "runtime_error",
    "disconnected",
    "restart_required",
}


class VisualDevRuntime:
    def __init__(
        self,
        *,
        now_fn: Callable[[], float] | None = None,
        heartbeat_timeout_seconds: float = 15.0,
        console_dedupe_window_seconds: float = 2.0,
    ) -> None:
        self._now_fn = now_fn or time.monotonic
        self._heartbeat_timeout_seconds = max(float(heartbeat_timeout_seconds), 0.1)
        self._console_dedupe_window_seconds = max(float(console_dedupe_window_seconds), 0.0)
        self._sessions: dict[str, dict[str, Any]] = {}
        self._console_fingerprints: dict[str, tuple[str, float]] = {}

    def attach_session(self, *, session_id: str, user_id: str, chat_id: int, preview_url: str) -> dict[str, Any]:
        now = self._now_fn()
        state = self._sessions.get(session_id, {}).copy()
        state.update(
            {
                "session_id": session_id,
                "user_id": str(user_id),
                "chat_id": int(chat_id),
                "preview_url": str(preview_url),
                "state": "connecting",
                "stale": False,
                "attached": True,
                "last_error": str(state.get("last_error") or ""),
                "last_event_at": now,
                "last_heartbeat_at": state.get("last_heartbeat_at"),
            }
        )
        self._sessions[session_id] = state
        return self.get_session_state(session_id) or state.copy()

    def detach_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)
        self._console_fingerprints.pop(session_id, None)

    def record_event(self, session_id: str, event_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if session_id not in self._sessions:
            raise KeyError(f"Visual dev runtime session {session_id} not found")
        payload = payload or {}
        now = self._now_fn()
        state = self._sessions[session_id]
        state["last_event_at"] = now
        state["stale"] = False
        accepted = True

        if event_type == "heartbeat":
            state["last_heartbeat_at"] = now
            if state.get("state") != "restart_required":
                state["state"] = "live"
        elif event_type == "bridge-ready":
            state["state"] = "live"
            state["last_heartbeat_at"] = now
            state["last_error"] = ""
        elif event_type == "build-state":
            next_state = str(payload.get("state") or "").strip()
            if next_state in _RUNTIME_STATES:
                state["state"] = next_state
            message = str(payload.get("message") or "").strip()
            if next_state in {"build_failed", "runtime_error", "restart_required"} and message:
                state["last_error"] = message
            elif next_state == "live":
                state["last_error"] = ""
        elif event_type == "console":
            level = str(payload.get("level") or "info").strip().lower()
            message = str(payload.get("message") or "").strip()
            source = str(payload.get("source") or "").strip()
            fingerprint = f"{level}|{source}|{message}"
            previous = self._console_fingerprints.get(session_id)
            if (
                previous
                and previous[0] == fingerprint
                and (now - previous[1]) < self._console_dedupe_window_seconds
            ):
                accepted = False
            else:
                self._console_fingerprints[session_id] = (fingerprint, now)
                if level == "error" and message:
                    state["state"] = "runtime_error"
                    state["last_error"] = message
        elif event_type == "disconnect":
            state["state"] = "disconnected"
        elif event_type == "restart-required":
            state["state"] = "restart_required"
            state["last_error"] = str(payload.get("message") or state.get("last_error") or "").strip()

        self._sessions[session_id] = state
        current = self.get_session_state(session_id) or state.copy()
        current["accepted"] = accepted
        return current

    def get_session_state(self, session_id: str) -> dict[str, Any] | None:
        state = self._sessions.get(session_id)
        if not state:
            return None
        return self._with_staleness(state.copy())

    def list_session_states(self, *, user_id: str | None = None) -> list[dict[str, Any]]:
        rows = []
        for state in self._sessions.values():
            if user_id is not None and str(state.get("user_id")) != str(user_id):
                continue
            rows.append(self._with_staleness(state.copy()))
        rows.sort(key=lambda item: (float(item.get("last_event_at") or 0.0), str(item.get("session_id") or "")), reverse=True)
        return rows

    def summarize(self) -> dict[str, Any]:
        rows = self.list_session_states()
        counts: dict[str, int] = {}
        for row in rows:
            counts[row["state"]] = counts.get(row["state"], 0) + 1
        return {
            "total_sessions": len(rows),
            "states": counts,
            "sessions": rows,
        }

    def _with_staleness(self, state: dict[str, Any]) -> dict[str, Any]:
        now = self._now_fn()
        last_heartbeat_at = state.get("last_heartbeat_at")
        stale = False
        if isinstance(last_heartbeat_at, (int, float)):
            stale = (now - float(last_heartbeat_at)) > self._heartbeat_timeout_seconds
        if stale:
            state["state"] = "disconnected"
            state["stale"] = True
        else:
            state["stale"] = False
        return state
