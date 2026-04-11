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


@dataclass
class _Chat:
    title: str


class _FakeStore:
    def __init__(self) -> None:
        self.messages: list[tuple[str, int, str, str]] = []
        self.completed: list[int] = []
        self.checkpoint_writes: list[dict[str, object]] = []
        self.job_state = {"status": "running"}
        self.operator_body = "hello"
        self.chat_title = "Chat"

    def get_message(self, *, user_id: str, chat_id: int, message_id: int):
        if message_id == -1:
            raise KeyError("missing")
        return _Turn(body=self.operator_body)

    def get_chat(self, user_id: str, chat_id: int):
        return _Chat(title=self.chat_title)

    def get_runtime_checkpoint(self, _session_id: str):
        return None

    def get_runtime_checkpoint_state(self, _session_id: str):
        return None

    def get_history_before(self, **_kwargs):
        return []

    def get_skin(self, _user_id: str) -> str:
        return "terminal"

    def add_message(self, *, user_id: str, chat_id: int, role: str, body: str) -> None:
        self.messages.append((user_id, chat_id, role, body))

    def set_runtime_checkpoint(
        self,
        *,
        session_id: str,
        user_id: str,
        chat_id: int,
        history: list[dict[str, str]] | None = None,
        pending_tool_lines: list[str] | None = None,
        pending_assistant: str | None = None,
    ) -> None:
        self.checkpoint_writes.append({
            "session_id": session_id,
            "user_id": user_id,
            "chat_id": chat_id,
            "history": history,
            "pending_tool_lines": list(pending_tool_lines or []),
            "pending_assistant": str(pending_assistant or ""),
        })

    def complete_job(self, job_id: int) -> None:
        self.completed.append(job_id)

    def get_job_state(self, _job_id: int):
        return dict(self.job_state)

    def get_turn_count(self, _user_id: str, *, chat_id: int) -> int:
        return 7


class _FakeClient:
    def __init__(self, events: list[dict[str, object]], *, warm_owner_state: dict[str, object] | None = None) -> None:
        self._events = events
        self.evicted_sessions: list[str] = []
        self._warm_owner_state = warm_owner_state or {"owner_records": []}
        self.stream_calls: list[dict[str, object]] = []

    def should_include_conversation_history(self, *, session_id: str) -> bool:
        return False

    def persistent_stats(self) -> dict[str, object]:
        return {"enabled": True, "total": 1}

    def evict_session(self, session_id: str) -> bool:
        self.evicted_sessions.append(str(session_id))
        return True

    def warm_session_owner_state(self) -> dict[str, object]:
        return dict(self._warm_owner_state)

    def stream_events(self, **kwargs):
        self.stream_calls.append(dict(kwargs))
        yield from self._events


class _FakeRuntime:
    def __init__(self, events: list[dict[str, object]], *, warm_owner_state: dict[str, object] | None = None) -> None:
        self.store = _FakeStore()
        self.client = _FakeClient(events, warm_owner_state=warm_owner_state)
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


