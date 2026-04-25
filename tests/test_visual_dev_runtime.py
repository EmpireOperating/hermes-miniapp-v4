from __future__ import annotations

from visual_dev_runtime import VisualDevRuntime


class _Clock:
    def __init__(self) -> None:
        self.value = 100.0

    def now(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds



def test_visual_dev_runtime_tracks_attach_heartbeat_and_stale_disconnect() -> None:
    clock = _Clock()
    runtime = VisualDevRuntime(now_fn=clock.now, heartbeat_timeout_seconds=10.0)

    runtime.attach_session(session_id="session-a", user_id="u1", chat_id=7, preview_url="https://preview.example.com/app")
    attached = runtime.get_session_state("session-a")
    assert attached is not None
    assert attached["state"] == "connecting"

    runtime.record_event("session-a", "heartbeat")
    live = runtime.get_session_state("session-a")
    assert live is not None
    assert live["state"] == "live"
    assert live["last_heartbeat_at"] == 100.0

    clock.advance(11.0)
    stale = runtime.get_session_state("session-a")
    assert stale is not None
    assert stale["state"] == "disconnected"
    assert stale["stale"] is True



def test_visual_dev_runtime_marks_bridge_ready_preview_live() -> None:
    clock = _Clock()
    runtime = VisualDevRuntime(now_fn=clock.now, heartbeat_timeout_seconds=10.0)

    runtime.attach_session(session_id="session-a", user_id="u1", chat_id=7, preview_url="https://preview.example.com/app")
    ready = runtime.record_event(
        "session-a",
        "bridge-ready",
        {"preview_url": "https://preview.example.com/app", "preview_title": "Workspace media editor"},
    )

    assert ready["state"] == "live"
    assert ready["stale"] is False
    assert runtime.get_session_state("session-a")["state"] == "live"



def test_visual_dev_runtime_reduces_build_and_runtime_error_states_deterministically() -> None:
    clock = _Clock()
    runtime = VisualDevRuntime(now_fn=clock.now, heartbeat_timeout_seconds=10.0)

    runtime.attach_session(session_id="session-a", user_id="u1", chat_id=7, preview_url="https://preview.example.com/app")
    runtime.record_event("session-a", "heartbeat")
    runtime.record_event("session-a", "build-state", {"state": "reloading"})
    runtime.record_event("session-a", "build-state", {"state": "build_failed", "message": "vite compile failed"})

    build_failed = runtime.get_session_state("session-a")
    assert build_failed is not None
    assert build_failed["state"] == "build_failed"
    assert build_failed["last_error"] == "vite compile failed"

    runtime.record_event("session-a", "console", {"level": "error", "message": "ReferenceError: score is not defined"})
    runtime_error = runtime.get_session_state("session-a")
    assert runtime_error is not None
    assert runtime_error["state"] == "runtime_error"
    assert runtime_error["last_error"] == "ReferenceError: score is not defined"

    runtime.record_event("session-a", "build-state", {"state": "live"})
    recovered = runtime.get_session_state("session-a")
    assert recovered is not None
    assert recovered["state"] == "live"



def test_visual_dev_runtime_dedupes_console_noise_within_window() -> None:
    clock = _Clock()
    runtime = VisualDevRuntime(now_fn=clock.now, console_dedupe_window_seconds=5.0)
    runtime.attach_session(session_id="session-a", user_id="u1", chat_id=7, preview_url="https://preview.example.com/app")

    first = runtime.record_event(
        "session-a",
        "console",
        {"level": "warn", "message": "slow frame", "source": "preview"},
    )
    second = runtime.record_event(
        "session-a",
        "console",
        {"level": "warn", "message": "slow frame", "source": "preview"},
    )
    clock.advance(6.0)
    third = runtime.record_event(
        "session-a",
        "console",
        {"level": "warn", "message": "slow frame", "source": "preview"},
    )

    assert first["accepted"] is True
    assert second["accepted"] is False
    assert third["accepted"] is True



def test_visual_dev_runtime_lists_active_sessions_by_updated_recency() -> None:
    clock = _Clock()
    runtime = VisualDevRuntime(now_fn=clock.now)
    runtime.attach_session(session_id="session-a", user_id="u1", chat_id=7, preview_url="https://preview-a.example.com/app")
    clock.advance(1.0)
    runtime.attach_session(session_id="session-b", user_id="u1", chat_id=8, preview_url="https://preview-b.example.com/app")
    runtime.record_event("session-b", "heartbeat")
    clock.advance(1.0)
    runtime.record_event("session-a", "heartbeat")

    sessions = runtime.list_session_states(user_id="u1")

    assert [session["session_id"] for session in sessions] == ["session-a", "session-b"]
    runtime.detach_session("session-a")
    assert [session["session_id"] for session in runtime.list_session_states(user_id="u1")] == ["session-b"]
