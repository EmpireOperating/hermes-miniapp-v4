from __future__ import annotations

import sys

import hermes_client


class _FakeAgent:
    created = 0
    calls: list[dict[str, object]] = []

    def __init__(self, **kwargs):
        type(self).created += 1
        self.kwargs = kwargs
        self.tool_progress_callback = kwargs.get("tool_progress_callback")

    def run_conversation(self, message, conversation_history=None, task_id=None):
        type(self).calls.append(
            {
                "message": message,
                "conversation_history": conversation_history,
                "task_id": task_id,
            }
        )
        if self.tool_progress_callback:
            self.tool_progress_callback("read_file", "test")
        return {"final_response": f"echo:{message}", "error": None}


class _FakeRunAgentModule:
    AIAgent = _FakeAgent


def test_persistent_session_manager_reuses_runtime() -> None:
    manager = hermes_client.PersistentSessionManager(max_sessions=8, idle_ttl_seconds=3600)

    created = {"count": 0}

    def make_agent():
        created["count"] += 1
        return object()

    first = manager.get_or_create(session_id="miniapp-u-1", model="m1", max_iterations=90, create_agent=make_agent)
    second = manager.get_or_create(session_id="miniapp-u-1", model="m1", max_iterations=90, create_agent=make_agent)

    assert first is second
    assert created["count"] == 1


def test_persistent_session_manager_evict_and_stats() -> None:
    manager = hermes_client.PersistentSessionManager(max_sessions=8, idle_ttl_seconds=3600)

    manager.get_or_create(session_id="miniapp-u-1", model="m1", max_iterations=90, create_agent=lambda: object())
    manager.get_or_create(session_id="miniapp-u-2", model="m1", max_iterations=90, create_agent=lambda: object())

    stats_before = manager.stats()
    assert stats_before["total"] == 2

    assert manager.evict("miniapp-u-1") is True
    assert manager.evict("missing") is False

    stats_after = manager.stats()
    assert stats_after["total"] == 1


def test_stream_events_prefers_persistent_runtime_when_enabled(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()

    monkeypatch.setattr(
        client,
        "_stream_via_persistent_agent",
        lambda **kwargs: iter(
            [
                {"type": "meta", "source": "agent-persistent"},
                {"type": "chunk", "text": "ok"},
                {"type": "done", "reply": "ok", "source": "agent-persistent", "latency_ms": 1},
            ]
        ),
    )

    # If the old paths are touched, this test should fail.
    monkeypatch.setattr(client, "_stream_via_agent", lambda **kwargs: (_ for _ in ()).throw(AssertionError("subprocess fallback should not run")))
    monkeypatch.setattr(client, "_stream_via_cli_progress", lambda **kwargs: (_ for _ in ()).throw(AssertionError("cli fallback should not run")))

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-7"))
    assert any(event.get("source") == "agent-persistent" for event in events)
    assert any(event.get("type") == "done" for event in events)


def test_persistent_agent_runtime_reuses_agent_for_same_session(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    _FakeAgent.created = 0
    _FakeAgent.calls = []
    monkeypatch.setitem(sys.modules, "run_agent", _FakeRunAgentModule())

    client = hermes_client.HermesClient()

    first = list(
        client._stream_via_persistent_agent(
            user_id="123",
            message="one",
            session_id="miniapp-123-9",
            conversation_history=[{"role": "operator", "body": "old"}],
        )
    )
    second = list(
        client._stream_via_persistent_agent(
            user_id="123",
            message="two",
            session_id="miniapp-123-9",
            conversation_history=[{"role": "operator", "body": "new"}],
        )
    )

    assert _FakeAgent.created == 1
    assert any(event.get("type") == "tool" for event in first)
    assert any(event.get("type") == "done" and event.get("reply") == "echo:one" for event in first)
    assert any(event.get("type") == "done" and event.get("reply") == "echo:two" for event in second)
    assert any(event.get("type") == "meta" and event.get("persistent_mode") == "bootstrap" for event in first)
    assert any(event.get("type") == "meta" and event.get("persistent_mode") == "live" for event in second)

    assert len(_FakeAgent.calls) == 2
    # first call bootstraps history
    assert _FakeAgent.calls[0]["conversation_history"] == [{"role": "user", "content": "old"}]
    # second call reuses in-memory checkpoint context to preserve continuity
    assert _FakeAgent.calls[1]["conversation_history"] == [
        {"role": "user", "content": "old"},
        {"role": "user", "content": "one"},
        {"role": "assistant", "content": "echo:one"},
    ]

    first_done = next(event for event in first if event.get("type") == "done")
    second_done = next(event for event in second if event.get("type") == "done")
    assert len(first_done.get("runtime_checkpoint") or []) == 3
    assert len(second_done.get("runtime_checkpoint") or []) == 5


def test_should_include_conversation_history_only_on_first_persistent_turn(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()
    session_id = "miniapp-42-1"

    assert client.should_include_conversation_history(session_id=session_id) is True

    runtime = client._session_manager.get_or_create(
        session_id=session_id,
        model=client.model,
        max_iterations=client.max_iterations,
        create_agent=lambda: object(),
    )
    assert client.should_include_conversation_history(session_id=session_id) is True

    runtime.bootstrapped = True
    assert client.should_include_conversation_history(session_id=session_id) is False


def test_restart_like_new_client_requires_bootstrap_again(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client1 = hermes_client.HermesClient()
    session_id = "miniapp-42-2"
    runtime = client1._session_manager.get_or_create(
        session_id=session_id,
        model=client1.model,
        max_iterations=client1.max_iterations,
        create_agent=lambda: object(),
    )
    runtime.bootstrapped = True
    assert client1.should_include_conversation_history(session_id=session_id) is False

    # New client instance simulates process restart: no in-memory runtimes survive.
    client2 = hermes_client.HermesClient()
    assert client2.should_include_conversation_history(session_id=session_id) is True


def test_stream_events_falls_back_when_persistent_path_raises_non_hermes_error(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()

    def blow_up(**kwargs):
        raise ModuleNotFoundError("No module named 'run_agent'")

    monkeypatch.setattr(client, "_stream_via_persistent_agent", blow_up)
    monkeypatch.setattr(
        client,
        "_stream_via_agent",
        lambda **kwargs: iter(
            [
                {"type": "meta", "source": "agent"},
                {"type": "chunk", "text": "fallback-ok"},
                {"type": "done", "reply": "fallback-ok", "source": "agent", "latency_ms": 1},
            ]
        ),
    )

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-fallback"))
    assert any(event.get("type") == "done" and event.get("reply") == "fallback-ok" for event in events)


def test_stream_events_logs_when_persistent_path_falls_back(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()

    warning_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class _Logger:
        @staticmethod
        def warning(*args, **kwargs):
            warning_calls.append((args, kwargs))

    monkeypatch.setattr(hermes_client, "logger", _Logger())

    def blow_up(**kwargs):
        raise ModuleNotFoundError("No module named 'run_agent'")

    monkeypatch.setattr(client, "_stream_via_persistent_agent", blow_up)
    monkeypatch.setattr(
        client,
        "_stream_via_agent",
        lambda **kwargs: iter(
            [
                {"type": "meta", "source": "agent"},
                {"type": "chunk", "text": "fallback-ok"},
                {"type": "done", "reply": "fallback-ok", "source": "agent", "latency_ms": 1},
            ]
        ),
    )

    list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-fallback-logs"))

    assert warning_calls
