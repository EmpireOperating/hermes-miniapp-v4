from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

import hermes_client
import hermes_client_agent
import hermes_client_cli
import hermes_client_tool_progress
import pytest


@pytest.fixture(autouse=True)
def _clear_ambient_miniapp_env(monkeypatch) -> None:
    for key in (
        "MINI_APP_PERSISTENT_SESSIONS",
        "MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP",
        "MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP_REQUESTED",
        "MINI_APP_JOB_WORKER_LAUNCHER",
        "MINI_APP_WARM_WORKER_REUSE",
        "MINI_APP_WARM_WORKER_SAME_CHAT_ONLY",
        "MINI_APP_DIRECT_AGENT",
        "MINI_APP_AGENT_HOME",
        "MINI_APP_AGENT_HERMES_HOME",
        "MINI_APP_AGENT_WORKDIR",
        "MINI_APP_AGENT_VENV",
        "MINI_APP_AGENT_PYTHON",
        "HERMES_HOME",
    ):
        monkeypatch.delenv(key, raising=False)


def test_client_derives_agent_runtime_defaults_from_environment(monkeypatch) -> None:
    monkeypatch.setenv("HOME", "/tmp/miniapp-home")
    monkeypatch.setenv("HERMES_HOME", "/tmp/custom-hermes-home")

    client = hermes_client.HermesClient()

    assert client.agent_home == "/tmp/miniapp-home"
    assert client.agent_hermes_home == "/tmp/custom-hermes-home"
    assert client.agent_workdir == "/tmp/custom-hermes-home/hermes-agent"
    assert client.agent_venv == "/tmp/custom-hermes-home/hermes-agent/venv"
    assert client.agent_python == hermes_client._default_venv_python_path(client.agent_venv)


def test_default_venv_python_path_is_platform_aware() -> None:
    assert hermes_client._default_venv_python_path("/tmp/demo-venv", platform_name="posix") == "/tmp/demo-venv/bin/python"
    assert hermes_client._default_venv_python_path("C:/demo/venv", platform_name="nt") == "C:/demo/venv/Scripts/python.exe"


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

    stats = manager.stats()
    assert stats["total"] == 2
    assert stats["bootstrapped"] == 0

    assert manager.evict("miniapp-u-1") is True
    assert manager.evict("miniapp-u-1") is False
    assert manager.stats()["total"] == 1


def test_persistent_session_manager_tracks_owner_events_and_state() -> None:
    manager = hermes_client.PersistentSessionManager(max_sessions=8, idle_ttl_seconds=3600)

    manager.get_or_create(session_id="miniapp-u-1", model="m1", max_iterations=90, create_agent=lambda: object())
    manager.get_runtime("miniapp-u-1")
    manager.evict("miniapp-u-1")

    owner_state = manager.owner_state()
    assert owner_state["owner_class"] == "PersistentSessionManager"
    assert owner_state["active_owner_count"] == 0
    recent_events = owner_state["recent_events"]
    assert [event["event"] for event in recent_events][-3:] == ["created", "attach", "evicted_explicit"]
    assert all(event["session_id"] == "miniapp-u-1" for event in recent_events[-3:])


def test_client_exposes_warm_session_registry_alias() -> None:
    client = hermes_client.HermesClient()

    assert client._warm_session_registry is client._session_manager
    assert type(client._warm_session_registry).__name__ == "PersistentSessionManager"


