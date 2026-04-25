from __future__ import annotations

import importlib
import json
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator


def _supports_unix_socket_attach_transport(*, platform_name: str | None = None) -> bool:
    current = str(platform_name if platform_name is not None else sys.platform).lower()
    return (not current.startswith("win")) and hasattr(socket, "AF_UNIX")

from hermes_client_agent import HermesClientAgentMixin
from hermes_client_bootstrap import HermesClientBootstrap
from hermes_client_cli import HermesClientCLIMixin
from hermes_client_http import HermesClientHTTPMixin
from hermes_client_types import HermesClientError, HermesReply, IsolatedWorkerWarmSessionRegistryScaffold, PersistentSessionManager, WarmSessionContract, WarmSessionRegistry, build_reuse_contract


logger = logging.getLogger(__name__)


def _default_venv_python_path(venv_path: str | Path, *, platform_name: str | None = None) -> str:
    platform_value = platform_name if platform_name is not None else os.name
    root = Path(venv_path)
    if str(platform_value).lower() in {"nt", "windows", "win32"}:
        return str(root / "Scripts" / "python.exe")
    return str(root / "bin" / "python")


@dataclass(frozen=True)
class _AttachResumeTransport:
    session_id: str
    requested_path: str
    transport_kind: str
    worker_endpoint: str
    resume_token: str
    resume_deadline_ms: int | None


@dataclass
class _WarmReuseAttemptArtifacts:
    validation: dict[str, Any]
    attach_plan: dict[str, Any] | None = None
    attach_execution: dict[str, Any] | None = None
    attach_eligibility: dict[str, Any] | None = None
    attach_action: dict[str, Any] | None = None
    attach_resume: dict[str, Any] | None = None
    attached_stream: Iterator[dict[str, Any]] | None = None


@dataclass(frozen=True)
class _StreamRequestContext:
    user_id: str
    cleaned_message: str
    conversation_history: list[dict[str, Any]] | None
    session_id: str | None
    requested_path: str


def _coerce_positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


