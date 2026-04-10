from __future__ import annotations

import os
import queue
import threading
import time
from collections import deque
from typing import Callable

from hermes_client import HermesClient, HermesClientError
from job_runtime_diagnostics import (
    build_runtime_diagnostics,
    rate_windows as helper_rate_windows,
    runtime_rate_windows as helper_runtime_rate_windows,
    severity_hint as helper_severity_hint,
    worker_isolation_boundary_signal as helper_worker_isolation_boundary_signal,
)
from job_runtime_runner_state import (
    finish_job_runner as helper_finish_job_runner,
    terminate_job_children as helper_terminate_job_children,
    try_start_job_runner as helper_try_start_job_runner,
)
from job_runtime_support import (
    best_effort_failure_counts as helper_best_effort_failure_counts,
    bounded_attempts_for_display as helper_bounded_attempts_for_display,
    clear_touch_tracking as helper_clear_touch_tracking,
    fd_metrics as helper_fd_metrics,
    is_stale_chat_job_error as helper_is_stale_chat_job_error,
    record_best_effort_failure as helper_record_best_effort_failure,
    record_runtime_counter as helper_record_runtime_counter,
    safe_add_system_message as helper_safe_add_system_message,
    touch_job_best_effort as helper_touch_job_best_effort,
)
from job_status import JOB_EVENT_TERMINAL
from job_runtime_events import JobEventBroker
from job_runtime_lifecycle import ensure_pending_jobs as lifecycle_ensure_pending_jobs
from job_runtime_lifecycle import shutdown_runtime, start_runtime_once, watchdog_loop as lifecycle_watchdog_loop, worker_loop as lifecycle_worker_loop
from job_runtime_loop import (
    process_available_jobs_once as loop_process_available_jobs_once,
    sweep_locally_orphaned_active_runners as loop_sweep_locally_orphaned_active_runners,
    sweep_stale_running_jobs as loop_sweep_stale_running_jobs,
)
from job_runtime_worker_launcher import InlineJobWorkerLauncher, JobWorkerLauncher
from runtime_limits import (
    JOB_KEEPALIVE_INTERVAL_MAX_SECONDS,
    JOB_KEEPALIVE_INTERVAL_MIN_SECONDS,
    JOB_TOUCH_MIN_INTERVAL_SECONDS,
    MIN_JOB_EVENT_HISTORY_MAX_JOBS,
    MIN_JOB_EVENT_HISTORY_TTL_SECONDS,
    MIN_JOB_STALL_TIMEOUT_SECONDS,
)
from store import SessionStore


class JobRetryableError(Exception):
    pass


class JobNonRetryableError(Exception):
    pass


class JobDuplicateRunnerSuppressed(Exception):
    """Raised when a duplicate in-process runner is detected for the same job_id.

    This is an attribution/guardrail signal, not a user-visible terminal job failure.
    """

    pass