def test_client_uses_isolated_worker_warm_registry_scaffold_in_checkpoint_only_mode(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    assert type(client._warm_session_registry).__name__ == "IsolatedWorkerWarmSessionRegistryScaffold"
    assert client._warm_session_registry is not client._session_manager
    owner_state = client.warm_session_owner_state()
    assert owner_state["owner_class"] == "IsolatedWorkerWarmSessionRegistryScaffold"
    assert owner_state["active_owner_count"] == 0
    assert owner_state["owner_records"] == []
    assert any(event["event"] == "scaffold_initialized" for event in owner_state["recent_events"])


def test_isolated_worker_warm_registry_tracks_owner_records(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    client.note_warm_session_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
    owner_state = client.warm_session_owner_state()
    assert owner_state["active_owner_count"] == 1
    assert owner_state["active_session_ids"] == ["miniapp-123-55"]
    record = owner_state["owner_records"][0]
    assert record["session_id"] == "miniapp-123-55"
    assert record["state"] == "running"
    assert record["lifecycle_phase"] == "active_attempt"
    assert record["reusable"] is False
    assert record["reusability_reason"] == "worker_attempt_in_progress"
    assert record["chat_id"] == 55
    assert record["job_id"] == 991
    assert record["owner_pid"] == 44001
    assert record["run_count"] == 1
    assert record["last_finished_monotonic_ms"] is None
    assert owner_state["reusable_candidate_count"] == 0

    client.note_warm_session_worker_finished(session_id="miniapp-123-55", outcome="completed", chat_id=55, job_id=991, owner_pid=44001)
    owner_state = client.warm_session_owner_state()
    assert owner_state["active_owner_count"] == 0
    assert owner_state["reusable_candidate_count"] == 1
    assert owner_state["reusable_candidate_session_ids"] == ["miniapp-123-55"]
    record = owner_state["owner_records"][0]
    assert record["state"] == "reusable_candidate"
    assert record["lifecycle_phase"] == "post_attempt"
    assert record["reusable"] is True
    assert record["reusability_reason"] == "isolated_worker_warm_reuse_not_implemented"
    assert record["run_count"] == 1
    assert record["last_outcome"] == "completed"
    assert record["last_finished_monotonic_ms"] is not None
    assert record["reusable_until_monotonic_ms"] is not None


def test_isolated_worker_running_worker_becomes_attachable_candidate(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    client.note_warm_session_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
    client.note_warm_session_worker_attach_ready(
        session_id="miniapp-123-55",
        owner_pid=44001,
        transport_kind="unix_socket_jsonl",
        worker_endpoint="/tmp/miniapp-attach.sock",
        resume_token="token-123",
        resume_deadline_ms=int(time.monotonic() * 1000) + 5000,
    )

    owner_state = client.warm_session_owner_state()
    assert owner_state["active_owner_count"] == 1
    assert owner_state["attachable_owner_count"] == 1
    assert owner_state["live_attach_ready_count"] == 1
    record = owner_state["owner_records"][0]
    assert record["state"] == "attachable_running"
    assert record["reusable"] is True
    assert record["reusability_reason"] == "worker_attach_live_available"
    assert record["attach_transport_kind"] == "unix_socket_jsonl"
    assert record["attach_worker_endpoint"] == "/tmp/miniapp-attach.sock"
    assert record["attach_resume_token"] == "token-123"
    candidate = client.select_warm_session_candidate("miniapp-123-55")
    assert candidate is not None
    assert candidate["state"] == "attachable_running"
    assert candidate["reuse_contract"]["resume_supported"] is True
    assert candidate["reuse_contract"]["resume_capability"] == "worker_attach"
    assert candidate["reuse_contract"]["transport_kind"] == "unix_socket_jsonl"
    assert candidate["reuse_contract"]["worker_endpoint"] == "/tmp/miniapp-attach.sock"
    assert candidate["reuse_contract"]["resume_token"] == "token-123"


def test_isolated_worker_reusable_candidate_expires() -> None:
    registry = hermes_client.IsolatedWorkerWarmSessionRegistryScaffold(reusable_candidate_ttl_ms=1000)
    registry.note_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
    registry.note_worker_finished(session_id="miniapp-123-55", outcome="completed", chat_id=55, job_id=991, owner_pid=44001)

    before = registry.owner_state()
    expiry = before["owner_records"][0]["reusable_until_monotonic_ms"]
    registry._prune_reusable_candidates(now_ms=int(expiry) + 1)

    owner_state = registry.owner_state()
    assert owner_state["reusable_candidate_count"] == 0
    record = owner_state["owner_records"][0]
    assert record["state"] == "expired"
    assert record["reusable"] is False
    assert record["reusability_reason"] == "candidate_ttl_expired"
    assert any(event["event"] == "candidate_expired" for event in owner_state["recent_events"])


def test_isolated_worker_registry_owner_state_payload_and_detail_helpers() -> None:
    registry = hermes_client.IsolatedWorkerWarmSessionRegistryScaffold(reusable_candidate_ttl_ms=1000)
    registry.note_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
    registry.note_worker_attach_ready(
        session_id="miniapp-123-55",
        owner_pid=44001,
        transport_kind="unix_socket_jsonl",
        worker_endpoint="/tmp/miniapp-attach.sock",
        resume_token="token-123",
        resume_deadline_ms=123456,
    )

    records = [record.as_dict() for record in registry._owner_records.values()]
    recent_events = [item.as_dict() for item in registry._owner_events[-16:]]
    payload = registry._build_owner_state_payload(records=records, recent_events=recent_events)

    assert payload["owner_class"] == "IsolatedWorkerWarmSessionRegistryScaffold"
    assert payload["active_owner_count"] == 1
    assert payload["attachable_owner_count"] == 1
    assert payload["live_attach_ready_count"] == 1
    detail = registry._build_worker_event_detail(chat_id=55, job_id=991, owner_pid=44001, outcome="completed")
    assert detail == "chat_id=55 job_id=991 owner_pid=44001 outcome=completed"


def test_isolated_worker_attachable_candidate_expires_by_resume_deadline() -> None:
    registry = hermes_client.IsolatedWorkerWarmSessionRegistryScaffold(reusable_candidate_ttl_ms=1000)
    registry.note_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
    registry.note_worker_attach_ready(
        session_id="miniapp-123-55",
        owner_pid=44001,
        transport_kind="unix_socket_jsonl",
        worker_endpoint="/tmp/miniapp-attach.sock",
        resume_token="token-123",
        resume_deadline_ms=123456,
    )
    registry._prune_reusable_candidates(now_ms=123457)

    owner_state = registry.owner_state()
    assert owner_state["attachable_owner_count"] == 0
    assert owner_state["live_attach_ready_count"] == 0
    record = owner_state["owner_records"][0]
    assert record["state"] == "expired"
    assert record["reusability_reason"] == "attach_resume_deadline_expired"
    assert any(event["event"] == "attach_expired" for event in owner_state["recent_events"])


def test_attachable_running_worker_finished_preserves_live_attach_candidate() -> None:
    registry = hermes_client.IsolatedWorkerWarmSessionRegistryScaffold(reusable_candidate_ttl_ms=1000)
    registry.note_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
    registry.note_worker_attach_ready(
        session_id="miniapp-123-55",
        owner_pid=44001,
        transport_kind="unix_socket_jsonl",
        worker_endpoint="/tmp/miniapp-attach.sock",
        resume_token="token-123",
        resume_deadline_ms=int(time.monotonic() * 1000) + 5000,
    )
    registry.note_worker_finished(session_id="miniapp-123-55", outcome="finished", chat_id=55, job_id=991, owner_pid=44001)

    owner_state = registry.owner_state()
    record = owner_state["owner_records"][0]
    assert record["state"] == "attachable_running"
    assert record["reusability_reason"] == "worker_attach_live_available"
    assert owner_state["live_attach_ready_count"] == 1


def test_isolated_worker_reusable_candidate_invalidated_by_evict() -> None:
    registry = hermes_client.IsolatedWorkerWarmSessionRegistryScaffold(reusable_candidate_ttl_ms=1000)
    registry.note_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
    registry.note_worker_finished(session_id="miniapp-123-55", outcome="completed", chat_id=55, job_id=991, owner_pid=44001)

    assert registry.evict("miniapp-123-55", reason="invalidated_by_clear") is True
    owner_state = registry.owner_state()
    assert owner_state["reusable_candidate_count"] == 0
    record = owner_state["owner_records"][0]
    assert record["state"] == "evicted"
    assert record["lifecycle_phase"] == "invalidated"
    assert record["reusable"] is False
    assert record["reusability_reason"] == "invalidated_by_clear"
    assert any(event["event"] == "evicted_explicit" and "invalidated_by=invalidated_by_clear" in str(event.get("detail") or "") for event in owner_state["recent_events"])


def test_isolated_worker_registry_selects_reusable_candidate() -> None:
    registry = hermes_client.IsolatedWorkerWarmSessionRegistryScaffold(reusable_candidate_ttl_ms=1000)
    registry.note_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
    assert registry.select_reusable_candidate("miniapp-123-55") is None
    registry.note_worker_finished(session_id="miniapp-123-55", outcome="completed", chat_id=55, job_id=991, owner_pid=44001)

    candidate = registry.select_reusable_candidate("miniapp-123-55")
    assert candidate is not None
    assert candidate["session_id"] == "miniapp-123-55"
    assert candidate["state"] == "reusable_candidate"
    assert candidate["reusable"] is True
    reuse_contract = candidate["reuse_contract"]
    assert reuse_contract["contract_version"] == "warm-reuse-v1"
    assert reuse_contract["session_id"] == "miniapp-123-55"
    assert reuse_contract["owner_pid"] == 44001
    assert reuse_contract["owner_class"] == "IsolatedWorkerWarmSessionRegistryScaffold"
    assert reuse_contract["lifecycle_phase"] == "post_attempt"
    assert reuse_contract["reusability_reason"] == "isolated_worker_warm_reuse_not_implemented"
    assert reuse_contract["resume_supported"] is False
    assert reuse_contract["resume_capability"] == "none"
    assert reuse_contract["supported_resume_modes"] == []
    assert reuse_contract["required_transport"] == "subprocess"
    assert reuse_contract["attach_mechanism"] == "pid_only"
    assert reuse_contract["required_now"] == [
        "contract_version",
        "session_id",
        "owner_class",
        "owner_pid",
        "lifecycle_phase",
        "reusability_reason",
    ]
    assert reuse_contract["reserved_for_future"] == [
        "resume_token",
        "worker_endpoint",
        "transport_kind",
        "resume_deadline_ms",
    ]
    assert reuse_contract["resume_token"] is None
    assert reuse_contract["worker_endpoint"] is None
    assert reuse_contract["transport_kind"] is None
    assert reuse_contract["resume_deadline_ms"] is None


def test_client_select_warm_session_candidate_uses_active_registry(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()
    assert client.select_warm_session_candidate("miniapp-123-55") is None
    client.note_warm_session_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991)
    client.note_warm_session_worker_finished(session_id="miniapp-123-55", outcome="completed", chat_id=55, job_id=991)
    candidate = client.select_warm_session_candidate("miniapp-123-55")
    assert candidate is not None
    assert candidate["session_id"] == "miniapp-123-55"


def test_probe_warm_session_candidate_records_unavailable_reason(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    probe = client.probe_warm_session_candidate("miniapp-123-missing", reason="stream_start:agent")
    assert probe["available"] is False
    assert probe["unavailable_reason"] == "no_owner_record"
    recent = client.warm_session_strategy()["recent_candidate_probes"]
    assert recent[-1]["session_id"] == "miniapp-123-missing"


def test_record_warm_reuse_decision_unavailable(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    decision = client.record_warm_reuse_decision("miniapp-123-missing", reason="stream_start:agent", candidate=None)
    assert decision["decision"] == "candidate_unavailable"
    assert decision["detail"] == "no_owner_record"
    recent = client.warm_session_strategy()["recent_reuse_decisions"]
    assert recent[-1]["session_id"] == "miniapp-123-missing"


def test_probe_warm_session_candidate_records_available_candidate(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()
    client.note_warm_session_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991)
    client.note_warm_session_worker_finished(session_id="miniapp-123-55", outcome="completed", chat_id=55, job_id=991)

    probe = client.probe_warm_session_candidate("miniapp-123-55", reason="stream_start:agent")
    assert probe["available"] is True
    assert probe["candidate"]["session_id"] == "miniapp-123-55"
    assert probe["unavailable_reason"] is None


def test_evaluate_warm_reuse_policy_defaults_disabled(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()
    client.note_warm_session_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991)
    client.note_warm_session_worker_finished(session_id="miniapp-123-55", outcome="completed", chat_id=55, job_id=991)
    candidate = client.select_warm_session_candidate("miniapp-123-55")

    policy = client.evaluate_warm_reuse_policy(
        "miniapp-123-55",
        reason="stream_start:agent",
        requested_path="agent",
        candidate=candidate,
    )
    assert policy["allowed"] is False
    assert policy["policy"] == "disabled_by_policy"
    assert policy["detail"] == "warm worker reuse flag is disabled"
    assert policy["candidate_available"] is True
    assert policy["candidate"]["session_id"] == "miniapp-123-55"
    recent = client.warm_session_strategy()["recent_reuse_policy_checks"]
    assert recent[-1]["session_id"] == "miniapp-123-55"


def test_evaluate_warm_reuse_policy_allows_same_chat_worker_attach_when_flag_enabled(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_REUSE", "1")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_SAME_CHAT_ONLY", "1")
    client = hermes_client.HermesClient()
    client.note_warm_session_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
    client.note_warm_session_worker_attach_ready(
        session_id="miniapp-123-55",
        owner_pid=44001,
        transport_kind="unix_socket_jsonl",
        worker_endpoint="/tmp/miniapp-attach.sock",
        resume_token="token-123",
        resume_deadline_ms=int(time.monotonic() * 1000) + 5000,
    )
    candidate = client.select_warm_session_candidate("miniapp-123-55")

    policy = client.evaluate_warm_reuse_policy(
        "miniapp-123-55",
        reason="stream_start:agent-worker-isolated",
        requested_path="agent-worker-isolated",
        candidate=candidate,
    )

    assert policy["allowed"] is True
    assert policy["policy"] == "same_chat_warm_worker_reuse"
    assert policy["detail"] == "same-chat warm worker reuse allowed"
    assert policy["warm_worker_reuse_enabled"] is True
    assert policy["warm_worker_same_chat_only"] is True
    assert policy["candidate"]["session_id"] == "miniapp-123-55"


def test_evaluate_warm_reuse_policy_retires_candidate_over_thread_budget(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_REUSE", "1")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_SAME_CHAT_ONLY", "1")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_HEALTH_MAX_THREADS", "8")
    client = hermes_client.HermesClient()
    client.note_warm_session_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
    client.note_warm_session_worker_attach_ready(
        session_id="miniapp-123-55",
        owner_pid=44001,
        transport_kind="unix_socket_jsonl",
        worker_endpoint="/tmp/miniapp-attach.sock",
        resume_token="token-123",
        resume_deadline_ms=int(time.monotonic() * 1000) + 5000,
    )
    monkeypatch.setattr(client, "_read_process_status", lambda pid: {"Threads": "12", "VmRSS": "512000 kB", "state_code": "S"})
    candidate = client.select_warm_session_candidate("miniapp-123-55")

    policy = client.evaluate_warm_reuse_policy(
        "miniapp-123-55",
        reason="stream_start:agent-worker-isolated",
        requested_path="agent-worker-isolated",
        candidate=candidate,
    )

    assert policy["allowed"] is False
    assert policy["policy"] == "candidate_unavailable"
    assert "retired_thread_limit" in str(policy["detail"])
    owner_state = client.warm_session_owner_state()
    record = owner_state["owner_records"][0]
    assert record["state"] == "evicted"
    assert "retired_thread_limit" in str(record["reusability_reason"])
    assert record["last_known_thread_count"] == 12
    summary = owner_state["retirement_summary"]
    assert summary["total"] == 1
    assert summary["by_reason"]["thread_limit"] == 1
    assert summary["recent"][0]["session_id"] == "miniapp-123-55"


def test_probe_warm_session_candidate_retires_candidate_after_run_budget(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_REUSE", "1")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_RETIRE_AFTER_RUNS", "2")
    client = hermes_client.HermesClient()
    for _ in range(3):
        client.note_warm_session_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
        client.note_warm_session_worker_finished(session_id="miniapp-123-55", outcome="completed", chat_id=55, job_id=991, owner_pid=44001)

    probe = client.probe_warm_session_candidate("miniapp-123-55", reason="stream_start:agent-worker-isolated")

    assert probe["available"] is False
    assert probe["unavailable_reason"] == "retired_after_run_budget"
    owner_state = client.warm_session_owner_state()
    record = owner_state["owner_records"][0]
    assert record["state"] == "evicted"
    assert "retired_after_run_budget" in str(record["reusability_reason"])
    summary = client.warm_session_strategy()["retirement_summary"]
    assert summary["total"] == 1
    assert summary["by_reason"]["run_budget"] == 1


def test_warm_session_strategy_surfaces_failure_signature_retirements(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_REUSE", "1")
    client = hermes_client.HermesClient()
    client.note_warm_session_worker_started(session_id="miniapp-123-99", chat_id=99, job_id=991, owner_pid=44001)
    assert client.evict_session("miniapp-123-99", reason="failure_signature:direct_agent:memory_pressure") is True

    summary = client.warm_session_strategy()["retirement_summary"]
    assert summary["total"] == 1
    assert summary["by_reason"]["failure_signature"] == 1
    assert summary["recent"][0]["session_id"] == "miniapp-123-99"
    assert "failure_signature:direct_agent:memory_pressure" in str(summary["recent"][0]["reason"])


def test_record_warm_reuse_decision_available_policy_blocked(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()
    client.note_warm_session_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991)
    client.note_warm_session_worker_finished(session_id="miniapp-123-55", outcome="completed", chat_id=55, job_id=991)
    candidate = client.select_warm_session_candidate("miniapp-123-55")
    policy = client.evaluate_warm_reuse_policy(
        "miniapp-123-55",
        reason="stream_start:agent",
        requested_path="agent",
        candidate=candidate,
    )

    decision = client.record_warm_reuse_decision(
        "miniapp-123-55",
        reason="stream_start:agent",
        candidate=candidate,
        policy=policy,
    )
    assert decision["decision"] == "candidate_available_policy_blocked"
    assert decision["available"] is True
    assert decision["detail"] == "disabled_by_policy"
    assert decision["policy"]["allowed"] is False
    assert decision["candidate"]["session_id"] == "miniapp-123-55"
    recent = client.warm_session_strategy()["recent_reuse_decisions"]
    assert recent[-1]["session_id"] == "miniapp-123-55"


def test_validate_warm_reuse_contract_reports_missing_required_fields(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    contract = {
        "contract_version": "warm-reuse-v1",
        "session_id": "miniapp-123-7",
        "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
        "owner_pid": None,
        "lifecycle_phase": "post_attempt",
        "reusability_reason": "isolated_worker_warm_reuse_not_implemented",
        "resume_supported": False,
        "required_now": [
            "contract_version",
            "session_id",
            "owner_class",
            "owner_pid",
            "lifecycle_phase",
            "reusability_reason",
        ],
        "reserved_for_future": ["resume_token", "worker_endpoint", "transport_kind", "resume_deadline_ms"],
    }

    validation = client.validate_warm_reuse_contract(session_id="miniapp-123-7", reuse_contract=contract)
    assert validation["valid"] is False
    assert validation["status"] == "missing_required_fields"
    assert validation["missing_required_fields"] == ["owner_pid"]
    assert validation["resume_capability"] == "unknown"


def test_validate_warm_reuse_contract_reports_invalid_session_binding(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    contract = {
        "contract_version": "warm-reuse-v1",
        "session_id": "miniapp-123-other",
        "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
        "owner_pid": 4242,
        "lifecycle_phase": "post_attempt",
        "reusability_reason": "isolated_worker_warm_reuse_not_implemented",
        "resume_supported": False,
        "required_now": [
            "contract_version",
            "session_id",
            "owner_class",
            "owner_pid",
            "lifecycle_phase",
            "reusability_reason",
        ],
        "reserved_for_future": ["resume_token", "worker_endpoint", "transport_kind", "resume_deadline_ms"],
    }

    validation = client.validate_warm_reuse_contract(session_id="miniapp-123-7", reuse_contract=contract)
    assert validation["valid"] is False
    assert validation["status"] == "invalid_session_binding"
    assert validation["missing_required_fields"] == []
    assert validation["resume_capability"] == "unknown"


def test_validate_warm_reuse_contract_reports_unsupported_version(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    contract = {
        "contract_version": "warm-reuse-v2",
        "session_id": "miniapp-123-7",
        "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
        "owner_pid": 4242,
        "lifecycle_phase": "post_attempt",
        "reusability_reason": "isolated_worker_warm_reuse_not_implemented",
        "resume_supported": False,
        "required_now": [
            "contract_version",
            "session_id",
            "owner_class",
            "owner_pid",
            "lifecycle_phase",
            "reusability_reason",
        ],
        "reserved_for_future": ["resume_token", "worker_endpoint", "transport_kind", "resume_deadline_ms"],
    }

    validation = client.validate_warm_reuse_contract(session_id="miniapp-123-7", reuse_contract=contract)
    assert validation["valid"] is False
    assert validation["status"] == "unsupported_contract_version"
    assert validation["missing_required_fields"] == []
    assert validation["resume_capability"] == "unknown"


def test_attempt_warm_reuse_records_invalid_session_binding_fallback(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    candidate = {
        "session_id": "miniapp-123-7",
        "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
        "owner_pid": 4242,
        "reuse_contract": {
            "contract_version": "warm-reuse-v1",
            "session_id": "miniapp-123-other",
            "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
            "owner_pid": 4242,
            "lifecycle_phase": "post_attempt",
            "reusability_reason": "isolated_worker_warm_reuse_not_implemented",
            "resume_supported": False,
            "required_now": [
                "contract_version",
                "session_id",
                "owner_class",
                "owner_pid",
                "lifecycle_phase",
                "reusability_reason",
            ],
            "reserved_for_future": ["resume_token", "worker_endpoint", "transport_kind", "resume_deadline_ms"],
        },
    }
    policy = {"policy": "test_allow", "allowed": True}

    result = client.attempt_warm_reuse(
        session_id="miniapp-123-7",
        reason="stream_start:agent",
        requested_path="agent",
        candidate=candidate,
        policy=policy,
        user_id="123",
        message="hello",
        conversation_history=None,
    )

    assert result is None
    recent = client.warm_session_strategy()["recent_reuse_attempts"]
    assert recent[-1]["attempt"] == "reuse_contract_invalid_session_binding"
    assert recent[-1]["fallback_reason"] == "reuse_contract_invalid_session_binding"
    assert recent[-1]["validation"]["status"] == "invalid_session_binding"
    assert recent[-1]["validation"]["resume_capability"] == "none"


def test_attempt_warm_reuse_records_unsupported_version_fallback(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    candidate = {
        "session_id": "miniapp-123-7",
        "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
        "owner_pid": 4242,
        "reuse_contract": {
            "contract_version": "warm-reuse-v2",
            "session_id": "miniapp-123-7",
            "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
            "owner_pid": 4242,
            "lifecycle_phase": "post_attempt",
            "reusability_reason": "isolated_worker_warm_reuse_not_implemented",
            "resume_supported": False,
            "required_now": [
                "contract_version",
                "session_id",
                "owner_class",
                "owner_pid",
                "lifecycle_phase",
                "reusability_reason",
            ],
            "reserved_for_future": ["resume_token", "worker_endpoint", "transport_kind", "resume_deadline_ms"],
        },
    }
    policy = {"policy": "test_allow", "allowed": True}

    result = client.attempt_warm_reuse(
        session_id="miniapp-123-7",
        reason="stream_start:agent",
        requested_path="agent",
        candidate=candidate,
        policy=policy,
        user_id="123",
        message="hello",
        conversation_history=None,
    )

    assert result is None
    recent = client.warm_session_strategy()["recent_reuse_attempts"]
    assert recent[-1]["attempt"] == "reuse_contract_unsupported_version"
    assert recent[-1]["fallback_reason"] == "reuse_contract_unsupported_version"
    assert recent[-1]["validation"]["status"] == "unsupported_contract_version"
    assert recent[-1]["validation"]["resume_capability"] == "none"


def test_attempt_warm_reuse_records_contract_missing_fallback(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    candidate = {
        "session_id": "miniapp-123-7",
        "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
        "owner_pid": None,
        "reuse_contract": {
            "contract_version": "warm-reuse-v1",
            "session_id": "miniapp-123-7",
            "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
            "owner_pid": None,
            "lifecycle_phase": "post_attempt",
            "reusability_reason": "isolated_worker_warm_reuse_not_implemented",
            "resume_supported": False,
            "required_now": [
                "contract_version",
                "session_id",
                "owner_class",
                "owner_pid",
                "lifecycle_phase",
                "reusability_reason",
            ],
            "reserved_for_future": ["resume_token", "worker_endpoint", "transport_kind", "resume_deadline_ms"],
        },
    }
    policy = {"policy": "test_allow", "allowed": True}

    result = client.attempt_warm_reuse(
        session_id="miniapp-123-7",
        reason="stream_start:agent",
        requested_path="agent",
        candidate=candidate,
        policy=policy,
        user_id="123",
        message="hello",
        conversation_history=None,
    )

    assert result is None
    recent = client.warm_session_strategy()["recent_reuse_attempts"]
    assert recent[-1]["attempt"] == "reuse_contract_missing_required_fields"
    assert recent[-1]["fallback_to"] == "agent"
    assert recent[-1]["fallback_reason"] == "reuse_contract_missing_required_fields"
    assert recent[-1]["reuse_contract"]["contract_version"] == "warm-reuse-v1"
    assert recent[-1]["validation"]["status"] == "missing_required_fields"
    assert recent[-1]["validation"]["resume_capability"] == "none"
    assert recent[-1]["missing_required_fields"] == ["owner_pid"]
    assert recent[-1]["policy"]["policy"] == "test_allow"


def test_attempt_warm_reuse_records_resume_not_supported_yet(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    candidate = {
        "session_id": "miniapp-123-7",
        "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
        "owner_pid": 4242,
        "reuse_contract": {
            "contract_version": "warm-reuse-v1",
            "session_id": "miniapp-123-7",
            "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
            "owner_pid": 4242,
            "lifecycle_phase": "post_attempt",
            "reusability_reason": "isolated_worker_warm_reuse_not_implemented",
            "resume_supported": False,
            "resume_capability": "none",
            "supported_resume_modes": [],
            "required_transport": "subprocess",
            "attach_mechanism": "pid_only",
            "required_now": [
                "contract_version",
                "session_id",
                "owner_class",
                "owner_pid",
                "lifecycle_phase",
                "reusability_reason",
            ],
            "reserved_for_future": ["resume_token", "worker_endpoint", "transport_kind", "resume_deadline_ms"],
        },
    }
    policy = {"policy": "test_allow", "allowed": True}

    result = client.attempt_warm_reuse(
        session_id="miniapp-123-7",
        reason="stream_start:agent",
        requested_path="agent",
        candidate=candidate,
        policy=policy,
        user_id="123",
        message="hello",
        conversation_history=[{"role": "user", "content": "earlier"}],
    )

    assert result is None
    recent = client.warm_session_strategy()["recent_reuse_attempts"]
    assert recent[-1]["attempt"] == "reuse_resume_not_supported_yet"
    assert recent[-1]["fallback_to"] == "agent"
    assert recent[-1]["reuse_contract"]["owner_pid"] == 4242
    assert recent[-1]["validation"]["status"] == "valid"
    assert recent[-1]["validation"]["resume_capability"] == "none"
    assert recent[-1]["missing_required_fields"] == []
    assert recent[-1]["reserved_future_fields"] == [
        "resume_token",
        "worker_endpoint",
        "transport_kind",
        "resume_deadline_ms",
    ]
    assert recent[-1]["conversation_history_len"] == 1


def test_execute_worker_attach_reports_owner_missing(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    attach_plan = {
        "mode": "worker_attach",
        "planned": True,
        "deferred": True,
        "status": "attach_plan_ready",
        "session_id": "miniapp-123-7",
        "requested_path": "agent",
        "attach_mechanism": "pid_only",
        "required_transport": "subprocess",
        "supported_resume_modes": ["worker_attach"],
        "owner_pid": 4242,
        "candidate_session_id": "miniapp-123-7",
        "validation_status": "valid",
        "missing_prerequisites": [],
        "next_step": "implement_worker_attach_execution",
    }

    def fake_kill(pid, sig):
        raise ProcessLookupError()

    monkeypatch.setattr(hermes_client.os, "kill", fake_kill)

    execution = client.execute_worker_attach(
        session_id="miniapp-123-7",
        requested_path="agent",
        attach_plan=attach_plan,
    )
    assert execution["executed"] is False
    assert execution["status"] == "attach_owner_missing"
    assert execution["owner_pid"] == 4242


def test_execute_worker_attach_reports_owner_present_wrong_identity(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    attach_plan = {
        "mode": "worker_attach",
        "planned": True,
        "deferred": True,
        "status": "attach_plan_ready",
        "session_id": "miniapp-123-7",
        "requested_path": "agent",
        "attach_mechanism": "pid_only",
        "required_transport": "subprocess",
        "supported_resume_modes": ["worker_attach"],
        "owner_pid": 4242,
        "candidate_session_id": "miniapp-123-7",
        "validation_status": "valid",
        "missing_prerequisites": [],
        "next_step": "implement_worker_attach_execution",
    }

    monkeypatch.setattr(hermes_client.os, "kill", lambda pid, sig: None)
    monkeypatch.setattr(client, "_read_process_cmdline", lambda pid: "/usr/bin/python other_process.py")

    execution = client.execute_worker_attach(
        session_id="miniapp-123-7",
        requested_path="agent",
        attach_plan=attach_plan,
    )
    assert execution["executed"] is False
    assert execution["status"] == "attach_owner_present_wrong_identity"
    assert execution["owner_pid"] == 4242


def test_execute_worker_attach_reports_owner_present_identity_verified_via_contract_when_cmdline_session_is_missing(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    attach_plan = {
        "mode": "worker_attach",
        "planned": True,
        "deferred": True,
        "status": "attach_plan_ready",
        "session_id": "miniapp-123-7",
        "requested_path": "agent",
        "attach_mechanism": "pid_only",
        "required_transport": "subprocess",
        "supported_resume_modes": ["worker_attach"],
        "owner_pid": 4242,
        "candidate_session_id": "miniapp-123-7",
        "validation_status": "valid",
        "missing_prerequisites": [],
        "next_step": "implement_worker_attach_execution",
    }

    monkeypatch.setattr(hermes_client.os, "kill", lambda pid, sig: None)
    monkeypatch.setattr(client, "_read_process_cmdline", lambda pid: "/usr/bin/python chat_worker_subprocess.py")

    execution = client.execute_worker_attach(
        session_id="miniapp-123-7",
        requested_path="agent",
        attach_plan=attach_plan,
    )
    assert execution["executed"] is False
    assert execution["status"] == "attach_owner_identity_verified_session_verified"
    assert execution["session_binding"]["verified"] is True
    assert execution["session_binding"]["reason"] == "session_id_verified_by_contract"
    assert execution["owner_pid"] == 4242


def test_execute_worker_attach_reports_owner_present_identity_and_session_verified(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    attach_plan = {
        "mode": "worker_attach",
        "planned": True,
        "deferred": True,
        "status": "attach_plan_ready",
        "session_id": "miniapp-123-7",
        "requested_path": "agent",
        "attach_mechanism": "pid_only",
        "required_transport": "subprocess",
        "supported_resume_modes": ["worker_attach"],
        "owner_pid": 4242,
        "candidate_session_id": "miniapp-123-7",
        "validation_status": "valid",
        "missing_prerequisites": [],
        "next_step": "implement_worker_attach_execution",
    }

    monkeypatch.setattr(hermes_client.os, "kill", lambda pid, sig: None)
    monkeypatch.setattr(client, "_read_process_cmdline", lambda pid: "/usr/bin/python chat_worker_subprocess.py --session miniapp-123-7")

    execution = client.execute_worker_attach(
        session_id="miniapp-123-7",
        requested_path="agent",
        attach_plan=attach_plan,
    )
    assert execution["executed"] is False
    assert execution["status"] == "attach_owner_identity_verified_session_verified"
    assert execution["session_binding"]["verified"] is True
    assert execution["owner_pid"] == 4242


def test_decide_worker_attach_eligibility_reports_probe_only(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    validation = {"valid": True, "status": "valid", "resume_capability": "worker_attach"}
    attach_plan = {"status": "attach_plan_ready", "missing_prerequisites": []}
    attach_execution = {"status": "attach_owner_identity_verified_session_verified", "executed": False}

    eligibility = client.decide_worker_attach_eligibility(
        validation=validation,
        attach_plan=attach_plan,
        attach_execution=attach_execution,
    )
    assert eligibility["status"] == "attach_eligible_probe_only"
    assert eligibility["eligible"] is True


def test_execute_worker_attach_action_attempts_handshake_without_cmdline_when_eligible(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    eligibility = {"status": "attach_eligible_probe_only", "eligible": True, "reason": "attach_owner_identity_verified_session_verified"}
    attach_execution = {"status": "attach_owner_identity_verified_session_verified", "executed": False, "owner_pid": 4242, "cmdline": None}
    monkeypatch.setattr(
        client,
        "_attempt_live_worker_attach_handshake",
        lambda *, session_id, requested_path, attach_execution: {
            "executed": True,
            "status": "attach_action_handshake_succeeded",
            "session_id": session_id,
            "requested_path": requested_path,
            "owner_pid": attach_execution.get("owner_pid"),
            "reason": "handshake_proc_probe_succeeded",
            "handshake_attempted": True,
        },
    )

    action = client.execute_worker_attach_action(
        session_id="miniapp-123-7",
        requested_path="agent",
        attach_eligibility=eligibility,
        attach_execution=attach_execution,
    )
    assert action["executed"] is True
    assert action["status"] == "attach_action_handshake_succeeded"
    assert action["reason"] == "handshake_proc_probe_succeeded"


def test_execute_worker_attach_action_merges_handshake_result(monkeypatch) -> None:

    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    monkeypatch.setattr(hermes_client.os, "kill", lambda pid, sig: None)
    monkeypatch.setattr(
        client,
        "_read_process_status",
        lambda pid: {"state": "S (sleeping)", "state_code": "S"},
    )
    monkeypatch.setattr(
        client,
        "_read_process_fd_link",
        lambda pid, fd: {0: "pipe:[12345]", 1: "pipe:[67890]"}.get(fd),
    )

    action = client._attempt_live_worker_attach_handshake(
        session_id="miniapp-123-7",
        requested_path="agent",
        attach_execution={"owner_pid": 4242},
    )
    assert action["executed"] is True
    assert action["status"] == "attach_action_handshake_succeeded"
    assert action["owner_pid"] == 4242
    assert action["handshake_detail"]["stdin_link"] == "pipe:[12345]"
    assert action["handshake_detail"]["stdout_link"] == "pipe:[67890]"


def test_execute_worker_attach_action_runs_live_handshake_when_ready(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    eligibility = {"status": "attach_eligible_probe_only", "eligible": True, "reason": "attach_owner_identity_verified_session_verified"}
    attach_execution = {
        "status": "attach_owner_identity_verified_session_verified",
        "executed": False,
        "owner_pid": 4242,
        "cmdline": "/usr/bin/python chat_worker_subprocess.py --session miniapp-123-7",
    }
    monkeypatch.setattr(
        client,
        "_attempt_live_worker_attach_handshake",
        lambda *, session_id, requested_path, attach_execution: {
            "executed": True,
            "status": "attach_action_handshake_succeeded",
            "session_id": session_id,
            "requested_path": requested_path,
            "owner_pid": attach_execution.get("owner_pid"),
            "reason": "handshake_proc_probe_succeeded",
            "handshake_attempted": True,
            "handshake_timeout_ms": 250,
            "handshake_detail": {"stdin_link": "pipe:[12345]", "stdout_link": "pipe:[67890]"},
            "next_step": "implement_live_stream_attach_after_handshake",
        },
    )

    action = client.execute_worker_attach_action(
        session_id="miniapp-123-7",
        requested_path="agent",
        attach_eligibility=eligibility,
        attach_execution=attach_execution,
    )
    assert action["executed"] is True
    assert action["status"] == "attach_action_handshake_succeeded"
    assert action["owner_pid"] == 4242
    assert action["precondition_status"] == "attach_action_handshake_ready"
    assert action["handshake_attempted"] is True


def test_evict_session_terminates_live_attach_owner(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()
    client.note_warm_session_worker_started(session_id="miniapp-123-55", chat_id=55, job_id=991, owner_pid=44001)
    client.note_warm_session_worker_attach_ready(
        session_id="miniapp-123-55",
        owner_pid=44001,
        transport_kind="unix_socket_jsonl",
        worker_endpoint="/tmp/miniapp-attach.sock",
        resume_token="token-123",
        resume_deadline_ms=int(time.monotonic() * 1000) + 5000,
    )
    terminated = []
    monkeypatch.setattr(client, "_terminate_warm_owner_process", lambda *, pid, reason: terminated.append((pid, reason)) or True)

    result = client.evict_session("miniapp-123-55", reason="invalidated_by_remove")

    assert result is True
    assert terminated == [(44001, "invalidated_by_remove")]
    owner_state = client.warm_session_owner_state()
    assert owner_state["owner_records"][0]["state"] == "evicted"


def test_stream_events_from_worker_attach_socket_refreshes_attach_contract(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    class _FakeReader:
        def __init__(self) -> None:
            self._lines = [
                f'{{"type":"attach_ready","session_id":"miniapp-123-55","transport_kind":"unix_socket_jsonl","worker_endpoint":"/tmp/next.sock","resume_token":"next-token","resume_deadline_ms":{int(time.monotonic() * 1000) + 5000}}}\n'.encode(),
                b'{"type":"done","reply":"ok","source":"warm-attach","latency_ms":1}\n',
                b"",
            ]
            self.closed = False

        def readline(self):
            return self._lines.pop(0)

        def close(self):
            self.closed = True

    class _FakeSocket:
        def __init__(self) -> None:
            self.closed = False

        def close(self):
            self.closed = True

    reader = _FakeReader()
    sock = _FakeSocket()
    events = list(client._stream_events_from_worker_attach_socket(session_id="miniapp-123-55", sock=sock, reader=reader))

    assert events == [{"type": "done", "reply": "ok", "source": "warm-attach", "latency_ms": 1}]
    owner_state = client.warm_session_owner_state()
    record = owner_state["owner_records"][0]
    assert record["state"] == "attachable_running"
    assert record["attach_worker_endpoint"] == "/tmp/next.sock"
    assert record["attach_resume_token"] == "next-token"
    assert reader.closed is True
    assert sock.closed is True


def test_stream_events_from_worker_attach_socket_reports_error_on_eof_without_terminal_event(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    class _FakeReader:
        def __init__(self) -> None:
            self._lines = [
                b'{"type":"meta","source":"warm-attach"}\n',
                b"",
            ]
            self.closed = False

        def readline(self):
            return self._lines.pop(0)

        def close(self):
            self.closed = True

    class _FakeSocket:
        def __init__(self) -> None:
            self.closed = False

        def close(self):
            self.closed = True

    reader = _FakeReader()
    sock = _FakeSocket()
    events = list(client._stream_events_from_worker_attach_socket(session_id="miniapp-123-55", sock=sock, reader=reader))

    assert events == [
        {"type": "meta", "source": "warm-attach"},
        {"type": "error", "error": "Warm attach stream closed before a terminal event was received."},
    ]
    assert reader.closed is True
    assert sock.closed is True


def test_attempt_live_worker_attach_resume_succeeds_over_unix_socket(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    with tempfile.TemporaryDirectory() as tmpdir:
        socket_path = Path(tmpdir) / "warm-attach.sock"
        received = {}

        def _server() -> None:
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(socket_path))
            server.listen(1)
            conn, _addr = server.accept()
            with conn:
                reader = conn.makefile("rb")
                request = json.loads(reader.readline().decode("utf-8"))
                received.update(request)
                conn.sendall(b'{"type":"attach_ack","accepted":true,"reason":"accepted_for_test"}\n')
                conn.sendall(b'{"type":"meta","source":"warm-attach"}\n')
                conn.sendall(b'{"type":"done","reply":"attached ok","source":"warm-attach","latency_ms":1}\n')
                reader.close()
            server.close()

        thread = threading.Thread(target=_server, daemon=True)
        thread.start()
        time.sleep(0.02)

        action, events_iter = client._attempt_live_worker_attach_resume(
            session_id="miniapp-123-7",
            requested_path="agent",
            reuse_contract={
                "transport_kind": "unix_socket_jsonl",
                "worker_endpoint": str(socket_path),
                "resume_token": "token-123",
                "resume_deadline_ms": int(time.monotonic() * 1000) + 5000,
            },
            attach_action={"status": "attach_action_handshake_succeeded"},
            user_id="123",
            message="hello",
            conversation_history=[{"role": "user", "content": "earlier"}],
        )
        events = list(events_iter or [])
        thread.join(timeout=1)

    assert action["status"] == "attach_action_attach_succeeded"
    assert action["reason"] == "accepted_for_test"
    assert received["type"] == "warm_attach_resume"
    assert received["session_id"] == "miniapp-123-7"
    assert received["resume_token"] == "token-123"
    assert [event.get("type") for event in events] == ["meta", "done"]
    assert events[-1]["reply"] == "attached ok"


def test_resolve_attach_resume_transport_requires_supported_socket_contract(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    unavailable = client._resolve_attach_resume_transport(
        session_id="miniapp-123-7",
        requested_path="agent",
        reuse_contract={"transport_kind": "http", "resume_token": "token-123"},
        attach_action={"status": "attach_action_handshake_succeeded"},
    )

    assert unavailable["status"] == "attach_action_attach_unavailable"
    assert unavailable["reason"] == "unsupported_transport_kind"
    assert unavailable["resume_token_present"] is True

    resolved = client._resolve_attach_resume_transport(
        session_id="miniapp-123-7",
        requested_path="agent",
        reuse_contract={
            "transport_kind": "unix_socket_jsonl",
            "worker_endpoint": "/tmp/fake.sock",
            "resume_token": "token-123",
            "resume_deadline_ms": int(time.monotonic() * 1000) + 5000,
        },
        attach_action={"status": "attach_action_handshake_succeeded"},
    )

    assert resolved["status"] == "attach_action_attach_ready"
    assert resolved["transport_kind"] == "unix_socket_jsonl"
    assert resolved["worker_endpoint"] == "/tmp/fake.sock"
    assert resolved["resume_token"] == "token-123"


def test_resolve_attach_resume_transport_reports_windows_platform_limit(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    monkeypatch.setattr(hermes_client.sys, "platform", "win32", raising=False)
    client = hermes_client.HermesClient()

    resolved = client._resolve_attach_resume_transport(
        session_id="miniapp-123-7",
        requested_path="agent",
        reuse_contract={
            "transport_kind": "unix_socket_jsonl",
            "worker_endpoint": "C:/tmp/fake.sock",
            "resume_token": "token-123",
            "resume_deadline_ms": int(time.monotonic() * 1000) + 5000,
        },
        attach_action={"status": "attach_action_handshake_succeeded"},
    )

    assert resolved["status"] == "attach_action_attach_unavailable"
    assert resolved["reason"] == "unsupported_platform_warm_attach"
    assert resolved["transport_kind"] == "unix_socket_jsonl"


def test_attempt_warm_reuse_returns_live_attach_stream_when_transport_available(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    client = hermes_client.HermesClient()

    candidate = {
        "session_id": "miniapp-123-7",
        "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
        "owner_pid": 4242,
        "reuse_contract": {
            "contract_version": "warm-reuse-v1",
            "session_id": "miniapp-123-7",
            "owner_class": "IsolatedWorkerWarmSessionRegistryScaffold",
            "owner_pid": 4242,
            "lifecycle_phase": "post_attempt",
            "reusability_reason": "isolated_worker_warm_reuse_not_implemented",
            "resume_supported": False,
            "resume_capability": "worker_attach",
            "supported_resume_modes": ["worker_attach"],
            "required_transport": "subprocess",
            "attach_mechanism": "pid_only",
            "transport_kind": "unix_socket_jsonl",
            "worker_endpoint": "/tmp/fake.sock",
            "resume_token": "token-123",
            "resume_deadline_ms": int(time.monotonic() * 1000) + 5000,
            "required_now": [
                "contract_version",
                "session_id",
                "owner_class",
                "owner_pid",
                "lifecycle_phase",
                "reusability_reason",
            ],
            "reserved_for_future": ["resume_token", "worker_endpoint", "transport_kind", "resume_deadline_ms"],
        },
    }
    policy = {"policy": "test_allow", "allowed": True}
    monkeypatch.setattr(hermes_client.os, "kill", lambda pid, sig: None)
    monkeypatch.setattr(client, "_read_process_cmdline", lambda pid: "/usr/bin/python chat_worker_subprocess.py --session miniapp-123-7")
    monkeypatch.setattr(
        client,
        "_read_process_status",
        lambda pid: {"state": "S (sleeping)", "state_code": "S"},
    )
    monkeypatch.setattr(
        client,
        "_read_process_fd_link",
        lambda pid, fd: {0: "pipe:[12345]", 1: "pipe:[67890]"}.get(fd),
    )
    monkeypatch.setattr(
        client,
        "_attempt_live_worker_attach_resume",
        lambda **kwargs: (
            {
                "executed": True,
                "status": "attach_action_attach_succeeded",
                "session_id": kwargs["session_id"],
                "requested_path": kwargs["requested_path"],
                "reason": "accepted_for_test",
                "transport_kind": "unix_socket_jsonl",
                "worker_endpoint": "/tmp/fake.sock",
                "resume_token_present": True,
                "ack_payload": {"type": "attach_ack", "accepted": True},
                "next_step": "stream_attached_worker_events",
            },
            iter([
                {"type": "meta", "source": "warm-attach"},
                {"type": "done", "reply": "attached ok", "source": "warm-attach", "latency_ms": 1},
            ]),
        ),
    )

    result = client.attempt_warm_reuse(
        session_id="miniapp-123-7",
        reason="stream_start:agent",
        requested_path="agent",
        candidate=candidate,
        policy=policy,
        user_id="123",
        message="hello",
        conversation_history=None,
    )

    assert result is not None
    assert list(result) == [
        {"type": "meta", "source": "warm-attach"},
        {"type": "done", "reply": "attached ok", "source": "warm-attach", "latency_ms": 1},
    ]
    recent = client.warm_session_strategy()["recent_reuse_attempts"]
    assert recent[-1]["attempt"] == "reuse_worker_attach_resume_streaming"
    assert recent[-1]["validation"]["status"] == "valid"
    assert recent[-1]["attach_action"]["status"] == "attach_action_handshake_succeeded"
    assert recent[-1]["attach_resume"]["status"] == "attach_action_attach_succeeded"
    assert recent[-1]["attach_resume"]["transport_kind"] == "unix_socket_jsonl"


def test_stream_events_attempts_warm_reuse_when_policy_allows(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()
    client.note_warm_session_worker_started(session_id="miniapp-123-7", chat_id=7, job_id=9001)
    client.note_warm_session_worker_finished(session_id="miniapp-123-7", outcome="completed", chat_id=7, job_id=9001)

    monkeypatch.setattr(
        client,
        "evaluate_warm_reuse_policy",
        lambda session_id, *, reason, requested_path, candidate: {
            "event": "warm_reuse_policy_check",
            "session_id": session_id,
            "reason": reason,
            "requested_path": requested_path,
            "policy": "test_allow",
            "allowed": True,
            "detail": "test policy enabled",
            "candidate_available": True,
            "candidate": candidate,
            "monotonic_ms": 1,
        },
    )

    attempted = {"count": 0}
    original_attempt = client.attempt_warm_reuse

    def fake_attempt(*, session_id, reason, requested_path, candidate, policy, user_id, message, conversation_history):
        attempted["count"] += 1
        return original_attempt(
            session_id=session_id,
            reason=reason,
            requested_path=requested_path,
            candidate=candidate,
            policy=policy,
            user_id=user_id,
            message=message,
            conversation_history=conversation_history,
        )

    monkeypatch.setattr(client, "attempt_warm_reuse", fake_attempt)
    monkeypatch.setattr(
        client,
        "_stream_via_agent",
        lambda **kwargs: iter(
            [
                {"type": "meta", "source": "agent"},
                {"type": "chunk", "text": "ok"},
                {"type": "done", "reply": "ok", "source": "agent", "latency_ms": 1},
            ]
        ),
    )
    monkeypatch.setattr(client, "_stream_via_cli_progress", lambda **kwargs: (_ for _ in ()).throw(AssertionError("cli fallback should not run")))

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-7"))
    assert attempted["count"] == 1
    assert any(event.get("source") == "agent" for event in events)
    assert any(event.get("type") == "done" for event in events)
    recent = client.warm_session_strategy()["recent_reuse_attempts"]
    assert recent[-1]["attempt"] == "reuse_contract_missing_required_fields"
    assert recent[-1]["fallback_to"] == "agent"
    assert recent[-1]["policy"]["policy"] == "test_allow"


def test_stream_events_skips_warm_reuse_attempt_when_policy_blocks(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()
    client.note_warm_session_worker_started(session_id="miniapp-123-7", chat_id=7, job_id=9001)
    client.note_warm_session_worker_finished(session_id="miniapp-123-7", outcome="completed", chat_id=7, job_id=9001)

    monkeypatch.setattr(client, "attempt_warm_reuse", lambda **kwargs: (_ for _ in ()).throw(AssertionError("warm reuse attempt should not run")))
    monkeypatch.setattr(
        client,
        "_stream_via_agent",
        lambda **kwargs: iter(
            [
                {"type": "meta", "source": "agent"},
                {"type": "chunk", "text": "ok"},
                {"type": "done", "reply": "ok", "source": "agent", "latency_ms": 1},
            ]
        ),
    )

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-7"))
    assert any(event.get("source") == "agent" for event in events)
    assert any(event.get("type") == "done" for event in events)
    assert client.warm_session_strategy()["recent_reuse_attempts"] == []


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


def test_stream_events_skips_persistent_runtime_when_ownership_is_checkpoint_only(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "checkpoint_only")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()

    monkeypatch.setattr(client, "_stream_via_persistent_agent", lambda **kwargs: (_ for _ in ()).throw(AssertionError("persistent path should be disabled")))
    monkeypatch.setattr(
        client,
        "_stream_via_agent",
        lambda **kwargs: iter(
            [
                {"type": "meta", "source": "agent"},
                {"type": "chunk", "text": "ok"},
                {"type": "done", "reply": "ok", "source": "agent", "latency_ms": 1},
            ]
        ),
    )

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-7"))
    assert any(event.get("source") == "agent" for event in events)
    assert client.persistent_sessions_requested is True
    assert client.persistent_sessions_enabled is False
    assert client.persistent_runtime_ownership == "checkpoint_only"


def test_persistent_runtime_ownership_defaults_to_auto_resolution(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.delenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", raising=False)
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")

    client = hermes_client.HermesClient()

    assert client.persistent_runtime_ownership == "checkpoint_only"
    assert client.persistent_sessions_enabled is False


def test_should_include_conversation_history_when_checkpoint_only_ownership(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "checkpoint_only")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()
    session_id = "miniapp-42-checkpoint-only"

    runtime = client._session_manager.get_or_create(
        session_id=session_id,
        model=client.model,
        max_iterations=client.max_iterations,
        create_agent=lambda: object(),
    )
    runtime.bootstrapped = True
    runtime.checkpoint_history = [{"role": "user", "content": "prior"}, {"role": "assistant", "content": "ok"}]

    assert client.should_include_conversation_history(session_id=session_id) is True


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


def test_persistent_agent_timeout_resets_on_progress_events(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("HERMES_TIMEOUT_SECONDS", "1")

    class _ProgressAgent:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.tool_progress_callback = kwargs.get("tool_progress_callback")

        def run_conversation(self, message, conversation_history=None, task_id=None):
            for idx in range(4):
                time.sleep(0.35)
                if self.tool_progress_callback:
                    self.tool_progress_callback("search_files", f"step-{idx}")
            return {"final_response": "progress-ok", "error": None, "messages": []}

    class _ProgressRunAgentModule:
        AIAgent = _ProgressAgent

    monkeypatch.setitem(sys.modules, "run_agent", _ProgressRunAgentModule())

    client = hermes_client.HermesClient()
    events = list(
        client._stream_via_persistent_agent(
            user_id="123",
            message="hello",
            session_id="miniapp-123-persistent-progress",
            conversation_history=[{"role": "operator", "body": "old"}],
        )
    )

    assert any(event.get("type") == "tool" for event in events)
    assert any(event.get("type") == "done" and event.get("reply") == "progress-ok" for event in events)


def test_persistent_agent_supports_event_typed_tool_progress_callback(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    class _TypedProgressAgent:
        def __init__(self, **kwargs):
            self.tool_progress_callback = kwargs.get("tool_progress_callback")

        def run_conversation(self, message, conversation_history=None, task_id=None):
            assert self.tool_progress_callback is not None
            self.tool_progress_callback("reasoning.available", "_thinking", "ignored", None)
            self.tool_progress_callback("tool.started", "terminal", "date", {"command": "date"})
            return {"final_response": "typed-progress-ok", "error": None, "messages": []}

    class _TypedProgressRunAgentModule:
        AIAgent = _TypedProgressAgent

    monkeypatch.setitem(sys.modules, "run_agent", _TypedProgressRunAgentModule())

    client = hermes_client.HermesClient()
    events = list(
        client._stream_via_persistent_agent(
            user_id="123",
            message="hello",
            session_id="miniapp-123-persistent-typed-progress",
            conversation_history=[{"role": "operator", "body": "old"}],
        )
    )

    tool_event = next(event for event in events if event.get("type") == "tool")
    assert tool_event.get("event_type") == "tool.started"
    assert tool_event.get("tool_name") == "terminal"
    assert tool_event.get("preview") == "date"
    assert tool_event.get("args") == {"command": "date"}
    assert tool_event.get("phase") == "started"
    assert any(event.get("type") == "done" and event.get("reply") == "typed-progress-ok" for event in events)


def test_persistent_agent_tool_progress_preserves_canonical_phase_and_ids(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    class _StructuredProgressAgent:
        def __init__(self, **kwargs):
            self.tool_progress_callback = kwargs.get("tool_progress_callback")

        def run_conversation(self, message, conversation_history=None, task_id=None):
            assert self.tool_progress_callback is not None
            self.tool_progress_callback(
                "tool.completed",
                "read_file",
                "loaded",
                {"path": "/tmp/x", "tool_call_id": "call-7", "message_id": 52},
            )
            return {"final_response": "structured-progress-ok", "error": None, "messages": []}

    class _StructuredProgressRunAgentModule:
        AIAgent = _StructuredProgressAgent

    monkeypatch.setitem(sys.modules, "run_agent", _StructuredProgressRunAgentModule())

    client = hermes_client.HermesClient()
    events = list(
        client._stream_via_persistent_agent(
            user_id="123",
            message="hello",
            session_id="miniapp-123-persistent-structured-progress",
            conversation_history=[{"role": "operator", "body": "old"}],
        )
    )

    tool_event = next(event for event in events if event.get("type") == "tool")
    assert tool_event.get("event_type") == "tool.completed"
    assert tool_event.get("phase") == "completed"
    assert tool_event.get("tool_call_id") == "call-7"
    assert tool_event.get("message_id") == 52
    assert tool_event.get("display")


def test_tool_progress_normalizer_accepts_legacy_four_arg_callback_with_metadata() -> None:
    normalized = hermes_client_tool_progress.normalize_tool_progress_callback_args(
        ("read_file", "loaded", {"path": "/tmp/x"}, {"message_id": 9, "tool_call_id": "call-legacy"})
    )

    assert normalized is not None
    assert normalized["event_type"] == "tool.started"
    assert normalized["tool_name"] == "read_file"
    assert normalized["preview"] == "loaded"
    assert normalized["args"] == {"path": "/tmp/x"}
    assert normalized["message_id"] == 9
    assert normalized["tool_call_id"] == "call-legacy"


def test_tool_progress_item_preserves_id_alias_as_tool_call_id() -> None:
    item = hermes_client_tool_progress.build_tool_progress_item(
        event_type="tool.completed",
        tool_name="read_file",
        preview="loaded",
        args={"id": "call-from-id", "turn_id": 12},
        display="read_file loaded",
    )

    event = hermes_client_tool_progress.stream_event_from_tool_item(
        item,
        display_formatter=lambda tool_name, preview=None, args=None: f"{tool_name}:{preview}",
    )

    assert item["tool_call_id"] == "call-from-id"
    assert item["message_id"] == 12
    assert event["tool_call_id"] == "call-from-id"
    assert event["message_id"] == 12
    assert event["event_type"] == "tool.completed"
    assert event["phase"] == "completed"


def test_tool_progress_dedupe_key_requires_stable_tool_call_id_for_new_mode() -> None:
    key = hermes_client_tool_progress.tool_progress_dedupe_key(
        {
            "event_type": "tool.started",
            "tool_name": "search_files",
            "preview": "first",
            "args": {},
            "metadata": {},
        },
        mode="new",
    )

    assert key is None


def test_tool_progress_dedupe_key_uses_event_type_tool_name_and_stable_call_id() -> None:
    key = hermes_client_tool_progress.tool_progress_dedupe_key(
        {
            "event_type": "tool.updated",
            "tool_name": "search_files",
            "tool_call_id": "call-123",
        },
        mode="new",
    )

    assert key == "tool.updated::search_files::call-123"


def test_direct_agent_timeout_resets_on_progress_events(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("HERMES_TIMEOUT_SECONDS", "1")

    client = hermes_client.HermesClient()
    monkeypatch.setattr(os.path, "exists", lambda _path: True)
    client.agent_python = sys.executable
    client.agent_workdir = str(Path(__file__).resolve().parents[1])
    monkeypatch.setattr(
        client,
        "_agent_runner_script",
        lambda: (
            "import json, sys, time\n"
            "json.loads(sys.stdin.read() or '{}')\n"
            "for idx in range(3):\n"
            "    time.sleep(0.35)\n"
            "    print(json.dumps({'kind':'tool','tool_name':'search_files','preview':f'step-{idx}','args':{}}), flush=True)\n"
            "print(json.dumps({'kind':'done','reply':'direct-progress-ok','source':'agent','latency_ms':1}), flush=True)\n"
        ),
    )

    events = list(
        client._stream_via_agent(
            user_id="123",
            message="hello",
            session_id="miniapp-123-direct-progress",
            conversation_history=[{"role": "operator", "body": "old"}],
        )
    )

    assert any(event.get("type") == "tool" for event in events)
    assert any(event.get("type") == "done" and event.get("reply") == "direct-progress-ok" for event in events)


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

    warm_sessions = status.get("warm_sessions") or {}
    assert warm_sessions.get("current_mode") == "shared_backend_warm_runtime"
    assert warm_sessions.get("owner") == "shared_backend_process"
    assert warm_sessions.get("owner_class") == "PersistentSessionManager"
    assert warm_sessions.get("lifecycle_state") == "active_when_session_manager_entry_exists"
    assert warm_sessions.get("eviction_policy") == "session_manager_idle_ttl_or_capacity"
    owner_state = warm_sessions.get("owner_state") or {}
    assert owner_state.get("owner_class") == "PersistentSessionManager"
    assert isinstance(owner_state.get("recent_events"), list)
    assert warm_sessions.get("target_mode") == "isolated_worker_owned_warm_continuity"

    startup = status.get("startup") or {}
    startup_routing = startup.get("routing") or {}
    assert startup_routing.get("selected_transport") == "agent-persistent"
    assert startup_routing.get("persistent_sessions_requested") is True
    assert startup_routing.get("persistent_sessions_enabled") is True
    assert startup_routing.get("persistent_shared_backend_enabled") is True
    assert startup_routing.get("persistent_worker_owned_enabled") is False
    assert startup_routing.get("persistent_runtime_ownership_requested") == "auto"
    assert startup_routing.get("persistent_runtime_ownership") == "shared"
    assert startup_routing.get("persistent_sessions_enablement_reason") == "shared_backend_runtime_enabled"
    startup_warm = startup.get("warm_sessions") or {}
    assert startup_warm.get("current_mode") == "shared_backend_warm_runtime"
    assert startup_warm.get("owner_class") == "PersistentSessionManager"

    children = status.get("children") or {}
    assert "caps" in children
    assert "active_total" in children


def test_warm_session_strategy_reports_worker_owned_continuity_for_subprocess_mode(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_JOB_WORKER_LAUNCHER", "subprocess")
    monkeypatch.setenv("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto")

    client = hermes_client.HermesClient()
    contract = client.warm_session_contract()
    strategy = client.warm_session_strategy()
    status = client.runtime_status()

    assert contract.current_mode == "isolated_worker_owned_warm_continuity"
    assert contract.owner == "isolated_worker_processes"
    assert contract.owner_class == "IsolatedWorkerWarmSessionRegistryScaffold"
    assert contract.lifecycle_state == "worker_owned_live_attach_or_checkpoint_continuity"
    assert contract.lifecycle_scope == "per_chat_isolated_worker"
    assert contract.eviction_policy == "worker_owner_lifecycle_attach_deadline_or_explicit_invalidation"
    assert contract.enabled is True
    assert contract.requested is True
    assert contract.ownership == "checkpoint_only"
    assert contract.target_mode == "isolated_worker_owned_warm_continuity"
    assert contract.target_status == "enabled_in_subprocess_mode"
    assert strategy.get("owner_state", {}).get("owner_class") == "IsolatedWorkerWarmSessionRegistryScaffold"
    assert any(event.get("event") == "scaffold_initialized" for event in strategy.get("owner_state", {}).get("recent_events", []))
    assert strategy.get("recent_candidate_probes") == []
    assert strategy.get("recent_reuse_policy_checks") == []
    assert strategy.get("recent_reuse_attempts") == []
    assert status.get("routing", {}).get("persistent_sessions_enabled") is True
    assert status.get("routing", {}).get("persistent_shared_backend_enabled") is False
    assert status.get("routing", {}).get("persistent_worker_owned_enabled") is True
    assert status.get("routing", {}).get("persistent_sessions_enablement_reason") == "worker_owned_warm_continuity_enabled"
    assert status.get("startup", {}).get("routing", {}).get("selected_transport") == "agent-worker-isolated"
    assert status.get("persistent", {}).get("enabled") is True
    assert status.get("persistent", {}).get("worker_owned_enabled") is True
    assert strategy.get("recent_reuse_decisions") == []
    strategy_without_extras = dict(strategy)
    strategy_without_extras.pop("owner_state", None)
    strategy_without_extras.pop("recent_candidate_probes", None)
    strategy_without_extras.pop("recent_reuse_policy_checks", None)
    strategy_without_extras.pop("recent_reuse_attempts", None)
    strategy_without_extras.pop("recent_reuse_decisions", None)
    strategy_without_extras.pop("retirement_summary", None)
    assert strategy_without_extras == contract.as_dict()


def test_child_spawn_caps_default_enabled(monkeypatch) -> None:
    monkeypatch.delenv("MINI_APP_CHILD_SPAWN_CAPS_ENABLED", raising=False)

    client = hermes_client.HermesClient()

    assert client.child_spawn_caps_enabled is True


def test_child_spawn_caps_fail_fast_per_job(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAPS_ENABLED", "1")
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_TOTAL", "8")
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_CHAT", "4")
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_JOB", "1")
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_SESSION", "2")

    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=77, job_id=9001, session_id="miniapp-123-77")

    client.register_child_spawn(
        transport="agent-direct",
        pid=41001,
        command=["python", "-c", "print('ok')"],
        session_id="miniapp-123-77",
    )

    try:
        client.assert_child_spawn_allowed(transport="agent-direct", session_id="miniapp-123-77")
        raise AssertionError("Expected HermesClientError when per-job child spawn cap is reached")
    except hermes_client.HermesClientError as exc:
        assert "spawn cap reached" in str(exc).lower()
        assert "job 9001" in str(exc)
    finally:
        client.deregister_child_spawn(pid=41001, outcome="test_cleanup")
        client.clear_spawn_trace_context()


def test_child_spawn_caps_disabled_allows_same_job_spawn(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAPS_ENABLED", "0")
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_JOB", "1")

    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=77, job_id=9002, session_id="miniapp-123-77")

    client.register_child_spawn(
        transport="agent-direct",
        pid=41011,
        command=["python", "-c", "print('ok')"],
        session_id="miniapp-123-77",
    )

    try:
        client.assert_child_spawn_allowed(transport="agent-direct", session_id="miniapp-123-77")
    finally:
        client.deregister_child_spawn(pid=41011, outcome="test_cleanup")
        client.clear_spawn_trace_context()


def test_terminate_tracked_children_deregisters_processes(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_JOB", "3")

    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=88, job_id=9100, session_id="miniapp-123-88")
    client.register_child_spawn(
        transport="agent-direct",
        pid=42001,
        command=["python", "-c", "print('ok')"],
        session_id="miniapp-123-88",
    )
    client.register_child_spawn(
        transport="agent-direct",
        pid=42002,
        command=["python", "-c", "print('ok')"],
        session_id="miniapp-123-88",
    )

    kills: list[tuple[int, int]] = []

    def fake_kill(pid: int, sig: int) -> None:
        kills.append((int(pid), int(sig)))

    monkeypatch.setattr(hermes_client.os, "kill", fake_kill)

    summary = client.terminate_tracked_children(job_id=9100, reason="test_cleanup")

    assert summary["targeted"] == 2
    assert summary["killed"] == 2
    assert len(kills) == 2
    diagnostics = client.child_spawn_diagnostics()
    assert diagnostics.get("active_total") == 0
    assert diagnostics.get("high_water_total") == 2
    assert diagnostics.get("high_water_by_job") == {"9100": 2}
    assert diagnostics.get("high_water_by_chat") == {"88": 2}
    recent_events = diagnostics.get("recent_events") or []
    assert any(event.get("event") == "spawn" and event.get("job_id") == 9100 for event in recent_events)
    assert any(event.get("event") == "finish" and event.get("job_id") == 9100 for event in recent_events)
    assert diagnostics.get("timeouts", {}).get("total") == 0
    client.clear_spawn_trace_context()


def test_terminate_tracked_children_uses_killpg_for_chat_worker_subprocess(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_JOB", "3")

    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=88, job_id=9100, session_id="miniapp-123-88")
    client.register_child_spawn(
        transport="chat-worker-subprocess",
        pid=43001,
        command=["python", "worker.py"],
        session_id="miniapp-123-88",
    )

    kill_calls: list[tuple[int, int]] = []
    killpg_calls: list[tuple[int, int]] = []

    monkeypatch.setattr(hermes_client.os, "kill", lambda pid, sig: kill_calls.append((int(pid), int(sig))))
    monkeypatch.setattr(hermes_client.os, "killpg", lambda pgid, sig: killpg_calls.append((int(pgid), int(sig))))
    monkeypatch.setattr(hermes_client.os, "getpid", lambda: 50000)
    monkeypatch.setattr(
        hermes_client.os,
        "getpgid",
        lambda pid: 50000 if int(pid) == 50000 else 43099,
    )

    summary = client.terminate_tracked_children(job_id=9100, reason="test_cleanup")

    assert summary["targeted"] == 1
    assert summary["killed"] == 1
    assert kill_calls == []
    assert killpg_calls == [(43099, int(hermes_client.signal.SIGKILL))]
    client.clear_spawn_trace_context()


def test_terminate_tracked_children_kills_observed_descendants_for_job(monkeypatch) -> None:
    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=88, job_id=9100, session_id="miniapp-123-88")
    client.observe_descendant_spawn(
        transport="cli-stream",
        pid=53101,
        command=["hermes", "chat"],
        session_id="miniapp-123-88",
        parent_transport="chat-worker-subprocess",
        parent_pid=43001,
    )

    kill_calls: list[tuple[int, int]] = []
    monkeypatch.setattr(hermes_client.os, "kill", lambda pid, sig: kill_calls.append((int(pid), int(sig))))

    summary = client.terminate_tracked_children(job_id=9100, reason="test_cleanup")

    assert summary["targeted"] == 1
    assert summary["killed"] == 1
    assert kill_calls == [(53101, int(hermes_client.signal.SIGKILL))]
    diagnostics = client.child_spawn_diagnostics()
    assert diagnostics.get("descendant_active_total") == 0
    assert any(
        event.get("event") == "descendant_finish" and event.get("pid") == 53101 and event.get("outcome") == "cleanup_kill:test_cleanup"
        for event in (diagnostics.get("recent_descendant_events") or [])
    )
    client.clear_spawn_trace_context()


def test_observed_descendant_telemetry_tracks_active_and_recent_events(monkeypatch) -> None:
    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=88, job_id=9100, session_id="miniapp-123-88")

    client.observe_descendant_spawn(
        transport="agent-direct",
        pid=53101,
        command=["python", "worker.py"],
        session_id="miniapp-123-88",
        parent_transport="chat-worker-subprocess",
        parent_pid=43001,
    )
    client.observe_descendant_spawn(
        transport="cli-stream",
        pid=53102,
        command=["python", "cli.py"],
        session_id="miniapp-123-88",
        parent_transport="chat-worker-subprocess",
        parent_pid=43001,
    )

    diagnostics = client.child_spawn_diagnostics()
    assert diagnostics.get("descendant_active_total") == 2
    assert diagnostics.get("descendant_active_by_transport") == {"agent-direct": 1, "cli-stream": 1}
    assert diagnostics.get("descendant_active_by_job") == {"9100": 2}
    assert diagnostics.get("descendant_active_by_chat") == {"88": 2}
    assert diagnostics.get("descendant_high_water_total") == 2
    recent = diagnostics.get("recent_descendant_events") or []
    assert any(event.get("event") == "descendant_spawn" and event.get("pid") == 53101 for event in recent)

    client.observe_descendant_finish(pid=53101, outcome="completed", return_code=0, parent_transport="chat-worker-subprocess", parent_pid=43001)
    diagnostics = client.child_spawn_diagnostics()
    assert diagnostics.get("descendant_active_total") == 1
    recent = diagnostics.get("recent_descendant_events") or []
    assert any(event.get("event") == "descendant_finish" and event.get("pid") == 53101 for event in recent)
    client.clear_spawn_trace_context()


def test_observe_descendant_finish_collects_snapshots_outside_spawn_tracker_lock(monkeypatch) -> None:
    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=88, job_id=9100, session_id="miniapp-123-88")
    client.observe_descendant_spawn(
        transport="cli-stream",
        pid=53103,
        command=["python", "cli.py"],
        session_id="miniapp-123-88",
        parent_transport="chat-worker-subprocess",
        parent_pid=43001,
    )

    base_lock = threading.Lock()

    class AssertingLock:
        def __init__(self, inner_lock) -> None:
            self._inner_lock = inner_lock
            self.held = False

        def __enter__(self):
            self._inner_lock.acquire()
            self.held = True
            return self

        def __exit__(self, exc_type, exc, tb):
            self.held = False
            self._inner_lock.release()
            return False

    asserting_lock = AssertingLock(base_lock)
    client._spawn_tracker_lock = asserting_lock

    monkeypatch.setattr(
        client,
        "_child_process_snapshot",
        lambda pid: ({"rss_kb": 10} if not asserting_lock.held else (_ for _ in ()).throw(AssertionError("snapshot called under lock"))),
    )
    monkeypatch.setattr(
        client,
        "_host_memory_snapshot",
        lambda: ({"host_available_kb": 20} if not asserting_lock.held else (_ for _ in ()).throw(AssertionError("host snapshot called under lock"))),
    )

    client.observe_descendant_finish(pid=53103, outcome="completed", return_code=0, parent_transport="chat-worker-subprocess", parent_pid=43001)

    recent = client.child_spawn_diagnostics().get("recent_descendant_events") or []
    assert any(event.get("event") == "descendant_finish" and event.get("pid") == 53103 for event in recent)
    client.clear_spawn_trace_context()


def test_observe_child_process_sample_collects_snapshots_outside_spawn_tracker_lock(monkeypatch) -> None:
    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=88, job_id=9100, session_id="miniapp-123-88")
    client.register_child_spawn(
        transport="chat-worker-subprocess",
        pid=43103,
        command=["python", "worker.py"],
        session_id="miniapp-123-88",
    )

    base_lock = threading.Lock()

    class AssertingLock:
        def __init__(self, inner_lock) -> None:
            self._inner_lock = inner_lock
            self.held = False

        def __enter__(self):
            self._inner_lock.acquire()
            self.held = True
            return self

        def __exit__(self, exc_type, exc, tb):
            self.held = False
            self._inner_lock.release()
            return False

    asserting_lock = AssertingLock(base_lock)
    client._spawn_tracker_lock = asserting_lock

    monkeypatch.setattr(
        client,
        "_child_process_snapshot",
        lambda pid: ({"rss_kb": 10} if not asserting_lock.held else (_ for _ in ()).throw(AssertionError("snapshot called under lock"))),
    )
    monkeypatch.setattr(
        client,
        "_host_memory_snapshot",
        lambda: ({"host_available_kb": 20} if not asserting_lock.held else (_ for _ in ()).throw(AssertionError("host snapshot called under lock"))),
    )

    client.observe_child_process_sample(pid=43103, transport="chat-worker-subprocess", session_id="miniapp-123-88")

    recent = client.child_spawn_diagnostics().get("recent_events") or []
    assert any(event.get("event") == "sample" and event.get("pid") == 43103 for event in recent)
    client.clear_spawn_trace_context()


def test_child_spawn_timeout_counters_track_by_job_and_chat(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_JOB", "3")

    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=88, job_id=9100, session_id="miniapp-123-88")
    client.register_child_spawn(
        transport="chat-worker-subprocess",
        pid=42101,
        command=["python", "worker.py"],
        session_id="miniapp-123-88",
    )
    client.deregister_child_spawn(pid=42101, outcome="chat-worker-subprocess:failed:timeout", return_code=-9)

    client.set_spawn_trace_context(user_id="123", chat_id=89, job_id=9101, session_id="miniapp-123-89")
    client.register_child_spawn(
        transport="chat-worker-subprocess",
        pid=42102,
        command=["python", "worker.py"],
        session_id="miniapp-123-89",
    )
    client.deregister_child_spawn(pid=42102, outcome="chat-worker-subprocess:failed:kill_timeout", return_code=-9)

    client.set_spawn_trace_context(user_id="123", chat_id=88, job_id=9100, session_id="miniapp-123-88")
    client.register_child_spawn(
        transport="chat-worker-subprocess",
        pid=42103,
        command=["python", "worker.py"],
        session_id="miniapp-123-88",
    )
    client.deregister_child_spawn(pid=42103, outcome="chat-worker-subprocess:completed", return_code=0)

    diagnostics = client.child_spawn_diagnostics()
    timeout_info = diagnostics.get("timeouts") or {}
    assert timeout_info.get("total") == 2
    assert timeout_info.get("by_job") == {"9100": 1, "9101": 1}
    assert timeout_info.get("by_chat") == {"88": 1, "89": 1}
    assert timeout_info.get("by_transport") == {"chat-worker-subprocess": 2}
    by_outcome = timeout_info.get("by_outcome") or {}
    assert by_outcome.get("chat-worker-subprocess:failed:timeout") == 1
    assert by_outcome.get("chat-worker-subprocess:failed:kill_timeout") == 1
    recent = timeout_info.get("recent_events") or []
    assert len(recent) == 2
    assert all(item.get("event") == "timeout_finish" for item in recent)
    client.clear_spawn_trace_context()


def test_child_spawn_logs_include_lineage_fields(monkeypatch) -> None:
    info_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class _Logger:
        @staticmethod
        def info(*args, **kwargs):
            info_calls.append((args, kwargs))

        @staticmethod
        def debug(*args, **kwargs):
            return None

    original_logger = hermes_client.logger
    monkeypatch.setenv("MINI_APP_CHILD_SPAWN_CAP_PER_JOB", "2")

    try:
        hermes_client.logger = _Logger()
        client = hermes_client.HermesClient()
        client.set_spawn_trace_context(user_id="lineage-user", chat_id=77, job_id=9007, session_id="miniapp-lineage-77")
        client.register_child_spawn(
            transport="agent-direct",
            pid=43001,
            command=["python", "-m", "hermes_cli.main"],
            session_id="miniapp-lineage-77",
        )
        client.deregister_child_spawn(pid=43001, outcome="completed", return_code=0)
    finally:
        hermes_client.logger = original_logger

    rendered = "\n".join(str(args[0]) for args, _kwargs in info_calls if args)
    assert "Miniapp Hermes child spawned" in rendered
    assert "Miniapp Hermes child finished" in rendered
    assert "spawn_id=" in rendered
    assert "job_id=9007" in rendered
    assert "chat_id=77" in rendered
    assert "user_id=lineage-user" in rendered
    assert "active_for_job=" in rendered
    assert "active_for_chat=" in rendered
    assert "command=python -m hermes_cli.main" in rendered


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
    runtime.checkpoint_history = [{"role": "user", "content": "prior"}, {"role": "assistant", "content": "ok"}]
    assert client.should_include_conversation_history(session_id=session_id) is False


def test_should_include_conversation_history_when_bootstrapped_runtime_has_empty_checkpoint(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()
    session_id = "miniapp-42-empty-checkpoint"
    runtime = client._session_manager.get_or_create(
        session_id=session_id,
        model=client.model,
        max_iterations=client.max_iterations,
        create_agent=lambda: object(),
    )
    runtime.bootstrapped = True
    runtime.checkpoint_history = []

    assert client.should_include_conversation_history(session_id=session_id) is True


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
    runtime.checkpoint_history = [{"role": "user", "content": "prior"}, {"role": "assistant", "content": "reply"}]
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


def test_stream_events_persistent_fallback_recovers_checkpoint_and_evicts_runtime(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()
    session_id = "miniapp-123-fallback-checkpoint"
    runtime = client._session_manager.get_or_create(
        session_id=session_id,
        model=client.model,
        max_iterations=client.max_iterations,
        create_agent=lambda: object(),
    )
    runtime.bootstrapped = True
    runtime.checkpoint_history = [
        {"role": "user", "content": "earlier user"},
        {"role": "assistant", "content": "earlier assistant"},
    ]

    captured_agent_history = {"value": None}

    def blow_up(**kwargs):
        raise ModuleNotFoundError("No module named 'run_agent'")

    def fallback_agent(**kwargs):
        captured_agent_history["value"] = kwargs.get("conversation_history")
        return iter(
            [
                {"type": "meta", "source": "agent"},
                {"type": "chunk", "text": "fallback-ok"},
                {"type": "done", "reply": "fallback-ok", "source": "agent", "latency_ms": 1},
            ]
        )

    monkeypatch.setattr(client, "_stream_via_persistent_agent", blow_up)
    monkeypatch.setattr(client, "_stream_via_agent", fallback_agent)

    events = list(client.stream_events(user_id="123", message="hello", session_id=session_id))

    done = next(event for event in events if event.get("type") == "done")
    assert captured_agent_history["value"] == runtime.checkpoint_history
    assert done.get("runtime_checkpoint") == [
        {"role": "user", "content": "earlier user"},
        {"role": "assistant", "content": "earlier assistant"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "fallback-ok"},
    ]
    assert client._session_manager.get_runtime(session_id) is None


def test_stream_events_retires_warm_session_on_persistent_thread_failure(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_REUSE", "1")

    client = hermes_client.HermesClient()
    session_id = "miniapp-123-persistent-oom"
    runtime = client._session_manager.get_or_create(
        session_id=session_id,
        model=client.model,
        max_iterations=client.max_iterations,
        create_agent=lambda: object(),
    )
    runtime.checkpoint_history = [{"role": "assistant", "content": "warm"}]
    evictions: list[tuple[str, str]] = []
    monkeypatch.setattr(client, "evict_session", lambda sid, *, reason="explicit_eviction": evictions.append((sid, reason)) or True)

    def blow_up(**kwargs):
        raise hermes_client.HermesClientError("can't start new thread")

    monkeypatch.setattr(client, "_stream_via_persistent_agent", blow_up)
    monkeypatch.setattr(
        client,
        "_stream_via_agent",
        lambda **kwargs: iter([
            {"type": "meta", "source": "agent"},
            {"type": "done", "reply": "fallback-ok", "source": "agent", "latency_ms": 1},
        ]),
    )

    events = list(client.stream_events(user_id="123", message="hello", session_id=session_id))
    assert any(event.get("type") == "done" and event.get("reply") == "fallback-ok" for event in events)
    assert evictions
    assert evictions[0][0] == session_id
    assert "failure_signature:persistent_runtime:thread_exhaustion" in evictions[0][1]


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


def test_stream_events_records_persistent_to_direct_transition(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "1")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()
    client.set_spawn_trace_context(user_id="123", chat_id=77, job_id=9001, session_id="miniapp-123-77")

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

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-77"))
    assert any(event.get("type") == "done" and event.get("reply") == "fallback-ok" for event in events)

    transitions = client.child_spawn_diagnostics().get("recent_transport_transitions") or []
    assert any(
        str(item.get("previous_path")) == "agent-persistent"
        and str(item.get("next_path")) == "agent"
        and str(item.get("reason") or "").startswith("persistent_failure:")
        and str(item.get("session_id")) == "miniapp-123-77"
        and int(item.get("chat_id") or 0) == 77
        and int(item.get("job_id") or 0) == 9001
        for item in transitions
    )


def test_stream_events_retires_warm_session_on_direct_memory_failure(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_WARM_WORKER_REUSE", "1")

    client = hermes_client.HermesClient()
    evictions: list[tuple[str, str]] = []
    monkeypatch.setattr(client, "evict_session", lambda sid, *, reason="explicit_eviction": evictions.append((sid, reason)) or True)

    def direct_fail(**kwargs):
        raise hermes_client.HermesClientError("API call failed after 3 retries: [Errno 12] Cannot allocate memory")

    monkeypatch.setattr(client, "_stream_via_agent", direct_fail)
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

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-cli-hop"))
    assert any(event.get("type") == "done" and event.get("reply") == "cli-ok" and event.get("source") == "cli" for event in events)

    assert evictions
    assert evictions[0][0] == "miniapp-123-cli-hop"
    assert "failure_signature:direct_agent:memory_pressure" in evictions[0][1]


def test_stream_events_records_direct_to_cli_transition(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")

    client = hermes_client.HermesClient()

    def direct_fail(**kwargs):
        raise hermes_client.HermesClientError("synthetic direct failure")

    monkeypatch.setattr(client, "_stream_via_agent", direct_fail)
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

    events = list(client.stream_events(user_id="123", message="hello", session_id="miniapp-123-cli-hop"))
    assert any(event.get("type") == "done" and event.get("reply") == "cli-ok" and event.get("source") == "cli" for event in events)

    transitions = client.child_spawn_diagnostics().get("recent_transport_transitions") or []
    assert any(
        str(item.get("previous_path")) == "agent"
        and str(item.get("next_path")) == "cli"
        and str(item.get("reason") or "").startswith("direct_failure:")
        and str(item.get("session_id")) == "miniapp-123-cli-hop"
        for item in transitions
    )


def test_stream_events_logs_resume_relaunch_in_plain_text(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "0")

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

    list(client.stream_events(user_id="123", message="/resume", session_id="miniapp-123-resume"))

    rendered = "\n".join(str((args[0] if args else "")) for args, _kwargs in info_calls)
    assert "Miniapp Hermes transport transition" in rendered
    assert "previous_path=cli" in rendered
    assert "next_path=cli" in rendered
    assert "reason=resume_relaunch:launch_count=1" in rendered
    assert "session_id=miniapp-123-resume" in rendered


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


def test_stream_via_cli_progress_detects_tool_lines_before_query_banner(monkeypatch) -> None:
    client = hermes_client.HermesClient()

    def fake_popen(*args, **kwargs):
        return _FakeProcess(
            stdout=_LineStream(
                [
                    "Initializing agent...\n",
                    "┊ 💻 $         date '+%Y-%m-%d %H:%M:%S %Z'  0.3s\n",
                    "⚕ Hermes\n",
                    "tool demo reply\n",
                    "Messages: 4\n",
                ]
            ),
            stderr=_LineStream([]),
            wait_return_code=0,
        )

    monkeypatch.setattr(hermes_client_cli.subprocess, "Popen", fake_popen)

    events = list(client._stream_via_cli_progress("hello"))
    assert any(
        event.get("type") == "tool"
        and event.get("display") == "💻 $ date '+%Y-%m-%d %H:%M:%S %Z'"
        for event in events
    )
    assert any(event.get("type") == "done" and event.get("reply") == "tool demo reply" for event in events)


def test_stream_via_cli_progress_strips_cli_response_box_frame(monkeypatch) -> None:
    client = hermes_client.HermesClient()

    def fake_popen(*args, **kwargs):
        return _FakeProcess(
            stdout=_LineStream(
                [
                    "ignored before query\n",
                    "Query: hello\n",
                    "⚕ Hermes\n",
                    "Hi — how can I help?\n",
                    "╰──────────────────────────────────────────────────────────────────────────────╯\n",
                    "Duration: 1.2s\n",
                ]
            ),
            stderr=_LineStream([]),
            wait_return_code=0,
        )

    monkeypatch.setattr(hermes_client_cli.subprocess, "Popen", fake_popen)

    events = list(client._stream_via_cli_progress("hello"))
    done_event = next(event for event in events if event.get("type") == "done")
    assert done_event.get("reply") == "Hi — how can I help?"


def test_stream_via_cli_progress_surfaces_nonzero_exit_context(monkeypatch) -> None:
    client = hermes_client.HermesClient()

    def fake_popen(*args, **kwargs):
        return _FakeProcess(
            stdout=_LineStream(
                [
                    "ignored before query\n",
                    "Query: hello\n",
                    "⚙️ read_file (0.2s)\n",
                    "Error: upstream provider unavailable\n",
                    "Trace id: abc123\n",
                ]
            ),
            stderr=_LineStream([]),
            wait_return_code=7,
        )

    monkeypatch.setattr(hermes_client_cli.subprocess, "Popen", fake_popen)

    with pytest.raises(hermes_client.HermesClientError) as exc_info:
        list(client._stream_via_cli_progress("hello"))

    message = str(exc_info.value)
    assert "Hermes CLI stream failed (rc=7)" in message
    assert "upstream provider unavailable" in message
    assert "Trace id: abc123" in message


def test_stream_via_agent_runner_script_does_not_duplicate_tool_formatter_map() -> None:
    client = hermes_client.HermesClient()
    script = client._agent_runner_script()

    assert "tool_emojis = {" not in script
    assert "'display': format_tool_progress(" not in script


def test_stream_via_agent_runner_script_forwards_provider_and_base_url() -> None:
    client = hermes_client.HermesClient()
    script = client._agent_runner_script()

    assert "if payload.get('provider'):" in script
    assert "agent_kwargs['provider'] = payload['provider']" in script
    assert "if payload.get('base_url'):" in script
    assert "agent_kwargs['base_url'] = payload['base_url']" in script


def test_stream_via_agent_runner_script_uses_protocol_stdout_and_redirects_noise() -> None:
    client = hermes_client.HermesClient()
    script = client._agent_runner_script()

    assert "_protocol_stdout = getattr(sys, '__stdout__', None) or sys.stdout" in script
    assert "_protocol_stdout.write(json.dumps(payload, ensure_ascii=False)" in script
    assert "_protocol_stdout.flush()" in script
    assert "with contextlib.redirect_stdout(io.StringIO()):" in script


def test_stream_via_agent_runner_script_supports_event_typed_tool_progress_callbacks() -> None:
    client = hermes_client.HermesClient()
    script = client._agent_runner_script()

    assert "def progress_callback(*callback_args):" in script
    assert "normalize_tool_progress_callback_args(callback_args)" in script
    assert "build_tool_progress_item(" in script


def test_stream_via_agent_runner_script_compiles_and_escapes_protocol_newline() -> None:
    client = hermes_client.HermesClient()
    script = client._agent_runner_script()

    assert "\\n" in script
    compile(script, "<miniapp-agent-runner>", "exec")


def test_stream_via_agent_payload_includes_provider_and_base_url(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_DIRECT_AGENT", "1")
    monkeypatch.setenv("MINI_APP_PERSISTENT_SESSIONS", "0")
    client = hermes_client.HermesClient()
    client.provider = "test-provider"
    client.base_url = "https://example.invalid/v1"
    monkeypatch.setattr(os.path, "exists", lambda _path: True)

    captured = {}

    def fake_popen(*args, **kwargs):
        process = _FakeProcess(
            stdout=_LineStream([
                '{"kind":"done","reply":"ok","source":"agent","latency_ms":1}\n',
            ]),
            stderr=_LineStream([]),
            wait_return_code=0,
        )
        original_write = process.stdin.write

        def capturing_write(data):
            captured['payload'] = data
            return original_write(data)

        process.stdin.write = capturing_write
        process.returncode = 0
        return process

    monkeypatch.setattr(hermes_client_agent.subprocess, "Popen", fake_popen)

    events = list(client._stream_via_agent(user_id="123", message="hello", session_id="miniapp-123-provider-forward"))
    done_event = next(event for event in events if event.get("type") == "done")
    assert done_event.get("reply") == "ok"
    payload = json.loads(captured["payload"])
    assert payload.get("provider") == "test-provider"
    assert payload.get("base_url") == "https://example.invalid/v1"


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

    monkeypatch.setattr(client._stream_via_agent.__globals__["subprocess"], "Popen", fake_popen)

    try:
        list(client._stream_via_agent(user_id="123", message="hello", session_id="miniapp-123-stderr"))
        raise AssertionError("Expected HermesClientError for non-zero exit")
    except hermes_client.HermesClientError as exc:
        assert "agent crashed" in str(exc)

    process = process_holder["process"]
    assert process.stdin.close_calls == 1
    assert process.stdout.close_calls == 1
    assert process.stderr.close_calls == 1


def test_direct_agent_history_normalization_preserves_attachment_context() -> None:
    class _Client(hermes_client_agent.HermesClientDirectAgentMixin):
        pass

    client = _Client()

    normalized = client._normalize_conversation_history(
        [
            {
                "role": "operator",
                "body": "Can you inspect this image?",
                "attachments": [
                    {
                        "filename": "screen.png",
                        "kind": "image",
                        "content_type": "image/png",
                        "size_bytes": 2048,
                        "storage_path": "/tmp/miniapp-attachments/att_1-screen.png",
                        "preview_url": "/api/chats/attachments/att_1/content",
                    }
                ],
            }
        ]
    )

    assert normalized == [
        {
            "role": "user",
            "content": (
                "Can you inspect this image?\n\n"
                "Attached files:\n"
                "- screen.png (image, image/png, 2048 bytes)\n"
                "  local file path: /tmp/miniapp-attachments/att_1-screen.png"
            ),
        }
    ]


def test_direct_agent_history_normalization_uses_preview_url_when_storage_path_is_unavailable() -> None:
    class _Client(hermes_client_agent.HermesClientDirectAgentMixin):
        pass

    client = _Client()

    normalized = client._normalize_conversation_history(
        [
            {
                "role": "operator",
                "body": "Can you inspect this file?",
                "attachments": [
                    {
                        "filename": "notes.txt",
                        "kind": "file",
                        "content_type": "text/plain",
                        "size_bytes": 12,
                        "preview_url": "/api/chats/attachments/att_2/content",
                    }
                ],
            }
        ]
    )

    assert normalized[0]["role"] == "user"
    assert "Attached files:" in normalized[0]["content"]
    assert "- notes.txt (file, text/plain, 12 bytes)" in normalized[0]["content"]
    assert "preview url: /api/chats/attachments/att_2/content" in normalized[0]["content"]
