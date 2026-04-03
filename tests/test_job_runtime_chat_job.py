from __future__ import annotations

from dataclasses import dataclass

import pytest

from job_runtime_chat_job import execute_chat_job


class RetryableError(Exception):
    pass


class NonRetryableError(Exception):
    pass


class ClientError(Exception):
    pass


@dataclass
class _Turn:
    body: str


class _FakeStore:
    def __init__(self) -> None:
        self.messages: list[tuple[str, int, str, str]] = []
        self.completed: list[int] = []
        self.checkpoint_writes: list[tuple[str, list[dict[str, str]]]] = []
        self.job_state = {"status": "running"}

    def get_message(self, *, user_id: str, chat_id: int, message_id: int):
        if message_id == -1:
            raise KeyError("missing")
        return _Turn(body="hello")

    def get_runtime_checkpoint(self, _session_id: str):
        return None

    def get_history_before(self, **_kwargs):
        return []

    def get_skin(self, _user_id: str) -> str:
        return "terminal"

    def add_message(self, *, user_id: str, chat_id: int, role: str, body: str) -> None:
        self.messages.append((user_id, chat_id, role, body))

    def set_runtime_checkpoint(self, *, session_id: str, user_id: str, chat_id: int, history: list[dict[str, str]]) -> None:
        self.checkpoint_writes.append((session_id, history))

    def complete_job(self, job_id: int) -> None:
        self.completed.append(job_id)

    def get_job_state(self, _job_id: int):
        return dict(self.job_state)

    def get_turn_count(self, _user_id: str, *, chat_id: int) -> int:
        return 7


class _FakeClient:
    def __init__(self, events: list[dict[str, object]]) -> None:
        self._events = events
        self.evicted_sessions: list[str] = []

    def should_include_conversation_history(self, *, session_id: str) -> bool:
        return False

    def persistent_stats(self) -> dict[str, object]:
        return {"enabled": True, "total": 1}

    def evict_session(self, session_id: str) -> bool:
        self.evicted_sessions.append(str(session_id))
        return True

    def stream_events(self, **_kwargs):
        yield from self._events


class _FakeRuntime:
    def __init__(self, events: list[dict[str, object]]) -> None:
        self.store = _FakeStore()
        self.client = _FakeClient(events)
        self.session_id_builder = lambda user_id, chat_id: f"miniapp-{user_id}-{chat_id}"
        self.job_keepalive_interval_seconds = 10
        self.assistant_hard_limit = 5000
        self.assistant_chunk_len = 4096
        self.touch_cleared: list[int] = []
        self.published: list[tuple[int, str, dict[str, object]]] = []

    def _clear_touch_tracking(self, job_id: int) -> None:
        self.touch_cleared.append(job_id)

    def _build_recent_context_brief(self, history: list[dict[str, object]]) -> str:
        return ""

    def _touch_job_best_effort(self, _job_id: int, *, force: bool = False) -> None:
        return None

    def publish_job_event(self, job_id: int, event_name: str, payload: dict[str, object]) -> None:
        self.published.append((job_id, event_name, payload))

    def _chunk_assistant_reply(self, text: str, chunk_len: int) -> list[str]:
        return [text]


def test_execute_chat_job_raises_non_retryable_when_operator_turn_missing() -> None:
    runtime = _FakeRuntime(events=[])
    job = {"id": 1, "user_id": "u", "chat_id": 9, "operator_message_id": -1}

    with pytest.raises(NonRetryableError):
        execute_chat_job(
            runtime,
            job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
        )


def test_execute_chat_job_raises_retryable_on_stream_error_event() -> None:
    runtime = _FakeRuntime(events=[{"type": "error", "error": "upstream failed"}])
    job = {"id": 2, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    with pytest.raises(RetryableError):
        execute_chat_job(
            runtime,
            job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
        )


def test_execute_chat_job_completes_and_publishes_done_event() -> None:
    runtime = _FakeRuntime(
        events=[
            {"type": "meta", "source": "agent"},
            {"type": "chunk", "text": "hello world"},
            {"type": "done", "reply": "hello world", "latency_ms": 5},
        ]
    )
    job = {"id": 3, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    execute_chat_job(
        runtime,
        job,
        retryable_error_cls=RetryableError,
        non_retryable_error_cls=NonRetryableError,
        client_error_cls=ClientError,
    )

    assert runtime.touch_cleared == [3]
    assert runtime.client.evicted_sessions == ["miniapp-u-9"]
    assert runtime.store.completed == [3]
    assert any(role == "hermes" and body == "hello world" for _, _, role, body in runtime.store.messages)
    assert any(name == "done" and payload.get("reply") == "hello world" for _, name, payload in runtime.published)


def test_execute_chat_job_raises_retryable_on_session_mismatch_event() -> None:
    runtime = _FakeRuntime(
        events=[
            {"type": "chunk", "text": "cross-chat contamination", "session_id": "miniapp-u-777"},
        ]
    )
    job = {"id": 4, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    with pytest.raises(RetryableError, match="session mismatch"):
        execute_chat_job(
            runtime,
            job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
        )

    assert runtime.store.completed == []
    assert not any(role == "hermes" for _, _, role, _ in runtime.store.messages)


def test_execute_chat_job_raises_retryable_on_chat_id_mismatch_event() -> None:
    runtime = _FakeRuntime(
        events=[
            {"type": "chunk", "text": "wrong chat", "chat_id": 99},
        ]
    )
    job = {"id": 5, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    with pytest.raises(RetryableError, match="chat mismatch"):
        execute_chat_job(
            runtime,
            job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
        )

    assert runtime.store.completed == []
    assert not any(role == "hermes" for _, _, role, _ in runtime.store.messages)
