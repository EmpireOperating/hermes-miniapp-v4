from __future__ import annotations

import logging
import queue
import sqlite3
import time

from server_test_utils import load_server, patch_verified_user


def _authed_client(monkeypatch, tmp_path, **load_kwargs):
    server = load_server(monkeypatch, tmp_path, **load_kwargs)
    client = server.app.test_client()
    patch_verified_user(monkeypatch, server)
    return server, client

def test_detects_stale_chat_job_errors(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    assert server._is_stale_chat_job_error(KeyError("Chat 22 not found")) is True
    assert server._is_stale_chat_job_error(RuntimeError("Chat 22 not found")) is False
    assert server._is_stale_chat_job_error(KeyError("Message 22 not found")) is False

def test_jobs_status_endpoint_returns_jobs_and_dead_letters(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "job")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id, max_attempts=1)
    server.store.claim_next_job()
    server.store.retry_or_dead_letter_job(job_id, "hard fail", retry_base_seconds=1)

    response = client.post("/api/jobs/status", json={"init_data": "ok", "limit": 10})

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert "summary" in data
    assert any(job["id"] == job_id for job in data["jobs"])
    assert data["summary"]["dead_letter_count"] >= 1

def test_jobs_cleanup_endpoint_dead_letters_stale_jobs(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    stale_chat = server.store.create_chat("123", "Stale")
    operator_message_id = server.store.add_message("123", stale_chat.id, "operator", "stale")
    job_id = server.store.enqueue_chat_job("123", stale_chat.id, operator_message_id)

    # Simulate stale open job by archiving the chat directly (legacy state).
    conn = sqlite3.connect(server.store.db_path)
    conn.execute("UPDATE chat_threads SET is_archived = 1 WHERE user_id = ? AND id = ?", ("123", stale_chat.id))
    conn.commit()
    conn.close()

    response = client.post("/api/jobs/cleanup", json={"init_data": "ok", "limit": 50})

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert data["cleaned_count"] >= 1
    assert any(item["job_id"] == job_id for item in data["cleaned"])

    state = server.store.get_job_state(job_id)
    assert state is not None
    assert state["status"] == "dead"

def test_jobs_status_endpoint_rejects_non_integer_limit(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = client.post("/api/jobs/status", json={"init_data": "ok", "limit": "abc"})

    assert response.status_code == 400
    assert "limit" in response.get_json()["error"].lower()

def test_jobs_cleanup_endpoint_rejects_non_integer_limit(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = client.post("/api/jobs/cleanup", json={"init_data": "ok", "limit": "abc"})

    assert response.status_code == 400
    assert "limit" in response.get_json()["error"].lower()

def test_runtime_status_endpoint_returns_persistent_stats(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)
    monkeypatch.setattr(
        server.client,
        "runtime_status",
        lambda: {
            "persistent": {"enabled": True, "total": 2, "bootstrapped": 1, "unbootstrapped": 1},
            "routing": {
                "model": "gpt-5.3-codex",
                "provider": "openai-codex",
                "base_url": "https://chatgpt.com/backend-api/codex",
                "direct_agent_enabled": True,
                "persistent_sessions_enabled": True,
            },
            "health": {
                "session_db_available": True,
                "agent_kwargs_has_session_db": True,
                "agent_kwargs_session_db_available": True,
                "session_search_ready": True,
            },
        },
    )

    response = client.post("/api/runtime/status", json={"init_data": "ok"})

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert data["persistent"]["enabled"] is True
    assert data["persistent"]["total"] == 2
    assert data["routing"]["provider"] == "openai-codex"
    assert data["routing"]["direct_agent_enabled"] is True
    assert data["health"]["session_db_available"] is True
    assert data["health"]["agent_kwargs_has_session_db"] is True
    assert data["health"]["agent_kwargs_session_db_available"] is True
    assert data["health"]["session_search_ready"] is True

def test_run_chat_job_skips_db_history_when_runtime_already_bootstrapped(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    server.store.add_message(user_id, chat_id, "operator", "older context")
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "latest question")
    server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = server.store.claim_next_job()
    assert job is not None

    captured = {"history": "unset"}

    monkeypatch.setattr(server.client, "should_include_conversation_history", lambda session_id: False)

    def fake_stream_events(*, user_id, message, conversation_history, session_id):
        captured["history"] = conversation_history
        yield {"type": "meta", "source": "agent-persistent"}
        yield {"type": "done", "reply": "ok", "latency_ms": 1}

    monkeypatch.setattr(server.client, "stream_events", fake_stream_events)

    server._run_chat_job(job)

    assert captured["history"] == []
    latest = server.store.get_history(user_id=user_id, chat_id=chat_id, limit=5)
    assert any(turn.role == "hermes" and "ok" in turn.body for turn in latest)

def test_run_chat_job_uses_runtime_checkpoint_when_bootstrapping(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "latest question")
    session_id = f"miniapp-{user_id}-{chat_id}"
    checkpoint_history = [
        {"role": "system", "content": "You are Hermes."},
        {"role": "user", "content": "Older user turn"},
    ]
    server.store.set_runtime_checkpoint(
        session_id=session_id,
        user_id=user_id,
        chat_id=chat_id,
        history=checkpoint_history,
    )

    server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = server.store.claim_next_job()
    assert job is not None

    captured = {"history": None}
    monkeypatch.setattr(server.client, "should_include_conversation_history", lambda session_id: True)

    def fake_stream_events(*, user_id, message, conversation_history, session_id):
        captured["history"] = conversation_history
        yield {"type": "meta", "source": "agent-persistent"}
        yield {"type": "done", "reply": "ok", "latency_ms": 1}

    monkeypatch.setattr(server.client, "stream_events", fake_stream_events)

    server._run_chat_job(job)

    assert captured["history"] == checkpoint_history

def test_run_chat_job_persists_runtime_checkpoint_from_done_event(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "latest question")
    session_id = f"miniapp-{user_id}-{chat_id}"

    server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = server.store.claim_next_job()
    assert job is not None

    monkeypatch.setattr(server.client, "should_include_conversation_history", lambda session_id: False)

    checkpoint_history = [
        {"role": "system", "content": "You are Hermes."},
        {"role": "user", "content": "latest question"},
        {"role": "assistant", "content": "ok"},
    ]

    def fake_stream_events(*, user_id, message, conversation_history, session_id):
        yield {"type": "meta", "source": "agent-persistent"}
        yield {"type": "done", "reply": "ok", "latency_ms": 1, "runtime_checkpoint": checkpoint_history}

    monkeypatch.setattr(server.client, "stream_events", fake_stream_events)

    server._run_chat_job(job)

    stored = server.store.get_runtime_checkpoint(session_id)
    assert stored == checkpoint_history


def test_publish_job_event_throttles_touch_job_frequency(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    user_id = "touch-user"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "touch test")
    job_id = server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    claimed = server.store.claim_next_job()
    assert claimed is not None

    server.runtime.job_touch_min_interval_seconds = 0.25

    touch_calls: list[tuple[int, float]] = []
    original_touch_job = server.store.touch_job

    def tracking_touch_job(touched_job_id: int) -> None:
        touch_calls.append((int(touched_job_id), time.monotonic()))
        original_touch_job(touched_job_id)

    monkeypatch.setattr(server.store, "touch_job", tracking_touch_job)

    for _ in range(4):
        server._publish_job_event(job_id, "meta", {"chat_id": chat_id, "source": "test"})

    job_touch_calls = [call for call in touch_calls if call[0] == job_id]
    assert len(job_touch_calls) == 1

    time.sleep(0.3)
    server._publish_job_event(job_id, "meta", {"chat_id": chat_id, "source": "test-2"})
    job_touch_calls = [call for call in touch_calls if call[0] == job_id]
    assert len(job_touch_calls) == 2


def test_publish_job_event_delivers_done_when_subscriber_queue_is_full(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    user_id = "terminal-overflow"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "overflow")
    job_id = server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    claimed = server.store.claim_next_job()
    assert claimed is not None
    assert claimed["id"] == job_id

    saturated_subscriber: queue.Queue[dict[str, object]] = queue.Queue(maxsize=1)
    saturated_subscriber.put_nowait({"event": "chunk", "payload": {"text": "old"}})

    with server.runtime._event_lock:
        server.runtime._event_queues[job_id] = [saturated_subscriber]

    server._publish_job_event(job_id, "done", {"chat_id": chat_id, "reply": "ok", "latency_ms": 1})

    delivered = saturated_subscriber.get_nowait()
    assert delivered["event"] == "done"
    assert delivered["payload"]["reply"] == "ok"


def test_run_chat_job_keeps_running_job_fresh_during_silent_upstream_wait(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "wait")

    server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = server.store.claim_next_job()
    assert job is not None

    monkeypatch.setattr(server.client, "should_include_conversation_history", lambda session_id: False)
    server.runtime.job_keepalive_interval_seconds = 0.5

    touch_calls: list[float] = []
    original_touch_job = server.store.touch_job

    def tracking_touch_job(job_id: int) -> None:
        touch_calls.append(time.monotonic())
        original_touch_job(job_id)

    monkeypatch.setattr(server.store, "touch_job", tracking_touch_job)

    def fake_stream_events(*, user_id, message, conversation_history, session_id):
        time.sleep(0.7)
        yield {"type": "done", "reply": "ok", "latency_ms": 1}

    monkeypatch.setattr(server.client, "stream_events", fake_stream_events)

    server._run_chat_job(job)

    assert len(touch_calls) >= 2


def test_touch_job_best_effort_records_failure_and_logs_warning(monkeypatch, tmp_path, caplog) -> None:
    server = load_server(monkeypatch, tmp_path)

    def failing_touch_job(job_id: int) -> None:
        raise RuntimeError("touch failed")

    monkeypatch.setattr(server.runtime.store, "touch_job", failing_touch_job)

    with caplog.at_level(logging.WARNING, logger="job_runtime"):
        server.runtime._touch_job_best_effort(42, force=True)

    counts = server.runtime.best_effort_failure_counts()
    assert counts["touch_job_write"] == 1
    assert counts["system_message_write"] == 0
    assert any("best_effort_write_failure kind=touch_job_write" in message for message in caplog.messages)


def test_safe_add_system_message_records_failure_and_logs_warning(monkeypatch, tmp_path, caplog) -> None:
    server = load_server(monkeypatch, tmp_path)

    def failing_add_message(*args, **kwargs):
        raise RuntimeError("insert failed")

    monkeypatch.setattr(server.runtime.store, "add_message", failing_add_message)

    with caplog.at_level(logging.WARNING, logger="job_runtime"):
        server.runtime._safe_add_system_message(user_id="123", chat_id=99, text="hello")

    counts = server.runtime.best_effort_failure_counts()
    assert counts["touch_job_write"] == 0
    assert counts["system_message_write"] == 1
    assert any("best_effort_write_failure kind=system_message_write" in message for message in caplog.messages)
