from __future__ import annotations

import hermes_client
from server_test_utils import load_server


def test_forensics_signature_fallback_cascade_persistent_to_direct_to_cli(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=71, job_id=9910, session_id="miniapp-123-71")

    def persistent_fail(**kwargs):
        raise RuntimeError("synthetic persistent blowup")

    def direct_fail(**kwargs):
        raise hermes_client.HermesClientError("synthetic direct blowup")

    monkeypatch.setattr(client, "_stream_via_persistent_agent", persistent_fail)
    monkeypatch.setattr(client, "_stream_via_agent", direct_fail)
    monkeypatch.setattr(
        client,
        "_stream_via_cli_progress",
        lambda **kwargs: iter(
            [
                {"type": "meta", "source": "cli"},
                {"type": "chunk", "text": "cli-fallback-ok"},
                {"type": "done", "reply": "cli-fallback-ok", "source": "cli", "latency_ms": 1},
            ]
        ),
    )

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-71"))
    assert any(event.get("type") == "done" and event.get("source") == "cli" for event in events)

    transitions = client.child_spawn_diagnostics().get("recent_transport_transitions") or []
    assert any(
        str(item.get("previous_path")) == "agent-persistent"
        and str(item.get("next_path")) == "agent"
        and str(item.get("reason") or "").startswith("persistent_failure:")
        and int(item.get("chat_id") or 0) == 71
        and int(item.get("job_id") or 0) == 9910
        for item in transitions
    )
    assert any(
        str(item.get("previous_path")) == "agent"
        and str(item.get("next_path")) == "cli"
        and str(item.get("reason") or "").startswith("direct_failure:")
        and int(item.get("chat_id") or 0) == 71
        and int(item.get("job_id") or 0) == 9910
        for item in transitions
    )


def test_forensics_signature_direct_spawn_cap_blocks_cli_fallback(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=72, job_id=9911, session_id="miniapp-123-72")

    def direct_spawn_cap_fail(**kwargs):
        raise hermes_client.HermesClientError("Hermes child spawn cap reached for job 9911 (1/1).")

    monkeypatch.setattr(client, "_stream_via_agent", direct_spawn_cap_fail)
    monkeypatch.setattr(
        client,
        "_stream_via_cli_progress",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("cli fallback should be blocked for direct spawn-cap failures")),
    )

    try:
        list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-72"))
        raise AssertionError("Expected direct spawn-cap HermesClientError")
    except hermes_client.HermesClientError as exc:
        assert "child spawn cap reached" in str(exc).lower()

    transitions = client.child_spawn_diagnostics().get("recent_transport_transitions") or []
    assert any(
        str(item.get("previous_path")) == "agent"
        and str(item.get("next_path")) == "agent"
        and str(item.get("reason") or "").startswith("direct_failure_no_cli_fallback:")
        and int(item.get("chat_id") or 0) == 72
        and int(item.get("job_id") or 0) == 9911
        for item in transitions
    )
    assert not any(
        str(item.get("previous_path")) == "agent"
        and str(item.get("next_path")) == "cli"
        and str(item.get("reason") or "").startswith("direct_failure:")
        and int(item.get("chat_id") or 0) == 72
        and int(item.get("job_id") or 0) == 9911
        for item in transitions
    )


def test_forensics_signature_resume_relaunch_across_two_chats(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "0")

    client = hermes_client.HermesClient()
    monkeypatch.setattr(
        client,
        "_stream_via_cli_progress",
        lambda **kwargs: iter(
            [
                {"type": "meta", "source": "cli"},
                {"type": "done", "reply": "ok", "source": "cli", "latency_ms": 1},
            ]
        ),
    )

    client.set_spawn_trace_context(user_id="123", chat_id=1001, job_id=5001, session_id="miniapp-123-1001")
    list(client.stream_events(user_id="123", message="/resume", session_id="miniapp-123-1001"))

    client.set_spawn_trace_context(user_id="123", chat_id=1002, job_id=5002, session_id="miniapp-123-1002")
    list(client.stream_events(user_id="123", message="/resume", session_id="miniapp-123-1002"))

    transitions = client.child_spawn_diagnostics().get("recent_transport_transitions") or []
    resume_events = [
        item
        for item in transitions
        if str(item.get("previous_path")) == str(item.get("next_path")) == "cli"
        and str(item.get("reason") or "").startswith("resume_relaunch:")
    ]

    assert len(resume_events) >= 2
    assert {str(item.get("session_id")) for item in resume_events} >= {"miniapp-123-1001", "miniapp-123-1002"}


def test_forensics_signature_child_fanout_hotspot_and_cap_hit(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_TOTAL", "8")
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_CHAT", "4")
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_JOB", "3")
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_SESSION", "4")

    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=55, job_id=777, session_id="miniapp-123-55")

    client.register_child_spawn(transport="agent-direct", pid=51001, command=["python", "worker.py"], session_id="miniapp-123-55")
    client.register_child_spawn(transport="agent-direct", pid=51002, command=["python", "worker.py"], session_id="miniapp-123-55")
    client.register_child_spawn(transport="agent-direct", pid=51003, command=["python", "worker.py"], session_id="miniapp-123-55")

    try:
        client.register_child_spawn(transport="agent-direct", pid=51004, command=["python", "worker.py"], session_id="miniapp-123-55")
        raise AssertionError("Expected per-job cap failure")
    except hermes_client.HermesClientError as exc:
        assert "job 777" in str(exc)

    diagnostics = client.child_spawn_diagnostics()
    assert diagnostics["active_by_job"] == {"777": 3}
    assert diagnostics["active_by_chat"] == {"55": 3}
    assert diagnostics["high_water_by_job"].get("777") == 3
    assert diagnostics["high_water_by_chat"].get("55") == 3

    for pid in (51001, 51002, 51003):
        client.deregister_child_spawn(pid=pid, outcome="completed", return_code=0)


def test_forensics_signature_duplicate_runner_counter(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    runtime = server._RUNTIME_DEPS.bind_runtime()

    user_id = "dup-user"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "hello")
    _ = server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)

    monkeypatch.setattr(runtime, "_try_start_job_runner", lambda **kwargs: False)

    runtime._process_available_jobs_once()

    diagnostics = runtime.runtime_diagnostics()
    assert int((diagnostics.get("counters") or {}).get("duplicate_runner_reject") or 0) >= 1