class JobRuntime:
    def __init__(
        self,
        *,
        store: SessionStore,
        client: HermesClient,
        job_max_attempts: int,
        job_retry_base_seconds: int,
        job_worker_concurrency: int,
        job_stall_timeout_seconds: int,
        assistant_chunk_len: int,
        assistant_hard_limit: int,
        job_event_history_max_jobs: int,
        job_event_history_ttl_seconds: int,
        session_id_builder: Callable[[str, int], str],
        worker_launcher: JobWorkerLauncher | None = None,
    ) -> None:
        self.store = store
        self.client = client
        self.job_max_attempts = int(job_max_attempts)
        self.job_retry_base_seconds = int(job_retry_base_seconds)
        self.job_worker_concurrency = max(1, int(job_worker_concurrency))
        self.job_stall_timeout_seconds = max(MIN_JOB_STALL_TIMEOUT_SECONDS, int(job_stall_timeout_seconds))
        # Keep running jobs alive even when upstream model providers are silent for long stretches.
        self.job_keepalive_interval_seconds = max(
            JOB_KEEPALIVE_INTERVAL_MIN_SECONDS,
            min(JOB_KEEPALIVE_INTERVAL_MAX_SECONDS, self.job_stall_timeout_seconds / 6.0),
        )
        self.assistant_chunk_len = int(assistant_chunk_len)
        self.assistant_hard_limit = int(assistant_hard_limit)
        self.job_event_history_max_jobs = max(MIN_JOB_EVENT_HISTORY_MAX_JOBS, int(job_event_history_max_jobs))
        self.job_event_buffer_cap = self.job_event_history_max_jobs
        self.job_event_history_ttl_seconds = max(MIN_JOB_EVENT_HISTORY_TTL_SECONDS, int(job_event_history_ttl_seconds))
        self.session_id_builder = session_id_builder
        self.worker_launcher = worker_launcher or InlineJobWorkerLauncher()

        self._event_broker = JobEventBroker(
            event_buffer_cap=self.job_event_buffer_cap,
            history_max_jobs=self.job_event_history_max_jobs,
            history_ttl_seconds=self.job_event_history_ttl_seconds,
        )
        # Compatibility shims for tests/monkeypatch surfaces that inspect event internals.
        self._event_lock = self._event_broker._event_lock
        self._event_queues = self._event_broker._event_queues
        self._event_history = self._event_broker._event_history
        self._event_timestamps = self._event_broker._event_timestamps

        self.wake_event = threading.Event()
        self._shutdown_event = threading.Event()
        self._shutdown_lock = threading.Lock()
        self._shutdown_started = False
        self._worker_threads: list[threading.Thread] = []
        self._worker_start_lock = threading.Lock()
        self._watchdog_started = False
        self._watchdog_thread: threading.Thread | None = None
        self._watchdog_lock = threading.Lock()

        self.job_touch_min_interval_seconds = JOB_TOUCH_MIN_INTERVAL_SECONDS
        self._touch_lock = threading.Lock()
        self._last_touch_by_job: dict[int, float] = {}

        self._best_effort_failure_lock = threading.Lock()
        self._best_effort_failure_counts: dict[str, int] = {
            "touch_job_write": 0,
            "system_message_write": 0,
        }

        self._runtime_counter_lock = threading.Lock()
        self._runtime_counters: dict[str, int] = {
            "retry_scheduled": 0,
            "retry_exhausted_dead": 0,
            "non_retryable_dead": 0,
            "unexpected_dead": 0,
            "stale_chat_dead": 0,
            "stale_timeout_dead": 0,
            "duplicate_runner_reject": 0,
        }
        self._runtime_counter_timeline: deque[tuple[float, str, int]] = deque(maxlen=4096)
        self._active_job_runner_lock = threading.Lock()
        self._active_job_runner_records: dict[int, dict[str, object]] = {}
        self._terminal_system_message_job_ids: set[int] = set()
        self._terminal_system_message_lock = threading.Lock()

    def publish_job_event(self, job_id: int, event_name: str, payload: dict[str, object]) -> None:
        if event_name not in JOB_EVENT_TERMINAL:
            self._touch_job_best_effort(job_id)
            with self._active_job_runner_lock:
                record = self._active_job_runner_records.get(int(job_id))
                if isinstance(record, dict):
                    record["last_progress_at"] = int(time.time())
        else:
            self._clear_touch_tracking(job_id)

        safe_payload = dict(payload or {})
        operator_debug = os.environ.get("MINI_APP_OPERATOR_DEBUG", os.environ.get("MINIAPP_OPERATOR_DEBUG", "0")) == "1"
        stream_timing_debug = os.environ.get("MINI_APP_STREAM_TIMING_DEBUG", os.environ.get("MINIAPP_STREAM_TIMING_DEBUG", "0")) == "1"
        if operator_debug and stream_timing_debug:
            timing_payload = safe_payload.get("_timing")
            if isinstance(timing_payload, dict):
                merged_timing = dict(timing_payload)
            else:
                merged_timing = {}
            merged_timing.setdefault("runtime_publish_monotonic_ms", int(time.monotonic() * 1000))
            safe_payload["_timing"] = merged_timing

        self._event_broker.publish(int(job_id), event_name, safe_payload)

    def subscribe_job_events(self, job_id: int, *, after_event_id: int = 0) -> queue.Queue[dict[str, object]]:
        return self._event_broker.subscribe(int(job_id), after_event_id=max(0, int(after_event_id or 0)))

    def unsubscribe_job_events(self, job_id: int, subscriber: queue.Queue[dict[str, object]]) -> None:
        self._event_broker.unsubscribe(int(job_id), subscriber)

    def _clear_touch_tracking(self, job_id: int) -> None:
        helper_clear_touch_tracking(self, job_id)

    def _record_best_effort_failure(self, kind: str, **context: object) -> int:
        return helper_record_best_effort_failure(self, kind, **context)

    def best_effort_failure_counts(self) -> dict[str, int]:
        return helper_best_effort_failure_counts(self)

    def _record_runtime_counter(self, key: str, delta: int = 1) -> None:
        helper_record_runtime_counter(self, key, delta)

    @staticmethod
    def _rate_windows() -> dict[str, int]:
        return helper_rate_windows()

    def _runtime_rate_windows(self) -> dict[str, dict[str, int]]:
        return helper_runtime_rate_windows(self, monotonic_fn=time.monotonic)

    @staticmethod
    def _severity_hint(
        *,
        worker_alive: int,
        worker_configured: int,
        terminal_window_5m: dict[str, int],
        runtime_window_5m: dict[str, int],
    ) -> dict[str, str]:
        return helper_severity_hint(
            worker_alive=worker_alive,
            worker_configured=worker_configured,
            terminal_window_5m=terminal_window_5m,
            runtime_window_5m=runtime_window_5m,
        )

    @staticmethod
    def _worker_isolation_boundary_signal(launcher_info: dict[str, object]) -> dict[str, object]:
        return helper_worker_isolation_boundary_signal(launcher_info, os_name=os.name)

    def runtime_diagnostics(self) -> dict[str, object]:
        return build_runtime_diagnostics(self, time_fn=time.time, monotonic_fn=time.monotonic)

    def _try_start_job_runner(self, *, job_id: int, user_id: str, chat_id: int) -> bool:
        return helper_try_start_job_runner(self, job_id=job_id, user_id=user_id, chat_id=chat_id)

    def _finish_job_runner(self, job_id: int, *, outcome: str = "finished") -> None:
        helper_finish_job_runner(self, job_id, outcome=outcome)

    def _terminate_job_children(self, *, job_id: int, reason: str) -> None:
        helper_terminate_job_children(self, job_id=job_id, reason=reason)

    def _touch_job_best_effort(self, job_id: int, *, force: bool = False) -> None:
        helper_touch_job_best_effort(self, job_id, force=force)

    def is_stale_chat_job_error(self, exc: Exception) -> bool:
        return helper_is_stale_chat_job_error(exc)

    @staticmethod
    def _bounded_attempts_for_display(attempts: int, max_attempts: int) -> int:
        return helper_bounded_attempts_for_display(attempts, max_attempts)

    @staticmethod
    def _fd_metrics() -> tuple[int | None, int | None]:
        return helper_fd_metrics()

    def start_once(self) -> None:
        start_runtime_once(self)

    def shutdown(self, *, reason: str = "shutdown", join_timeout: float = 1.0) -> None:
        shutdown_runtime(self, reason=reason, join_timeout=join_timeout)

    def ensure_pending_jobs(self, user_id: str) -> None:
        lifecycle_ensure_pending_jobs(self, user_id)

    def run_chat_job(self, job: dict[str, object]) -> None:
        job_id = int(job.get("id") or 0)
        user_id = str(job.get("user_id") or "")
        chat_id = int(job.get("chat_id") or 0)

        if not self._try_start_job_runner(job_id=job_id, user_id=user_id, chat_id=chat_id):
            self._record_runtime_counter("duplicate_runner_reject")
            raise JobDuplicateRunnerSuppressed(
                f"Duplicate active job runner blocked for job_id={job_id} chat_id={chat_id}."
            )

        try:
            self.worker_launcher.launch(
                runtime=self,
                job=job,
                retryable_error_cls=JobRetryableError,
                non_retryable_error_cls=JobNonRetryableError,
                client_error_cls=HermesClientError,
            )
        finally:
            self._finish_job_runner(job_id)

    def _safe_add_system_message(self, user_id: str, chat_id: int, text: str, *, job_id: int | None = None) -> None:
        helper_safe_add_system_message(self, user_id, chat_id, text, job_id=job_id)

    def _sweep_stale_running_jobs(self) -> None:
        loop_sweep_stale_running_jobs(self)

    def _sweep_locally_orphaned_active_runners(self) -> None:
        loop_sweep_locally_orphaned_active_runners(self)

    def _watchdog_loop(self) -> None:
        lifecycle_watchdog_loop(self)

    def _worker_loop(self) -> None:
        lifecycle_worker_loop(self)

    def _process_available_jobs_once(self) -> None:
        loop_process_available_jobs_once(
            self,
            duplicate_runner_error_cls=JobDuplicateRunnerSuppressed,
            non_retryable_error_cls=JobNonRetryableError,
            retryable_error_cls=JobRetryableError,
        )

    def _prune_event_history(self) -> None:
        self._event_broker.prune()

    @staticmethod
    def _chunk_assistant_reply(text: str, chunk_len: int) -> list[str]:
        cleaned = str(text or "").strip()
        if not cleaned:
            return []

        safe_chunk_len = max(800, int(chunk_len or 12000))
        parts: list[str] = []
        cursor = 0
        text_len = len(cleaned)

        while cursor < text_len:
            end = min(text_len, cursor + safe_chunk_len)
            if end < text_len:
                split_candidates = ["\n\n", "\n", " "]
                best = -1
                for token in split_candidates:
                    idx = cleaned.rfind(token, cursor, end)
                    if idx > best:
                        best = idx
                if best > cursor:
                    end = best + 1
            piece = cleaned[cursor:end].strip()
            if piece:
                parts.append(piece)
            cursor = end

        return parts

    @staticmethod
    def _build_recent_context_brief(history: list[dict[str, object]], max_items: int = 8, max_chars: int = 1200) -> str:
        if not history:
            return ""

        lines: list[str] = []
        for turn in history:
            role = str(turn.get("role") or "").strip().lower()
            if role not in {"operator", "hermes", "system"}:
                continue

            body = str(turn.get("body") or turn.get("content") or "").strip()
            if not body:
                continue

            body_single = " ".join(body.split())
            if len(body_single) > 180:
                body_single = body_single[:177].rstrip() + "..."

            if role == "operator":
                label = "user"
            elif role == "hermes":
                label = "assistant"
            else:
                label = "system"

            lines.append(f"- {label}: {body_single}")

        if not lines:
            return ""

        selected = lines[-max_items:]
        brief = "\n".join(selected)
        if len(brief) > max_chars:
            brief = brief[-max_chars:]
            newline = brief.find("\n")
            if newline > 0:
                brief = brief[newline + 1 :]
        return brief
