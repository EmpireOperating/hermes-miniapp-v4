from __future__ import annotations

import os
import sys
import time

import hermes_client
import hermes_client_agent
import hermes_client_cli


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


class _FakeYAMLError(Exception):
    pass


class _FakeYAMLModuleParseError:
    YAMLError = _FakeYAMLError

    @staticmethod
    def safe_load(_payload: str):
        raise _FakeYAMLError("synthetic parse error")


class _FakeYAMLModuleTypedFields:
    YAMLError = _FakeYAMLError

    @staticmethod
    def safe_load(_payload: str):
        return {"model": {"default": 123, "base_url": []}}


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


def test_persistent_agent_passes_session_db_to_run_agent(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    _FakeAgent.created = 0
    _FakeAgent.calls = []
    monkeypatch.setitem(sys.modules, "run_agent", _FakeRunAgentModule())

    sentinel_db = object()
    monkeypatch.setattr(hermes_client.HermesClient, "_init_session_db", lambda self: sentinel_db)

    client = hermes_client.HermesClient()

    list(
        client._stream_via_persistent_agent(
            user_id="123",
            message="one",
            session_id="miniapp-123-db",
            conversation_history=[{"role": "operator", "body": "old"}],
        )
    )

    runtime = client._session_manager.get_runtime("miniapp-123-db")
    assert runtime is not None
    assert getattr(runtime.agent, "kwargs", {}).get("session_db") is sentinel_db


def test_persistent_agent_keeps_session_db_on_resumed_turn(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    _FakeAgent.created = 0
    _FakeAgent.calls = []
    monkeypatch.setitem(sys.modules, "run_agent", _FakeRunAgentModule())

    sentinel_db = object()
    monkeypatch.setattr(hermes_client.HermesClient, "_init_session_db", lambda self: sentinel_db)

    client = hermes_client.HermesClient()
    session_id = "miniapp-123-resume-db"

    list(
        client._stream_via_persistent_agent(
            user_id="123",
            message="first",
            session_id=session_id,
            conversation_history=[{"role": "operator", "body": "old"}],
        )
    )
    list(
        client._stream_via_persistent_agent(
            user_id="123",
            message="/resume",
            session_id=session_id,
            conversation_history=[{"role": "operator", "body": "ignored on resumed runtime"}],
        )
    )

    runtime = client._session_manager.get_runtime(session_id)
    assert runtime is not None
    assert _FakeAgent.created == 1
    assert runtime.bootstrapped is True
    assert getattr(runtime.agent, "kwargs", {}).get("session_db") is sentinel_db


def test_persistent_agent_stream_times_out_when_worker_stalls(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("HERMES_TIMEOUT_SECONDS", "1")

    class _SlowAgent:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.tool_progress_callback = kwargs.get("tool_progress_callback")

        def run_conversation(self, message, conversation_history=None, task_id=None):
            time.sleep(1.5)
            return {"final_response": "late", "error": None, "messages": []}

    class _SlowRunAgentModule:
        AIAgent = _SlowAgent

    monkeypatch.setitem(sys.modules, "run_agent", _SlowRunAgentModule())

    client = hermes_client.HermesClient()

    try:
        list(
            client._stream_via_persistent_agent(
                user_id="123",
                message="hello",
                session_id="miniapp-123-persistent-timeout",
                conversation_history=[{"role": "operator", "body": "old"}],
            )
        )
        raise AssertionError("Expected HermesClientError timeout")
    except hermes_client.HermesClientError as exc:
        text = str(exc).lower()
        assert "timed out" in text
        assert "miniapp-123-persistent-timeout" in text


def test_persistent_agent_wraps_worker_exception_as_hermes_client_error(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    class _FailingAgent:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def run_conversation(self, message, conversation_history=None, task_id=None):
            raise ValueError("synthetic persistent failure")

    class _FailingRunAgentModule:
        AIAgent = _FailingAgent

    monkeypatch.setitem(sys.modules, "run_agent", _FailingRunAgentModule())

    client = hermes_client.HermesClient()

    try:
        list(
            client._stream_via_persistent_agent(
                user_id="123",
                message="hello",
                session_id="miniapp-123-persistent-error",
                conversation_history=[{"role": "operator", "body": "old"}],
            )
        )
        raise AssertionError("Expected HermesClientError for worker failure")
    except hermes_client.HermesClientError as exc:
        assert "synthetic persistent failure" in str(exc)


def test_runtime_status_reports_recall_health(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    sentinel_db = object()
    monkeypatch.setattr(hermes_client.HermesClient, "_init_session_db", lambda self: sentinel_db)

    client = hermes_client.HermesClient()
    status = client.runtime_status()

    health = status.get("health") or {}
    assert health.get("session_db_available") is True
    assert health.get("agent_kwargs_has_session_db") is True
    assert health.get("agent_kwargs_session_db_available") is True
    assert health.get("session_search_ready") is True

    startup = status.get("startup") or {}
    startup_routing = startup.get("routing") or {}
    assert startup_routing.get("selected_transport") == "agent-persistent"
    assert startup_routing.get("direct_agent_enabled") is True


def test_init_logs_startup_diagnostics_without_secret_values(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "0")
    monkeypatch.setenv("HERMES_API_URL", "https://api.example/v1")
    monkeypatch.setenv("HERMES_BASE_URL", "https://upstream.example/v1?token=super-secret")
    monkeypatch.setattr(hermes_client.HermesClient, "_init_session_db", lambda self: None)

    info_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class _Logger:
        @staticmethod
        def info(*args, **kwargs):
            info_calls.append((args, kwargs))

        @staticmethod
        def warning(*args, **kwargs):
            return None

        @staticmethod
        def debug(*args, **kwargs):
            return None

    monkeypatch.setattr(hermes_client, "logger", _Logger())

    client = hermes_client.HermesClient()

    assert client.startup_diagnostics().get("routing", {}).get("selected_transport") == "http"
    assert info_calls

    args, kwargs = info_calls[0]
    assert args and args[0] == "HermesClient startup diagnostics"

    startup = (kwargs.get("extra") or {}).get("startup") or {}
    routing = startup.get("routing") or {}
    assert routing.get("api_url_configured") is True
    assert routing.get("base_url_configured") is True

    startup_repr = str(startup)
    assert "upstream.example" not in startup_repr
    assert "super-secret" not in startup_repr


def test_init_logs_warning_when_recall_is_unavailable_in_persistent_mode(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    warning_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class _Logger:
        @staticmethod
        def warning(*args, **kwargs):
            warning_calls.append((args, kwargs))

        @staticmethod
        def debug(*args, **kwargs):
            return None

    monkeypatch.setattr(hermes_client, "logger", _Logger())
    monkeypatch.setattr(hermes_client.HermesClient, "_init_session_db", lambda self: None)

    client = hermes_client.HermesClient()

    assert client._session_db is None
    assert warning_calls
    _, kwargs = warning_calls[0]
    assert (kwargs.get("extra") or {}).get("session_db_available") is False
    assert (kwargs.get("extra") or {}).get("agent_kwargs_has_session_db") is True
    assert (kwargs.get("extra") or {}).get("agent_kwargs_session_db_available") is False
    assert (kwargs.get("extra") or {}).get("persistent_sessions_enabled") is True


def test_build_agent_kwargs_warns_once_when_session_db_missing(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    warning_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class _Logger:
        @staticmethod
        def warning(*args, **kwargs):
            warning_calls.append((args, kwargs))

        @staticmethod
        def debug(*args, **kwargs):
            return None

    monkeypatch.setattr(hermes_client_agent, "logger", _Logger())
    monkeypatch.setattr(hermes_client.HermesClient, "_init_session_db", lambda self: None)

    client = hermes_client.HermesClient()

    # Boot recall self-check triggers one warning via _build_agent_kwargs.
    assert len(warning_calls) == 1
    _, first_kwargs = warning_calls[0]
    assert (first_kwargs.get("extra") or {}).get("session_id") == "miniapp-healthcheck"

    first = client._build_agent_kwargs(session_id="miniapp-123-1", tool_progress_callback=lambda *a, **k: None)
    second = client._build_agent_kwargs(session_id="miniapp-123-2", tool_progress_callback=lambda *a, **k: None)

    assert first.get("session_db") is None
    assert second.get("session_db") is None
    assert len(warning_calls) == 1


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

        @staticmethod
        def debug(*args, **kwargs):
            return None

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
    _, kwargs = warning_calls[0]
    assert (kwargs.get("extra") or {}).get("session_id") == "miniapp-123-fallback-logs"
    assert "fallback_to" in (kwargs.get("extra") or {})


def test_stream_url_takes_precedence_over_api_and_agent(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_STREAM_URL", "https://stream.example")
    monkeypatch.setenv("HERMES_API_URL", "https://api.example")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()

    def fake_stream(url, *, user_id, message):
        assert url == "https://stream.example"
        assert user_id == "123"
        assert message == "hello"
        return iter(["s", "tream"])

    monkeypatch.setattr(client, "_stream_via_http", fake_stream)
    monkeypatch.setattr(client, "_stream_via_agent", lambda **kwargs: (_ for _ in ()).throw(AssertionError("agent fallback should not run")))
    monkeypatch.setattr(client, "_stream_via_cli_progress", lambda **kwargs: (_ for _ in ()).throw(AssertionError("cli fallback should not run")))

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-http-precedence"))

    assert events[0].get("type") == "meta"
    assert events[0].get("source") == "http-stream"
    assert any(event.get("type") == "done" and event.get("reply") == "stream" and event.get("source") == "http-stream" for event in events)


def test_api_stream_error_falls_back_to_direct_agent_before_cli(monkeypatch) -> None:
    monkeypatch.delenv("HERMES_STREAM_URL", raising=False)
    monkeypatch.setenv("HERMES_API_URL", "https://api.example")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")

    client = hermes_client.HermesClient()

    def blow_up_http(*args, **kwargs):
        raise hermes_client.HermesClientError("http stream failed")

    monkeypatch.setattr(client, "_stream_via_http", blow_up_http)
    monkeypatch.setattr(
        client,
        "_stream_via_agent",
        lambda **kwargs: iter(
            [
                {"type": "meta", "source": "agent"},
                {"type": "chunk", "text": "agent-ok"},
                {"type": "done", "reply": "agent-ok", "source": "agent", "latency_ms": 1},
            ]
        ),
    )
    monkeypatch.setattr(client, "_stream_via_cli_progress", lambda **kwargs: (_ for _ in ()).throw(AssertionError("cli fallback should not run")))

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-agent-fallback"))
    assert any(event.get("type") == "done" and event.get("reply") == "agent-ok" and event.get("source") == "agent" for event in events)


def test_api_stream_error_falls_back_to_cli_when_direct_agent_disabled(monkeypatch) -> None:
    monkeypatch.delenv("HERMES_STREAM_URL", raising=False)
    monkeypatch.setenv("HERMES_API_URL", "https://api.example")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "0")

    client = hermes_client.HermesClient()

    def blow_up_http(*args, **kwargs):
        raise hermes_client.HermesClientError("http stream failed")

    monkeypatch.setattr(client, "_stream_via_http", blow_up_http)
    monkeypatch.setattr(client, "_stream_via_agent", lambda **kwargs: (_ for _ in ()).throw(AssertionError("agent path should be disabled")))
    monkeypatch.setattr(
        client,
        "_stream_via_cli_progress",
        lambda **kwargs: iter(
            [
                {"type": "meta", "source": "cli"},
                {"type": "chunk", "text": "cli-ok"},
                {"type": "done", "reply": "cli-ok", "source": "cli", "latency_ms": 1},
            ]
        ),
    )

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-cli-fallback"))
    assert any(event.get("type") == "done" and event.get("reply") == "cli-ok" and event.get("source") == "cli" for event in events)


def test_malformed_auth_store_logs_structured_warning_and_falls_back(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_AGENT_HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "0")
    monkeypatch.setattr(hermes_client.HermesClient, "_init_session_db", lambda self: None)

    auth_path = tmp_path / "auth.json"
    auth_path.write_text("{not-json", encoding="utf-8")

    warning_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class _Logger:
        @staticmethod
        def warning(*args, **kwargs):
            warning_calls.append((args, kwargs))

        @staticmethod
        def debug(*args, **kwargs):
            return None

    monkeypatch.setattr(hermes_client, "logger", _Logger())

    client = hermes_client.HermesClient()
    assert client._load_active_provider_from_auth_store() is None

    assert warning_calls
    _, kwargs = warning_calls[0]
    extra = kwargs.get("extra") or {}
    assert extra.get("path") == str(auth_path)
    assert extra.get("failure_class") == "JSONDecodeError"
    assert extra.get("reason")


def test_malformed_config_yaml_logs_structured_warning_and_falls_back(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_AGENT_HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "0")
    monkeypatch.setattr(hermes_client.HermesClient, "_init_session_db", lambda self: None)
    monkeypatch.setitem(sys.modules, "yaml", _FakeYAMLModuleParseError())

    config_path = tmp_path / "config.yaml"
    config_path.write_text("model: [", encoding="utf-8")

    warning_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class _Logger:
        @staticmethod
        def warning(*args, **kwargs):
            warning_calls.append((args, kwargs))

        @staticmethod
        def debug(*args, **kwargs):
            return None

    monkeypatch.setattr(hermes_client, "logger", _Logger())

    client = hermes_client.HermesClient()
    assert client._load_model_cfg_from_config() is None

    assert warning_calls
    _, kwargs = warning_calls[0]
    extra = kwargs.get("extra") or {}
    assert extra.get("path") == str(config_path)
    assert extra.get("failure_class")
    assert extra.get("reason")


def test_non_utf8_auth_store_logs_structured_warning_and_falls_back(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_AGENT_HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "0")
    monkeypatch.setattr(hermes_client.HermesClient, "_init_session_db", lambda self: None)

    auth_path = tmp_path / "auth.json"
    auth_path.write_bytes(b"\xff\xfe\x00\x80")

    warning_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class _Logger:
        @staticmethod
        def warning(*args, **kwargs):
            warning_calls.append((args, kwargs))

        @staticmethod
        def debug(*args, **kwargs):
            return None

    monkeypatch.setattr(hermes_client, "logger", _Logger())

    client = hermes_client.HermesClient()
    assert client._load_active_provider_from_auth_store() is None

    assert warning_calls
    _, kwargs = warning_calls[0]
    extra = kwargs.get("extra") or {}
    assert extra.get("path") == str(auth_path)
    assert extra.get("failure_class") == "UnicodeDecodeError"
    assert extra.get("reason")


def test_non_utf8_config_yaml_logs_structured_warning_and_falls_back(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_AGENT_HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "0")
    monkeypatch.setattr(hermes_client.HermesClient, "_init_session_db", lambda self: None)
    monkeypatch.setitem(sys.modules, "yaml", _FakeYAMLModuleParseError())

    config_path = tmp_path / "config.yaml"
    config_path.write_bytes(b"\xff\xfe\x00\x80")

    warning_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class _Logger:
        @staticmethod
        def warning(*args, **kwargs):
            warning_calls.append((args, kwargs))

        @staticmethod
        def debug(*args, **kwargs):
            return None

    monkeypatch.setattr(hermes_client, "logger", _Logger())

    client = hermes_client.HermesClient()
    assert client._load_model_cfg_from_config() is None

    assert warning_calls
    _, kwargs = warning_calls[0]
    extra = kwargs.get("extra") or {}
    assert extra.get("path") == str(config_path)
    assert extra.get("failure_class") == "UnicodeDecodeError"
    assert extra.get("reason")


def test_invalid_model_fields_log_reasoned_warnings_and_keep_fallbacks(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_AGENT_HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "0")
    monkeypatch.setenv("HERMES_MODEL", "forced-model")
    monkeypatch.setenv("HERMES_PROVIDER", "forced-provider")
    monkeypatch.setenv("HERMES_BASE_URL", "https://forced.example")
    monkeypatch.setattr(hermes_client.HermesClient, "_init_session_db", lambda self: None)
    monkeypatch.setitem(sys.modules, "yaml", _FakeYAMLModuleTypedFields())

    config_path = tmp_path / "config.yaml"
    config_path.write_text("model:\n  default: 123\n  base_url: []\n", encoding="utf-8")

    warning_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class _Logger:
        @staticmethod
        def warning(*args, **kwargs):
            warning_calls.append((args, kwargs))

        @staticmethod
        def debug(*args, **kwargs):
            return None

    monkeypatch.setattr(hermes_client, "logger", _Logger())

    client = hermes_client.HermesClient()
    assert client._load_default_model_from_config() is None
    assert client._load_base_url_from_config() is None

    reasons = [(kwargs.get("extra") or {}).get("reason") for _, kwargs in warning_calls]
    assert f"model.default_not_nonempty_string:{int.__name__}" in reasons
    assert f"model.base_url_not_nonempty_string:{list.__name__}" in reasons
    for _, kwargs in warning_calls:
        assert (kwargs.get("extra") or {}).get("path") == str(config_path)


class _FakeStdin:
    def __init__(self) -> None:
        self.writes: list[str] = []
        self.closed = False
        self.close_calls = 0

    def write(self, data: str) -> int:
        self.writes.append(data)
        return len(data)

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True


class _BlockingStdout:
    def __init__(self) -> None:
        self.closed = False
        self.close_calls = 0

    def __iter__(self):
        return self

    def __next__(self) -> str:
        time.sleep(2.0)
        raise StopIteration

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True


class _LineStream:
    def __init__(self, lines: list[str]) -> None:
        self._lines = list(lines)
        self.closed = False
        self.close_calls = 0

    def __iter__(self):
        return iter(self._lines)

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True


class _RaisingCloseLineStream(_LineStream):
    def close(self) -> None:
        self.close_calls += 1
        self.closed = True
        raise RuntimeError("synthetic close failure")


class _FakeProcess:
    def __init__(self, *, stdout, stderr, wait_return_code: int = 0) -> None:
        self.stdin = _FakeStdin()
        self.stdout = stdout
        self.stderr = stderr
        self._wait_return_code = int(wait_return_code)
        self.returncode: int | None = None
        self.killed = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = -9 if self.killed else self._wait_return_code
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


def test_stream_via_cli_progress_supports_iterator_only_stdout(monkeypatch) -> None:
    client = hermes_client.HermesClient()

    def fake_popen(*args, **kwargs):
        return _FakeProcess(
            stdout=_LineStream(
                [
                    "ignored before query\n",
                    "Query: hello\n",
                    "⚙️ read_file (0.2s)\n",
                    "⚕ Hermes\n",
                    "reply from iterator stdout\n",
                    "Duration: 1.2s\n",
                ]
            ),
            stderr=_LineStream([]),
            wait_return_code=0,
        )

    monkeypatch.setattr(hermes_client_cli.subprocess, "Popen", fake_popen)

    events = list(client._stream_via_cli_progress("hello"))
    assert any(event.get("type") == "tool" and event.get("display") == "⚙️ read_file" for event in events)
    assert any(event.get("type") == "done" and event.get("reply") == "reply from iterator stdout" for event in events)


def test_stream_via_agent_runner_script_does_not_duplicate_tool_formatter_map() -> None:
    client = hermes_client.HermesClient()
    script = client._agent_runner_script()

    assert "tool_emojis = {" not in script
    assert "'display': format_tool_progress(" not in script


def test_stream_via_agent_formats_tool_display_in_parent(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("HERMES_TIMEOUT_SECONDS", "2")

    client = hermes_client.HermesClient()
    monkeypatch.setattr(os.path, "exists", lambda _path: True)

    def fake_popen(*args, **kwargs):
        process = _FakeProcess(
            stdout=_LineStream(
                [
                    '{"kind":"tool","tool_name":"read_file","preview":"alpha","args":{"path":"/tmp/x"}}\n',
                    '{"kind":"done","reply":"ok","source":"agent","latency_ms":1}\n',
                ]
            ),
            stderr=_LineStream([]),
            wait_return_code=0,
        )
        process.returncode = 0
        return process

    monkeypatch.setattr(hermes_client_agent.subprocess, "Popen", fake_popen)

    events = list(client._stream_via_agent(user_id="123", message="hello", session_id="miniapp-123-tool-display"))
    tool_event = next(event for event in events if event.get("type") == "tool")
    assert tool_event.get("display") == '📖 read_file: "alpha"'


def test_shim_logger_proxy_is_used_by_direct_module_cleanup(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("HERMES_TIMEOUT_SECONDS", "2")

    client = hermes_client.HermesClient()
    monkeypatch.setattr(os.path, "exists", lambda _path: True)

    debug_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class _Logger:
        @staticmethod
        def debug(*args, **kwargs):
            debug_calls.append((args, kwargs))

    original_logger = hermes_client_agent.logger

    def fake_popen(*args, **kwargs):
        process = _FakeProcess(
            stdout=_RaisingCloseLineStream(['{"kind":"done","reply":"ok","source":"agent","latency_ms":1}\n']),
            stderr=_RaisingCloseLineStream([]),
            wait_return_code=0,
        )
        process.returncode = 0
        return process

    try:
        hermes_client_agent.logger = _Logger()
        monkeypatch.setattr(hermes_client_agent.subprocess, "Popen", fake_popen)

        events = list(client._stream_via_agent(user_id="123", message="hello", session_id="miniapp-123-logger-proxy"))
        assert any(event.get("type") == "done" and event.get("reply") == "ok" for event in events)
        assert any(args and "close failed" in str(args[0]) for args, _kwargs in debug_calls)
    finally:
        hermes_client_agent.logger = original_logger


def test_shim_subprocess_proxy_supports_module_replacement(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("HERMES_TIMEOUT_SECONDS", "2")

    client = hermes_client.HermesClient()
    monkeypatch.setattr(os.path, "exists", lambda _path: True)

    calls = {"popen": 0}

    class _ReplacementSubprocess:
        PIPE = object()
        TimeoutExpired = TimeoutError

        @staticmethod
        def Popen(*args, **kwargs):
            calls["popen"] += 1
            process = _FakeProcess(
                stdout=_LineStream(['{"kind":"done","reply":"ok","source":"agent","latency_ms":1}\n']),
                stderr=_LineStream([]),
                wait_return_code=0,
            )
            process.returncode = 0
            return process

    original_subprocess = hermes_client_agent.subprocess
    try:
        hermes_client_agent.subprocess = _ReplacementSubprocess
        events = list(client._stream_via_agent(user_id="123", message="hello", session_id="miniapp-123-subprocess-proxy"))
        assert calls["popen"] == 1
        assert any(event.get("type") == "done" and event.get("reply") == "ok" for event in events)
    finally:
        hermes_client_agent.subprocess = original_subprocess


def test_stream_via_agent_closes_stdio_handles_on_success(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("HERMES_TIMEOUT_SECONDS", "2")

    client = hermes_client.HermesClient()
    monkeypatch.setattr(os.path, "exists", lambda _path: True)

    process_holder: dict[str, _FakeProcess] = {}

    def fake_popen(*args, **kwargs):
        process = _FakeProcess(
            stdout=_LineStream(['{"kind":"done","reply":"ok","source":"agent","latency_ms":1}\n']),
            stderr=_LineStream([]),
            wait_return_code=0,
        )
        process.returncode = 0
        process_holder["process"] = process
        return process

    monkeypatch.setattr(hermes_client_agent.subprocess, "Popen", fake_popen)

    events = list(client._stream_via_agent(user_id="123", message="hello", session_id="miniapp-123-success"))
    assert any(event.get("type") == "done" and event.get("reply") == "ok" for event in events)

    process = process_holder["process"]
    assert process.stdin.close_calls == 1
    assert process.stdout.close_calls == 1
    assert process.stderr.close_calls == 1


def test_stream_via_agent_times_out_and_kills_stalled_process(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("HERMES_TIMEOUT_SECONDS", "1")

    client = hermes_client.HermesClient()
    monkeypatch.setattr(os.path, "exists", lambda _path: True)

    process_holder: dict[str, _FakeProcess] = {}

    def fake_popen(*args, **kwargs):
        process = _FakeProcess(stdout=_BlockingStdout(), stderr=_LineStream(["still running\n"]), wait_return_code=0)
        process_holder["process"] = process
        return process

    monkeypatch.setattr(hermes_client_agent.subprocess, "Popen", fake_popen)

    try:
        list(client._stream_via_agent(user_id="123", message="hello", session_id="miniapp-123-timeout"))
        raise AssertionError("Expected HermesClientError timeout")
    except hermes_client.HermesClientError as exc:
        assert "timed out" in str(exc).lower()

    process = process_holder["process"]
    assert process.killed is True
    assert process.stdin.close_calls == 1
    assert process.stdout.close_calls == 1
    assert process.stderr.close_calls == 1


def test_stream_via_agent_surfaces_stderr_on_nonzero_exit(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("HERMES_TIMEOUT_SECONDS", "2")

    client = hermes_client.HermesClient()
    monkeypatch.setattr(os.path, "exists", lambda _path: True)

    process_holder: dict[str, _FakeProcess] = {}

    def fake_popen(*args, **kwargs):
        process = _FakeProcess(stdout=_LineStream([]), stderr=_LineStream(["agent crashed\n"]), wait_return_code=2)
        process.returncode = 2
        process_holder["process"] = process
        return process

    monkeypatch.setattr(hermes_client_agent.subprocess, "Popen", fake_popen)

    try:
        list(client._stream_via_agent(user_id="123", message="hello", session_id="miniapp-123-stderr"))
        raise AssertionError("Expected HermesClientError for non-zero exit")
    except hermes_client.HermesClientError as exc:
        assert "agent crashed" in str(exc)

    process = process_holder["process"]
    assert process.stdin.close_calls == 1
    assert process.stdout.close_calls == 1
    assert process.stderr.close_calls == 1
