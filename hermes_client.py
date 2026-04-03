from __future__ import annotations

import importlib
import logging
import os
import signal
import sys
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Iterator

from hermes_client_agent import HermesClientAgentMixin
from hermes_client_bootstrap import HermesClientBootstrap
from hermes_client_cli import HermesClientCLIMixin
from hermes_client_http import HermesClientHTTPMixin
from hermes_client_types import HermesClientError, HermesReply, PersistentSessionManager


logger = logging.getLogger(__name__)


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
        self.agent_python = os.environ.get("MINI_APP_AGENT_PYTHON") or "/home/hermes-agent/.hermes/hermes-agent/venv/bin/python"
        self.agent_home = os.environ.get("MINI_APP_AGENT_HOME") or "/home/hermes-agent"
        self.agent_hermes_home = os.environ.get("MINI_APP_AGENT_HERMES_HOME") or f"{self.agent_home}/.hermes"
        self.agent_workdir = os.environ.get("MINI_APP_AGENT_WORKDIR") or f"{self.agent_hermes_home}/hermes-agent"
        self.agent_venv = os.environ.get("MINI_APP_AGENT_VENV") or f"{self.agent_workdir}/venv"
        self._session_db = self._init_session_db()
        self._bootstrap = HermesClientBootstrap(agent_hermes_home=self.agent_hermes_home, logger=logger)
        self.model = env_model if env_model and env_model.lower() != "auto" else self._load_default_model_from_config()
        self.provider, self.base_url = self._resolve_agent_routing(env_provider=env_provider, env_base_url=env_base_url)
        self.persistent_sessions_requested = os.environ.get("MINI_APP_PERSISTENT_SESSIONS", "0") == "1"
        self.persistent_runtime_ownership = self._resolve_persistent_runtime_ownership()
        self.persistent_sessions_enabled = self.persistent_sessions_requested and self.persistent_runtime_ownership == "shared"
        self.persistent_max_sessions = int(os.environ.get("MINI_APP_PERSISTENT_MAX_SESSIONS", "64"))
        self.persistent_idle_ttl_seconds = int(os.environ.get("MINI_APP_PERSISTENT_IDLE_TTL_SECONDS", "1800"))
        self.child_spawn_caps_enabled = os.environ.get("MINI_APP_CHILD_SPAWN_CAPS_ENABLED", "1") == "1"
        self.child_spawn_cap_total = max(1, int(os.environ.get("MINI_APP_CHILD_SPAWN_CAP_TOTAL", "16")))
        self.child_spawn_cap_per_chat = max(1, int(os.environ.get("MINI_APP_CHILD_SPAWN_CAP_PER_CHAT", "4")))
        self.child_spawn_cap_per_job = max(1, int(os.environ.get("MINI_APP_CHILD_SPAWN_CAP_PER_JOB", "1")))
        self.child_spawn_cap_per_session = max(1, int(os.environ.get("MINI_APP_CHILD_SPAWN_CAP_PER_SESSION", "2")))
        self._session_manager = PersistentSessionManager(
            max_sessions=self.persistent_max_sessions,
            idle_ttl_seconds=self.persistent_idle_ttl_seconds,
        )
        self._spawn_trace_local = threading.local()
        self._spawn_tracker_lock = threading.Lock()
        self._active_child_spawns: dict[int, dict[str, Any]] = {}
        self._child_spawn_high_water_total = 0
        self._child_spawn_high_water_by_job: dict[str, int] = {}
        self._child_spawn_high_water_by_chat: dict[str, int] = {}
        self._child_spawn_events: deque[dict[str, Any]] = deque(maxlen=64)
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
        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort logger wrapper must never break caller
            pass

    def _safe_failure_reason(self, exc: Exception) -> str:
        return exc.__class__.__name__

    def _resolve_persistent_runtime_ownership(self) -> str:
        raw = str(os.environ.get("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", "shared") or "").strip().lower()
        launcher = str(os.environ.get("MINI_APP_JOB_WORKER_LAUNCHER", "inline") or "").strip().lower()

        if raw in {"shared", "checkpoint_only"}:
            return raw
        if raw == "auto":
            return "checkpoint_only" if launcher == "subprocess" else "shared"

        logger.warning(
            "Invalid MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP; defaulting to shared",
            extra={
                "raw": raw,
                "launcher": launcher,
            },
        )
        return "shared"

    @staticmethod
    def _is_child_spawn_cap_error(exc: Exception) -> bool:
        message = str(exc or "").strip().lower()
        if not message:
            return False
        return "child spawn cap reached" in message

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
            target_pids = [
                int(pid)
                for pid, record in self._active_child_spawns.items()
                if int(record.get("job_id") or 0) == safe_job_id
            ]

        killed = 0
        already_exited = 0
        failed = 0
        already_exited_pids: list[int] = []
        for pid in target_pids:
            try:
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

        summary = {
            "targeted": len(target_pids),
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

            high_water_total = int(self._child_spawn_high_water_total)
            high_water_by_job = dict(self._child_spawn_high_water_by_job)
            high_water_by_chat = dict(self._child_spawn_high_water_by_chat)
            timeout_total = int(self._child_spawn_timeout_total)
            timeout_by_job = dict(self._child_spawn_timeouts_by_job)
            timeout_by_chat = dict(self._child_spawn_timeouts_by_chat)
            timeout_by_transport = dict(self._child_spawn_timeouts_by_transport)
            timeout_by_outcome = dict(self._child_spawn_timeouts_by_outcome)
            recent_timeout_events = [dict(item) for item in list(self._child_spawn_timeout_events)[-16:]]
            recent_events = [dict(item) for item in list(self._child_spawn_events)[-12:]]
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
            "high_water_total": high_water_total,
            "high_water_by_job": high_water_by_job,
            "high_water_by_chat": high_water_by_chat,
            "timeouts": {
                "total": timeout_total,
                "by_job": timeout_by_job,
                "by_chat": timeout_by_chat,
                "by_transport": timeout_by_transport,
                "by_outcome": timeout_by_outcome,
                "recent_events": recent_timeout_events,
            },
            "recent_events": recent_events,
            "recent_transport_transitions": recent_transport_transitions,
        }

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
            "user_id": str(context.get("user_id") or ""),
            "chat_id": context.get("chat_id"),
            "job_id": context.get("job_id"),
            "session_id": session_value,
            "started_monotonic": time.monotonic(),
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
                    "active_total": int(active_total),
                    "active_for_job": int(active_for_job),
                    "active_for_chat": int(active_for_chat),
                    "active_for_session": int(active_for_session),
                    "monotonic_ms": int(time.monotonic() * 1000),
                }
            )

        command_preview = " ".join(record.get("command") or [])[:200]
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
        if record:
            payload.update(
                {
                    "spawn_id": record.get("spawn_id"),
                    "transport": record.get("transport"),
                    "command": record.get("command"),
                    "user_id": record.get("user_id"),
                    "chat_id": record.get("chat_id"),
                    "job_id": record.get("job_id"),
                    "session_id": record.get("session_id"),
                    "lifetime_ms": int((time.monotonic() - float(record.get("started_monotonic") or time.monotonic())) * 1000),
                }
            )

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

    def _selected_transport(self) -> str:
        if self.stream_url:
            return "http-stream"
        if self.api_url:
            return "http"
        if self.direct_agent_enabled and self.persistent_sessions_enabled:
            return "agent-persistent"
        if self.direct_agent_enabled:
            return "agent"
        return "cli"

    def startup_diagnostics(self) -> dict[str, Any]:
        health = self._recall_health()
        return {
            "routing": {
                "selected_transport": self._selected_transport(),
                "stream_url_configured": bool(self.stream_url),
                "api_url_configured": bool(self.api_url),
                "direct_agent_enabled": self.direct_agent_enabled,
                "persistent_sessions_requested": self.persistent_sessions_requested,
                "persistent_sessions_enabled": self.persistent_sessions_enabled,
                "persistent_runtime_ownership": self.persistent_runtime_ownership,
                "provider_configured": bool(self.provider),
                "model_configured": bool(self.model),
                "base_url_configured": bool(self.base_url),
            },
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

    def evict_session(self, session_id: str) -> bool:
        if not session_id:
            return False
        return self._session_manager.evict(session_id)

    def persistent_stats(self) -> dict[str, int | bool]:
        stats = self._session_manager.stats()
        return {
            "requested": self.persistent_sessions_requested,
            "enabled": self.persistent_sessions_enabled and self.direct_agent_enabled,
            "ownership": self.persistent_runtime_ownership,
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
                "persistent_sessions_enabled": self.persistent_sessions_enabled,
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
                "persistent_sessions_enabled": self.persistent_sessions_enabled,
                "persistent_runtime_ownership": self.persistent_runtime_ownership,
            },
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

        if self.stream_url:
            self._record_transport_transition(
                previous_path="none",
                next_path="http-stream",
                reason="stream_url_start",
                session_id=session_id,
                user_id=user_id,
            )
            yield {"type": "meta", "source": "http-stream"}
            built = []
            started = time.perf_counter()
            for chunk in self._stream_via_http(self.stream_url, user_id=user_id, message=cleaned):
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
                "source": "http-stream",
                "latency_ms": int((time.perf_counter() - started) * 1000),
            }
            return

        if self.api_url:
            self._record_transport_transition(
                previous_path="none",
                next_path="http",
                reason="api_stream_start",
                session_id=session_id,
                user_id=user_id,
            )
            try:
                yielded_any = False
                built = []
                started = time.perf_counter()
                yield {"type": "meta", "source": "http"}
                for chunk in self._stream_via_http(self.api_url, user_id=user_id, message=cleaned):
                    yielded_any = True
                    built.append(chunk)
                    yield {"type": "chunk", "text": chunk}
                if yielded_any:
                    reply = "".join(built).strip()
                    yield {
                        "type": "done",
                        "reply": reply,
                        "source": "http",
                        "latency_ms": int((time.perf_counter() - started) * 1000),
                    }
                    return
            except HermesClientError as exc:
                self._record_transport_transition(
                    previous_path="http",
                    next_path="agent" if self.direct_agent_enabled else "cli",
                    reason=f"http_stream_failure:{self._safe_failure_reason(exc)}",
                    session_id=session_id,
                    user_id=user_id,
                )

        recovered_fallback_history: list[dict[str, str]] = []
        persistent_fallback_triggered = False
        requested_path = "agent-persistent" if (self.direct_agent_enabled and self.persistent_sessions_enabled) else ("agent" if self.direct_agent_enabled else "cli")
        self._record_session_launch(session_id=session_id, requested_path=requested_path, message=cleaned, user_id=user_id)

        if self.direct_agent_enabled and self.persistent_sessions_enabled:
            self._record_transport_transition(
                previous_path="none",
                next_path="agent-persistent",
                reason="persistent_start",
                session_id=session_id,
                user_id=user_id,
            )
            try:
                yield from self._stream_via_persistent_agent(
                    user_id=user_id,
                    message=cleaned,
                    conversation_history=conversation_history,
                    session_id=session_id,
                )
                return
            except Exception as exc:  # broad-except-policy: persistent runtime failures must fall back to non-persistent transport
                persistent_fallback_triggered = True
                recovered_fallback_history = self._recover_fallback_history(
                    session_id=session_id,
                    conversation_history=conversation_history,
                )
                if session_id:
                    self.evict_session(session_id)
                self._record_transport_transition(
                    previous_path="agent-persistent",
                    next_path="agent" if self.direct_agent_enabled else "cli",
                    reason=f"persistent_failure:{self._safe_failure_reason(exc)}",
                    session_id=session_id,
                    user_id=user_id,
                )
                # Fall back to existing subprocess/CLI path when persistent runtime fails.
                logger.warning(
                    "Persistent miniapp runtime failed; falling back to non-persistent path",
                    extra={
                        "session_id": session_id or "",
                        "user_id": user_id,
                        "error": str(exc),
                        "fallback_to": "agent" if self.direct_agent_enabled else "cli",
                        "recovered_history_len": len(recovered_fallback_history),
                    },
                    exc_info=True,
                )

        if self.direct_agent_enabled:
            self._record_transport_transition(
                previous_path="agent-persistent" if persistent_fallback_triggered else "none",
                next_path="agent",
                reason="direct_start",
                session_id=session_id,
                user_id=user_id,
            )
            try:
                agent_history = recovered_fallback_history or conversation_history
                for event in self._stream_via_agent(
                    user_id=user_id,
                    message=cleaned,
                    conversation_history=agent_history,
                    session_id=session_id,
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
                            user_message=cleaned,
                            assistant_reply=str(done_event.get("reply") or ""),
                        )
                        if synthesized:
                            done_event["runtime_checkpoint"] = synthesized
                    yield done_event
                return
            except HermesClientError as exc:
                if self._is_child_spawn_cap_error(exc):
                    self._record_transport_transition(
                        previous_path="agent",
                        next_path="agent",
                        reason=f"direct_failure_no_cli_fallback:{self._safe_failure_reason(exc)}",
                        session_id=session_id,
                        user_id=user_id,
                    )
                    raise
                self._record_transport_transition(
                    previous_path="agent",
                    next_path="cli",
                    reason=f"direct_failure:{self._safe_failure_reason(exc)}",
                    session_id=session_id,
                    user_id=user_id,
                )

        self._record_transport_transition(
            previous_path="none" if not self.direct_agent_enabled else "agent",
            next_path="cli",
            reason="cli_start",
            session_id=session_id,
            user_id=user_id,
        )
        yield from self._stream_via_cli_progress(message=cleaned, session_id=session_id)
        return
