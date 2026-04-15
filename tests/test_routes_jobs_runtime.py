from __future__ import annotations

import logging
import os
import queue
import sqlite3
import time
from types import SimpleNamespace

from job_runtime import JobDuplicateRunnerSuppressed, JobRetryableError
from job_runtime_diagnostics import build_runtime_diagnostics
from job_runtime_loop import process_available_jobs_once as helper_process_available_jobs_once
from job_runtime_worker_launcher import SubprocessJobWorkerLauncher
from server_test_utils import load_server, patch_verified_user


def _authed_client(monkeypatch, tmp_path, **load_kwargs):
    server = load_server(monkeypatch, tmp_path, **load_kwargs)
    client = server.app.test_client()
    patch_verified_user(monkeypatch, server)
    return server, client


def _claim_or_get_open_job(server, user_id: str, chat_id: int):
    claimed = server.store.claim_next_job()
    if claimed is not None:
        return claimed
    open_job = server.store.get_open_job(user_id, chat_id)
    assert open_job is not None
    return open_job


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
            "persistent": {
                "enabled": True,
                "shared_backend_enabled": False,
                "worker_owned_enabled": True,
                "ownership": "checkpoint_only",
                "enablement_reason": "worker_owned_warm_continuity_enabled",
                "total": 2,
                "bootstrapped": 1,
                "unbootstrapped": 1,
            },
            "routing": {
                "model": "gpt-5.3-codex",
                "provider": "openai-codex",
                "base_url": "https://chatgpt.com/backend-api/codex",
                "direct_agent_enabled": True,
                "persistent_sessions_enabled": True,
                "persistent_shared_backend_enabled": False,
                "persistent_worker_owned_enabled": True,
                "persistent_runtime_ownership": "checkpoint_only",
                "persistent_sessions_enablement_reason": "worker_owned_warm_continuity_enabled",
            },
            "warm_sessions": {
                "current_mode": "isolated_worker_owned_warm_continuity",
                "owner": "isolated_worker_processes",
                "target_mode": "isolated_worker_owned_warm_continuity",
                "target_status": "enabled_in_subprocess_mode",
            },
            "health": {
                "session_db_available": True,
                "agent_kwargs_has_session_db": True,
                "agent_kwargs_session_db_available": True,
                "session_search_ready": True,
            },
        },
    )
    monkeypatch.setattr(
        server.runtime,
        "runtime_diagnostics",
        lambda: {
            "children": {
                "active_total": 3,
                "caps": {"total": 16},
                "high_water_total": 5,
                "high_water_by_job": {"991": 3},
                "high_water_by_chat": {"55": 4},
                "recent_events": [{"event": "spawn", "job_id": 991, "chat_id": 55}],
            },
            "operator_summary": {
                "status": {"level": "warning", "reason": "recent_failures_detected"},
                "active_job_total": 1,
                "active_paths": {"agent": 1},
                "fallback_transition_total_recent": 1,
                "cli_fallback_total_recent": 0,
                "child_timeout_total": 0,
                "suspicious_active_jobs": [{"job_id": 991, "chat_id": 55, "current_path": "agent"}],
            },
        },
    )

    response = client.post("/api/runtime/status", json={"init_data": "ok"})

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert data["persistent"]["enabled"] is True
    assert data["persistent"]["worker_owned_enabled"] is True
    assert data["persistent"]["shared_backend_enabled"] is False
    assert data["persistent"]["total"] == 2
    assert data["routing"]["provider"] == "openai-codex"
    assert data["routing"]["direct_agent_enabled"] is True
    assert data["routing"]["persistent_worker_owned_enabled"] is True
    assert data["warm_sessions"]["current_mode"] == "isolated_worker_owned_warm_continuity"
    assert data["warm_sessions"]["target_mode"] == "isolated_worker_owned_warm_continuity"
    assert data["health"]["session_db_available"] is True
    assert data["health"]["agent_kwargs_has_session_db"] is True
    assert data["health"]["agent_kwargs_session_db_available"] is True
    assert data["health"]["session_search_ready"] is True
    assert data["operator_summary"]["status"]["level"] == "warning"
    assert data["operator_summary"]["active_paths"] == {"agent": 1}
    assert data["operator_summary"]["fallback_transition_total_recent"] == 1
    assert data["runtime"]["children"]["active_total"] == 3
    assert data["runtime"]["children"]["high_water_total"] == 5
    assert data["runtime"]["children"]["high_water_by_job"] == {"991": 3}
    assert data["runtime"]["children"]["high_water_by_chat"] == {"55": 4}
    assert data["runtime"]["children"]["recent_events"][0]["event"] == "spawn"