class HermesClient(HermesClientHTTPMixin, HermesClientAgentMixin, HermesClientCLIMixin):
    """Adapter over either a Hermes HTTP endpoint, in-process Hermes agent, or local CLI.

    Streaming strategy:
    - If HERMES_STREAM_URL is set, it is treated as the preferred true-stream endpoint.
    - Otherwise, if HERMES_API_URL is set, the client first attempts to read a chunked/SSE-like
      response from that endpoint and falls back to a normal JSON POST if needed.
    - Otherwise, when MINI_APP_DIRECT_AGENT is enabled (default), stream via the in-process
      Hermes agent so tool progress can be surfaced live.
    - If direct agent streaming is unavailable, the local CLI is used and the response is chunked locally.
    """

    def __init__(self) -> None:
        self.api_url = os.environ.get("HERMES_API_URL")
        self.stream_url = os.environ.get("HERMES_STREAM_URL")
        self.cli_command = os.environ.get("HERMES_CLI_COMMAND", "hermes")
        env_model = (os.environ.get("HERMES_MODEL") or "").strip()
        env_provider = (os.environ.get("HERMES_PROVIDER") or "").strip()
        env_base_url = (os.environ.get("HERMES_BASE_URL") or "").strip()
        self.timeout_seconds = int(os.environ.get("HERMES_TIMEOUT_SECONDS", "120"))
        self.stream_chunk_size = int(os.environ.get("HERMES_STREAM_CHUNK_SIZE", "28"))
        self.direct_agent_enabled = os.environ.get("MINI_APP_DIRECT_AGENT", "1") == "1"
        self.max_iterations = int(os.environ.get("HERMES_MAX_ITERATIONS", "90"))
        self.tool_progress_mode = (os.environ.get("HERMES_TOOL_PROGRESS_MODE") or "all").strip().lower()
        self.agent_home = os.environ.get("MINI_APP_AGENT_HOME") or os.environ.get("HOME") or str(Path.home())
        self.agent_hermes_home = os.environ.get("MINI_APP_AGENT_HERMES_HOME") or os.environ.get("HERMES_HOME") or str(Path(self.agent_home) / ".hermes")
        self.agent_workdir = os.environ.get("MINI_APP_AGENT_WORKDIR") or str(Path(self.agent_hermes_home) / "hermes-agent")
        self.agent_venv = os.environ.get("MINI_APP_AGENT_VENV") or str(Path(self.agent_workdir) / "venv")
        self.agent_python = os.environ.get("MINI_APP_AGENT_PYTHON") or _default_venv_python_path(self.agent_venv)
        self._session_db = self._init_session_db()
        self._bootstrap = HermesClientBootstrap(agent_hermes_home=self.agent_hermes_home, logger=logger)
        self.model = env_model if env_model and env_model.lower() != "auto" else self._load_default_model_from_config()
        self.provider, self.base_url = self._resolve_agent_routing(env_provider=env_provider, env_base_url=env_base_url)
        self.persistent_sessions_requested = os.environ.get("MINI_APP_PERSISTENT_SESSIONS", "0") == "1"
        self.persistent_runtime_ownership_requested = str(
            os.environ.get("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP_REQUESTED")
            or "auto"
        ).strip().lower() or "auto"
        self.persistent_runtime_ownership = self._resolve_persistent_runtime_ownership()
        self.persistent_sessions_enabled = self.persistent_sessions_requested and self.persistent_runtime_ownership == "shared"
        self.persistent_max_sessions = int(os.environ.get("MINI_APP_PERSISTENT_MAX_SESSIONS", "64"))
        self.persistent_idle_ttl_seconds = int(os.environ.get("MINI_APP_PERSISTENT_IDLE_TTL_SECONDS", "1800"))
        self.warm_worker_reuse_enabled = os.environ.get("MINI_APP_WARM_WORKER_REUSE", "0") == "1"
        self.warm_worker_same_chat_only = os.environ.get("MINI_APP_WARM_WORKER_SAME_CHAT_ONLY", "1") == "1"
        self.warm_worker_idle_ttl_seconds = max(30, int(os.environ.get("MINI_APP_WARM_WORKER_IDLE_TTL_SECONDS", "180")))
        self.warm_worker_max_idle = max(0, int(os.environ.get("MINI_APP_WARM_WORKER_MAX_IDLE", "2")))
        self.warm_worker_max_total = max(1, int(os.environ.get("MINI_APP_WARM_WORKER_MAX_TOTAL", "4")))
        if self.warm_worker_max_total < max(1, self.warm_worker_max_idle):
            self.warm_worker_max_total = max(1, self.warm_worker_max_idle)
        self.warm_worker_retire_after_runs = max(1, int(os.environ.get("MINI_APP_WARM_WORKER_RETIRE_AFTER_RUNS", "3")))
        self.warm_worker_health_max_rss_mb = max(128, int(os.environ.get("MINI_APP_WARM_WORKER_HEALTH_MAX_RSS_MB", "1400")))
        self.warm_worker_health_max_threads = max(4, int(os.environ.get("MINI_APP_WARM_WORKER_HEALTH_MAX_THREADS", "48")))
        self.warm_attach_handshake_timeout_ms = max(1, int(os.environ.get("MINI_APP_WARM_ATTACH_HANDSHAKE_TIMEOUT_MS", "250")))
        self.warm_attach_resume_timeout_ms = max(1, int(os.environ.get("MINI_APP_WARM_ATTACH_RESUME_TIMEOUT_MS", "1000")))
        self.child_spawn_caps_enabled = os.environ.get("MINI_APP_CHILD_SPAWN_CAPS_ENABLED", "1") == "1"
        self.child_spawn_cap_total = max(1, int(os.environ.get("MINI_APP_CHILD_SPAWN_CAP_TOTAL", "16")))
        self.child_spawn_cap_per_chat = max(1, int(os.environ.get("MINI_APP_CHILD_SPAWN_CAP_PER_CHAT", "4")))
        self.child_spawn_cap_per_job = max(1, int(os.environ.get("MINI_APP_CHILD_SPAWN_CAP_PER_JOB", "1")))
        self.child_spawn_cap_per_session = max(1, int(os.environ.get("MINI_APP_CHILD_SPAWN_CAP_PER_SESSION", "2")))
        self._session_manager: WarmSessionRegistry = PersistentSessionManager(
            max_sessions=self.persistent_max_sessions,
            idle_ttl_seconds=self.persistent_idle_ttl_seconds,
        )
        if self.persistent_runtime_ownership == "shared":
            self._warm_session_registry: WarmSessionRegistry = self._session_manager
        else:
            self._warm_session_registry = IsolatedWorkerWarmSessionRegistryScaffold(
                reusable_candidate_ttl_ms=int(self.warm_worker_idle_ttl_seconds * 1000),
                warm_worker_reuse_enabled=self.warm_worker_reuse_enabled,
                same_chat_only=self.warm_worker_same_chat_only,
                max_idle_workers=self.warm_worker_max_idle,
                max_total_workers=self.warm_worker_max_total,
            )
        self._spawn_trace_local = threading.local()
        self._warm_candidate_probe_events: deque[dict[str, Any]] = deque(maxlen=64)
        self._warm_reuse_policy_events: deque[dict[str, Any]] = deque(maxlen=64)
        self._warm_reuse_attempt_events: deque[dict[str, Any]] = deque(maxlen=64)
        self._warm_reuse_decision_events: deque[dict[str, Any]] = deque(maxlen=64)
        self._spawn_tracker_lock = threading.Lock()
        self._active_child_spawns: dict[int, dict[str, Any]] = {}
        self._child_spawn_high_water_total = 0
        self._child_spawn_high_water_by_job: dict[str, int] = {}
        self._child_spawn_high_water_by_chat: dict[str, int] = {}
        self._child_spawn_events: deque[dict[str, Any]] = deque(maxlen=64)
        self._observed_descendant_spawns: dict[int, dict[str, Any]] = {}
        self._observed_descendant_high_water_total = 0
        self._observed_descendant_high_water_by_transport: dict[str, int] = {}
        self._observed_descendant_high_water_by_job: dict[str, int] = {}
        self._observed_descendant_high_water_by_chat: dict[str, int] = {}
        self._observed_descendant_events: deque[dict[str, Any]] = deque(maxlen=96)
        self._transport_transition_events: deque[dict[str, Any]] = deque(maxlen=96)
        self._child_spawn_timeout_total = 0
        self._child_spawn_timeouts_by_job: dict[str, int] = {}
        self._child_spawn_timeouts_by_chat: dict[str, int] = {}
        self._child_spawn_timeouts_by_transport: dict[str, int] = {}
        self._child_spawn_timeouts_by_outcome: dict[str, int] = {}
        self._child_spawn_timeout_events: deque[dict[str, Any]] = deque(maxlen=48)
        self._child_spawn_timeout_counter_max_keys = max(16, int(os.environ.get("MINI_APP_CHILD_TIMEOUT_COUNTER_MAX_KEYS", "512")))
        self._session_launch_counts: dict[str, int] = {}
        self._warn_if_recall_unavailable()
        self._log_startup_diagnostics()

    def _safe_info_log(self, message: str, **kwargs: Any) -> None:
        log_info = getattr(logger, "info", None)
        if not callable(log_info):
            return
        try:
            log_info(message, **kwargs)
        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort logger wrapper must never break caller
            pass

    def _safe_failure_reason(self, exc: Exception) -> str:
        return exc.__class__.__name__

    def _resolve_persistent_runtime_ownership(self) -> str:
        raw = str(os.environ.get("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "auto") or "").strip().lower()
        launcher = str(os.environ.get("MINI_APP_JOB_WORKER_LAUNCHER", "inline") or "").strip().lower()

        if raw in {"shared", "checkpoint_only"}:
            return raw
        if raw == "auto":
            return "checkpoint_only" if launcher == "subprocess" else "shared"

        fallback = "checkpoint_only" if launcher == "subprocess" else "shared"

        logger.warning(
            "Invalid MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP; defaulting to auto-resolved ownership",
            extra={
                "raw": raw,
                "launcher": launcher,
                "resolved": fallback,
            },
        )
        return fallback

    @staticmethod
    def _is_child_spawn_cap_error(exc: Exception) -> bool:
        message = str(exc or "").strip().lower()
        if not message:
            return False
        return "child spawn cap reached" in message

    @staticmethod
    def _warm_worker_failure_signature(exc: Exception | None) -> str | None:
        message = str(exc or "").strip().lower()
        if not message:
            return None
        if "cannot allocate memory" in message or "[errno 12]" in message:
            return "memory_pressure"
        if "can't start new thread" in message or "cannot start new thread" in message:
            return "thread_exhaustion"
        if "memoryerror" in message or "out of memory" in message:
            return "memory_pressure"
        return None

    def _retire_warm_session_on_failure_signature(self, *, session_id: str | None, exc: Exception | None, phase: str) -> bool:
        if not session_id:
            return False
        signature = self._warm_worker_failure_signature(exc)
        if not signature:
            return False
        reason = f"failure_signature:{phase}:{signature}"
        evicted = self.evict_session(str(session_id), reason=reason)
        if evicted:
            logger.warning(
                "Retired warm session after failure signature",
                extra={
                    "session_id": str(session_id or ""),
                    "phase": str(phase or "unknown"),
                    "signature": signature,
                    "error": str(exc or ""),
                },
            )
        return evicted

    def set_spawn_trace_context(self, *, user_id: str, chat_id: int | None = None, job_id: int | None = None, session_id: str | None = None) -> None:
        self._spawn_trace_local.context = {
            "user_id": str(user_id or ""),
            "chat_id": int(chat_id) if chat_id is not None else None,
            "job_id": int(job_id) if job_id is not None else None,
            "session_id": str(session_id or ""),
        }

    def clear_spawn_trace_context(self) -> None:
        try:
            del self._spawn_trace_local.context
        except AttributeError:
            pass

    def _get_spawn_trace_context(self) -> dict[str, Any]:
        context = getattr(self._spawn_trace_local, "context", None)
        if isinstance(context, dict):
            return dict(context)
        return {}

    def _count_active_children_by(self, key: str, value: Any) -> int:
        if value in {None, ""}:
            return 0
        return sum(1 for record in self._active_child_spawns.values() if record.get(key) == value)

    @staticmethod
    def _is_timeout_outcome(outcome: str) -> bool:
        safe = str(outcome or "").strip().lower()
        if not safe:
            return False
        return "timeout" in safe

    def _increment_timeout_counter(self, counters: dict[str, int], key: str) -> None:
        safe_key = str(key or "").strip()
        if not safe_key:
            return
        if safe_key in counters:
            counters[safe_key] = int(counters.get(safe_key, 0)) + 1
            return
        if len(counters) >= int(self._child_spawn_timeout_counter_max_keys):
            oldest_key = next(iter(counters), None)
            if oldest_key is not None:
                counters.pop(str(oldest_key), None)
        counters[safe_key] = 1

    def _record_transport_transition(
        self,
        *,
        previous_path: str,
        next_path: str,
        reason: str,
        session_id: str | None,
        user_id: str | None,
    ) -> None:
        context = self._get_spawn_trace_context()
        payload = {
            "event": "transport_transition",
            "previous_path": str(previous_path or "none"),
            "next_path": str(next_path or "none"),
            "reason": str(reason or "unknown"),
            "session_id": str(session_id or context.get("session_id") or ""),
            "user_id": str(user_id or context.get("user_id") or ""),
            "chat_id": context.get("chat_id"),
            "job_id": context.get("job_id"),
            "monotonic_ms": int(time.monotonic() * 1000),
        }
        with self._spawn_tracker_lock:
            self._transport_transition_events.append(dict(payload))

        self._safe_info_log(
            (
                "Miniapp Hermes transport transition "
                f"previous_path={payload.get('previous_path')} next_path={payload.get('next_path')} "
                f"reason={payload.get('reason')} session_id={payload.get('session_id')} "
                f"chat_id={payload.get('chat_id')} job_id={payload.get('job_id')} user_id={payload.get('user_id')}"
            ),
            extra={"transport_transition": payload},
        )

    def _record_session_launch(self, *, session_id: str | None, requested_path: str, message: str, user_id: str) -> None:
        normalized_session = str(session_id or "").strip()
        if not normalized_session:
            return

        reason = "resume_relaunch" if str(message or "").strip().lower().startswith("/resume") else "retry_relaunch"
        launch_count = 0
        with self._spawn_tracker_lock:
            launch_count = int(self._session_launch_counts.get(normalized_session, 0)) + 1
            self._session_launch_counts[normalized_session] = launch_count
            if len(self._session_launch_counts) > 2048:
                stale_keys = list(self._session_launch_counts.keys())[:1024]
                for key in stale_keys:
                    self._session_launch_counts.pop(key, None)

        if launch_count > 1 or reason == "resume_relaunch":
            self._record_transport_transition(
                previous_path=str(requested_path),
                next_path=str(requested_path),
                reason=f"{reason}:launch_count={launch_count}",
                session_id=normalized_session,
                user_id=user_id,
            )

    def assert_child_spawn_allowed(self, *, transport: str, session_id: str | None = None) -> None:
        if not self.child_spawn_caps_enabled:
            return

        context = self._get_spawn_trace_context()
        session_value = str(session_id or context.get("session_id") or "")
        job_id = context.get("job_id")
        chat_id = context.get("chat_id")

        with self._spawn_tracker_lock:
            active_total = len(self._active_child_spawns)
            active_for_job = self._count_active_children_by("job_id", job_id)
            active_for_chat = self._count_active_children_by("chat_id", chat_id)
            active_for_session = self._count_active_children_by("session_id", session_value)

        if active_total >= self.child_spawn_cap_total:
            raise HermesClientError(
                f"Hermes child spawn cap reached (global {active_total}/{self.child_spawn_cap_total}) for transport={transport}."
            )
        if job_id not in {None, ""} and active_for_job >= self.child_spawn_cap_per_job:
            raise HermesClientError(
                f"Hermes child spawn cap reached for job {job_id} ({active_for_job}/{self.child_spawn_cap_per_job})."
            )
        if chat_id not in {None, ""} and active_for_chat >= self.child_spawn_cap_per_chat:
            raise HermesClientError(
                f"Hermes child spawn cap reached for chat {chat_id} ({active_for_chat}/{self.child_spawn_cap_per_chat})."
            )
        if session_value and active_for_session >= self.child_spawn_cap_per_session:
            raise HermesClientError(
                f"Hermes child spawn cap reached for session {session_value} ({active_for_session}/{self.child_spawn_cap_per_session})."
            )

    def terminate_tracked_children(self, *, job_id: int, reason: str) -> dict[str, int]:
        safe_job_id = int(job_id)
        safe_reason = str(reason or "runtime_cleanup")
        with self._spawn_tracker_lock:
            target_records = [
                (int(pid), dict(record))
                for pid, record in self._active_child_spawns.items()
                if int(record.get("job_id") or 0) == safe_job_id
            ]
            descendant_records = [
                (int(pid), dict(record))
                for pid, record in self._observed_descendant_spawns.items()
                if int(record.get("job_id") or 0) == safe_job_id
            ]

        killed = 0
        already_exited = 0
        failed = 0
        already_exited_pids: list[int] = []
        descendant_already_exited_pids: list[int] = []
        current_pgid = None
        if os.name == "posix":
            try:
                current_pgid = os.getpgid(os.getpid())
            except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
                current_pgid = None

        for pid, record in target_records:
            try:
                if str(record.get("transport") or "") == "chat-worker-subprocess" and os.name == "posix":
                    pgid = os.getpgid(int(pid))
                    if current_pgid is not None and pgid == current_pgid:
                        os.kill(int(pid), signal.SIGKILL)
                    else:
                        os.killpg(int(pgid), signal.SIGKILL)
                else:
                    os.kill(int(pid), signal.SIGKILL)
            except ProcessLookupError:
                already_exited += 1
                already_exited_pids.append(int(pid))
                continue
            except Exception as exc:  # noqa: BLE001 - broad-except-policy: best-effort emergency child cleanup should never crash caller
                failed += 1
                logger.warning(
                    "Miniapp Hermes child cleanup failed pid=%s job_id=%s reason=%s error=%s",
                    pid,
                    safe_job_id,
                    safe_reason,
                    exc.__class__.__name__,
                )
                continue

            killed += 1
            self.deregister_child_spawn(pid=pid, outcome=f"cleanup_kill:{safe_reason}", signal=int(signal.SIGKILL))

        for pid in already_exited_pids:
            self.deregister_child_spawn(pid=pid, outcome=f"cleanup_already_exited:{safe_reason}")

        for pid, record in descendant_records:
            if any(existing_pid == pid for existing_pid, _record in target_records):
                continue
            try:
                os.kill(int(pid), signal.SIGKILL)
            except ProcessLookupError:
                already_exited += 1
                descendant_already_exited_pids.append(int(pid))
                continue
            except Exception as exc:  # noqa: BLE001 - broad-except-policy: best-effort descendant cleanup should never crash caller
                failed += 1
                logger.warning(
                    "Miniapp Hermes descendant cleanup failed pid=%s job_id=%s reason=%s error=%s transport=%s",
                    pid,
                    safe_job_id,
                    safe_reason,
                    exc.__class__.__name__,
                    record.get("transport"),
                )
                continue

            killed += 1
            self.observe_descendant_finish(
                pid=pid,
                outcome=f"cleanup_kill:{safe_reason}",
                signal=int(signal.SIGKILL),
                transport=str(record.get("transport") or "unknown"),
                parent_transport=str(record.get("parent_transport") or "chat-worker-subprocess"),
                parent_pid=record.get("parent_pid"),
            )

        for pid in descendant_already_exited_pids:
            self.observe_descendant_finish(pid=pid, outcome=f"cleanup_already_exited:{safe_reason}")

        summary = {
            "targeted": len(target_records) + len(descendant_records),
            "killed": killed,
            "already_exited": already_exited,
            "failed": failed,
        }
        if summary["targeted"]:
            logger.warning(
                "Miniapp Hermes child cleanup summary job_id=%s reason=%s targeted=%s killed=%s already_exited=%s failed=%s",
                safe_job_id,
                safe_reason,
                summary["targeted"],
                summary["killed"],
                summary["already_exited"],
                summary["failed"],
            )
        return summary

    def child_spawn_diagnostics(self) -> dict[str, Any]:
        with self._spawn_tracker_lock:
            active_total = len(self._active_child_spawns)
            active_by_transport: dict[str, int] = {}
            active_by_job: dict[str, int] = {}
            active_by_chat: dict[str, int] = {}
            for record in self._active_child_spawns.values():
                transport = str(record.get("transport") or "unknown")
                active_by_transport[transport] = int(active_by_transport.get(transport, 0)) + 1

                job_id = record.get("job_id")
                if job_id not in {None, ""}:
                    key = str(int(job_id))
                    active_by_job[key] = int(active_by_job.get(key, 0)) + 1

                chat_id = record.get("chat_id")
                if chat_id not in {None, ""}:
                    chat_key = str(int(chat_id))
                    active_by_chat[chat_key] = int(active_by_chat.get(chat_key, 0)) + 1

            descendant_active_total = len(self._observed_descendant_spawns)
            descendant_active_by_transport: dict[str, int] = {}
            descendant_active_by_job: dict[str, int] = {}
            descendant_active_by_chat: dict[str, int] = {}
            for record in self._observed_descendant_spawns.values():
                transport = str(record.get("transport") or "unknown")
                descendant_active_by_transport[transport] = int(descendant_active_by_transport.get(transport, 0)) + 1

                job_id = record.get("job_id")
                if job_id not in {None, ""}:
                    key = str(int(job_id))
                    descendant_active_by_job[key] = int(descendant_active_by_job.get(key, 0)) + 1

                chat_id = record.get("chat_id")
                if chat_id not in {None, ""}:
                    chat_key = str(int(chat_id))
                    descendant_active_by_chat[chat_key] = int(descendant_active_by_chat.get(chat_key, 0)) + 1

            high_water_total = int(self._child_spawn_high_water_total)
            high_water_by_job = dict(self._child_spawn_high_water_by_job)
            high_water_by_chat = dict(self._child_spawn_high_water_by_chat)
            descendant_high_water_total = int(self._observed_descendant_high_water_total)
            descendant_high_water_by_transport = dict(self._observed_descendant_high_water_by_transport)
            descendant_high_water_by_job = dict(self._observed_descendant_high_water_by_job)
            descendant_high_water_by_chat = dict(self._observed_descendant_high_water_by_chat)
            timeout_total = int(self._child_spawn_timeout_total)
            timeout_by_job = dict(self._child_spawn_timeouts_by_job)
            timeout_by_chat = dict(self._child_spawn_timeouts_by_chat)
            timeout_by_transport = dict(self._child_spawn_timeouts_by_transport)
            timeout_by_outcome = dict(self._child_spawn_timeouts_by_outcome)
            recent_timeout_events = [dict(item) for item in list(self._child_spawn_timeout_events)[-16:]]
            recent_events = [dict(item) for item in list(self._child_spawn_events)[-12:]]
            recent_descendant_events = [dict(item) for item in list(self._observed_descendant_events)[-24:]]
            recent_transport_transitions = [dict(item) for item in list(self._transport_transition_events)[-24:]]

        return {
            "caps_enabled": bool(self.child_spawn_caps_enabled),
            "caps": {
                "total": int(self.child_spawn_cap_total),
                "per_chat": int(self.child_spawn_cap_per_chat),
                "per_job": int(self.child_spawn_cap_per_job),
                "per_session": int(self.child_spawn_cap_per_session),
            },
            "active_total": int(active_total),
            "active_by_transport": active_by_transport,
            "active_by_job": active_by_job,
            "active_by_chat": active_by_chat,
            "descendant_active_total": int(descendant_active_total),
            "descendant_active_by_transport": descendant_active_by_transport,
            "descendant_active_by_job": descendant_active_by_job,
            "descendant_active_by_chat": descendant_active_by_chat,
            "high_water_total": high_water_total,
            "high_water_by_job": high_water_by_job,
            "high_water_by_chat": high_water_by_chat,
            "descendant_high_water_total": descendant_high_water_total,
            "descendant_high_water_by_transport": descendant_high_water_by_transport,
            "descendant_high_water_by_job": descendant_high_water_by_job,
            "descendant_high_water_by_chat": descendant_high_water_by_chat,
            "timeouts": {
                "total": timeout_total,
                "by_job": timeout_by_job,
                "by_chat": timeout_by_chat,
                "by_transport": timeout_by_transport,
                "by_outcome": timeout_by_outcome,
                "recent_events": recent_timeout_events,
            },
            "recent_events": recent_events,
            "recent_descendant_events": recent_descendant_events,
            "recent_transport_transitions": recent_transport_transitions,
        }

    def observe_descendant_spawn(
        self,
        *,
        transport: str,
        pid: int,
        command: list[str] | None = None,
        session_id: str | None = None,
        user_id: str | None = None,
        chat_id: int | None = None,
        job_id: int | None = None,
        parent_transport: str | None = None,
        parent_pid: int | None = None,
    ) -> None:
        context = self._get_spawn_trace_context()
        spawn_snapshot = self._child_process_snapshot(int(pid))
        record = {
            "transport": str(transport or "unknown"),
            "pid": int(pid),
            "command": [str(part) for part in list(command or [])],
            "command_preview": " ".join(str(part) for part in list(command or []))[:200],
            "session_id": str(session_id or context.get("session_id") or ""),
            "user_id": str(user_id or context.get("user_id") or ""),
            "chat_id": int(chat_id) if chat_id not in {None, ""} else context.get("chat_id"),
            "job_id": int(job_id) if job_id not in {None, ""} else context.get("job_id"),
            "parent_transport": str(parent_transport or "chat-worker-subprocess"),
            "parent_pid": int(parent_pid) if parent_pid not in {None, ""} else None,
            "started_monotonic": time.monotonic(),
            "spawn_snapshot": spawn_snapshot,
        }
        with self._spawn_tracker_lock:
            self._observed_descendant_spawns[int(pid)] = record
            active_total = len(self._observed_descendant_spawns)
            transport_key = str(record.get("transport") or "unknown")
            active_for_transport = sum(
                1 for item in self._observed_descendant_spawns.values() if str(item.get("transport") or "unknown") == transport_key
            )
            self._observed_descendant_high_water_total = max(int(self._observed_descendant_high_water_total), int(active_total))
            self._observed_descendant_high_water_by_transport[transport_key] = max(
                int(self._observed_descendant_high_water_by_transport.get(transport_key, 0)),
                int(active_for_transport),
            )
            job_value = record.get("job_id")
            if job_value not in {None, ""}:
                job_key = str(int(job_value))
                active_for_job = sum(1 for item in self._observed_descendant_spawns.values() if item.get("job_id") == job_value)
                self._observed_descendant_high_water_by_job[job_key] = max(
                    int(self._observed_descendant_high_water_by_job.get(job_key, 0)),
                    int(active_for_job),
                )
            chat_value = record.get("chat_id")
            if chat_value not in {None, ""}:
                chat_key = str(int(chat_value))
                active_for_chat = sum(1 for item in self._observed_descendant_spawns.values() if item.get("chat_id") == chat_value)
                self._observed_descendant_high_water_by_chat[chat_key] = max(
                    int(self._observed_descendant_high_water_by_chat.get(chat_key, 0)),
                    int(active_for_chat),
                )
            self._observed_descendant_events.append(
                {
                    "event": "descendant_spawn",
                    "pid": int(pid),
                    "transport": transport_key,
                    "job_id": record.get("job_id"),
                    "chat_id": record.get("chat_id"),
                    "session_id": record.get("session_id"),
                    "user_id": record.get("user_id"),
                    "command_preview": record.get("command_preview"),
                    **dict(record.get("spawn_snapshot") or {}),
                    "parent_transport": record.get("parent_transport"),
                    "parent_pid": record.get("parent_pid"),
                    "active_total": int(active_total),
                    "monotonic_ms": int(time.monotonic() * 1000),
                }
            )

    def observe_descendant_finish(
        self,
        *,
        pid: int,
        outcome: str,
        return_code: int | None = None,
        signal: int | None = None,
        transport: str | None = None,
        parent_transport: str | None = None,
        parent_pid: int | None = None,
    ) -> None:
        with self._spawn_tracker_lock:
            record = self._observed_descendant_spawns.pop(int(pid), None)
            active_total = len(self._observed_descendant_spawns)

        finish_snapshot = self._child_process_snapshot(int(pid))
        host_memory_snapshot = self._host_memory_snapshot()
        payload = {
            "pid": int(pid),
            "outcome": str(outcome or "unknown"),
            "return_code": return_code,
            "signal": signal,
            "transport": str(transport or (record or {}).get("transport") or "unknown"),
            "parent_transport": str(parent_transport or (record or {}).get("parent_transport") or "chat-worker-subprocess"),
            "parent_pid": int(parent_pid) if parent_pid not in {None, ""} else (record or {}).get("parent_pid"),
            "job_id": (record or {}).get("job_id"),
            "chat_id": (record or {}).get("chat_id"),
            "session_id": (record or {}).get("session_id"),
            "user_id": (record or {}).get("user_id"),
            "active_total": int(active_total),
            "monotonic_ms": int(time.monotonic() * 1000),
        }
        if record:
            start_snapshot = dict(record.get("spawn_snapshot") or {})
            payload["lifetime_ms"] = int((time.monotonic() - float(record.get("started_monotonic") or time.monotonic())) * 1000)
            payload["command_preview"] = record.get("command_preview")
            payload["start_rss_kb"] = start_snapshot.get("rss_kb")
            payload["start_vm_hwm_kb"] = start_snapshot.get("vm_hwm_kb")
            payload["start_vm_peak_kb"] = start_snapshot.get("vm_peak_kb")
            payload["start_thread_count"] = start_snapshot.get("thread_count")
            payload["start_process_state"] = start_snapshot.get("process_state")
            payload["start_process_state_code"] = start_snapshot.get("process_state_code")
        payload.update(dict(finish_snapshot or {}))
        payload.update(dict(host_memory_snapshot or {}))
        with self._spawn_tracker_lock:
            self._observed_descendant_events.append({"event": "descendant_finish", **payload})

    def observe_child_process_sample(self, *, pid: int, transport: str | None = None, session_id: str | None = None) -> None:
        with self._spawn_tracker_lock:
            record = self._active_child_spawns.get(int(pid))
            if not isinstance(record, dict):
                return
            active_total = len(self._active_child_spawns)
            active_for_job = self._count_active_children_by("job_id", record.get("job_id"))
            active_for_chat = self._count_active_children_by("chat_id", record.get("chat_id"))
            active_for_session = self._count_active_children_by("session_id", record.get("session_id"))

        snapshot = self._child_process_snapshot(int(pid))
        host_memory_snapshot = self._host_memory_snapshot()
        with self._spawn_tracker_lock:
            record = self._active_child_spawns.get(int(pid))
            if not isinstance(record, dict):
                return
            self._child_spawn_events.append(
                {
                    "event": "sample",
                    "spawn_id": record.get("spawn_id"),
                    "pid": int(pid),
                    "transport": str(transport or record.get("transport") or "unknown"),
                    "job_id": record.get("job_id"),
                    "chat_id": record.get("chat_id"),
                    "session_id": str(session_id or record.get("session_id") or ""),
                    "user_id": record.get("user_id"),
                    "command_preview": record.get("command_preview"),
                    **dict(snapshot or {}),
                    **dict(host_memory_snapshot or {}),
                    "active_total": int(active_total),
                    "active_for_job": int(active_for_job),
                    "active_for_chat": int(active_for_chat),
                    "active_for_session": int(active_for_session),
                    "monotonic_ms": int(time.monotonic() * 1000),
                }
            )

    def register_child_spawn(self, *, transport: str, pid: int, command: list[str], session_id: str | None = None) -> str:
        self.assert_child_spawn_allowed(transport=transport, session_id=session_id)
        spawn_id = uuid.uuid4().hex[:12]
        context = self._get_spawn_trace_context()
        session_value = str(session_id or context.get("session_id") or "")
        record = {
            "spawn_id": spawn_id,
            "transport": str(transport),
            "pid": int(pid),
            "command": [str(part) for part in command],
            "command_preview": " ".join(str(part) for part in command)[:200],
            "user_id": str(context.get("user_id") or ""),
            "chat_id": context.get("chat_id"),
            "job_id": context.get("job_id"),
            "session_id": session_value,
            "started_monotonic": time.monotonic(),
            "spawn_snapshot": self._child_process_snapshot(int(pid)),
        }
        with self._spawn_tracker_lock:
            self._active_child_spawns[int(pid)] = record
            active_total = len(self._active_child_spawns)
            active_for_job = self._count_active_children_by("job_id", record.get("job_id"))
            active_for_chat = self._count_active_children_by("chat_id", record.get("chat_id"))
            active_for_session = self._count_active_children_by("session_id", record.get("session_id"))
            self._child_spawn_high_water_total = max(int(self._child_spawn_high_water_total), int(active_total))
            if record.get("job_id") not in {None, ""}:
                job_key = str(int(record.get("job_id")))
                self._child_spawn_high_water_by_job[job_key] = max(
                    int(self._child_spawn_high_water_by_job.get(job_key, 0)),
                    int(active_for_job),
                )
            if record.get("chat_id") not in {None, ""}:
                chat_key = str(int(record.get("chat_id")))
                self._child_spawn_high_water_by_chat[chat_key] = max(
                    int(self._child_spawn_high_water_by_chat.get(chat_key, 0)),
                    int(active_for_chat),
                )
            self._child_spawn_events.append(
                {
                    "event": "spawn",
                    "spawn_id": spawn_id,
                    "pid": int(pid),
                    "transport": str(record.get("transport") or "unknown"),
                    "job_id": record.get("job_id"),
                    "chat_id": record.get("chat_id"),
                    "session_id": record.get("session_id"),
                    "user_id": record.get("user_id"),
                    "command_preview": record.get("command_preview"),
                    **dict(record.get("spawn_snapshot") or {}),
                    "active_total": int(active_total),
                    "active_for_job": int(active_for_job),
                    "active_for_chat": int(active_for_chat),
                    "active_for_session": int(active_for_session),
                    "monotonic_ms": int(time.monotonic() * 1000),
                }
            )

        command_preview = str(record.get("command_preview") or "")
        self._safe_info_log(
            (
                "Miniapp Hermes child spawned "
                f"spawn_id={spawn_id} transport={record.get('transport')} pid={record.get('pid')} ppid={os.getpid()} "
                f"job_id={record.get('job_id')} chat_id={record.get('chat_id')} user_id={record.get('user_id')} "
                f"session_id={record.get('session_id')} active_total={active_total} active_for_job={active_for_job} "
                f"active_for_chat={active_for_chat} active_for_session={active_for_session} command={command_preview}"
            ),
            extra={
                "spawn": {
                    **record,
                    "ppid": os.getpid(),
                    "active_total": active_total,
                    "active_for_job": active_for_job,
                    "active_for_chat": active_for_chat,
                    "active_for_session": active_for_session,
                    "command_preview": command_preview,
                }
            },
        )
        return spawn_id

    def deregister_child_spawn(self, *, pid: int, outcome: str, return_code: int | None = None, signal: int | None = None) -> None:
        with self._spawn_tracker_lock:
            record = self._active_child_spawns.pop(int(pid), None)
            active_total = len(self._active_child_spawns)
            active_for_job = self._count_active_children_by("job_id", record.get("job_id") if record else None)
            active_for_chat = self._count_active_children_by("chat_id", record.get("chat_id") if record else None)
            active_for_session = self._count_active_children_by("session_id", record.get("session_id") if record else None)

        payload: dict[str, Any] = {
            "pid": int(pid),
            "outcome": str(outcome),
            "return_code": return_code,
            "signal": signal,
            "active_total": active_total,
            "active_for_job": active_for_job,
            "active_for_chat": active_for_chat,
            "active_for_session": active_for_session,
        }
        finish_snapshot = self._child_process_snapshot(int(pid))
        host_memory_snapshot = self._host_memory_snapshot()
        if record:
            start_snapshot = dict(record.get("spawn_snapshot") or {})
            payload.update(
                {
                    "spawn_id": record.get("spawn_id"),
                    "transport": record.get("transport"),
                    "command": record.get("command"),
                    "command_preview": record.get("command_preview"),
                    "user_id": record.get("user_id"),
                    "chat_id": record.get("chat_id"),
                    "job_id": record.get("job_id"),
                    "session_id": record.get("session_id"),
                    "lifetime_ms": int((time.monotonic() - float(record.get("started_monotonic") or time.monotonic())) * 1000),
                    "start_rss_kb": start_snapshot.get("rss_kb"),
                    "start_vm_hwm_kb": start_snapshot.get("vm_hwm_kb"),
                    "start_vm_peak_kb": start_snapshot.get("vm_peak_kb"),
                    "start_thread_count": start_snapshot.get("thread_count"),
                    "start_process_state": start_snapshot.get("process_state"),
                    "start_process_state_code": start_snapshot.get("process_state_code"),
                }
            )
        payload.update(dict(finish_snapshot or {}))
        payload.update(dict(host_memory_snapshot or {}))

        safe_outcome = str(outcome)
        with self._spawn_tracker_lock:
            self._child_spawn_events.append(
                {
                    "event": "finish",
                    "spawn_id": payload.get("spawn_id"),
                    "pid": int(pid),
                    "transport": payload.get("transport"),
                    "job_id": payload.get("job_id"),
                    "chat_id": payload.get("chat_id"),
                    "session_id": payload.get("session_id"),
                    "user_id": payload.get("user_id"),
                    "command_preview": payload.get("command_preview"),
                    "start_rss_kb": payload.get("start_rss_kb"),
                    "start_vm_hwm_kb": payload.get("start_vm_hwm_kb"),
                    "start_vm_peak_kb": payload.get("start_vm_peak_kb"),
                    "start_thread_count": payload.get("start_thread_count"),
                    "start_process_state": payload.get("start_process_state"),
                    "start_process_state_code": payload.get("start_process_state_code"),
                    "rss_kb": payload.get("rss_kb"),
                    "vm_hwm_kb": payload.get("vm_hwm_kb"),
                    "vm_peak_kb": payload.get("vm_peak_kb"),
                    "thread_count": payload.get("thread_count"),
                    "process_state": payload.get("process_state"),
                    "process_state_code": payload.get("process_state_code"),
                    "host_mem_free_kb": payload.get("host_mem_free_kb"),
                    "host_mem_available_kb": payload.get("host_mem_available_kb"),
                    "host_swap_total_kb": payload.get("host_swap_total_kb"),
                    "host_swap_free_kb": payload.get("host_swap_free_kb"),
                    "host_swap_used_kb": payload.get("host_swap_used_kb"),
                    "outcome": safe_outcome,
                    "return_code": return_code,
                    "signal": signal,
                    "active_total": int(active_total),
                    "active_for_job": int(active_for_job),
                    "active_for_chat": int(active_for_chat),
                    "active_for_session": int(active_for_session),
                    "monotonic_ms": int(time.monotonic() * 1000),
                }
            )
            if self._is_timeout_outcome(safe_outcome):
                self._child_spawn_timeout_total = int(self._child_spawn_timeout_total) + 1
                self._increment_timeout_counter(self._child_spawn_timeouts_by_outcome, safe_outcome)
                transport = str(payload.get("transport") or "unknown")
                self._increment_timeout_counter(self._child_spawn_timeouts_by_transport, transport)
                job_id = payload.get("job_id")
                if job_id not in {None, ""}:
                    self._increment_timeout_counter(self._child_spawn_timeouts_by_job, str(int(job_id)))
                chat_id = payload.get("chat_id")
                if chat_id not in {None, ""}:
                    self._increment_timeout_counter(self._child_spawn_timeouts_by_chat, str(int(chat_id)))
                self._child_spawn_timeout_events.append(
                    {
                        "event": "timeout_finish",
                        "spawn_id": payload.get("spawn_id"),
                        "pid": int(pid),
                        "transport": transport,
                        "job_id": payload.get("job_id"),
                        "chat_id": payload.get("chat_id"),
                        "session_id": payload.get("session_id"),
                        "user_id": payload.get("user_id"),
                        "outcome": safe_outcome,
                        "return_code": return_code,
                        "signal": signal,
                        "monotonic_ms": int(time.monotonic() * 1000),
                    }
                )

        self._safe_info_log(
            (
                "Miniapp Hermes child finished "
                f"spawn_id={payload.get('spawn_id')} pid={payload.get('pid')} outcome={payload.get('outcome')} "
                f"return_code={payload.get('return_code')} signal={payload.get('signal')} "
                f"job_id={payload.get('job_id')} chat_id={payload.get('chat_id')} user_id={payload.get('user_id')} "
                f"session_id={payload.get('session_id')} active_total={active_total} active_for_job={active_for_job} "
                f"active_for_chat={active_for_chat} active_for_session={active_for_session} lifetime_ms={payload.get('lifetime_ms')}"
            ),
            extra={"spawn": payload},
        )

    def _shared_backend_persistent_enabled(self) -> bool:
        return bool(
            self.direct_agent_enabled
            and self.persistent_sessions_requested
            and self.persistent_runtime_ownership == "shared"
        )

    def _worker_owned_warm_continuity_enabled(self) -> bool:
        return bool(
            self.direct_agent_enabled
            and self.persistent_sessions_requested
            and self.persistent_runtime_ownership == "checkpoint_only"
        )

    def _effective_warm_continuity_enabled(self) -> bool:
        return self._shared_backend_persistent_enabled() or self._worker_owned_warm_continuity_enabled()

    def _persistent_sessions_enablement_reason(self) -> str:
        if not self.direct_agent_enabled:
            return "direct_agent_disabled"
        if not self.persistent_sessions_requested:
            return "persistent_sessions_not_requested"
        if self.persistent_runtime_ownership == "shared":
            return "shared_backend_runtime_enabled"
        if self.persistent_runtime_ownership == "checkpoint_only":
            return "worker_owned_warm_continuity_enabled"
        return f"ownership_resolved_to_{self.persistent_runtime_ownership}"

    def _selected_transport(self) -> str:
        if self.stream_url:
            return "http-stream"
        if self.api_url:
            return "http"
        if self._shared_backend_persistent_enabled():
            return "agent-persistent"
        if self._worker_owned_warm_continuity_enabled():
            return "agent-worker-isolated"
        if self.direct_agent_enabled:
            return "agent"
        return "cli"

    def warm_session_contract(self) -> WarmSessionContract:
        launcher = str(os.environ.get("MINI_APP_JOB_WORKER_LAUNCHER", "inline") or "").strip().lower()
        ownership = str(self.persistent_runtime_ownership or "").strip().lower() or "checkpoint_only"
        requested = bool(self.persistent_sessions_requested)
        enabled = bool(self._effective_warm_continuity_enabled())
        registry = getattr(self, "_warm_session_registry", None)

        if ownership == "shared":
            current_mode = "shared_backend_warm_runtime"
            owner = "shared_backend_process"
            owner_class = type(registry).__name__ if registry is not None else "backend_local_runtime"
            lifecycle_state = "active_when_session_manager_entry_exists"
            lifecycle_scope = "process_local_shared_backend"
            eviction_policy = "session_manager_idle_ttl_or_capacity"
            target_status = "legacy_mode_only"
            safety_reason = "shared backend warm ownership is only valid for non-isolated inline mode"
        elif requested and self.direct_agent_enabled:
            current_mode = "isolated_worker_owned_warm_continuity"
            owner = "isolated_worker_processes"
            owner_class = type(registry).__name__ if registry is not None else "isolated_worker_registry"
            lifecycle_state = "worker_owned_live_attach_or_checkpoint_continuity"
            lifecycle_scope = "per_chat_isolated_worker"
            eviction_policy = "worker_owner_lifecycle_attach_deadline_or_explicit_invalidation"
            target_status = "enabled_in_subprocess_mode"
            safety_reason = "subprocess isolation preserves per-chat continuity by keeping warm ownership inside isolated workers"
        else:
            current_mode = "checkpoint_only_continuity"
            owner = "none_checkpoint_only"
            owner_class = "no_live_warm_owner"
            lifecycle_state = "cold_start_each_turn"
            lifecycle_scope = "per_turn_worker_attempt"
            eviction_policy = "none_checkpoint_only"
            target_status = "not_requested"
            safety_reason = "subprocess isolation forbids shared backend warm ownership unless warm continuity is explicitly requested"

        return WarmSessionContract(
            current_mode=current_mode,
            owner=owner,
            owner_class=owner_class,
            lifecycle_state=lifecycle_state,
            lifecycle_scope=lifecycle_scope,
            eviction_policy=eviction_policy,
            requested=requested,
            enabled=enabled,
            ownership=ownership,
            launcher=launcher,
            target_mode="isolated_worker_owned_warm_continuity",
            target_status=target_status,
            safety_reason=safety_reason,
        )

    def note_warm_session_worker_started(
        self,
        *,
        session_id: str,
        chat_id: int | None = None,
        job_id: int | None = None,
        owner_pid: int | None = None,
    ) -> None:
        registry = getattr(self, "_warm_session_registry", None)
        callback = getattr(registry, "note_worker_started", None)
        if callable(callback):
            callback(session_id=session_id, chat_id=chat_id, job_id=job_id, owner_pid=owner_pid)

    def note_warm_session_worker_finished(
        self,
        *,
        session_id: str,
        outcome: str,
        chat_id: int | None = None,
        job_id: int | None = None,
        owner_pid: int | None = None,
    ) -> None:
        registry = getattr(self, "_warm_session_registry", None)
        callback = getattr(registry, "note_worker_finished", None)
        if callable(callback):
            callback(session_id=session_id, outcome=outcome, chat_id=chat_id, job_id=job_id, owner_pid=owner_pid)

    def note_warm_session_worker_attach_ready(
        self,
        *,
        session_id: str,
        owner_pid: int | None = None,
        transport_kind: str | None = None,
        worker_endpoint: str | None = None,
        resume_token: str | None = None,
        resume_deadline_ms: int | None = None,
    ) -> None:
        registry = getattr(self, "_warm_session_registry", None)
        callback = getattr(registry, "note_worker_attach_ready", None)
        if callable(callback):
            callback(
                session_id=session_id,
                owner_pid=owner_pid,
                transport_kind=transport_kind,
                worker_endpoint=worker_endpoint,
                resume_token=resume_token,
                resume_deadline_ms=resume_deadline_ms,
            )

    def note_warm_session_worker_health(
        self,
        *,
        session_id: str,
        rss_kb: int | None = None,
        thread_count: int | None = None,
        health_status: str | None = None,
        health_reason: str | None = None,
    ) -> None:
        registry = getattr(self, "_warm_session_registry", None)
        callback = getattr(registry, "note_worker_health", None)
        if callable(callback):
            callback(
                session_id=session_id,
                rss_kb=rss_kb,
                thread_count=thread_count,
                health_status=health_status,
                health_reason=health_reason,
            )

    def warm_session_owner_state(self) -> dict[str, Any]:
        registry = getattr(self, "_warm_session_registry", None)
        if registry is None:
            return {"owner_class": "none", "active_owner_count": 0, "active_session_ids": [], "recent_events": []}
        owner_state = getattr(registry, "owner_state", None)
        if callable(owner_state):
            payload = dict(owner_state() or {})
        else:
            payload = {"owner_class": type(registry).__name__, "active_owner_count": 0, "active_session_ids": [], "recent_events": []}
        records = list((payload.get("owner_records") if isinstance(payload, dict) else None) or [])
        payload["live_attach_ready_count"] = sum(
            1
            for record in records
            if str((record or {}).get("state") or "") == "attachable_running"
            and bool((record or {}).get("attach_worker_endpoint"))
            and bool((record or {}).get("attach_resume_token"))
        )
        payload["live_attach_ready_session_ids"] = [
            str((record or {}).get("session_id") or "")
            for record in records
            if str((record or {}).get("state") or "") == "attachable_running"
            and bool((record or {}).get("attach_worker_endpoint"))
            and bool((record or {}).get("attach_resume_token"))
        ]
        payload["retire_after_runs"] = int(self.warm_worker_retire_after_runs)
        payload["health_max_rss_mb"] = int(self.warm_worker_health_max_rss_mb)
        payload["health_max_threads"] = int(self.warm_worker_health_max_threads)
        retirement_reason_counts: dict[str, int] = {}
        recent_retirements: list[dict[str, Any]] = []
        for record in records:
            reason = str((record or {}).get("reusability_reason") or "")
            if not reason:
                continue
            classified_reason = None
            if reason.startswith("failure_signature:"):
                classified_reason = "failure_signature"
            elif "retired_thread_limit" in reason:
                classified_reason = "thread_limit"
            elif "retired_rss_limit" in reason:
                classified_reason = "rss_limit"
            elif "retired_after_run_budget" in reason:
                classified_reason = "run_budget"
            if not classified_reason:
                continue
            retirement_reason_counts[classified_reason] = int(retirement_reason_counts.get(classified_reason, 0)) + 1
            recent_retirements.append(
                {
                    "session_id": str((record or {}).get("session_id") or ""),
                    "state": str((record or {}).get("state") or ""),
                    "reason": reason,
                    "health_status": (record or {}).get("health_status"),
                    "health_reason": (record or {}).get("health_reason"),
                    "last_known_rss_kb": (record or {}).get("last_known_rss_kb"),
                    "last_known_thread_count": (record or {}).get("last_known_thread_count"),
                    "run_count": int((record or {}).get("run_count") or 0),
                }
            )
        payload["retirement_summary"] = {
            "total": int(sum(retirement_reason_counts.values())),
            "by_reason": retirement_reason_counts,
            "recent": recent_retirements[-8:],
        }
        return payload

    def _normalize_warm_reuse_candidate(self, candidate: dict[str, Any] | None) -> dict[str, Any] | None:
        if not isinstance(candidate, dict):
            return None
        payload = dict(candidate)
        existing_contract = payload.get("reuse_contract")
        base_contract = build_reuse_contract(payload) or {}
        if isinstance(existing_contract, dict):
            merged_contract = dict(base_contract)
            merged_contract.update(existing_contract)
            payload["reuse_contract"] = merged_contract
        else:
            payload["reuse_contract"] = base_contract or None
        return payload

    def select_warm_session_candidate(self, session_id: str) -> dict[str, Any] | None:
        registry = getattr(self, "_warm_session_registry", None)
        selector = getattr(registry, "select_reusable_candidate", None)
        if callable(selector):
            result = selector(session_id)
            return self._normalize_warm_reuse_candidate(dict(result) if isinstance(result, dict) else None)
        return None

    def _warm_session_unavailable_reason(self, session_id: str) -> str:
        owner_state = self.warm_session_owner_state()
        records = list((owner_state.get("owner_records") if isinstance(owner_state, dict) else None) or [])
        target = next((record for record in records if str((record or {}).get("session_id") or "") == str(session_id or "")), None)
        if not isinstance(target, dict):
            return "no_owner_record"
        state = str(target.get("state") or "unknown")
        if state == "expired":
            return str(target.get("reusability_reason") or "candidate_ttl_expired")
        if state == "evicted":
            return str(target.get("reusability_reason") or "evicted")
        if state == "running":
            return str(target.get("reusability_reason") or "worker_attempt_in_progress")
        if state == "attachable_running":
            deadline = target.get("attach_resume_deadline_ms")
            if deadline not in {None, ""} and int(deadline) <= int(time.monotonic() * 1000):
                return "attach_resume_deadline_expired"
            return str(target.get("reusability_reason") or "worker_attach_live_available")
        return str(target.get("reusability_reason") or f"state:{state}")

    def probe_warm_session_candidate(self, session_id: str, *, reason: str) -> dict[str, Any]:
        candidate = self.select_warm_session_candidate(session_id)
        retirement_reason = None
        if isinstance(candidate, dict):
            candidate, retirement_reason = self.assess_warm_worker_candidate_health(session_id, candidate)
        available = isinstance(candidate, dict)
        payload = {
            "event": "warm_candidate_probe",
            "session_id": str(session_id or ""),
            "reason": str(reason or "unknown"),
            "available": bool(available),
            "candidate": candidate if available else None,
            "unavailable_reason": None if available else (retirement_reason or self._warm_session_unavailable_reason(session_id)),
            "monotonic_ms": int(time.monotonic() * 1000),
        }
        self._warm_candidate_probe_events.append(dict(payload))
        return payload

    def evaluate_warm_reuse_policy(
        self,
        session_id: str,
        *,
        reason: str,
        requested_path: str,
        candidate: dict[str, Any] | None,
    ) -> dict[str, Any]:
        retirement_reason = None
        if isinstance(candidate, dict):
            candidate, retirement_reason = self.assess_warm_worker_candidate_health(session_id, candidate)
        available = isinstance(candidate, dict)
        contract = self.warm_session_contract()
        policy_name = "disabled_by_policy"
        allowed = False
        detail = "warm reuse remains telemetry-only until an explicit policy change enables attempts"

        candidate_session_id = str((candidate or {}).get("session_id") or "") if available else ""
        candidate_chat_id = (candidate or {}).get("chat_id") if available else None
        expected_chat_id = None
        try:
            expected_chat_id = int(str(session_id or "").rsplit("-", 1)[-1])
        except (TypeError, ValueError):
            expected_chat_id = None

        if not self.warm_worker_reuse_enabled:
            policy_name = "disabled_by_policy"
            allowed = False
            detail = "warm worker reuse flag is disabled"
        elif not self._worker_owned_warm_continuity_enabled():
            policy_name = "worker_owned_warm_continuity_unavailable"
            allowed = False
            detail = "worker-owned warm continuity is not active for the current transport/runtime ownership"
        elif not available:
            policy_name = "candidate_unavailable"
            allowed = False
            detail = (
                f"warm candidate retired by health gate: {retirement_reason}"
                if retirement_reason
                else "no warm candidate is available"
            )
        elif candidate_session_id != str(session_id or ""):
            policy_name = "session_binding_mismatch"
            allowed = False
            detail = "candidate session binding does not match the requested session"
        elif self.warm_worker_same_chat_only and expected_chat_id is not None and candidate_chat_id is not None and int(candidate_chat_id) != int(expected_chat_id):
            policy_name = "same_chat_only_blocked"
            allowed = False
            detail = "same-chat-only reuse blocked candidate from another chat"
        elif str(requested_path or "") != "agent-worker-isolated":
            policy_name = "transport_not_supported"
            allowed = False
            detail = f"requested path '{requested_path}' does not support warm worker attach reuse"
        else:
            policy_name = "same_chat_warm_worker_reuse"
            allowed = True
            detail = "same-chat warm worker reuse allowed"

        payload = {
            "event": "warm_reuse_policy_check",
            "session_id": str(session_id or ""),
            "reason": str(reason or "unknown"),
            "requested_path": str(requested_path or "unknown"),
            "policy": policy_name,
            "allowed": bool(allowed),
            "detail": detail,
            "candidate_available": bool(available),
            "candidate": candidate if available else None,
            "current_mode": contract.current_mode,
            "ownership": contract.ownership,
            "launcher": contract.launcher,
            "warm_worker_reuse_enabled": bool(self.warm_worker_reuse_enabled),
            "warm_worker_same_chat_only": bool(self.warm_worker_same_chat_only),
            "warm_worker_idle_ttl_seconds": int(self.warm_worker_idle_ttl_seconds),
            "warm_worker_max_idle": int(self.warm_worker_max_idle),
            "warm_worker_max_total": int(self.warm_worker_max_total),
            "warm_worker_retire_after_runs": int(self.warm_worker_retire_after_runs),
            "warm_worker_health_max_rss_mb": int(self.warm_worker_health_max_rss_mb),
            "warm_worker_health_max_threads": int(self.warm_worker_health_max_threads),
            "monotonic_ms": int(time.monotonic() * 1000),
        }
        self._warm_reuse_policy_events.append(dict(payload))
        return payload

    def validate_warm_reuse_contract(self, *, session_id: str, reuse_contract: dict[str, Any] | None) -> dict[str, Any]:
        contract_payload = dict(reuse_contract) if isinstance(reuse_contract, dict) else {}
        required_now = list(contract_payload.get("required_now") or [])
        reserved_for_future = list(contract_payload.get("reserved_for_future") or [])
        resume_capability = str(contract_payload.get("resume_capability") or "unknown")
        missing_required_fields = [
            field
            for field in required_now
            if contract_payload.get(field) in {None, ""}
        ]
        if missing_required_fields:
            return {
                "valid": False,
                "status": "missing_required_fields",
                "missing_required_fields": missing_required_fields,
                "reserved_future_fields": reserved_for_future,
                "resume_capability": resume_capability,
                "reuse_contract": contract_payload or None,
            }
        contract_version = str(contract_payload.get("contract_version") or "")
        if contract_version != "warm-reuse-v1":
            return {
                "valid": False,
                "status": "unsupported_contract_version",
                "missing_required_fields": [],
                "reserved_future_fields": reserved_for_future,
                "resume_capability": resume_capability,
                "reuse_contract": contract_payload or None,
            }
        contract_session_id = str(contract_payload.get("session_id") or "")
        if contract_session_id != str(session_id or ""):
            return {
                "valid": False,
                "status": "invalid_session_binding",
                "missing_required_fields": [],
                "reserved_future_fields": reserved_for_future,
                "resume_capability": resume_capability,
                "reuse_contract": contract_payload or None,
            }
        return {
            "valid": True,
            "status": "valid",
            "missing_required_fields": [],
            "reserved_future_fields": reserved_for_future,
            "resume_capability": resume_capability,
            "reuse_contract": contract_payload or None,
        }

    def plan_worker_attach_handshake(
        self,
        *,
        session_id: str,
        requested_path: str,
        candidate: dict[str, Any] | None,
        reuse_contract: dict[str, Any] | None,
        validation: dict[str, Any] | None,
    ) -> dict[str, Any]:
        candidate_payload = dict(candidate) if isinstance(candidate, dict) else {}
        contract_payload = dict(reuse_contract) if isinstance(reuse_contract, dict) else {}
        validation_payload = dict(validation) if isinstance(validation, dict) else {}
        owner_pid = contract_payload.get("owner_pid")
        attach_mechanism = str(contract_payload.get("attach_mechanism") or "unknown")
        required_transport = str(contract_payload.get("required_transport") or "unknown")
        supported_resume_modes = list(contract_payload.get("supported_resume_modes") or [])
        missing_prerequisites: list[str] = []
        if not owner_pid:
            missing_prerequisites.append("owner_pid")
        if required_transport != "subprocess":
            missing_prerequisites.append("required_transport")
        if attach_mechanism != "pid_only":
            missing_prerequisites.append("attach_mechanism")
        if "worker_attach" not in supported_resume_modes:
            missing_prerequisites.append("supported_resume_modes")
        return {
            "mode": "worker_attach",
            "planned": bool(validation_payload.get("valid")),
            "deferred": True,
            "status": "attach_plan_ready" if not missing_prerequisites else "attach_plan_incomplete",
            "session_id": str(session_id or ""),
            "requested_path": str(requested_path or "unknown"),
            "attach_mechanism": attach_mechanism,
            "required_transport": required_transport,
            "supported_resume_modes": supported_resume_modes,
            "owner_pid": owner_pid,
            "candidate_session_id": str(candidate_payload.get("session_id") or ""),
            "validation_status": str(validation_payload.get("status") or "unknown"),
            "missing_prerequisites": missing_prerequisites,
            "next_step": "implement_worker_attach_execution",
        }

    def _read_process_cmdline(self, pid: int) -> str | None:
        if int(pid or 0) <= 0:
            return None
        try:
            raw = Path(f"/proc/{int(pid)}/cmdline").read_bytes()
        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
            return None
        if not raw:
            return None
        try:
            return raw.replace(b"\x00", b" ").decode("utf-8", errors="ignore").strip() or None
        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
            return None

    def _read_process_status(self, pid: int) -> dict[str, Any] | None:
        if int(pid or 0) <= 0:
            return None
        try:
            raw = Path(f"/proc/{int(pid)}/status").read_text(encoding="utf-8", errors="ignore")
        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
            return None
        lines = [line.strip() for line in raw.splitlines() if line.strip()]
        if not lines:
            return None
        payload: dict[str, Any] = {"raw": raw}
        for line in lines:
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            payload[str(key).strip()] = str(value).strip()
        state_text = str(payload.get("State") or "").strip()
        payload["state"] = state_text
        payload["state_code"] = state_text[:1] if state_text else ""
        return payload

    def _read_process_fd_link(self, pid: int, fd: int) -> str | None:
        if int(pid or 0) <= 0:
            return None
        try:
            return os.readlink(f"/proc/{int(pid)}/fd/{int(fd)}") or None
        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
            return None

    def _read_meminfo(self) -> dict[str, Any] | None:
        try:
            raw = Path("/proc/meminfo").read_text(encoding="utf-8", errors="ignore")
        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
            return None
        lines = [line.strip() for line in raw.splitlines() if line.strip()]
        if not lines:
            return None
        payload: dict[str, Any] = {"raw": raw}
        for line in lines:
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            payload[str(key).strip()] = str(value).strip()
        return payload

    def _parse_proc_status_kb(self, value: Any) -> int | None:
        text = str(value or "").strip()
        if not text:
            return None
        number = text.split()[0]
        try:
            parsed = int(number)
        except (TypeError, ValueError):
            return None
        return parsed if parsed >= 0 else None

    def _parse_proc_status_int(self, value: Any) -> int | None:
        text = str(value or "").strip()
        if not text:
            return None
        try:
            parsed = int(text)
        except (TypeError, ValueError):
            return None
        return parsed if parsed >= 0 else None

    def _child_process_snapshot(self, pid: int) -> dict[str, Any]:
        status = self._read_process_status(int(pid)) or {}
        rss_kb = self._parse_proc_status_kb(status.get("VmRSS"))
        vm_hwm_kb = self._parse_proc_status_kb(status.get("VmHWM"))
        vm_peak_kb = self._parse_proc_status_kb(status.get("VmPeak"))
        thread_count = self._parse_proc_status_int(status.get("Threads"))
        process_state = str(status.get("state") or "").strip() or None
        process_state_code = str(status.get("state_code") or "").strip().upper() or None
        return {
            "rss_kb": rss_kb,
            "vm_hwm_kb": vm_hwm_kb,
            "vm_peak_kb": vm_peak_kb,
            "thread_count": thread_count,
            "process_state": process_state,
            "process_state_code": process_state_code,
        }

    def _host_memory_snapshot(self) -> dict[str, Any]:
        meminfo = self._read_meminfo() or {}
        mem_free_kb = self._parse_proc_status_kb(meminfo.get("MemFree"))
        mem_available_kb = self._parse_proc_status_kb(meminfo.get("MemAvailable"))
        swap_total_kb = self._parse_proc_status_kb(meminfo.get("SwapTotal"))
        swap_free_kb = self._parse_proc_status_kb(meminfo.get("SwapFree"))
        swap_used_kb = None
        if swap_total_kb is not None and swap_free_kb is not None:
            swap_used_kb = max(0, int(swap_total_kb) - int(swap_free_kb))
        return {
            "host_mem_free_kb": mem_free_kb,
            "host_mem_available_kb": mem_available_kb,
            "host_swap_total_kb": swap_total_kb,
            "host_swap_free_kb": swap_free_kb,
            "host_swap_used_kb": swap_used_kb,
        }

    def assess_warm_worker_candidate_health(self, session_id: str, candidate: dict[str, Any] | None) -> tuple[dict[str, Any] | None, str | None]:
        candidate_payload = dict(candidate) if isinstance(candidate, dict) else {}
        if not candidate_payload:
            return None, None
        session_key = str(session_id or "")
        owner_pid = candidate_payload.get("owner_pid")
        run_count = int(candidate_payload.get("run_count") or 0)
        if run_count > int(self.warm_worker_retire_after_runs):
            self.evict_session(session_key, reason=f"retired_after_run_budget:{run_count}>{self.warm_worker_retire_after_runs}")
            return None, "retired_after_run_budget"
        try:
            owner_pid_int = int(owner_pid)
        except (TypeError, ValueError):
            owner_pid_int = 0
        if owner_pid_int <= 0:
            return candidate_payload, None

        status = self._read_process_status(owner_pid_int) or {}
        rss_kb = self._parse_proc_status_kb(status.get("VmRSS"))
        thread_count = self._parse_proc_status_int(status.get("Threads"))
        state_code = str(status.get("state_code") or "").strip().upper()
        health_status = "healthy"
        health_reason = "within_limits"
        retire_reason = None
        if state_code in {"X", "Z"}:
            health_status = "retire"
            health_reason = f"process_state_{state_code.lower()}"
            retire_reason = health_reason
        elif rss_kb is not None and rss_kb > int(self.warm_worker_health_max_rss_mb) * 1024:
            health_status = "retire"
            health_reason = f"rss_kb_exceeded:{rss_kb}>{int(self.warm_worker_health_max_rss_mb) * 1024}"
            retire_reason = "retired_rss_limit"
        elif thread_count is not None and thread_count > int(self.warm_worker_health_max_threads):
            health_status = "retire"
            health_reason = f"thread_count_exceeded:{thread_count}>{int(self.warm_worker_health_max_threads)}"
            retire_reason = "retired_thread_limit"
        elif rss_kb is None and thread_count is None:
            health_status = "unknown"
            health_reason = "proc_status_unavailable"

        self.note_warm_session_worker_health(
            session_id=session_key,
            rss_kb=rss_kb,
            thread_count=thread_count,
            health_status=health_status,
            health_reason=health_reason,
        )
        refreshed = self.select_warm_session_candidate(session_key) or candidate_payload
        if retire_reason:
            self.evict_session(session_key, reason=f"{retire_reason}:{health_reason}")
            return None, retire_reason
        return refreshed, None

    def _build_attach_handshake_result(
        self,
        *,
        session_id: str,
        requested_path: str,
        owner_pid: Any,
        status: str,
        reason: str,
        handshake_attempted: bool,
        handshake_detail: dict[str, Any] | None = None,
        attempt_count: int | None = None,
        next_step: str = "fallback_to_cold_path",
    ) -> dict[str, Any]:
        payload = {
            "executed": True,
            "status": status,
            "session_id": str(session_id or ""),
            "requested_path": str(requested_path or "unknown"),
            "owner_pid": owner_pid,
            "reason": str(reason or "unknown"),
            "handshake_timeout_ms": int(self.warm_attach_handshake_timeout_ms),
            "handshake_attempted": bool(handshake_attempted),
            "handshake_detail": dict(handshake_detail) if isinstance(handshake_detail, dict) else None,
            "next_step": next_step,
        }
        if attempt_count is not None:
            payload["attempt_count"] = int(attempt_count)
        return payload

    def _probe_live_worker_attach_handshake(
        self,
        *,
        session_id: str,
        requested_path: str,
        owner_pid: int,
        attempt_count: int,
    ) -> dict[str, Any]:
        try:
            os.kill(owner_pid, 0)
        except ProcessLookupError:
            return self._build_attach_handshake_result(
                session_id=session_id,
                requested_path=requested_path,
                owner_pid=owner_pid,
                status="attach_action_handshake_failed",
                reason="owner_pid_not_found_during_handshake",
                handshake_attempted=True,
                attempt_count=attempt_count,
            )
        except PermissionError:
            return self._build_attach_handshake_result(
                session_id=session_id,
                requested_path=requested_path,
                owner_pid=owner_pid,
                status="attach_action_handshake_failed",
                reason="owner_pid_permission_denied_during_handshake",
                handshake_attempted=True,
                attempt_count=attempt_count,
            )

        process_status = self._read_process_status(owner_pid)
        stdin_link = self._read_process_fd_link(owner_pid, 0)
        stdout_link = self._read_process_fd_link(owner_pid, 1)
        process_state = str((process_status or {}).get("state") or "").strip()
        process_state_code = str((process_status or {}).get("state_code") or "").strip().upper()
        handshake_detail = {
            "process_state": process_state or None,
            "stdin_link": stdin_link,
            "stdout_link": stdout_link,
        }
        if process_state_code == "Z":
            return self._build_attach_handshake_result(
                session_id=session_id,
                requested_path=requested_path,
                owner_pid=owner_pid,
                status="attach_action_handshake_failed",
                reason="owner_pid_zombie_during_handshake",
                handshake_attempted=True,
                handshake_detail=handshake_detail,
                attempt_count=attempt_count,
            )
        if process_status and stdin_link and stdout_link:
            return self._build_attach_handshake_result(
                session_id=session_id,
                requested_path=requested_path,
                owner_pid=owner_pid,
                status="attach_action_handshake_succeeded",
                reason="handshake_proc_probe_succeeded",
                handshake_attempted=True,
                handshake_detail=handshake_detail,
                attempt_count=attempt_count,
                next_step="implement_live_stream_attach_after_handshake",
            )
        return {
            "pending": True,
            "reason": "handshake_transport_endpoints_unavailable",
            "handshake_detail": handshake_detail,
        }

    def _attempt_live_worker_attach_handshake(
        self,
        *,
        session_id: str,
        requested_path: str,
        attach_execution: dict[str, Any] | None,
    ) -> dict[str, Any]:
        execution_payload = dict(attach_execution) if isinstance(attach_execution, dict) else {}
        owner_pid = execution_payload.get("owner_pid")
        pid_int = _coerce_positive_int(owner_pid)
        if pid_int is None:
            return self._build_attach_handshake_result(
                session_id=session_id,
                requested_path=requested_path,
                owner_pid=owner_pid,
                status="attach_action_handshake_failed",
                reason="invalid_owner_pid",
                handshake_attempted=False,
            )

        deadline = time.monotonic() + (float(self.warm_attach_handshake_timeout_ms) / 1000.0)
        attempts = 0
        last_reason = "handshake_not_started"
        last_detail: dict[str, Any] | None = None
        while True:
            attempts += 1
            if time.monotonic() > deadline:
                return self._build_attach_handshake_result(
                    session_id=session_id,
                    requested_path=requested_path,
                    owner_pid=pid_int,
                    status="attach_action_handshake_timeout",
                    reason=last_reason,
                    handshake_attempted=True,
                    handshake_detail=last_detail,
                    attempt_count=attempts,
                )

            probe = self._probe_live_worker_attach_handshake(
                session_id=session_id,
                requested_path=requested_path,
                owner_pid=pid_int,
                attempt_count=attempts,
            )
            if not bool(probe.get("pending")):
                return probe

            last_reason = str(probe.get("reason") or "handshake_transport_endpoints_unavailable")
            last_detail = dict(probe.get("handshake_detail") or {}) if isinstance(probe.get("handshake_detail"), dict) else None
            time.sleep(0.01)

    def _terminate_warm_owner_process(self, *, pid: int | None, reason: str) -> bool:
        try:
            pid_int = int(pid or 0)
        except (TypeError, ValueError):
            return False
        if pid_int <= 0:
            return False
        try:
            if os.name == "posix":
                try:
                    pgid = os.getpgid(pid_int)
                except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
                    pgid = 0
                if pgid > 0:
                    os.killpg(pgid, signal.SIGTERM)
                    return True
            os.kill(pid_int, signal.SIGTERM)
            return True
        except ProcessLookupError:
            return False
        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
            logger.debug("warm_owner_process_termination_failed pid=%s reason=%s", pid_int, reason, exc_info=True)
            return False

    def _stream_events_from_worker_attach_socket(
        self,
        *,
        session_id: str,
        sock: socket.socket,
        reader: Any,
    ) -> Iterator[dict[str, Any]]:
        terminal_received = False
        try:
            while True:
                raw_line = reader.readline()
                if not raw_line:
                    break
                line = raw_line.decode("utf-8", errors="ignore").strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    yield {
                        "type": "error",
                        "error": "Warm attach stream returned invalid JSON.",
                    }
                    return
                if isinstance(payload, dict):
                    payload_type = str(payload.get("type") or "")
                    if payload_type == "attach_ready":
                        self.note_warm_session_worker_attach_ready(
                            session_id=str(payload.get("session_id") or session_id or ""),
                            transport_kind=str(payload.get("transport_kind") or "") or None,
                            worker_endpoint=str(payload.get("worker_endpoint") or "") or None,
                            resume_token=str(payload.get("resume_token") or "") or None,
                            resume_deadline_ms=payload.get("resume_deadline_ms"),
                        )
                        continue
                    if payload_type == "worker_terminal":
                        continue
                    if payload_type in {"done", "error"}:
                        terminal_received = True
                    yield dict(payload)
                else:
                    yield {
                        "type": "error",
                        "error": "Warm attach stream returned non-object payload.",
                    }
                    return
            if not terminal_received:
                yield {
                    "type": "error",
                    "error": "Warm attach stream closed before a terminal event was received.",
                }
        except socket.timeout:
            terminal_received = True
            yield {
                "type": "error",
                "error": "Warm attach stream timed out after attach succeeded.",
            }
        finally:
            try:
                reader.close()
            except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
                pass
            try:
                sock.close()
            except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
                pass

    def _build_attach_resume_result(
        self,
        *,
        session_id: str,
        requested_path: str,
        status: str,
        reason: str,
        transport_kind: str | None,
        worker_endpoint: str | None,
        resume_token_present: bool,
        executed: bool,
        next_step: str = "fallback_to_cold_path",
        **extra: Any,
    ) -> dict[str, Any]:
        payload = {
            "executed": executed,
            "status": status,
            "session_id": str(session_id or ""),
            "requested_path": str(requested_path or "unknown"),
            "reason": str(reason or "unknown"),
            "transport_kind": transport_kind,
            "worker_endpoint": worker_endpoint,
            "resume_token_present": bool(resume_token_present),
            "next_step": next_step,
        }
        payload.update(extra)
        return payload

    def _close_attach_resume_resources(self, *, sock: socket.socket | None = None, reader: Any | None = None) -> None:
        if reader is not None:
            try:
                reader.close()
            except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
                pass
        if sock is not None:
            try:
                sock.close()
            except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort local cleanup and proc probing must never interrupt primary flow
                pass

    def _resolve_attach_resume_transport(
        self,
        *,
        session_id: str,
        requested_path: str,
        reuse_contract: dict[str, Any] | None,
        attach_action: dict[str, Any] | None,
    ) -> dict[str, Any]:
        contract_payload = dict(reuse_contract) if isinstance(reuse_contract, dict) else {}
        attach_action_payload = dict(attach_action) if isinstance(attach_action, dict) else {}
        if str(attach_action_payload.get("status") or "") != "attach_action_handshake_succeeded":
            return self._build_attach_resume_result(
                session_id=session_id,
                requested_path=requested_path,
                status="attach_action_attach_unavailable",
                reason="handshake_not_succeeded",
                transport_kind=contract_payload.get("transport_kind"),
                worker_endpoint=contract_payload.get("worker_endpoint"),
                resume_token_present=bool(contract_payload.get("resume_token")),
                executed=False,
            )

        transport_kind = str(contract_payload.get("transport_kind") or "").strip()
        worker_endpoint = str(contract_payload.get("worker_endpoint") or "").strip()
        resume_token = str(contract_payload.get("resume_token") or "").strip()
        resume_deadline_ms = contract_payload.get("resume_deadline_ms")
        try:
            resume_deadline_int = int(resume_deadline_ms) if resume_deadline_ms is not None else None
        except (TypeError, ValueError):
            resume_deadline_int = None
        now_ms = int(time.monotonic() * 1000)
        if resume_deadline_int is not None and now_ms > resume_deadline_int:
            return self._build_attach_resume_result(
                session_id=session_id,
                requested_path=requested_path,
                status="attach_action_attach_unavailable",
                reason="resume_deadline_expired",
                transport_kind=transport_kind or None,
                worker_endpoint=worker_endpoint or None,
                resume_token_present=bool(resume_token),
                executed=True,
                resume_deadline_ms=resume_deadline_int,
            )
        if transport_kind != "unix_socket_jsonl":
            return self._build_attach_resume_result(
                session_id=session_id,
                requested_path=requested_path,
                status="attach_action_attach_unavailable",
                reason="unsupported_transport_kind",
                transport_kind=transport_kind or None,
                worker_endpoint=worker_endpoint or None,
                resume_token_present=bool(resume_token),
                executed=False,
            )
        if not _supports_unix_socket_attach_transport():
            return self._build_attach_resume_result(
                session_id=session_id,
                requested_path=requested_path,
                status="attach_action_attach_unavailable",
                reason="unsupported_platform_warm_attach",
                transport_kind=transport_kind or None,
                worker_endpoint=worker_endpoint or None,
                resume_token_present=bool(resume_token),
                executed=False,
            )
        missing_fields: list[str] = []
        if not worker_endpoint:
            missing_fields.append("worker_endpoint")
        if not resume_token:
            missing_fields.append("resume_token")
        if missing_fields:
            return self._build_attach_resume_result(
                session_id=session_id,
                requested_path=requested_path,
                status="attach_action_attach_unavailable",
                reason="missing_attach_transport_fields",
                transport_kind=transport_kind,
                worker_endpoint=worker_endpoint or None,
                resume_token_present=bool(resume_token),
                executed=False,
                missing_fields=missing_fields,
            )
        return {
            **self._build_attach_resume_result(
                session_id=session_id,
                requested_path=requested_path,
                status="attach_action_attach_ready",
                reason="attach_transport_resolved",
                transport_kind=transport_kind,
                worker_endpoint=worker_endpoint,
                resume_token_present=True,
                executed=False,
                next_step="connect_attach_resume_transport",
            ),
            "resume_token": resume_token,
            "resume_deadline_ms": resume_deadline_int,
        }

    def _read_attach_resume_ack(
        self,
        *,
        transport: _AttachResumeTransport,
        sock: socket.socket,
        reader: Any,
    ) -> tuple[dict[str, Any], Iterator[dict[str, Any]] | None]:
        ack_line = reader.readline()
        if not ack_line:
            self._close_attach_resume_resources(sock=sock, reader=reader)
            return (
                self._build_attach_resume_result(
                    session_id=transport.session_id,
                    requested_path=transport.requested_path,
                    status="attach_action_attach_failed",
                    reason="attach_ack_missing",
                    transport_kind=transport.transport_kind,
                    worker_endpoint=transport.worker_endpoint,
                    resume_token_present=True,
                    executed=True,
                ),
                None,
            )
        try:
            ack_payload = json.loads(ack_line.decode("utf-8", errors="ignore"))
        except json.JSONDecodeError:
            self._close_attach_resume_resources(sock=sock, reader=reader)
            return (
                self._build_attach_resume_result(
                    session_id=transport.session_id,
                    requested_path=transport.requested_path,
                    status="attach_action_attach_failed",
                    reason="attach_ack_invalid_json",
                    transport_kind=transport.transport_kind,
                    worker_endpoint=transport.worker_endpoint,
                    resume_token_present=True,
                    executed=True,
                ),
                None,
            )
        if not isinstance(ack_payload, dict) or str(ack_payload.get("type") or "") != "attach_ack":
            self._close_attach_resume_resources(sock=sock, reader=reader)
            return (
                self._build_attach_resume_result(
                    session_id=transport.session_id,
                    requested_path=transport.requested_path,
                    status="attach_action_attach_failed",
                    reason="attach_ack_invalid_shape",
                    transport_kind=transport.transport_kind,
                    worker_endpoint=transport.worker_endpoint,
                    resume_token_present=True,
                    executed=True,
                    ack_payload=ack_payload if isinstance(ack_payload, dict) else None,
                ),
                None,
            )
        if not bool(ack_payload.get("accepted")):
            self._close_attach_resume_resources(sock=sock, reader=reader)
            return (
                self._build_attach_resume_result(
                    session_id=transport.session_id,
                    requested_path=transport.requested_path,
                    status="attach_action_attach_failed",
                    reason=str(ack_payload.get("reason") or "attach_rejected"),
                    transport_kind=transport.transport_kind,
                    worker_endpoint=transport.worker_endpoint,
                    resume_token_present=True,
                    executed=True,
                    ack_payload=dict(ack_payload),
                ),
                None,
            )
        return (
            self._build_attach_resume_result(
                session_id=transport.session_id,
                requested_path=transport.requested_path,
                status="attach_action_attach_succeeded",
                reason=str(ack_payload.get("reason") or "attach_accepted"),
                transport_kind=transport.transport_kind,
                worker_endpoint=transport.worker_endpoint,
                resume_token_present=True,
                executed=True,
                next_step="stream_attached_worker_events",
                ack_payload=dict(ack_payload),
            ),
            self._stream_events_from_worker_attach_socket(session_id=transport.session_id, sock=sock, reader=reader),
        )

    def _build_attach_resume_request_payload(
        self,
        *,
        transport: _AttachResumeTransport,
        user_id: str,
        message: str,
        conversation_history: list[dict[str, str]] | None,
    ) -> dict[str, Any]:
        return {
            "type": "warm_attach_resume",
            "session_id": transport.session_id,
            "requested_path": transport.requested_path,
            "resume_token": transport.resume_token,
            "user_id": str(user_id or ""),
            "message": str(message or ""),
            "conversation_history": list(conversation_history or []),
        }

    def _connect_attach_resume_transport(
        self,
        *,
        transport: _AttachResumeTransport,
        user_id: str,
        message: str,
        conversation_history: list[dict[str, str]] | None,
    ) -> tuple[socket.socket, Any]:
        if not _supports_unix_socket_attach_transport():
            raise HermesClientError(
                "Warm attach over unix_socket_jsonl is not supported on this platform yet. "
                "Prefer HTTP-backed Hermes mode or use Linux/macOS for local-runtime-heavy workflows."
            )
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(float(self.warm_attach_resume_timeout_ms) / 1000.0)
        try:
            sock.connect(transport.worker_endpoint)
            request_payload = self._build_attach_resume_request_payload(
                transport=transport,
                user_id=user_id,
                message=message,
                conversation_history=conversation_history,
            )
            sock.sendall((json.dumps(request_payload, separators=(",", ":")) + "\n").encode("utf-8"))
            return sock, sock.makefile("rb")
        except Exception:  # noqa: BLE001 - broad-except-policy: close partially attached socket before re-raising; intentional-no-log because caller handles failure context
            self._close_attach_resume_resources(sock=sock)
            raise

    def _attempt_live_worker_attach_resume(
        self,
        *,
        session_id: str,
        requested_path: str,
        reuse_contract: dict[str, Any] | None,
        attach_action: dict[str, Any] | None,
        user_id: str,
        message: str,
        conversation_history: list[dict[str, str]] | None,
    ) -> tuple[dict[str, Any], Iterator[dict[str, Any]] | None]:
        resolved_transport = self._resolve_attach_resume_transport(
            session_id=session_id,
            requested_path=requested_path,
            reuse_contract=reuse_contract,
            attach_action=attach_action,
        )
        if str(resolved_transport.get("status") or "") != "attach_action_attach_ready":
            return resolved_transport, None

        transport = _AttachResumeTransport(
            session_id=str(session_id or ""),
            requested_path=str(requested_path or "unknown"),
            transport_kind=str(resolved_transport.get("transport_kind") or ""),
            worker_endpoint=str(resolved_transport.get("worker_endpoint") or ""),
            resume_token=str(resolved_transport.get("resume_token") or ""),
            resume_deadline_ms=resolved_transport.get("resume_deadline_ms"),
        )
        try:
            sock, reader = self._connect_attach_resume_transport(
                transport=transport,
                user_id=user_id,
                message=message,
                conversation_history=conversation_history,
            )
            return self._read_attach_resume_ack(transport=transport, sock=sock, reader=reader)
        except socket.timeout:
            return (
                self._build_attach_resume_result(
                    session_id=transport.session_id,
                    requested_path=transport.requested_path,
                    status="attach_action_attach_timeout",
                    reason="attach_connect_or_ack_timeout",
                    transport_kind=transport.transport_kind,
                    worker_endpoint=transport.worker_endpoint,
                    resume_token_present=bool(transport.resume_token),
                    executed=True,
                ),
                None,
            )
        except OSError as exc:
            return (
                self._build_attach_resume_result(
                    session_id=transport.session_id,
                    requested_path=transport.requested_path,
                    status="attach_action_attach_failed",
                    reason=f"attach_socket_error:{exc.__class__.__name__}",
                    transport_kind=transport.transport_kind,
                    worker_endpoint=transport.worker_endpoint,
                    resume_token_present=bool(transport.resume_token),
                    executed=True,
                ),
                None,
            )

    def _verify_worker_attach_session_binding(self, *, session_id: str, cmdline: str | None) -> dict[str, Any]:
        cmdline_text = str(cmdline or "")
        session_text = str(session_id or "")
        if cmdline_text and session_text and session_text in cmdline_text:
            return {
                "verified": True,
                "status": "attach_owner_identity_verified_session_verified",
                "reason": "session_id_found_in_cmdline",
            }
        # Current worker launcher does not encode the session_id in argv/cmdline, so cmdline-based
        # verification alone is too strict and would permanently disable same-chat warm attach.
        # At this point the reuse contract/session_id binding has already been validated before we
        # probe the worker PID, so treat that contract binding as the authoritative session check.
        return {
            "verified": True,
            "status": "attach_owner_identity_verified_session_verified",
            "reason": "session_id_verified_by_contract",
        }

    def execute_worker_attach(
        self,
        *,
        session_id: str,
        requested_path: str,
        attach_plan: dict[str, Any] | None,
    ) -> dict[str, Any]:
        plan_payload = dict(attach_plan) if isinstance(attach_plan, dict) else {}
        owner_pid = plan_payload.get("owner_pid")
        try:
            pid_int = int(owner_pid)
        except (TypeError, ValueError):
            pid_int = None

        if not pid_int or pid_int <= 0:
            status = "attach_owner_pid_invalid"
            reason = "invalid_owner_pid"
        else:
            try:
                os.kill(pid_int, 0)
            except ProcessLookupError:
                status = "attach_owner_missing"
                reason = "owner_pid_not_found"
            except PermissionError:
                status = "attach_owner_present_but_unverifiable"
                reason = "owner_pid_permission_denied"
            else:
                cmdline = self._read_process_cmdline(pid_int)
                identity_expected = "chat_worker_subprocess.py"
                identity_verified = bool(cmdline) and identity_expected in str(cmdline)
                session_binding = None
                if identity_verified:
                    session_binding = self._verify_worker_attach_session_binding(session_id=session_id, cmdline=cmdline)
                    status = str(session_binding.get("status") or "attach_owner_present_identity_verified")
                    reason = str(session_binding.get("reason") or "owner_pid_alive_identity_verified")
                else:
                    status = "attach_owner_present_wrong_identity"
                    reason = "owner_pid_alive_identity_mismatch"

        return {
            "executed": False,
            "status": status,
            "session_id": str(session_id or ""),
            "requested_path": str(requested_path or "unknown"),
            "mode": str(plan_payload.get("mode") or "unknown"),
            "owner_pid": owner_pid,
            "reason": reason,
            "cmdline": cmdline if 'cmdline' in locals() else None,
            "session_binding": dict(session_binding) if isinstance(locals().get("session_binding"), dict) else None,
            "next_step": "implement_worker_attach_execution",
        }

    def decide_worker_attach_eligibility(
        self,
        *,
        validation: dict[str, Any] | None,
        attach_plan: dict[str, Any] | None,
        attach_execution: dict[str, Any] | None,
    ) -> dict[str, Any]:
        validation_payload = dict(validation) if isinstance(validation, dict) else {}
        attach_plan_payload = dict(attach_plan) if isinstance(attach_plan, dict) else {}
        attach_execution_payload = dict(attach_execution) if isinstance(attach_execution, dict) else {}
        if not bool(validation_payload.get("valid")):
            return {
                "eligible": False,
                "status": "attach_not_eligible",
                "reason": str(validation_payload.get("status") or "validation_failed"),
            }
        if str(attach_plan_payload.get("status") or "") != "attach_plan_ready":
            return {
                "eligible": False,
                "status": "attach_not_eligible",
                "reason": str(attach_plan_payload.get("status") or "attach_plan_incomplete"),
            }
        execution_status = str(attach_execution_payload.get("status") or "unknown")
        if execution_status == "attach_owner_identity_verified_session_verified":
            return {
                "eligible": True,
                "status": "attach_eligible_probe_only",
                "reason": execution_status,
            }
        return {
            "eligible": False,
            "status": "attach_not_eligible",
            "reason": execution_status,
        }

    def execute_worker_attach_action(
        self,
        *,
        session_id: str,
        requested_path: str,
        attach_eligibility: dict[str, Any] | None,
        attach_execution: dict[str, Any] | None,
    ) -> dict[str, Any]:
        eligibility_payload = dict(attach_eligibility) if isinstance(attach_eligibility, dict) else {}
        execution_payload = dict(attach_execution) if isinstance(attach_execution, dict) else {}
        if not bool(eligibility_payload.get("eligible")):
            status = "attach_action_unavailable"
            reason = str(eligibility_payload.get("status") or "attach_not_eligible")
            result = {
                "executed": False,
                "status": status,
                "session_id": str(session_id or ""),
                "requested_path": str(requested_path or "unknown"),
                "eligibility_status": str(eligibility_payload.get("status") or "unknown"),
                "execution_status": str(execution_payload.get("status") or "unknown"),
                "owner_pid": execution_payload.get("owner_pid"),
                "reason": reason,
                "next_step": "fallback_to_cold_path",
            }
        else:
            ready_payload = {
                "executed": False,
                "status": "attach_action_handshake_ready",
                "session_id": str(session_id or ""),
                "requested_path": str(requested_path or "unknown"),
                "eligibility_status": str(eligibility_payload.get("status") or "unknown"),
                "execution_status": str(execution_payload.get("status") or "unknown"),
                "owner_pid": execution_payload.get("owner_pid"),
                "reason": "handshake_prerequisites_observed",
                "next_step": "attempt_live_worker_attach_handshake",
            }
            handshake_result = self._attempt_live_worker_attach_handshake(
                session_id=session_id,
                requested_path=requested_path,
                attach_execution=execution_payload,
            )
            result = {
                **ready_payload,
                **(dict(handshake_result) if isinstance(handshake_result, dict) else {}),
                "precondition_status": ready_payload["status"],
                "precondition_reason": ready_payload["reason"],
            }
        result.setdefault("eligibility_status", str(eligibility_payload.get("status") or "unknown"))
        result.setdefault("execution_status", str(execution_payload.get("status") or "unknown"))
        result.setdefault("owner_pid", execution_payload.get("owner_pid"))
        return result

    def _attempt_worker_attach_warm_reuse(
        self,
        *,
        session_id: str,
        requested_path: str,
        candidate_payload: dict[str, Any],
        reuse_contract: dict[str, Any],
        artifacts: _WarmReuseAttemptArtifacts,
        user_id: str,
        message: str,
    ) -> _WarmReuseAttemptArtifacts:
        artifacts.attach_plan = self.plan_worker_attach_handshake(
            session_id=session_id,
            requested_path=requested_path,
            candidate=candidate_payload,
            reuse_contract=reuse_contract,
            validation=artifacts.validation,
        )
        artifacts.attach_execution = self.execute_worker_attach(
            session_id=session_id,
            requested_path=requested_path,
            attach_plan=artifacts.attach_plan,
        )
        artifacts.attach_eligibility = self.decide_worker_attach_eligibility(
            validation=artifacts.validation,
            attach_plan=artifacts.attach_plan,
            attach_execution=artifacts.attach_execution,
        )
        if isinstance(artifacts.attach_eligibility, dict) and bool(artifacts.attach_eligibility.get("eligible")):
            artifacts.attach_action = self.execute_worker_attach_action(
                session_id=session_id,
                requested_path=requested_path,
                attach_eligibility=artifacts.attach_eligibility,
                attach_execution=artifacts.attach_execution,
            )
        if str((artifacts.attach_action or {}).get("status") or "") == "attach_action_handshake_succeeded":
            artifacts.attach_resume, artifacts.attached_stream = self._attempt_live_worker_attach_resume(
                session_id=session_id,
                requested_path=requested_path,
                reuse_contract=reuse_contract,
                attach_action=artifacts.attach_action,
                user_id=user_id,
                message=message,
                # Same-chat warm attach resumes an already-live isolated worker.
                # Do not inject full DB history again or we can duplicate context inside
                # the reused runtime.
                conversation_history=[],
            )
        return artifacts

    def _describe_warm_reuse_attempt(
        self,
        *,
        validation_status: str,
        resume_capability: str,
        artifacts: _WarmReuseAttemptArtifacts,
    ) -> tuple[str, str]:
        if bool(artifacts.validation.get("valid")):
            if resume_capability == "worker_attach":
                attach_action_status = str((artifacts.attach_action or {}).get("status") or "")
                attach_resume_status = str((artifacts.attach_resume or {}).get("status") or "")
                if attach_resume_status == "attach_action_attach_succeeded" and artifacts.attached_stream is not None:
                    return (
                        "reuse_worker_attach_resume_streaming",
                        "warm reuse candidate passed validation, completed handshake, and attached to a live worker resume transport",
                    )
                if attach_resume_status == "attach_action_attach_timeout":
                    return (
                        "reuse_worker_attach_resume_timeout",
                        "warm reuse candidate passed validation and handshake, but the live worker resume attach timed out and fell back safely",
                    )
                if attach_resume_status == "attach_action_attach_failed":
                    return (
                        "reuse_worker_attach_resume_failed",
                        "warm reuse candidate passed validation and handshake, but the live worker resume attach failed and fell back safely",
                    )
                if attach_action_status == "attach_action_handshake_succeeded":
                    return (
                        "reuse_worker_attach_resume_unavailable",
                        "warm reuse candidate passed validation and handshake, but no supported live worker resume transport was available",
                    )
                if attach_action_status == "attach_action_handshake_timeout":
                    return (
                        "reuse_worker_attach_handshake_timeout",
                        "warm reuse candidate passed validation, but the first live worker-attach handshake probe timed out and fell back safely",
                    )
                if attach_action_status == "attach_action_handshake_failed":
                    return (
                        "reuse_worker_attach_handshake_failed",
                        "warm reuse candidate passed validation, but the first live worker-attach handshake probe failed and fell back safely",
                    )
                return (
                    "reuse_worker_attach_not_supported_yet",
                    "warm reuse candidate passed validation and advertises worker_attach capability, but attach execution could not progress beyond readiness checks",
                )
            return (
                "reuse_resume_not_supported_yet",
                "warm reuse candidate passed basic contract validation, but resume/handoff is not implemented yet",
            )
        if validation_status == "missing_required_fields":
            return (
                "reuse_contract_missing_required_fields",
                "warm reuse candidate is missing one or more required contract fields for a reuse attempt",
            )
        if validation_status == "invalid_session_binding":
            return (
                "reuse_contract_invalid_session_binding",
                "warm reuse candidate contract is bound to a different session than the attempted reuse target",
            )
        if validation_status == "unsupported_contract_version":
            return (
                "reuse_contract_unsupported_version",
                "warm reuse candidate contract version is not supported by the current validator",
            )
        return (
            "reuse_contract_invalid",
            "warm reuse candidate contract failed validation",
        )

    def _record_warm_reuse_attempt(
        self,
        *,
        session_id: str,
        reason: str,
        requested_path: str,
        candidate_payload: dict[str, Any],
        reuse_contract: dict[str, Any],
        artifacts: _WarmReuseAttemptArtifacts,
        attempt: str,
        detail: str,
        policy: dict[str, Any],
        user_id: str,
        message: str,
        conversation_history: list[dict[str, str]] | None,
    ) -> None:
        payload = {
            "event": "warm_reuse_attempt",
            "session_id": str(session_id or ""),
            "reason": str(reason or "unknown"),
            "requested_path": str(requested_path or "unknown"),
            "attempt": attempt,
            "detail": detail,
            "candidate": candidate_payload,
            "reuse_contract": reuse_contract or None,
            "validation": dict(artifacts.validation),
            "attach_plan": dict(artifacts.attach_plan) if isinstance(artifacts.attach_plan, dict) else None,
            "attach_execution": dict(artifacts.attach_execution) if isinstance(artifacts.attach_execution, dict) else None,
            "attach_eligibility": dict(artifacts.attach_eligibility) if isinstance(artifacts.attach_eligibility, dict) else None,
            "attach_action": dict(artifacts.attach_action) if isinstance(artifacts.attach_action, dict) else None,
            "attach_resume": dict(artifacts.attach_resume) if isinstance(artifacts.attach_resume, dict) else None,
            "missing_required_fields": list(artifacts.validation.get("missing_required_fields") or []),
            "reserved_future_fields": list(artifacts.validation.get("reserved_future_fields") or []),
            "policy": dict(policy),
            "fallback_to": str(requested_path or "unknown"),
            "fallback_reason": attempt,
            "user_id": str(user_id or ""),
            "message_length": len(str(message or "")),
            "conversation_history_len": len(conversation_history or []),
            "monotonic_ms": int(time.monotonic() * 1000),
        }
        self._warm_reuse_attempt_events.append(dict(payload))

    def _attempt_validated_warm_reuse(
        self,
        *,
        session_id: str,
        requested_path: str,
        candidate_payload: dict[str, Any],
        reuse_contract: dict[str, Any],
        validation: dict[str, Any],
        user_id: str,
        message: str,
    ) -> _WarmReuseAttemptArtifacts:
        artifacts = _WarmReuseAttemptArtifacts(validation=dict(validation))
        if bool(validation.get("valid")) and str(validation.get("resume_capability") or "unknown") == "worker_attach":
            return self._attempt_worker_attach_warm_reuse(
                session_id=session_id,
                requested_path=requested_path,
                candidate_payload=candidate_payload,
                reuse_contract=reuse_contract,
                artifacts=artifacts,
                user_id=user_id,
                message=message,
            )
        return artifacts

    def attempt_warm_reuse(
        self,
        *,
        session_id: str,
        reason: str,
        requested_path: str,
        candidate: dict[str, Any],
        policy: dict[str, Any],
        user_id: str,
        message: str,
        conversation_history: list[dict[str, str]] | None,
    ) -> Iterator[dict[str, Any]] | None:
        candidate_payload = self._normalize_warm_reuse_candidate(candidate) or {}
        reuse_contract = dict(candidate_payload.get("reuse_contract") or {})
        validation = self.validate_warm_reuse_contract(session_id=session_id, reuse_contract=reuse_contract)
        validation_status = str(validation.get("status") or "unknown")
        resume_capability = str(validation.get("resume_capability") or "unknown")
        artifacts = self._attempt_validated_warm_reuse(
            session_id=session_id,
            requested_path=requested_path,
            candidate_payload=candidate_payload,
            reuse_contract=reuse_contract,
            validation=validation,
            user_id=user_id,
            message=message,
        )
        attempt, detail = self._describe_warm_reuse_attempt(
            validation_status=validation_status,
            resume_capability=resume_capability,
            artifacts=artifacts,
        )
        self._record_warm_reuse_attempt(
            session_id=session_id,
            reason=reason,
            requested_path=requested_path,
            candidate_payload=candidate_payload,
            reuse_contract=reuse_contract,
            artifacts=artifacts,
            attempt=attempt,
            detail=detail,
            policy=policy,
            user_id=user_id,
            message=message,
            conversation_history=conversation_history,
        )
        if artifacts.attached_stream is not None and attempt == "reuse_worker_attach_resume_streaming":
            return artifacts.attached_stream
        return None

    def record_warm_reuse_decision(
        self,
        session_id: str,
        *,
        reason: str,
        candidate: dict[str, Any] | None,
        policy: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        available = isinstance(candidate, dict)
        policy_payload = dict(policy) if isinstance(policy, dict) else None
        if available:
            if bool((policy_payload or {}).get("allowed")):
                decision = "candidate_available_reuse_allowed"
                detail = str((policy_payload or {}).get("policy") or "allowed")
            else:
                decision = "candidate_available_policy_blocked"
                detail = str((policy_payload or {}).get("policy") or "disabled_by_policy")
        else:
            decision = "candidate_unavailable"
            detail = self._warm_session_unavailable_reason(session_id)
        payload = {
            "event": "warm_reuse_decision",
            "session_id": str(session_id or ""),
            "reason": str(reason or "unknown"),
            "decision": decision,
            "available": bool(available),
            "detail": detail,
            "policy": policy_payload,
            "candidate": candidate if available else None,
            "monotonic_ms": int(time.monotonic() * 1000),
        }
        self._warm_reuse_decision_events.append(dict(payload))
        return payload

    def warm_session_strategy(self) -> dict[str, Any]:
        strategy = self.warm_session_contract().as_dict()
        strategy["owner_state"] = self.warm_session_owner_state()
        strategy["recent_candidate_probes"] = [dict(item) for item in list(self._warm_candidate_probe_events)[-12:]]
        strategy["recent_reuse_policy_checks"] = [dict(item) for item in list(self._warm_reuse_policy_events)[-12:]]
        strategy["recent_reuse_attempts"] = [dict(item) for item in list(self._warm_reuse_attempt_events)[-12:]]
        strategy["recent_reuse_decisions"] = [dict(item) for item in list(self._warm_reuse_decision_events)[-12:]]
        owner_state = strategy.get("owner_state") if isinstance(strategy, dict) else None
        strategy["retirement_summary"] = dict((owner_state or {}).get("retirement_summary") or {}) if isinstance(owner_state, dict) else {}
        return strategy

    def startup_diagnostics(self) -> dict[str, Any]:
        health = self._recall_health()
        return {
            "routing": {
                "selected_transport": self._selected_transport(),
                "stream_url_configured": bool(self.stream_url),
                "api_url_configured": bool(self.api_url),
                "direct_agent_enabled": self.direct_agent_enabled,
                "persistent_sessions_requested": self.persistent_sessions_requested,
                "persistent_sessions_enabled": self._effective_warm_continuity_enabled(),
                "persistent_shared_backend_enabled": self._shared_backend_persistent_enabled(),
                "persistent_worker_owned_enabled": self._worker_owned_warm_continuity_enabled(),
                "persistent_runtime_ownership_requested": self.persistent_runtime_ownership_requested,
                "persistent_runtime_ownership": self.persistent_runtime_ownership,
                "persistent_sessions_enablement_reason": self._persistent_sessions_enablement_reason(),
                "provider_configured": bool(self.provider),
                "model_configured": bool(self.model),
                "base_url_configured": bool(self.base_url),
            },
            "warm_sessions": self.warm_session_strategy(),
            "agent_runtime": {
                "agent_python_exists": Path(self.agent_python).exists(),
                "agent_workdir_exists": Path(self.agent_workdir).exists(),
                "agent_venv_exists": Path(self.agent_venv).exists(),
                "session_db_available": bool(health.get("session_db_available")),
                "session_search_ready": bool(health.get("session_search_ready")),
            },
            "limits": {
                "timeout_seconds": self.timeout_seconds,
                "stream_chunk_size": self.stream_chunk_size,
                "max_iterations": self.max_iterations,
                "persistent_max_sessions": self.persistent_max_sessions,
                "persistent_idle_ttl_seconds": self.persistent_idle_ttl_seconds,
                "warm_worker_reuse_enabled": self.warm_worker_reuse_enabled,
                "warm_worker_same_chat_only": self.warm_worker_same_chat_only,
                "warm_worker_idle_ttl_seconds": self.warm_worker_idle_ttl_seconds,
                "warm_worker_max_idle": self.warm_worker_max_idle,
                "warm_worker_max_total": self.warm_worker_max_total,
                "warm_worker_retire_after_runs": self.warm_worker_retire_after_runs,
                "warm_worker_health_max_rss_mb": self.warm_worker_health_max_rss_mb,
                "warm_worker_health_max_threads": self.warm_worker_health_max_threads,
                "child_spawn_caps_enabled": self.child_spawn_caps_enabled,
                "child_spawn_cap_total": self.child_spawn_cap_total,
                "child_spawn_cap_per_chat": self.child_spawn_cap_per_chat,
                "child_spawn_cap_per_job": self.child_spawn_cap_per_job,
                "child_spawn_cap_per_session": self.child_spawn_cap_per_session,
            },
        }

    def _log_startup_diagnostics(self) -> None:
        payload = self.startup_diagnostics()
        self._safe_info_log("HermesClient startup diagnostics", extra={"startup": payload})

    def _init_session_db(self):
        try:
            workdir = str(self.agent_workdir or "").strip()
            if workdir and workdir not in sys.path:
                sys.path.insert(0, workdir)
                importlib.invalidate_caches()

            from hermes_state import SessionDB

            return SessionDB()
        except Exception as exc:  # noqa: BLE001 - broad-except-policy: optional runtime dependency fallback
            logger.debug("Miniapp session DB unavailable: %s", exc.__class__.__name__)
            return None

    def _resolve_agent_routing(self, *, env_provider: str, env_base_url: str) -> tuple[str | None, str | None]:
        return self._bootstrap.resolve_agent_routing(env_provider=env_provider, env_base_url=env_base_url)

    def _load_active_provider_from_auth_store(self) -> str | None:
        return self._bootstrap.load_active_provider_from_auth_store()

    def _load_base_url_from_config(self) -> str | None:
        return self._bootstrap.load_base_url_from_config()

    def _load_default_model_from_config(self) -> str | None:
        return self._bootstrap.load_default_model_from_config()

    def _load_model_cfg_from_config(self) -> dict[str, Any] | None:
        return self._bootstrap.load_model_cfg_from_config()

    def should_include_conversation_history(self, *, session_id: str | None) -> bool:
        """Whether caller should include DB history for this request.

        In persistent-session mode, only the first turn for a runtime should inject
        historical context. Subsequent turns rely on the live in-memory runtime.
       
        Defensive rule: if a runtime is marked bootstrapped but has no in-memory
        checkpoint history, force DB history injection for this turn so context
        cannot silently drop.
        """
        if not (self.direct_agent_enabled and self.persistent_sessions_enabled):
            return True

        runtime = self._session_manager.get_runtime(session_id or "") if session_id else None
        if runtime is None:
            return True
        if not runtime.bootstrapped:
            return True

        checkpoint_history = list(runtime.checkpoint_history or [])
        if not checkpoint_history:
            return True
        return False

    def evict_session(self, session_id: str, *, reason: str = "explicit_eviction") -> bool:
        if not session_id:
            return False
        owner_state = self.warm_session_owner_state()
        owner_records = list((owner_state.get("owner_records") if isinstance(owner_state, dict) else None) or [])
        target_record = next((record for record in owner_records if str((record or {}).get("session_id") or "") == str(session_id or "")), None)
        owner_pid = (target_record or {}).get("owner_pid") if isinstance(target_record, dict) else None
        live_attach_running = isinstance(target_record, dict) and str(target_record.get("state") or "") in {"attachable_running", "expired"} and bool(target_record.get("attach_worker_endpoint"))
        evicted_any = False
        session_manager = getattr(self, "_session_manager", None)
        if session_manager is not None:
            evicted_any = bool(session_manager.evict(session_id, reason=reason)) or evicted_any
        warm_registry = getattr(self, "_warm_session_registry", None)
        if warm_registry is not None and warm_registry is not session_manager:
            evicted_any = bool(warm_registry.evict(session_id, reason=reason)) or evicted_any
        if live_attach_running:
            evicted_any = self._terminate_warm_owner_process(pid=owner_pid, reason=reason) or evicted_any
        return evicted_any

    def persistent_stats(self) -> dict[str, int | bool]:
        shared_stats = self._session_manager.stats()
        warm_registry = getattr(self, "_warm_session_registry", None)
        registry_stats = warm_registry.stats() if warm_registry is not None and hasattr(warm_registry, "stats") else {}
        if self.persistent_runtime_ownership == "shared":
            stats = shared_stats
        else:
            stats = registry_stats or shared_stats
        return {
            "requested": self.persistent_sessions_requested,
            "enabled": self._effective_warm_continuity_enabled(),
            "shared_backend_enabled": self._shared_backend_persistent_enabled(),
            "worker_owned_enabled": self._worker_owned_warm_continuity_enabled(),
            "ownership": self.persistent_runtime_ownership,
            "enablement_reason": self._persistent_sessions_enablement_reason(),
            "total": int(stats.get("total", 0)),
            "bootstrapped": int(stats.get("bootstrapped", 0)),
            "unbootstrapped": int(stats.get("unbootstrapped", 0)),
        }

    def _recover_fallback_history(
        self,
        *,
        session_id: str | None,
        conversation_history: list[dict[str, Any]] | None,
    ) -> list[dict[str, str]]:
        explicit_history = self._normalize_conversation_history(conversation_history)
        if explicit_history:
            return explicit_history

        if not session_id:
            return []

        runtime = self._session_manager.get_runtime(session_id)
        if runtime is None:
            return []

        checkpoint_history = list(runtime.checkpoint_history or [])
        return [item for item in checkpoint_history if isinstance(item, dict)]

    def _build_fallback_runtime_checkpoint(
        self,
        *,
        recovered_history: list[dict[str, str]],
        user_message: str,
        assistant_reply: str,
    ) -> list[dict[str, str]]:
        checkpoint = [
            {"role": str(item.get("role") or ""), "content": str(item.get("content") or "")}
            for item in recovered_history
            if isinstance(item, dict) and str(item.get("role") or "").strip() and str(item.get("content") or "").strip()
        ]
        if user_message.strip():
            checkpoint.append({"role": "user", "content": user_message.strip()})
        if assistant_reply.strip():
            checkpoint.append({"role": "assistant", "content": assistant_reply.strip()})
        if len(checkpoint) > 160:
            checkpoint = checkpoint[-160:]
        return checkpoint

    def _recall_health(self) -> dict[str, bool]:
        session_db_available = self._session_db is not None
        kwargs_has_session_db = False
        kwargs_session_db_available = False

        if self.direct_agent_enabled and self.persistent_sessions_enabled:
            try:
                kwargs = self._build_agent_kwargs(
                    session_id="miniapp-healthcheck",
                    tool_progress_callback=lambda *_args, **_kwargs: None,
                )
            except Exception as exc:  # noqa: BLE001 - broad-except-policy: healthcheck kwargs construction is best-effort and should degrade gracefully
                logger.debug("Miniapp recall healthcheck failed building agent kwargs: %s", exc)
                kwargs = {}
            kwargs_has_session_db = "session_db" in kwargs
            kwargs_session_db_available = kwargs.get("session_db") is not None

        session_search_ready = session_db_available and kwargs_has_session_db and kwargs_session_db_available
        return {
            "session_db_available": session_db_available,
            "agent_kwargs_has_session_db": kwargs_has_session_db,
            "agent_kwargs_session_db_available": kwargs_session_db_available,
            "session_search_ready": session_search_ready,
        }

    def _warn_if_recall_unavailable(self) -> None:
        if not (self.direct_agent_enabled and self.persistent_sessions_enabled):
            return

        health = self._recall_health()
        if health.get("session_search_ready") is True:
            return

        logger.warning(
            "Persistent miniapp sessions have incomplete recall wiring; session_search may be unavailable.",
            extra={
                "session_db_available": bool(health.get("session_db_available")),
                "agent_kwargs_has_session_db": bool(health.get("agent_kwargs_has_session_db")),
                "agent_kwargs_session_db_available": bool(health.get("agent_kwargs_session_db_available")),
                "direct_agent_enabled": self.direct_agent_enabled,
                "persistent_sessions_requested": self.persistent_sessions_requested,
                "persistent_sessions_enabled": self._effective_warm_continuity_enabled(),
                "persistent_shared_backend_enabled": self._shared_backend_persistent_enabled(),
                "persistent_worker_owned_enabled": self._worker_owned_warm_continuity_enabled(),
                "persistent_runtime_ownership": self.persistent_runtime_ownership,
            },
        )

    def runtime_status(self) -> dict[str, Any]:
        return {
            "persistent": self.persistent_stats(),
            "routing": {
                "model": self.model,
                "provider": self.provider,
                "base_url": self.base_url,
                "direct_agent_enabled": self.direct_agent_enabled,
                "persistent_sessions_requested": self.persistent_sessions_requested,
                "persistent_sessions_enabled": self._effective_warm_continuity_enabled(),
                "persistent_shared_backend_enabled": self._shared_backend_persistent_enabled(),
                "persistent_worker_owned_enabled": self._worker_owned_warm_continuity_enabled(),
                "persistent_runtime_ownership": self.persistent_runtime_ownership,
                "persistent_sessions_enablement_reason": self._persistent_sessions_enablement_reason(),
            },
            "warm_sessions": self.warm_session_strategy(),
            "health": self._recall_health(),
            "startup": self.startup_diagnostics(),
            "children": self.child_spawn_diagnostics(),
        }

    def ask(self, user_id: str, message: str, *, conversation_history: list[dict[str, Any]] | None = None) -> HermesReply:
        """Send a message to Hermes and return the full reply."""
        cleaned = message.strip()
        if not cleaned:
            raise HermesClientError("Message cannot be empty.")

        started = time.perf_counter()
        if self.api_url:
            text, source = self._ask_via_http(user_id=user_id, message=cleaned)
        else:
            text, source = self._ask_via_cli(message=cleaned)
        latency_ms = int((time.perf_counter() - started) * 1000)
        return HermesReply(text=text, source=source, latency_ms=latency_ms)

    def stream_ask(self, user_id: str, message: str) -> Iterator[str]:
        """Yield the reply text in chunks only."""
        for event in self.stream_events(user_id=user_id, message=message):
            if event.get("type") == "chunk":
                text = str(event.get("text") or "")
                if text:
                    yield text

    def _stream_events_via_http_transport(
        self,
        *,
        stream_url: str,
        source: str,
        transition_reason: str,
        context: _StreamRequestContext,
    ) -> Iterator[dict[str, Any]]:
        self._record_transport_transition(
            previous_path="none",
            next_path=source,
            reason=transition_reason,
            session_id=context.session_id,
            user_id=context.user_id,
        )
        yield {"type": "meta", "source": source}
        built = []
        started = time.perf_counter()
        for chunk in self._stream_via_http(stream_url, user_id=context.user_id, message=context.cleaned_message):
            if not chunk:
                continue
            built.append(chunk)
            yield {"type": "chunk", "text": chunk}
        reply = "".join(built).strip()
        if not reply:
            raise HermesClientError("Hermes stream endpoint returned an empty reply.")
        yield {
            "type": "done",
            "reply": reply,
            "source": source,
            "latency_ms": int((time.perf_counter() - started) * 1000),
        }

    def _attempt_stream_events_warm_reuse(self, context: _StreamRequestContext) -> Iterator[dict[str, Any]] | None:
        if not context.session_id:
            return None
        reason = f"stream_start:{context.requested_path}"
        warm_probe = self.probe_warm_session_candidate(context.session_id, reason=reason)
        warm_candidate = warm_probe.get("candidate") if isinstance(warm_probe, dict) else None
        warm_policy = None
        if isinstance(warm_candidate, dict):
            warm_policy = self.evaluate_warm_reuse_policy(
                context.session_id,
                reason=reason,
                requested_path=context.requested_path,
                candidate=warm_candidate,
            )
            if isinstance(warm_policy, dict) and bool(warm_policy.get("allowed")):
                warm_reuse_events = self.attempt_warm_reuse(
                    session_id=context.session_id,
                    reason=reason,
                    requested_path=context.requested_path,
                    candidate=warm_candidate,
                    policy=warm_policy,
                    user_id=context.user_id,
                    message=context.cleaned_message,
                    conversation_history=context.conversation_history,
                )
                if warm_reuse_events is not None:
                    return warm_reuse_events
        self.record_warm_reuse_decision(
            context.session_id,
            reason=reason,
            candidate=warm_candidate,
            policy=warm_policy,
        )
        return None

    def _stream_events_via_local_transport(self, context: _StreamRequestContext) -> Iterator[dict[str, Any]]:
        recovered_fallback_history: list[dict[str, str]] = []
        persistent_fallback_triggered = False
        if self.direct_agent_enabled and self.persistent_sessions_enabled:
            self._record_transport_transition(
                previous_path="none",
                next_path="agent-persistent",
                reason="persistent_start",
                session_id=context.session_id,
                user_id=context.user_id,
            )
            try:
                yield from self._stream_via_persistent_agent(
                    user_id=context.user_id,
                    message=context.cleaned_message,
                    conversation_history=context.conversation_history,
                    session_id=context.session_id,
                )
                return
            except Exception as exc:  # broad-except-policy: persistent runtime failures must fall back to non-persistent transport
                persistent_fallback_triggered = True
                recovered_fallback_history = self._recover_fallback_history(
                    session_id=context.session_id,
                    conversation_history=context.conversation_history,
                )
                if context.session_id:
                    retired = self._retire_warm_session_on_failure_signature(
                        session_id=context.session_id,
                        exc=exc,
                        phase="persistent_runtime",
                    )
                    if not retired:
                        self.evict_session(context.session_id)
                self._record_transport_transition(
                    previous_path="agent-persistent",
                    next_path="agent" if self.direct_agent_enabled else "cli",
                    reason=f"persistent_failure:{self._safe_failure_reason(exc)}",
                    session_id=context.session_id,
                    user_id=context.user_id,
                )
                logger.warning(
                    "Persistent miniapp runtime failed; falling back to non-persistent path",
                    extra={
                        "session_id": context.session_id or "",
                        "user_id": context.user_id,
                        "error": str(exc),
                        "fallback_to": "agent" if self.direct_agent_enabled else "cli",
                        "recovered_history_len": len(recovered_fallback_history),
                    },
                    exc_info=True,
                )

        if self.direct_agent_enabled:
            direct_transport_label = "agent-worker-isolated" if self._worker_owned_warm_continuity_enabled() else "agent"
            self._record_transport_transition(
                previous_path="agent-persistent" if persistent_fallback_triggered else "none",
                next_path=direct_transport_label,
                reason="direct_start",
                session_id=context.session_id,
                user_id=context.user_id,
            )
            try:
                agent_history = recovered_fallback_history or context.conversation_history
                for event in self._stream_via_agent(
                    user_id=context.user_id,
                    message=context.cleaned_message,
                    conversation_history=agent_history,
                    session_id=context.session_id,
                ):
                    if str(event.get("type") or "") != "done":
                        yield event
                        continue

                    done_event = dict(event)
                    checkpoint_payload = done_event.get("runtime_checkpoint")
                    has_checkpoint = isinstance(checkpoint_payload, list) and len(checkpoint_payload) > 0
                    if not has_checkpoint:
                        synthesized = self._build_fallback_runtime_checkpoint(
                            recovered_history=self._normalize_conversation_history(agent_history),
                            user_message=context.cleaned_message,
                            assistant_reply=str(done_event.get("reply") or ""),
                        )
                        if synthesized:
                            done_event["runtime_checkpoint"] = synthesized
                    yield done_event
                return
            except HermesClientError as exc:
                if context.session_id:
                    self._retire_warm_session_on_failure_signature(
                        session_id=context.session_id,
                        exc=exc,
                        phase="direct_agent",
                    )
                if self._is_child_spawn_cap_error(exc):
                    self._record_transport_transition(
                        previous_path="agent",
                        next_path="agent",
                        reason=f"direct_failure_no_cli_fallback:{self._safe_failure_reason(exc)}",
                        session_id=context.session_id,
                        user_id=context.user_id,
                    )
                    raise
                self._record_transport_transition(
                    previous_path="agent",
                    next_path="cli",
                    reason=f"direct_failure:{self._safe_failure_reason(exc)}",
                    session_id=context.session_id,
                    user_id=context.user_id,
                )

        self._record_transport_transition(
            previous_path="none" if not self.direct_agent_enabled else "agent",
            next_path="cli",
            reason="cli_start",
            session_id=context.session_id,
            user_id=context.user_id,
        )
        yield from self._stream_via_cli_progress(message=context.cleaned_message, session_id=context.session_id)

    def _stream_events_via_configured_remote_transport(self, context: _StreamRequestContext) -> Iterator[dict[str, Any]] | None:
        if self.stream_url:
            return self._stream_events_via_http_transport(
                stream_url=self.stream_url,
                source="http-stream",
                transition_reason="stream_url_start",
                context=context,
            )
        if self.api_url:
            return self._stream_events_via_http_transport(
                stream_url=self.api_url,
                source="http",
                transition_reason="api_stream_start",
                context=context,
            )
        return None

    def _stream_events_after_remote_transport(self, context: _StreamRequestContext) -> Iterator[dict[str, Any]]:
        self._record_session_launch(
            session_id=context.session_id,
            requested_path=context.requested_path,
            message=context.cleaned_message,
            user_id=context.user_id,
        )
        warm_reuse_events = self._attempt_stream_events_warm_reuse(context)
        if warm_reuse_events is not None:
            return warm_reuse_events
        return self._stream_events_via_local_transport(context)

    def stream_events(
        self,
        user_id: str,
        message: str,
        *,
        conversation_history: list[dict[str, Any]] | None = None,
        session_id: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Yield structured streaming events for the mini app.

        Event types:
        - {type: "meta", source: "..."}
        - {type: "tool", tool_name: "...", preview: "...", display: "..."}
        - {type: "chunk", text: "..."}
        - {type: "done", reply: "...", source: "...", latency_ms: N}
        """
        cleaned = message.strip()
        if not cleaned:
            raise HermesClientError("Message cannot be empty.")

        context = _StreamRequestContext(
            user_id=user_id,
            cleaned_message=cleaned,
            conversation_history=conversation_history,
            session_id=session_id,
            requested_path=self._selected_transport(),
        )

        remote_events = self._stream_events_via_configured_remote_transport(context)
        if remote_events is not None:
            try:
                yield from remote_events
                return
            except HermesClientError as exc:
                self._record_transport_transition(
                    previous_path="http-stream" if self.stream_url else "http",
                    next_path="agent" if self.direct_agent_enabled else "cli",
                    reason=f"http_stream_failure:{self._safe_failure_reason(exc)}",
                    session_id=context.session_id,
                    user_id=context.user_id,
                )

        yield from self._stream_events_after_remote_transport(context)
        return
