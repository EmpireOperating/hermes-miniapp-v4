from __future__ import annotations

import logging
import os
import queue
import sqlite3
import threading
import time
from collections import deque
from typing import Callable

from hermes_client import HermesClient, HermesClientError
from job_status import JOB_EVENT_ERROR, JOB_EVENT_TERMINAL
from job_runtime_events import JobEventBroker
from job_runtime_worker_launcher import InlineJobWorkerLauncher, JobWorkerLauncher
from runtime_limits import (
    JOB_KEEPALIVE_INTERVAL_MAX_SECONDS,
    JOB_KEEPALIVE_INTERVAL_MIN_SECONDS,
    JOB_TOUCH_MIN_INTERVAL_SECONDS,
    JOB_WATCHDOG_SLEEP_SECONDS,
    JOB_WORKER_WAIT_TIMEOUT_SECONDS,
    MIN_JOB_EVENT_HISTORY_MAX_JOBS,
    MIN_JOB_EVENT_HISTORY_TTL_SECONDS,
    MIN_JOB_STALL_TIMEOUT_SECONDS,
)
from store import SessionStore


LOGGER = logging.getLogger(__name__)


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
        with self._touch_lock:
            self._last_touch_by_job.pop(int(job_id), None)

    def _record_best_effort_failure(self, kind: str, **context: object) -> int:
        with self._best_effort_failure_lock:
            next_count = int(self._best_effort_failure_counts.get(kind, 0)) + 1
            self._best_effort_failure_counts[kind] = next_count

        details = " ".join(f"{key}={value}" for key, value in sorted(context.items()))
        if details:
            LOGGER.warning("best_effort_write_failure kind=%s count=%s %s", kind, next_count, details)
        else:
            LOGGER.warning("best_effort_write_failure kind=%s count=%s", kind, next_count)
        return next_count

    def best_effort_failure_counts(self) -> dict[str, int]:
        with self._best_effort_failure_lock:
            return dict(self._best_effort_failure_counts)

    def _record_runtime_counter(self, key: str, delta: int = 1) -> None:
        now = time.monotonic()
        with self._runtime_counter_lock:
            safe_delta = int(delta)
            next_value = int(self._runtime_counters.get(key, 0)) + safe_delta
            self._runtime_counters[key] = next_value
            self._runtime_counter_timeline.append((now, str(key), safe_delta))

    @staticmethod
    def _rate_windows() -> dict[str, int]:
        return {"5m": 300, "15m": 900, "60m": 3600}

    def _runtime_rate_windows(self) -> dict[str, dict[str, int]]:
        windows = self._rate_windows()
        dead_letter_keys = {
            "retry_exhausted_dead",
            "non_retryable_dead",
            "unexpected_dead",
            "stale_chat_dead",
            "stale_timeout_dead",
        }
        now = time.monotonic()
        with self._runtime_counter_lock:
            timeline = list(self._runtime_counter_timeline)

        result: dict[str, dict[str, int]] = {}
        for label, window_seconds in windows.items():
            retry_scheduled = 0
            dead_letter = 0
            for ts, key, delta in timeline:
                if now - ts > window_seconds:
                    continue
                if key == "retry_scheduled":
                    retry_scheduled += int(delta)
                if key in dead_letter_keys:
                    dead_letter += int(delta)
            result[label] = {
                "retry_scheduled": int(retry_scheduled),
                "dead_letter": int(dead_letter),
            }
        return result

    @staticmethod
    def _severity_hint(
        *,
        worker_alive: int,
        worker_configured: int,
        terminal_window_5m: dict[str, int],
        runtime_window_5m: dict[str, int],
    ) -> dict[str, str]:
        if int(worker_alive) <= 0 and int(worker_configured) > 0:
            return {"level": "critical", "reason": "no_alive_workers"}

        dead_5m = int((runtime_window_5m or {}).get("dead_letter", 0))
        error_5m = int((terminal_window_5m or {}).get("error", 0))
        retry_5m = int((runtime_window_5m or {}).get("retry_scheduled", 0))

        if dead_5m >= 3:
            return {"level": "critical", "reason": "dead_letter_spike_5m"}
        if error_5m >= 5:
            return {"level": "warning", "reason": "terminal_error_spike_5m"}
        if retry_5m >= 5:
            return {"level": "warning", "reason": "retry_spike_5m"}
        if dead_5m >= 1 or error_5m >= 1:
            return {"level": "warning", "reason": "recent_failures_detected"}
        return {"level": "ok", "reason": "healthy"}

    @staticmethod
    def _worker_isolation_boundary_signal(launcher_info: dict[str, object]) -> dict[str, object]:
        info = dict(launcher_info or {})
        launcher_name = str(info.get("name") or "").strip().lower()
        isolation_mode = str(info.get("isolation") or "").strip().lower()

        boundary_active = bool(launcher_name == "subprocess" or isolation_mode == "process")

        limits_payload = info.get("limits") if isinstance(info.get("limits"), dict) else {}
        required_limits = ("memory_mb", "max_tasks", "max_open_files")
        limits_present = all(int(limits_payload.get(key, 0) or 0) > 0 for key in required_limits)

        # Current enforcement mechanism is POSIX rlimit in preexec_fn.
        boundary_enforced = bool(boundary_active and limits_present and os.name == "posix")

        if boundary_enforced:
            reason = "process_boundary_with_posix_rlimits"
        elif boundary_active and not limits_present:
            reason = "process_boundary_missing_limits"
        elif boundary_active and os.name != "posix":
            reason = "process_boundary_without_posix_rlimits"
        else:
            reason = "in_process_launcher"

        return {
            "active": boundary_active,
            "enforced": boundary_enforced,
            "reason": reason,
        }

    def runtime_diagnostics(self) -> dict[str, object]:
        fd_open, fd_limit_soft = self._fd_metrics()
        with self._runtime_counter_lock:
            counters = dict(self._runtime_counters)

        child_diagnostics_getter = getattr(self.client, "child_spawn_diagnostics", None)
        child_diagnostics = child_diagnostics_getter() if callable(child_diagnostics_getter) else {}

        dead_letter_total = (
            int(counters.get("retry_exhausted_dead", 0))
            + int(counters.get("non_retryable_dead", 0))
            + int(counters.get("unexpected_dead", 0))
            + int(counters.get("stale_chat_dead", 0))
            + int(counters.get("stale_timeout_dead", 0))
        )

        queue_diagnostics = self.store.job_queue_diagnostics() if hasattr(self.store, "job_queue_diagnostics") else {}
        startup_recovered_running_total = int(queue_diagnostics.get("startup_recovered_running_total", 0) or 0)
        startup_clamped_exhausted_total = int(queue_diagnostics.get("startup_clamped_exhausted_total", 0) or 0)
        preclaim_dead_letter_total = int(queue_diagnostics.get("preclaim_dead_letter_total", 0) or 0)

        with self._worker_start_lock:
            worker_alive = sum(1 for worker in self._worker_threads if worker.is_alive())

        with self._active_job_runner_lock:
            active_job_records = [dict(record) for _job_id, record in sorted(self._active_job_runner_records.items())]

        terminal_events = self._event_broker.terminal_rollup(limit=12, error_limit=6)
        runtime_rate_windows = self._runtime_rate_windows()
        terminal_rate_windows = self._event_broker.terminal_window_counts(windows=self._rate_windows())
        severity_hint = self._severity_hint(
            worker_alive=worker_alive,
            worker_configured=self.job_worker_concurrency,
            terminal_window_5m=terminal_rate_windows.get("5m", {}),
            runtime_window_5m=runtime_rate_windows.get("5m", {}),
        )

        launcher_describe = getattr(self.worker_launcher, "describe", None)
        launcher_info = launcher_describe() if callable(launcher_describe) else {"name": type(self.worker_launcher).__name__}
        isolation_boundary = self._worker_isolation_boundary_signal(launcher_info)
        child_timeouts = (child_diagnostics.get("timeouts") if isinstance(child_diagnostics, dict) else None) or {}
        child_timeouts_total = int(child_timeouts.get("total", 0) or 0)
        recent_transport_transitions = list((child_diagnostics.get("recent_transport_transitions") if isinstance(child_diagnostics, dict) else None) or [])
        active_job_transport_snapshots: list[dict[str, object]] = []
        for record in active_job_records:
            session_id = str(record.get("session_id") or "")
            matching_transitions = [
                dict(item)
                for item in recent_transport_transitions
                if str((item or {}).get("session_id") or "") == session_id
            ]
            active_job_transport_snapshots.append(
                {
                    **record,
                    "recent_transport_transitions": matching_transitions[-6:],
                }
            )

        incident_snapshot = {
            "generated_at": int(time.time()),
            "workers": {
                "configured": int(self.job_worker_concurrency),
                "alive": int(worker_alive),
                "active_jobs": active_job_transport_snapshots,
                "active_job_total": len(active_job_transport_snapshots),
                "launcher": launcher_info,
                "isolation_boundary": isolation_boundary,
                "isolation_boundary_active": bool(isolation_boundary.get("active")),
                "isolation_boundary_enforced": bool(isolation_boundary.get("enforced")),
                "child_timeout_total": child_timeouts_total,
                "child_timeouts_by_job": dict(child_timeouts.get("by_job") or {}),
                "child_timeouts_by_chat": dict(child_timeouts.get("by_chat") or {}),
            },
            "wake_event_set": bool(self.wake_event.is_set()),
            "terminal_events": terminal_events,
            "rate_windows": {
                "runtime": runtime_rate_windows,
                "terminal": terminal_rate_windows,
            },
            "severity_hint": severity_hint,
        }

        return {
            "fd_open": fd_open,
            "fd_limit_soft": fd_limit_soft,
            "retry_scheduled_total": int(counters.get("retry_scheduled", 0)),
            "dead_letter_total": dead_letter_total,
            "counters": counters,
            "best_effort_failures": self.best_effort_failure_counts(),
            "queue_diagnostics": {
                "startup_recovered_running_total": startup_recovered_running_total,
                "startup_clamped_exhausted_total": startup_clamped_exhausted_total,
                "preclaim_dead_letter_total": preclaim_dead_letter_total,
            },
            "children": child_diagnostics,
            "child_timeouts": child_timeouts,
            "isolation_boundary": isolation_boundary,
            "incident_snapshot": incident_snapshot,
            # Flat aliases for quick grep/debug snapshots.
            "startup_recovered_running_total": startup_recovered_running_total,
            "startup_clamped_exhausted_total": startup_clamped_exhausted_total,
            "preclaim_dead_letter_total": preclaim_dead_letter_total,
        }

    def _try_start_job_runner(self, *, job_id: int, user_id: str, chat_id: int) -> bool:
        safe_job_id = int(job_id)
        with self._active_job_runner_lock:
            if safe_job_id in self._active_job_runner_records:
                return False
            session_id = str(self.session_id_builder(str(user_id or ""), int(chat_id)) or "")
            self._active_job_runner_records[safe_job_id] = {
                "job_id": safe_job_id,
                "user_id": str(user_id or ""),
                "chat_id": int(chat_id),
                "session_id": session_id,
                "started_at": int(time.time()),
                "last_progress_at": int(time.time()),
            }
            note_started = getattr(self.client, "note_warm_session_worker_started", None)
            if callable(note_started):
                note_started(session_id=session_id, chat_id=int(chat_id), job_id=safe_job_id)
            return True

    def _finish_job_runner(self, job_id: int, *, outcome: str = "finished") -> None:
        with self._active_job_runner_lock:
            record = self._active_job_runner_records.pop(int(job_id), None)
        if not isinstance(record, dict):
            return
        note_finished = getattr(self.client, "note_warm_session_worker_finished", None)
        if callable(note_finished):
            note_finished(
                session_id=str(record.get("session_id") or ""),
                chat_id=int(record.get("chat_id") or 0),
                job_id=int(record.get("job_id") or 0),
                outcome=str(outcome or "finished"),
            )

    def _terminate_job_children(self, *, job_id: int, reason: str) -> None:
        terminator = getattr(self.client, "terminate_tracked_children", None)
        if not callable(terminator):
            return
        try:
            terminator(job_id=int(job_id), reason=str(reason or "runtime_cleanup"))
        except Exception as exc:  # noqa: BLE001 - broad-except-policy: emergency cleanup must never break worker path
            LOGGER.warning(
                "job_child_cleanup_failed job_id=%s reason=%s error=%s",
                int(job_id),
                reason,
                exc.__class__.__name__,
            )

    def _touch_job_best_effort(self, job_id: int, *, force: bool = False) -> None:
        job_id = int(job_id)
        now = time.monotonic()
        if not force:
            with self._touch_lock:
                last = self._last_touch_by_job.get(job_id, 0.0)
                if now - last < self.job_touch_min_interval_seconds:
                    return
                self._last_touch_by_job[job_id] = now
        else:
            with self._touch_lock:
                self._last_touch_by_job[job_id] = now

        try:
            self.store.touch_job(job_id)
        except Exception as exc:  # noqa: BLE001 - broad-except-policy: best-effort liveness write should not fail active jobs
            self._record_best_effort_failure("touch_job_write", job_id=job_id, force=bool(force), error=type(exc).__name__)
            LOGGER.debug("touch_job_best_effort_exception job_id=%s", job_id, exc_info=exc)

    def is_stale_chat_job_error(self, exc: Exception) -> bool:
        if not isinstance(exc, KeyError):
            return False
        text = str(exc)
        return "Chat" in text and "not found" in text

    @staticmethod
    def _bounded_attempts_for_display(attempts: int, max_attempts: int) -> int:
        safe_max = max(1, int(max_attempts or 1))
        safe_attempts = max(1, int(attempts or 0))
        return min(safe_attempts, safe_max)

    @staticmethod
    def _fd_metrics() -> tuple[int | None, int | None]:
        open_fds: int | None = None
        soft_limit: int | None = None

        try:
            open_fds = len(os.listdir("/proc/self/fd"))
        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort diagnostics only for environments without /proc/self/fd
            open_fds = None

        try:
            import resource

            soft, _hard = resource.getrlimit(resource.RLIMIT_NOFILE)
            soft_limit = int(soft) if int(soft) >= 0 else None
        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log best-effort diagnostics only when resource limits are unavailable
            soft_limit = None

        return open_fds, soft_limit

    def start_once(self) -> None:
        if self._shutdown_event.is_set():
            LOGGER.info("job_runtime_start_skipped reason=shutdown")
            return

        with self._watchdog_lock:
            if not self._watchdog_started:
                watchdog = threading.Thread(target=self._watchdog_loop, name="miniapp-job-watchdog", daemon=True)
                watchdog.start()
                self._watchdog_thread = watchdog
                self._watchdog_started = True

        with self._worker_start_lock:
            alive_workers = [worker for worker in self._worker_threads if worker.is_alive()]
            self._worker_threads[:] = alive_workers

            missing = max(0, self.job_worker_concurrency - len(alive_workers))
            if missing <= 0:
                return

            for _ in range(missing):
                worker_index = len(self._worker_threads) + 1
                worker = threading.Thread(target=self._worker_loop, name=f"miniapp-job-worker-{worker_index}", daemon=True)
                worker.start()
                self._worker_threads.append(worker)

            self.wake_event.set()

    def shutdown(self, *, reason: str = "shutdown", join_timeout: float = 1.0) -> None:
        with self._shutdown_lock:
            if self._shutdown_started:
                return
            self._shutdown_started = True
            self._shutdown_event.set()
            self.wake_event.set()

        active_job_ids: list[int]
        with self._active_job_runner_lock:
            active_job_ids = sorted(int(job_id) for job_id in self._active_job_runner_records)

        for job_id in active_job_ids:
            self._terminate_job_children(job_id=job_id, reason=f"runtime_{reason}")

        threads: list[threading.Thread] = []
        with self._watchdog_lock:
            if self._watchdog_thread is not None:
                threads.append(self._watchdog_thread)
        with self._worker_start_lock:
            threads.extend(self._worker_threads)

        deadline = time.monotonic() + max(0.1, float(join_timeout))
        for thread in threads:
            if thread is None or not thread.is_alive():
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            thread.join(timeout=remaining)

        with self._watchdog_lock:
            if self._watchdog_thread is not None and not self._watchdog_thread.is_alive():
                self._watchdog_thread = None
                self._watchdog_started = False
        with self._worker_start_lock:
            self._worker_threads[:] = [worker for worker in self._worker_threads if worker.is_alive()]

    def ensure_pending_jobs(self, user_id: str) -> None:
        for chat_id, operator_message_id in self.store.list_recoverable_pending_turns(user_id):
            job_id = self.store.enqueue_chat_job(
                user_id=user_id,
                chat_id=chat_id,
                operator_message_id=operator_message_id,
                max_attempts=self.job_max_attempts,
            )
            self.publish_job_event(job_id, "meta", {"chat_id": chat_id, "source": "recovered"})
            self.wake_event.set()

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
        safe_job_id = int(job_id or 0)
        if safe_job_id > 0:
            with self._terminal_system_message_lock:
                if safe_job_id in self._terminal_system_message_job_ids:
                    return
                self._terminal_system_message_job_ids.add(safe_job_id)
        try:
            self.store.add_message(user_id=user_id, chat_id=chat_id, role="system", body=text)
        except Exception as exc:  # noqa: BLE001 - broad-except-policy: best-effort UX status message should never crash worker
            if safe_job_id > 0:
                with self._terminal_system_message_lock:
                    self._terminal_system_message_job_ids.discard(safe_job_id)
            self._record_best_effort_failure(
                "system_message_write",
                user_id=user_id,
                chat_id=int(chat_id),
                job_id=safe_job_id or None,
                text_len=len(text),
                error=type(exc).__name__,
            )
            LOGGER.debug(
                "safe_add_system_message_exception user_id=%s chat_id=%s job_id=%s",
                user_id,
                chat_id,
                safe_job_id or None,
                exc_info=exc,
            )
            return

    def _sweep_stale_running_jobs(self) -> None:
        stale_jobs = self.store.dead_letter_stale_running_jobs(
            timeout_seconds=self.job_stall_timeout_seconds,
            error=f"Job timed out after {self.job_stall_timeout_seconds}s without progress",
        )
        for stale in stale_jobs:
            stale_job_id = int(stale.get("id") or 0)
            stale_chat_id = int(stale.get("chat_id") or 0)
            stale_user_id = str(stale.get("user_id") or "")
            if stale_job_id:
                self._terminate_job_children(job_id=stale_job_id, reason="stale_timeout_dead")
                self._finish_job_runner(stale_job_id, outcome="stale_timeout_dead")
                self._record_runtime_counter("stale_timeout_dead")
                self.publish_job_event(
                    stale_job_id,
                    JOB_EVENT_ERROR,
                    {
                        "chat_id": stale_chat_id,
                        "error": f"Job timed out after {self.job_stall_timeout_seconds}s without progress",
                        "retrying": False,
                    },
                )
            if stale_user_id and stale_chat_id:
                self._safe_add_system_message(
                    user_id=stale_user_id,
                    chat_id=stale_chat_id,
                    job_id=stale_job_id,
                    text=f"Hermes timed out after {self.job_stall_timeout_seconds}s with no progress. Please retry.",
                )

        self._sweep_locally_orphaned_active_runners()

    def _sweep_locally_orphaned_active_runners(self) -> None:
        now = int(time.time())
        timeout = max(30, int(self.job_stall_timeout_seconds or 0))
        with self._active_job_runner_lock:
            active_records = [dict(record) for record in self._active_job_runner_records.values()]

        child_diag_fn = getattr(self.client, "child_spawn_diagnostics", None)
        child_diag = child_diag_fn() if callable(child_diag_fn) else {}
        descendant_active_by_job = dict((child_diag.get("descendant_active_by_job") if isinstance(child_diag, dict) else None) or {})
        warm_owner_state_fn = getattr(self.client, "warm_session_owner_state", None)
        warm_owner_state = warm_owner_state_fn() if callable(warm_owner_state_fn) else {}
        owner_records = {
            str(item.get("session_id") or ""): dict(item)
            for item in ((warm_owner_state.get("owner_records") if isinstance(warm_owner_state, dict) else None) or [])
            if isinstance(item, dict)
        }

        for record in active_records:
            job_id = int(record.get("job_id") or 0)
            if job_id <= 0:
                continue
            last_progress_at = int(record.get("last_progress_at") or record.get("started_at") or 0)
            if last_progress_at <= 0 or (now - last_progress_at) < timeout:
                continue
            session_id = str(record.get("session_id") or "")
            owner_record = owner_records.get(session_id) or {}
            owner_state = str(owner_record.get("state") or "")
            if owner_state != "expired":
                continue
            if int(descendant_active_by_job.get(str(job_id), 0) or 0) > 0:
                continue

            state = self.store.get_job_state(job_id)
            if not state or str(state.get("status") or "") != "running":
                self._finish_job_runner(job_id, outcome="orphaned_runner_dead")
                continue

            error_text = (
                f"Job timed out after {self.job_stall_timeout_seconds}s without progress "
                f"(orphaned active runner after descendants exited)"
            )
            self._terminate_job_children(job_id=job_id, reason="orphaned_runner_dead")
            self._finish_job_runner(job_id, outcome="orphaned_runner_dead")
            retrying = self.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0)
            self._record_runtime_counter("orphaned_runner_dead")
            if not retrying:
                self.publish_job_event(
                    job_id,
                    JOB_EVENT_ERROR,
                    {
                        "chat_id": int(record.get("chat_id") or 0),
                        "error": error_text,
                        "retrying": False,
                    },
                )
                user_id = str(record.get("user_id") or "")
                chat_id = int(record.get("chat_id") or 0)
                if user_id and chat_id:
                    self._safe_add_system_message(
                        user_id=user_id,
                        chat_id=chat_id,
                        job_id=job_id,
                        text=f"Hermes failed after 1 attempts: {error_text}",
                    )

    def _watchdog_loop(self) -> None:
        while not self._shutdown_event.wait(timeout=JOB_WATCHDOG_SLEEP_SECONDS):
            self._sweep_stale_running_jobs()

    def _worker_loop(self) -> None:
        while not self._shutdown_event.is_set():
            self.wake_event.wait(timeout=JOB_WORKER_WAIT_TIMEOUT_SECONDS)
            self.wake_event.clear()
            if self._shutdown_event.is_set():
                break
            self._process_available_jobs_once()

    def _process_available_jobs_once(self) -> None:
        if self._shutdown_event.is_set():
            return

        self._sweep_stale_running_jobs()

        while not self._shutdown_event.is_set():
            try:
                job = self.store.claim_next_job()
            except sqlite3.OperationalError as exc:
                if "database is locked" not in str(exc).lower():
                    raise
                LOGGER.warning("job_claim_retry_exhausted error=%s", exc)
                break
            if not job:
                break

            job_id = int(job["id"])
            user_id = str(job["user_id"])
            chat_id = int(job["chat_id"])
            attempts = int(job.get("attempts") or 0)
            max_attempts = int(job.get("max_attempts") or 1)

            try:
                self.run_chat_job(job)
            except JobDuplicateRunnerSuppressed as exc:
                self._clear_touch_tracking(job_id)
                fd_open, fd_limit_soft = self._fd_metrics()
                LOGGER.warning(
                    "job_duplicate_runner_suppressed job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s fd_open=%s fd_limit_soft=%s detail=%s",
                    job_id,
                    user_id,
                    chat_id,
                    attempts,
                    max_attempts,
                    fd_open,
                    fd_limit_soft,
                    exc,
                )
                self.publish_job_event(
                    job_id,
                    "meta",
                    {
                        "chat_id": chat_id,
                        "source": "duplicate-runner",
                        "detail": str(exc),
                    },
                )
                continue
            except JobNonRetryableError as exc:
                error_text = str(exc)
                self._terminate_job_children(job_id=job_id, reason="non_retryable_dead")
                self.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0)
                self._record_runtime_counter("non_retryable_dead")
                self._clear_touch_tracking(job_id)
                fd_open, fd_limit_soft = self._fd_metrics()
                LOGGER.error(
                    "job_non_retryable job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s fd_open=%s fd_limit_soft=%s error=%s",
                    job_id,
                    user_id,
                    chat_id,
                    attempts,
                    max_attempts,
                    fd_open,
                    fd_limit_soft,
                    error_text,
                )
                self._safe_add_system_message(user_id=user_id, chat_id=chat_id, job_id=job_id, text=f"Hermes failed permanently: {error_text}")
                self.publish_job_event(job_id, JOB_EVENT_ERROR, {"error": error_text, "chat_id": chat_id, "retrying": False})
            except JobRetryableError as exc:
                error_text = str(exc)
                self._terminate_job_children(job_id=job_id, reason="retryable_error")
                retrying = self.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=self.job_retry_base_seconds)
                fd_open, fd_limit_soft = self._fd_metrics()
                if retrying:
                    self._record_runtime_counter("retry_scheduled")
                    LOGGER.warning(
                        "job_retry_scheduled job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s fd_open=%s fd_limit_soft=%s error=%s",
                        job_id,
                        user_id,
                        chat_id,
                        attempts,
                        max_attempts,
                        fd_open,
                        fd_limit_soft,
                        error_text,
                    )
                    self.publish_job_event(
                        job_id,
                        "meta",
                        {
                            "chat_id": chat_id,
                            "source": "retry",
                            "attempt": attempts,
                            "max_attempts": max_attempts,
                            "detail": f"retrying after error: {error_text}",
                        },
                    )
                    self.wake_event.set()
                else:
                    self._record_runtime_counter("retry_exhausted_dead")
                    self._clear_touch_tracking(job_id)
                    LOGGER.error(
                        "job_retry_exhausted job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s fd_open=%s fd_limit_soft=%s error=%s",
                        job_id,
                        user_id,
                        chat_id,
                        attempts,
                        max_attempts,
                        fd_open,
                        fd_limit_soft,
                        error_text,
                    )
                    display_attempts = self._bounded_attempts_for_display(attempts, max_attempts)
                    self._safe_add_system_message(user_id=user_id, chat_id=chat_id, job_id=job_id, text=f"Hermes failed after {display_attempts} attempts: {error_text}")
                    self.publish_job_event(job_id, JOB_EVENT_ERROR, {"error": error_text, "chat_id": chat_id, "retrying": False})
            except Exception as exc:  # noqa: BLE001 - broad-except-policy: worker loop must quarantine unexpected failures per job
                if self.is_stale_chat_job_error(exc):
                    error_text = f"Stale chat job dropped: {exc}"
                    self._terminate_job_children(job_id=job_id, reason="stale_chat_dead")
                    self.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0)
                    self._record_runtime_counter("stale_chat_dead")
                    self._clear_touch_tracking(job_id)
                    fd_open, fd_limit_soft = self._fd_metrics()
                    LOGGER.info(
                        "job_stale_chat_dropped job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s fd_open=%s fd_limit_soft=%s detail=%s",
                        job_id,
                        user_id,
                        chat_id,
                        attempts,
                        max_attempts,
                        fd_open,
                        fd_limit_soft,
                        exc,
                    )
                    self.publish_job_event(job_id, "meta", {"chat_id": chat_id, "source": "stale-chat", "detail": str(exc)})
                    continue
                error_text = f"Unexpected worker failure: {exc}"
                self._terminate_job_children(job_id=job_id, reason="unexpected_dead")
                self.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0)
                self._record_runtime_counter("unexpected_dead")
                self._clear_touch_tracking(job_id)
                fd_open, fd_limit_soft = self._fd_metrics()
                LOGGER.exception(
                    "job_unexpected_failure job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s fd_open=%s fd_limit_soft=%s",
                    job_id,
                    user_id,
                    chat_id,
                    attempts,
                    max_attempts,
                    fd_open,
                    fd_limit_soft,
                )
                self._safe_add_system_message(user_id=user_id, chat_id=chat_id, job_id=job_id, text=error_text)
                self.publish_job_event(job_id, JOB_EVENT_ERROR, {"error": error_text, "chat_id": chat_id, "retrying": False})

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