def test_runtime_duplicate_job_runner_guard(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    runtime = server.runtime
    assert runtime._try_start_job_runner(job_id=991, user_id="123", chat_id=55) is True
    assert runtime._try_start_job_runner(job_id=991, user_id="123", chat_id=55) is False

    diagnostics = runtime.runtime_diagnostics()
    active_jobs = diagnostics["incident_snapshot"]["workers"]["active_jobs"]
    assert diagnostics["incident_snapshot"]["workers"]["active_job_total"] == 1
    assert active_jobs[0]["job_id"] == 991
    assert active_jobs[0]["user_id"] == "123"
    assert active_jobs[0]["chat_id"] == 55
    assert active_jobs[0]["session_id"] == "miniapp-123-55"
    assert active_jobs[0]["recent_transport_transitions"] == []

    runtime._finish_job_runner(991)
    assert runtime._try_start_job_runner(job_id=991, user_id="123", chat_id=55) is True
    runtime._finish_job_runner(991)


def test_runtime_diagnostics_include_active_job_transport_transitions(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    runtime = server.runtime

    assert runtime._try_start_job_runner(job_id=991, user_id="123", chat_id=55) is True
    server.client._record_transport_transition(
        previous_path="none",
        next_path="agent",
        reason="direct_start",
        session_id="miniapp-123-55",
        user_id="123",
    )
    server.client._record_transport_transition(
        previous_path="agent",
        next_path="cli",
        reason="direct_failure:HermesClientError",
        session_id="miniapp-123-55",
        user_id="123",
    )

    diagnostics = runtime.runtime_diagnostics()
    active_jobs = diagnostics["incident_snapshot"]["workers"]["active_jobs"]
    assert len(active_jobs) == 1
    assert [item["next_path"] for item in active_jobs[0]["recent_transport_transitions"]] == ["agent", "cli"]

    runtime._finish_job_runner(991)


def test_runtime_diagnostics_helper_matches_wrapper(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    runtime = server.runtime

    assert runtime._try_start_job_runner(job_id=991, user_id="123", chat_id=55) is True
    direct = build_runtime_diagnostics(runtime)
    wrapped = runtime.runtime_diagnostics()

    assert direct["incident_snapshot"]["workers"]["active_job_total"] == 1
    assert direct["incident_snapshot"]["workers"] == wrapped["incident_snapshot"]["workers"]
    assert direct["counters"] == wrapped["counters"]
    assert direct["best_effort_failures"] == wrapped["best_effort_failures"]

    runtime._finish_job_runner(991)


def test_checkpoint_only_runtime_tracks_warm_owner_worker_events(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP_REQUESTED", "checkpoint_only")
    server = load_server(monkeypatch, tmp_path)
    runtime = server.runtime

    assert runtime._try_start_job_runner(job_id=991, user_id="123", chat_id=55) is True
    owner_state = server.client.warm_session_owner_state()
    assert owner_state["owner_class"] == "IsolatedWorkerWarmSessionRegistryScaffold"
    assert any(event.get("event") == "worker_started" and event.get("session_id") == "miniapp-123-55" for event in owner_state["recent_events"])
    record = owner_state["owner_records"][0]
    assert record["session_id"] == "miniapp-123-55"
    assert record["state"] == "running"
    assert record["lifecycle_phase"] == "active_attempt"
    assert record["reusable"] is False
    assert record["job_id"] == 991
    assert record["chat_id"] == 55
    assert owner_state["reusable_candidate_count"] == 0

    runtime._finish_job_runner(991, outcome="completed")
    owner_state = server.client.warm_session_owner_state()
    assert any(event.get("event") == "worker_finished" and "outcome=completed" in str(event.get("detail") or "") for event in owner_state["recent_events"])
    record = owner_state["owner_records"][0]
    assert record["state"] == "reusable_candidate"
    assert record["lifecycle_phase"] == "post_attempt"
    assert record["reusable"] is True
    assert record["reusability_reason"] == "isolated_worker_warm_reuse_not_implemented"
    assert record["last_outcome"] == "completed"
    assert owner_state["reusable_candidate_count"] == 1
    assert owner_state["reusable_candidate_session_ids"] == ["miniapp-123-55"]


def test_sweep_stale_running_jobs_clears_active_runner_record(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    server = load_server(monkeypatch, tmp_path)
    runtime = server.runtime
    runtime.shutdown(reason="test-stale-sweep", join_timeout=0.2)

    assert runtime._try_start_job_runner(job_id=991, user_id="123", chat_id=55) is True
    terminated: list[tuple[int, str]] = []
    monkeypatch.setattr(runtime, "_terminate_job_children", lambda *, job_id, reason: terminated.append((int(job_id), str(reason))))
    monkeypatch.setattr(
        runtime.store,
        "dead_letter_stale_running_jobs",
        lambda timeout_seconds, error: [{"id": 991, "chat_id": 55, "user_id": "123"}],
    )

    runtime._sweep_stale_running_jobs()

    assert terminated == [(991, "stale_timeout_dead")]
    diagnostics = runtime.runtime_diagnostics()
    assert diagnostics["incident_snapshot"]["workers"]["active_job_total"] == 0
    assert runtime._try_start_job_runner(job_id=991, user_id="123", chat_id=55) is True
    runtime._finish_job_runner(991)


def test_publish_job_event_refreshes_active_runner_progress_timestamp(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    runtime = server.runtime

    assert runtime._try_start_job_runner(job_id=991, user_id="123", chat_id=55) is True
    with runtime._active_job_runner_lock:
        record = runtime._active_job_runner_records[991]
        record["last_progress_at"] = 100
    monkeypatch.setattr("job_runtime.time.time", lambda: 175)

    runtime.publish_job_event(991, "meta", {"chat_id": 55, "source": "test"})

    with runtime._active_job_runner_lock:
        assert int(runtime._active_job_runner_records[991]["last_progress_at"]) == 175
    runtime._finish_job_runner(991)


def test_orphaned_runner_sweep_uses_last_progress_not_start_time(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    server = load_server(monkeypatch, tmp_path)
    runtime = server.runtime

    job_id = 991
    user_id = "123"
    chat_id = 55
    assert runtime._try_start_job_runner(job_id=job_id, user_id=user_id, chat_id=chat_id) is True

    session_id = f"miniapp-{user_id}-{chat_id}"
    runtime.client.note_warm_session_worker_attach_ready(
        session_id=session_id,
        owner_pid=999,
        transport_kind="unix_socket_jsonl",
        worker_endpoint="/tmp/attach.sock",
        resume_token="tok",
        resume_deadline_ms=1,
    )

    with runtime._active_job_runner_lock:
        record = runtime._active_job_runner_records[job_id]
        record["started_at"] = 100
        record["last_progress_at"] = 460

    monkeypatch.setattr("job_runtime.time.time", lambda: 500)
    monkeypatch.setattr(runtime.client, "child_spawn_diagnostics", lambda: {"descendant_active_by_job": {str(job_id): 0}})
    monkeypatch.setattr(runtime.store, "get_job_state", lambda requested_job_id: {"id": requested_job_id, "status": "running"})
    retry_calls: list[tuple[int, str]] = []
    monkeypatch.setattr(runtime.store, "retry_or_dead_letter_job", lambda requested_job_id, error_text, retry_base_seconds=0: retry_calls.append((int(requested_job_id), str(error_text))) or False)
    terminated: list[tuple[int, str]] = []
    monkeypatch.setattr(runtime, "_terminate_job_children", lambda *, job_id, reason: terminated.append((int(job_id), str(reason))))

    runtime._sweep_locally_orphaned_active_runners()

    assert terminated == []
    assert retry_calls == []
    runtime._finish_job_runner(job_id)


def test_runtime_can_be_configured_with_subprocess_worker_launcher(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_MEMORY_LIMIT_MB", "2048")
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_MAX_TASKS", "120")
    monkeypatch.setenv("MINI_APP_JOB_WORKER_SUBPROCESS_MAX_OPEN_FILES", "900")
    server = load_server(monkeypatch, tmp_path)

    launcher_info = server.runtime.worker_launcher.describe()
    assert launcher_info["name"] == "subprocess"
    assert launcher_info["limits"] == {"memory_mb": 2048, "max_tasks": 120, "max_open_files": 900}

    diagnostics = server.runtime.runtime_diagnostics()
    workers = diagnostics["incident_snapshot"]["workers"]
    assert workers["launcher"]["name"] == "subprocess"
    assert workers["launcher"]["limits"] == {"memory_mb": 2048, "max_tasks": 120, "max_open_files": 900}
    assert workers["isolation_boundary_active"] is True
    assert workers["isolation_boundary_enforced"] is (os.name == "posix")
    assert workers["isolation_boundary"]["active"] is True
    assert workers["isolation_boundary"]["enforced"] is (os.name == "posix")


def test_subprocess_two_chat_session_mismatch_isolation_smoke(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    server, client = _authed_client(monkeypatch, tmp_path)
    runtime = server._RUNTIME_DEPS.bind_runtime()
    runtime.shutdown(reason="test-manual-run", join_timeout=0.2)
    runtime._shutdown_event.clear()

    user_id = "123"
    chat_a_id = server.store.ensure_default_chat(user_id)
    chat_b = server.store.create_chat(user_id, "Chat B")
    chat_b_id = int(chat_b.id)

    operator_a = server.store.add_message(user_id, chat_a_id, "operator", "chat-a")
    operator_b = server.store.add_message(user_id, chat_b_id, "operator", "chat-b")

    job_a = server.store.enqueue_chat_job(user_id, chat_a_id, operator_a, max_attempts=1)
    job_b = server.store.enqueue_chat_job(user_id, chat_b_id, operator_b, max_attempts=1)

    session_a = f"miniapp-{user_id}-{chat_a_id}"
    session_b = f"miniapp-{user_id}-{chat_b_id}"

    def fake_subprocess_stream(self, *, runtime, user_id, message, conversation_history, session_id):
        if session_id == session_a:
            yield {
                "type": "chunk",
                "text": "cross-chat contamination",
                "session_id": session_b,
            }
            return

        assert session_id == session_b
        yield {"type": "meta", "source": "agent", "session_id": session_b}
        yield {"type": "chunk", "text": "safe-reply-b", "session_id": session_b}
        yield {"type": "done", "reply": "safe-reply-b", "latency_ms": 5, "session_id": session_b}

    monkeypatch.setattr(SubprocessJobWorkerLauncher, "_stream_events_via_subprocess", fake_subprocess_stream)

    runtime._process_available_jobs_once()
    runtime._process_available_jobs_once()

    state_a = server.store.get_job_state(job_a)
    state_b = server.store.get_job_state(job_b)
    assert state_a is not None
    assert state_b is not None
    assert state_a["status"] == "dead"
    assert state_b["status"] == "done"
    assert state_a["attempts"] == 1
    assert state_b["attempts"] == 1

    history_a = server.store.get_history(user_id=user_id, chat_id=chat_a_id, limit=10)
    history_b = server.store.get_history(user_id=user_id, chat_id=chat_b_id, limit=10)

    roles_a = [turn.role for turn in history_a]
    assert "hermes" not in roles_a
    assert set(roles_a).issubset({"operator", "system"})
    assert any(turn.role == "hermes" and turn.body == "safe-reply-b" for turn in history_b)

    status_response = client.post("/api/runtime/status", json={"init_data": "ok"})
    assert status_response.status_code == 200
    status_data = status_response.get_json()
    assert status_data["ok"] is True

    workers = status_data["runtime"]["incident_snapshot"]["workers"]
    assert workers["launcher"]["name"] == "subprocess"
    assert workers["isolation_boundary_active"] is True
    assert workers["isolation_boundary_enforced"] is (os.name == "posix")


def test_runtime_diagnostics_expose_last_worker_limit_breach(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    server = load_server(monkeypatch, tmp_path)

    launcher = server.runtime.worker_launcher
    setattr(launcher, "_last_limit_breach", "memory")
    setattr(launcher, "_last_limit_breach_detail", "stderr_oom")

    diagnostics = server.runtime.runtime_diagnostics()
    launcher_info = diagnostics["incident_snapshot"]["workers"]["launcher"]
    assert launcher_info["last_limit_breach"] == "memory"
    assert launcher_info["last_limit_breach_detail"] == "stderr_oom"
    operator_summary = diagnostics["operator_summary"]
    assert operator_summary["launcher_limit_breach"] == "memory"
    assert operator_summary["launcher_limit_breach_detail"] == "stderr_oom"


def test_runtime_diagnostics_include_child_high_water(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_JOB", "2")
    server = load_server(monkeypatch, tmp_path)

    server.client.set_spawn_trace_context(user_id="123", chat_id=55, job_id=991, session_id="miniapp-123-55")
    server.client.register_child_spawn(
        transport="agent-direct",
        pid=44001,
        command=["python", "-m", "hermes_cli.main"],
        session_id="miniapp-123-55",
    )
    server.client.register_child_spawn(
        transport="agent-direct",
        pid=44002,
        command=["python", "-m", "hermes_cli.main"],
        session_id="miniapp-123-55",
    )
    server.client.deregister_child_spawn(pid=44001, outcome="completed", return_code=0)
    server.client.deregister_child_spawn(pid=44002, outcome="completed", return_code=0)
    server.client.clear_spawn_trace_context()

    diagnostics = server.runtime.runtime_diagnostics()

    children = diagnostics["children"]
    assert children["active_total"] == 0
    assert children["high_water_total"] == 2
    assert children["high_water_by_job"] == {"991": 2}
    assert children["high_water_by_chat"] == {"55": 2}
    assert any(event.get("event") == "spawn" for event in children["recent_events"])
    assert any(event.get("event") == "finish" for event in children["recent_events"])
    assert isinstance(children.get("recent_transport_transitions"), list)


def test_runtime_diagnostics_include_child_timeout_counters(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    server.client.set_spawn_trace_context(user_id="123", chat_id=55, job_id=991, session_id="miniapp-123-55")
    server.client.register_child_spawn(
        transport="chat-worker-subprocess",
        pid=44101,
        command=["python", "worker.py"],
        session_id="miniapp-123-55",
    )
    server.client.deregister_child_spawn(
        pid=44101,
        outcome="chat-worker-subprocess:failed:timeout",
        return_code=-9,
    )
    server.client.clear_spawn_trace_context()

    diagnostics = server.runtime.runtime_diagnostics()
    child_timeouts = diagnostics.get("child_timeouts") or {}
    assert child_timeouts.get("total") == 1
    assert child_timeouts.get("by_job") == {"991": 1}
    assert child_timeouts.get("by_chat") == {"55": 1}

    workers = diagnostics["incident_snapshot"]["workers"]
    assert workers.get("child_timeout_total") == 1
    assert workers.get("child_timeouts_by_job") == {"991": 1}
    assert workers.get("child_timeouts_by_chat") == {"55": 1}


def test_runtime_diagnostics_build_operator_summary_for_fallback_and_idle_jobs(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    runtime = server.runtime

    assert runtime._try_start_job_runner(job_id=991, user_id="123", chat_id=55) is True
    assert runtime._try_start_job_runner(job_id=992, user_id="123", chat_id=56) is True
    with runtime._active_job_runner_lock:
        runtime._active_job_runner_records[991]["started_at"] = 100
        runtime._active_job_runner_records[991]["last_progress_at"] = 170
        runtime._active_job_runner_records[992]["started_at"] = 100
        runtime._active_job_runner_records[992]["last_progress_at"] = 160

    server.client._record_transport_transition(
        previous_path="none",
        next_path="agent",
        reason="direct_start",
        session_id="miniapp-123-55",
        user_id="123",
    )
    server.client._record_transport_transition(
        previous_path="agent",
        next_path="cli",
        reason="direct_failure:HermesClientError",
        session_id="miniapp-123-55",
        user_id="123",
    )
    server.client._record_transport_transition(
        previous_path="none",
        next_path="agent-persistent",
        reason="warm_attach_resume",
        session_id="miniapp-123-56",
        user_id="123",
    )
    server.client.set_spawn_trace_context(user_id="123", chat_id=55, job_id=991, session_id="miniapp-123-55")
    server.client.register_child_spawn(
        transport="chat-worker-subprocess",
        pid=44101,
        command=["python", "worker.py"],
        session_id="miniapp-123-55",
    )
    server.client.deregister_child_spawn(
        pid=44101,
        outcome="chat-worker-subprocess:failed:timeout",
        return_code=-9,
    )
    server.client.clear_spawn_trace_context()

    monkeypatch.setattr(
        runtime.store,
        "job_queue_diagnostics",
        lambda: {
            "startup_recovered_running_total": 2,
            "startup_clamped_exhausted_total": 3,
            "preclaim_dead_letter_total": 4,
        },
    )

    diagnostics = build_runtime_diagnostics(runtime, time_fn=lambda: 200, monotonic_fn=lambda: 200)
    operator_summary = diagnostics["operator_summary"]
    assert operator_summary["status"]["level"] == "ok"
    assert operator_summary["active_job_total"] == 2
    assert operator_summary["active_paths"] == {"cli": 1, "agent-persistent": 1}
    assert operator_summary["active_latest_transition_reasons"] == {
        "direct_failure:HermesClientError": 1,
        "warm_attach_resume": 1,
    }
    assert operator_summary["active_resume_job_total"] == 1
    assert operator_summary["fallback_transition_total_recent"] == 1
    assert operator_summary["cli_fallback_total_recent"] == 1
    assert operator_summary["recent_fallback_reasons"] == {"direct_failure:HermesClientError": 1}
    assert operator_summary["child_timeout_total"] == 1
    assert operator_summary["timeout_affected_jobs"] == ["991"]
    assert operator_summary["timeout_affected_chats"] == ["55"]
    assert operator_summary["startup_recovered_running_total"] == 2
    assert operator_summary["startup_clamped_exhausted_total"] == 3
    assert operator_summary["preclaim_dead_letter_total"] == 4
    assert operator_summary["launcher_limit_breach"] is None
    assert operator_summary["launcher_limit_breach_detail"] is None
    suspicious = {item["job_id"]: item for item in operator_summary["suspicious_active_jobs"]}
    assert suspicious[991]["current_path"] == "cli"
    assert suspicious[991]["latest_transition_reason"] == "direct_failure:HermesClientError"
    assert suspicious[991]["latest_fallback_reason"] == "direct_failure:HermesClientError"
    assert "recent_transport_fallback" in suspicious[991]["suspicion_reasons"]
    assert "active_on_cli_path" in suspicious[991]["suspicion_reasons"]
    assert suspicious[992]["current_path"] == "agent-persistent"
    assert suspicious[992]["idle_seconds"] == 40
    assert suspicious[992]["suspicion_reasons"] == ["idle_without_progress_30s"]
    assert diagnostics["incident_snapshot"]["operator_summary"] == operator_summary
    assert diagnostics["queue_diagnostics"] == {
        "startup_recovered_running_total": 2,
        "startup_clamped_exhausted_total": 3,
        "preclaim_dead_letter_total": 4,
    }

    runtime._finish_job_runner(991)
    runtime._finish_job_runner(992)


def test_run_chat_job_duplicate_runner_is_suppressed_not_nonretryable(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    server.runtime.shutdown(reason="test-manual-run", join_timeout=0.2)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "hello")
    job_id = server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = _claim_or_get_open_job(server, user_id, chat_id)
    assert int(job.get("id") or 0) == job_id

    monkeypatch.setattr(server.runtime, "_try_start_job_runner", lambda **kwargs: False)

    try:
        server.runtime.run_chat_job(job)
        raise AssertionError("Expected duplicate-runner suppression signal")
    except JobDuplicateRunnerSuppressed as exc:
        assert f"job_id={job_id}" in str(exc)


def test_run_chat_job_skips_db_history_when_runtime_already_bootstrapped(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    server.runtime.shutdown(reason="test-manual-run", join_timeout=0.2)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    server.store.add_message(user_id, chat_id, "operator", "older context")
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "latest question")
    server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = _claim_or_get_open_job(server, user_id, chat_id)

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
    server.runtime.shutdown(reason="test-manual-run", join_timeout=0.2)

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
    job = _claim_or_get_open_job(server, user_id, chat_id)

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
    server.runtime.shutdown(reason="test-manual-run", join_timeout=0.2)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "latest question")
    session_id = f"miniapp-{user_id}-{chat_id}"

    server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = _claim_or_get_open_job(server, user_id, chat_id)

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


def test_run_chat_job_sends_telegram_unread_notification_for_new_unread_in_inactive_chat(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    server.runtime.shutdown(reason="test-manual-run", join_timeout=0.2)

    user_id = "123"
    main_chat_id = server.store.ensure_default_chat(user_id)
    worker_chat = server.store.create_chat(user_id, "Worker")
    server.store.set_active_chat(user_id, main_chat_id)
    server.store.set_telegram_unread_notifications_enabled(user_id, True)
    operator_message_id = server.store.add_message(user_id, worker_chat.id, "operator", "latest question")
    server.store.enqueue_chat_job(user_id, worker_chat.id, operator_message_id, max_attempts=1)
    job = _claim_or_get_open_job(server, user_id, worker_chat.id)

    monkeypatch.setattr(server.client, "should_include_conversation_history", lambda session_id: False)
    sent: list[dict[str, object]] = []
    monkeypatch.setattr(
        server.runtime.telegram_unread_reply_notifier.sender,
        "send_text",
        lambda **kwargs: sent.append(kwargs) or SimpleNamespace(ok=True, status_code=200, error=None, response_text='{"ok":true}'),
    )

    def fake_stream_events(*, user_id, message, conversation_history, session_id):
        yield {"type": "meta", "source": "agent-persistent"}
        yield {"type": "done", "reply": "ok", "latency_ms": 1}

    monkeypatch.setattr(server.client, "stream_events", fake_stream_events)

    server._run_chat_job(job)

    assert sent == [{"chat_id": user_id, "text": "🔔 Worker — New unread reply"}]
    attempts = server.store.list_telegram_notification_attempts(user_id=user_id, chat_id=worker_chat.id)
    assert len(attempts) == 1
    assert attempts[0]["decision_reason"] == "send"
    assert attempts[0]["ok"] is True
    diagnostics = server.runtime.runtime_diagnostics()
    assert diagnostics["telegram_notifications"]["recent_attempts"][0]["decision_reason"] == "send"
    assert diagnostics["incident_snapshot"]["telegram_notifications"]["recent_attempts"][0]["chat_id"] == worker_chat.id


def test_run_chat_job_retries_failed_telegram_unread_notification_once_for_same_unread_streak(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    server.runtime.shutdown(reason="test-manual-run", join_timeout=0.2)

    user_id = "123"
    main_chat_id = server.store.ensure_default_chat(user_id)
    worker_chat = server.store.create_chat(user_id, "Worker")
    server.store.set_active_chat(user_id, main_chat_id)
    server.store.set_telegram_unread_notifications_enabled(user_id, True)
    monkeypatch.setattr(server.client, "should_include_conversation_history", lambda session_id: False)

    send_results = [
        SimpleNamespace(ok=False, error="network down", status_code=None, response_text=None),
        SimpleNamespace(ok=True, error=None, status_code=200, response_text='{"ok":true}'),
    ]
    sent: list[dict[str, object]] = []

    def fake_send_text(**kwargs):
        sent.append(dict(kwargs))
        return send_results.pop(0)

    monkeypatch.setattr(server.runtime.telegram_unread_reply_notifier.sender, "send_text", fake_send_text)

    def fake_stream_events(*, user_id, message, conversation_history, session_id):
        yield {"type": "meta", "source": "agent-persistent"}
        yield {"type": "done", "reply": f"reply:{message}", "latency_ms": 1}

    monkeypatch.setattr(server.client, "stream_events", fake_stream_events)

    operator_message_id = server.store.add_message(user_id, worker_chat.id, "operator", "first question")
    server.store.enqueue_chat_job(user_id, worker_chat.id, operator_message_id, max_attempts=1)
    first_job = _claim_or_get_open_job(server, user_id, worker_chat.id)
    server._run_chat_job(first_job)

    second_operator_message_id = server.store.add_message(user_id, worker_chat.id, "operator", "second question")
    server.store.enqueue_chat_job(user_id, worker_chat.id, second_operator_message_id, max_attempts=1)
    second_job = _claim_or_get_open_job(server, user_id, worker_chat.id)
    server._run_chat_job(second_job)

    assert sent == [
        {"chat_id": user_id, "text": "🔔 Worker — New unread reply"},
        {"chat_id": user_id, "text": "🔔 Worker — New unread reply"},
    ]
    attempts = server.store.list_telegram_notification_attempts(user_id=user_id, chat_id=worker_chat.id, limit=5)
    assert [attempt["decision_reason"] for attempt in attempts[:2]] == ["retry_pending_unread", "send"]
    assert attempts[0]["ok"] is True
    assert attempts[1]["ok"] is False


def test_publish_job_event_throttles_touch_job_frequency(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    server.runtime.shutdown(reason="test-touch-throttle", join_timeout=0.2)

    user_id = "touch-user"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "touch test")
    job_id = server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    claimed = _claim_or_get_open_job(server, user_id, chat_id)

    server.runtime._clear_touch_tracking(job_id)
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
    claimed = _claim_or_get_open_job(server, user_id, chat_id)
    assert int(claimed["id"]) == job_id

    saturated_subscriber: queue.Queue[dict[str, object]] = queue.Queue(maxsize=1)
    saturated_subscriber.put_nowait({"event": "chunk", "payload": {"text": "old"}})

    with server.runtime._event_lock:
        server.runtime._event_queues[job_id] = [saturated_subscriber]

    server._publish_job_event(job_id, "done", {"chat_id": chat_id, "reply": "ok", "latency_ms": 1})

    delivered = saturated_subscriber.get_nowait()
    assert delivered["event"] == "done"
    assert delivered["payload"]["reply"] == "ok"


def test_job_event_buffers_follow_configured_cap(monkeypatch, tmp_path) -> None:
    configured_cap = 64
    monkeypatch.setenv("MINI_APP_JOB_EVENT_HISTORY_MAX_JOBS", str(configured_cap))
    server = load_server(monkeypatch, tmp_path)
    server.runtime.shutdown(reason="test-event-buffer-manual-drive", join_timeout=0.2)

    user_id = "event-cap"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "cap test")
    job_id = server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    claimed = _claim_or_get_open_job(server, user_id, chat_id)

    for idx in range(configured_cap + 6):
        server._publish_job_event(job_id, "chunk", {"chat_id": chat_id, "index": idx})
    server._publish_job_event(job_id, "done", {"chat_id": chat_id, "reply": "ok", "latency_ms": 1})

    with server.runtime._event_lock:
        history = list(server.runtime._event_history[job_id])

    assert len(history) == configured_cap
    assert history[0]["event"] == "chunk"
    assert history[0]["payload"]["index"] == 7
    assert history[-1]["event"] == "done"

    subscriber = server._subscribe_job_events(job_id)
    assert subscriber.maxsize == configured_cap

    replayed: list[dict[str, object]] = []
    while True:
        try:
            replayed.append(subscriber.get_nowait())
        except queue.Empty:
            break

    assert len(replayed) == configured_cap
    assert replayed[0]["event"] == "chunk"
    assert replayed[0]["payload"]["index"] == 7
    assert replayed[-1]["event"] == "done"


def test_run_chat_job_does_not_keepalive_touch_during_silent_upstream_wait(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    server.runtime.shutdown(reason="test-manual-run", join_timeout=0.2)

    user_id = "123"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "wait")

    server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)
    job = _claim_or_get_open_job(server, user_id, chat_id)

    monkeypatch.setattr(server.client, "should_include_conversation_history", lambda session_id: False)

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

    # One non-terminal meta event is published at job start; silent waits should not
    # continuously refresh updated_at via keepalive-only touches.
    assert len(touch_calls) == 1


def test_process_available_jobs_once_survives_database_locked_claim(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    runtime = server._RUNTIME_DEPS.bind_runtime()
    runtime._shutdown_event.clear()
    runtime._shutdown_started = False
    calls = {"count": 0}

    def locked_claim_next_job():
        calls["count"] += 1
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(runtime.store, "claim_next_job", locked_claim_next_job)

    runtime._process_available_jobs_once()

    assert calls["count"] >= 1



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


def test_safe_add_system_message_emits_only_one_terminal_message_per_job(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    calls: list[dict[str, object]] = []

    def record_add_message(*, user_id, chat_id, role, body):
        calls.append({"user_id": user_id, "chat_id": chat_id, "role": role, "body": body})

    monkeypatch.setattr(server.runtime.store, "add_message", record_add_message)

    server.runtime._safe_add_system_message(user_id="dedupe-user", chat_id=1, text="first terminal failure", job_id=321)
    server.runtime._safe_add_system_message(user_id="dedupe-user", chat_id=1, text="second terminal failure", job_id=321)

    assert calls == [{"user_id": "dedupe-user", "chat_id": 1, "role": "system", "body": "first terminal failure"}]


def test_bounded_attempts_for_display_caps_retry_count(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    assert server.runtime._bounded_attempts_for_display(123, 4) == 4
    assert server.runtime._bounded_attempts_for_display(0, 4) == 1
    assert server.runtime._bounded_attempts_for_display(2, 0) == 1


def test_worker_retry_exhaustion_stops_at_max_and_surfaces_terminal_error(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    runtime = server._RUNTIME_DEPS.bind_runtime()
    runtime.shutdown(reason="test-manual-run", join_timeout=0.2)
    runtime._shutdown_event.clear()

    user_id = "retry-user"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "please retry")
    job_id = server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=2)

    run_attempts: list[int] = []

    def always_retryable(job: dict[str, object]) -> None:
        run_attempts.append(int(job.get("attempts") or 0))
        raise JobRetryableError("temporary upstream outage")

    monkeypatch.setattr(runtime, "run_chat_job", always_retryable)
    monkeypatch.setattr(runtime, "_fd_metrics", lambda: (42, 1024))

    runtime._process_available_jobs_once()

    state_after_first = server.store.get_job_state(job_id)
    assert state_after_first is not None
    assert state_after_first["status"] in {"queued", "running"}
    assert state_after_first["attempts"] == 1

    conn = sqlite3.connect(server.store.db_path)
    conn.execute("UPDATE chat_jobs SET next_attempt_at = CURRENT_TIMESTAMP WHERE id = ?", (job_id,))
    conn.commit()
    conn.close()

    runtime._process_available_jobs_once()
    runtime._process_available_jobs_once()

    state_final = server.store.get_job_state(job_id)
    assert state_final is not None
    assert state_final["status"] == "dead"
    assert state_final["attempts"] == 2
    assert run_attempts == [1, 2]

    dead_letters = server.store.list_dead_letters(user_id, limit=10)
    matching = [item for item in dead_letters if item["job_id"] == job_id]
    assert len(matching) == 1

    history = server.store.get_history(user_id=user_id, chat_id=chat_id, limit=10)
    system_messages = [turn.body for turn in history if turn.role == "system"]
    assert any("failed after 2 attempts" in body and "temporary upstream outage" in body for body in system_messages)

    with runtime._event_lock:
        event_history = list(runtime._event_history.get(job_id) or [])
    retry_meta_events = [
        event
        for event in event_history
        if event.get("event") == "meta" and str((event.get("payload") or {}).get("source") or "") == "retry"
    ]
    error_events = [event for event in event_history if event.get("event") == "error"]
    assert len(retry_meta_events) == 1
    assert len(error_events) == 1
    assert (error_events[-1].get("payload") or {}).get("retrying") is False


def test_worker_retry_exhaustion_suppresses_terminal_error_for_intentional_interrupt_replacement(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    runtime = server._RUNTIME_DEPS.bind_runtime()
    runtime.shutdown(reason="test-manual-run", join_timeout=0.2)
    runtime._shutdown_event.clear()

    user_id = "interrupt-user"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "please stop")
    job_id = server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)

    def interrupted_retryable(_job: dict[str, object]) -> None:
        raise JobRetryableError("Subprocess worker exited rc=-9")

    suppressed_messages: list[dict[str, object]] = []
    published_events: list[dict[str, object]] = []

    monkeypatch.setattr(runtime, "run_chat_job", interrupted_retryable)
    monkeypatch.setattr(runtime, "_fd_metrics", lambda: (11, 16384))
    monkeypatch.setattr(runtime.store, "retry_or_dead_letter_job", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(runtime.store, "get_job_state", lambda _job_id: {
        "id": job_id,
        "chat_id": chat_id,
        "status": "dead",
        "error": "interrupted_by_new_message",
        "attempts": 1,
        "max_attempts": 1,
        "created_at": "",
        "started_at": "",
        "next_attempt_at": "",
        "queued_ahead": 0,
        "running_total": 0,
    })
    monkeypatch.setattr(
        runtime,
        "_safe_add_system_message",
        lambda **kwargs: suppressed_messages.append(dict(kwargs)),
    )
    monkeypatch.setattr(
        runtime,
        "publish_job_event",
        lambda job_id, event, payload=None: published_events.append({"job_id": job_id, "event": event, "payload": payload}),
    )

    runtime._process_available_jobs_once()

    assert suppressed_messages == []
    assert [event["event"] for event in published_events] == []


def test_runtime_status_endpoint_exposes_runtime_diagnostics(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)
    runtime = server._RUNTIME_DEPS.bind_runtime()
    runtime.shutdown(reason="test-manual-run", join_timeout=0.2)
    runtime._shutdown_event.clear()

    user_id = "diag-user"
    chat_id = server.store.ensure_default_chat(user_id)
    operator_message_id = server.store.add_message(user_id, chat_id, "operator", "diag")
    job_id = server.store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=1)

    def force_retry_exhausted(job: dict[str, object]) -> None:
        raise JobRetryableError("boom")

    monkeypatch.setattr(runtime, "run_chat_job", force_retry_exhausted)
    monkeypatch.setattr(runtime, "_fd_metrics", lambda: (77, 4096))

    runtime._process_available_jobs_once()

    response = client.post("/api/runtime/status", json={"init_data": "ok"})

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    runtime = data["runtime"]
    assert runtime["fd_open"] == 77
    assert runtime["fd_limit_soft"] == 4096
    assert runtime["retry_scheduled_total"] == 0
    assert runtime["dead_letter_total"] >= 1
    assert runtime["counters"]["retry_exhausted_dead"] >= 1
    assert runtime["best_effort_failures"]["touch_job_write"] >= 0
    assert runtime["queue_diagnostics"]["startup_recovered_running_total"] >= 0
    assert runtime["queue_diagnostics"]["startup_clamped_exhausted_total"] >= 0
    assert runtime["queue_diagnostics"]["preclaim_dead_letter_total"] >= 0
    assert runtime["startup_recovered_running_total"] == runtime["queue_diagnostics"]["startup_recovered_running_total"]
    assert runtime["startup_clamped_exhausted_total"] == runtime["queue_diagnostics"]["startup_clamped_exhausted_total"]
    assert runtime["preclaim_dead_letter_total"] == runtime["queue_diagnostics"]["preclaim_dead_letter_total"]

    incident = runtime["incident_snapshot"]
    assert incident["generated_at"] >= 1
    assert incident["workers"]["configured"] >= 1
    assert incident["workers"]["alive"] >= 0
    assert runtime["isolation_boundary"]["active"] is False
    assert incident["workers"]["isolation_boundary_active"] is False
    assert incident["workers"]["isolation_boundary_enforced"] is False
    assert incident["workers"]["isolation_boundary"]["reason"] == "in_process_launcher"
    terminal_events = incident["terminal_events"]
    assert terminal_events["terminal_counts"]["done"] >= 0
    assert terminal_events["terminal_counts"]["error"] >= 1
    assert terminal_events["recent_terminal"]
    assert terminal_events["recent_error_messages"]
    assert terminal_events["age_stats_seconds"]["sample_size"] >= 1
    assert terminal_events["window_counts"]["5m"]["error"] >= 1

    rate_windows = incident["rate_windows"]
    assert rate_windows["runtime"]["5m"]["retry_scheduled"] >= 0
    assert rate_windows["runtime"]["5m"]["dead_letter"] >= 1
    assert rate_windows["terminal"]["5m"]["error"] >= 1

    severity = incident["severity_hint"]
    assert severity["level"] in {"ok", "warning", "critical"}
    assert isinstance(severity["reason"], str)
    assert severity["reason"]

    state = server.store.get_job_state(job_id)
    assert state is not None
    assert state["status"] == "dead"