def test_execute_chat_job_persists_live_pending_tool_and_assistant_checkpoint_state() -> None:
    runtime = _FakeRuntime(
        events=[
            {"type": "tool", "display": "read_file"},
            {"type": "chunk", "text": "partial"},
            {"type": "done", "reply": "partial", "latency_ms": 5},
        ]
    )
    job = {"id": 30, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    execute_chat_job(
        runtime,
        job,
        retryable_error_cls=RetryableError,
        non_retryable_error_cls=NonRetryableError,
        client_error_cls=ClientError,
    )

    assert runtime.store.checkpoint_writes[0]["pending_tool_lines"] == ["read_file"]
    assert runtime.store.checkpoint_writes[0]["pending_assistant"] == ""
    assert runtime.store.checkpoint_writes[1]["pending_tool_lines"] == ["read_file"]
    assert runtime.store.checkpoint_writes[1]["pending_assistant"] == "partial"
    assert runtime.store.checkpoint_writes[-1]["pending_tool_lines"] == []
    assert runtime.store.checkpoint_writes[-1]["pending_assistant"] == ""


def test_execute_chat_job_scopes_ambiguous_followup_to_chat_title() -> None:
    runtime = _FakeRuntime(events=[{"type": "done", "reply": "ok", "latency_ms": 5}])
    runtime.store.operator_body = "Do it"
    runtime.store.chat_title = "Refactor"
    job = {"id": 31, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    execute_chat_job(
        runtime,
        job,
        retryable_error_cls=RetryableError,
        non_retryable_error_cls=NonRetryableError,
        client_error_cls=ClientError,
    )

    sent_message = runtime.client.stream_calls[0]["message"]
    assert 'Current thread title: "Refactor".' in sent_message
    assert "Operator message: Do it" in sent_message


def test_execute_chat_job_leaves_specific_prompt_unwrapped() -> None:
    runtime = _FakeRuntime(events=[{"type": "done", "reply": "ok", "latency_ms": 5}])
    runtime.store.operator_body = "Please finish R42 next and then R43."
    runtime.store.chat_title = "Refactor"
    job = {"id": 32, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    execute_chat_job(
        runtime,
        job,
        retryable_error_cls=RetryableError,
        non_retryable_error_cls=NonRetryableError,
        client_error_cls=ClientError,
    )

    assert runtime.client.stream_calls[0]["message"] == "Please finish R42 next and then R43."


def test_execute_chat_job_stops_consuming_stream_immediately_after_terminal_done() -> None:
    closed = {"value": False}
    trailing_consumed = {"value": False}

    def _events(**_kwargs):
        try:
            yield {"type": "meta", "source": "agent"}
            yield {"type": "chunk", "text": "hello world"}
            yield {"type": "done", "reply": "hello world", "latency_ms": 5}
            trailing_consumed["value"] = True
            yield {"type": "tool", "display": "should-not-consume"}
        finally:
            closed["value"] = True

    runtime = _FakeRuntime(events=[])
    job = {"id": 32, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    execute_chat_job(
        runtime,
        job,
        retryable_error_cls=RetryableError,
        non_retryable_error_cls=NonRetryableError,
        client_error_cls=ClientError,
        stream_events_fn=_events,
    )

    assert trailing_consumed["value"] is False
    assert closed["value"] is True
    assert any(name == "done" and payload.get("reply") == "hello world" for _, name, payload in runtime.published)


def test_execute_chat_job_raises_retryable_when_stream_emits_chunks_without_done() -> None:
    runtime = _FakeRuntime(
        events=[
            {"type": "meta", "source": "agent"},
            {"type": "chunk", "text": "partial but non-terminal"},
        ]
    )
    job = {"id": 31, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    with pytest.raises(RetryableError, match="without a terminal done event"):
        execute_chat_job(
            runtime,
            job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
        )


def test_execute_chat_job_raises_retryable_with_source_and_tool_count_on_empty_done_reply() -> None:
    runtime = _FakeRuntime(
        events=[
            {"type": "meta", "source": "cli"},
            {"type": "tool", "display": "📖 read_file"},
            {"type": "done", "reply": "", "latency_ms": 5},
        ]
    )
    job = {"id": 33, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    with pytest.raises(RetryableError) as exc_info:
        execute_chat_job(
            runtime,
            job,
            retryable_error_cls=RetryableError,
            non_retryable_error_cls=NonRetryableError,
            client_error_cls=ClientError,
        )

    message = str(exc_info.value)
    assert "Empty response from Hermes after terminal done event." in message
    assert "source=cli." in message
    assert "tools_seen=1." in message


def test_execute_chat_job_replays_tool_demo_when_first_reply_claims_tool_use_without_tool_events() -> None:
    runtime = _FakeRuntime(events=[])
    job = {"id": 34, "user_id": "u", "chat_id": 9, "operator_message_id": 1}
    runtime.store.get_message = lambda **_kwargs: _Turn(body="Can you do a tool call demo please?")

    calls: list[str] = []

    def _events(**kwargs):
        calls.append(str(kwargs.get("message") or ""))
        if len(calls) == 1:
            yield {"type": "meta", "source": "agent"}
            yield {"type": "chunk", "text": "I just ran the terminal tool"}
            yield {"type": "done", "reply": "I just ran the terminal tool and got the result.", "latency_ms": 5}
            return
        yield {"type": "meta", "source": "agent"}
        yield {"type": "tool", "display": "💻 terminal: \"date\""}
        yield {"type": "chunk", "text": "Here is the actual tool demo."}
        yield {"type": "done", "reply": "Here is the actual tool demo.", "latency_ms": 7}

    execute_chat_job(
        runtime,
        job,
        retryable_error_cls=RetryableError,
        non_retryable_error_cls=NonRetryableError,
        client_error_cls=ClientError,
        stream_events_fn=_events,
    )

    assert len(calls) == 2
    assert calls[0] == "Can you do a tool call demo please?"
    assert "must actually call at least one tool" in calls[1]
    assert runtime.client.evicted_sessions[0] == "miniapp-u-9"
    assert runtime.client.evicted_sessions[-1] == "miniapp-u-9"
    assert any(role == "tool" and "terminal" in body for _, _, role, body in runtime.store.messages)
    assert any(role == "hermes" and body == "Here is the actual tool demo." for _, _, role, body in runtime.store.messages)
    assert any(name == "meta" and payload.get("reason") == "tool_demo_guard_retry" for _, name, payload in runtime.published)


def test_execute_chat_job_preserves_evicted_warm_owner_state_on_completion() -> None:
    runtime = _FakeRuntime(
        events=[
            {"type": "meta", "source": "agent"},
            {"type": "chunk", "text": "hello world"},
            {"type": "done", "reply": "hello world", "latency_ms": 5},
        ],
        warm_owner_state={
            "owner_records": [
                {
                    "session_id": "miniapp-u-9",
                    "state": "evicted",
                }
            ]
        },
    )
    job = {"id": 29, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    execute_chat_job(
        runtime,
        job,
        retryable_error_cls=RetryableError,
        non_retryable_error_cls=NonRetryableError,
        client_error_cls=ClientError,
    )

    assert runtime.client.evicted_sessions == ["miniapp-u-9"]
    assert runtime.store.completed == [29]


def test_execute_chat_job_preserves_attachable_warm_owner_on_completion() -> None:
    runtime = _FakeRuntime(
        events=[
            {"type": "meta", "source": "agent"},
            {"type": "chunk", "text": "hello world"},
            {"type": "done", "reply": "hello world", "latency_ms": 5},
        ],
        warm_owner_state={
            "owner_records": [
                {
                    "session_id": "miniapp-u-9",
                    "state": "attachable_running",
                }
            ]
        },
    )
    job = {"id": 30, "user_id": "u", "chat_id": 9, "operator_message_id": 1}

    execute_chat_job(
        runtime,
        job,
        retryable_error_cls=RetryableError,
        non_retryable_error_cls=NonRetryableError,
        client_error_cls=ClientError,
    )

    assert runtime.client.evicted_sessions == []
    assert runtime.store.completed == [30]
    done_events = [event for event in runtime.published if event[1] == "done"]
    assert done_events
    assert done_events[-1][2]["persistent_mode"] == "warm-detached"
    assert done_events[-1][2]["warm_handoff"] is True


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
