from __future__ import annotations

import logging
import os
import queue
import threading
import time
from collections import deque
from typing import Callable

from hermes_client import HermesClient, HermesClientError
from job_status import JOB_EVENT_ERROR, JOB_EVENT_TERMINAL
from job_runtime_chat_job import execute_chat_job
from job_runtime_events import JobEventBroker
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
        self._worker_threads: list[threading.Thread] = []
        self._worker_start_lock = threading.Lock()
        self._watchdog_started = False
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
        }
        self._runtime_counter_timeline: deque[tuple[float, str, int]] = deque(maxlen=4096)

    def publish_job_event(self, job_id: int, event_name: str, payload: dict[str, object]) -> None:
        if event_name not in JOB_EVENT_TERMINAL:
            self._touch_job_best_effort(job_id)
        else:
            self._clear_touch_tracking(job_id)

        safe_payload = dict(payload or {})
        if os.environ.get("MINI_APP_STREAM_TIMING_DEBUG", "0") == "1":
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

    def runtime_diagnostics(self) -> dict[str, object]:
        fd_open, fd_limit_soft = self._fd_metrics()
        with self._runtime_counter_lock:
            counters = dict(self._runtime_counters)

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

        terminal_events = self._event_broker.terminal_rollup(limit=12, error_limit=6)
        runtime_rate_windows = self._runtime_rate_windows()
        terminal_rate_windows = self._event_broker.terminal_window_counts(windows=self._rate_windows())
        severity_hint = self._severity_hint(
            worker_alive=worker_alive,
            worker_configured=self.job_worker_concurrency,
            terminal_window_5m=terminal_rate_windows.get("5m", {}),
            runtime_window_5m=runtime_rate_windows.get("5m", {}),
        )

        incident_snapshot = {
            "generated_at": int(time.time()),
            "workers": {
                "configured": int(self.job_worker_concurrency),
                "alive": int(worker_alive),
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
            "incident_snapshot": incident_snapshot,
            # Flat aliases for quick grep/debug snapshots.
            "startup_recovered_running_total": startup_recovered_running_total,
            "startup_clamped_exhausted_total": startup_clamped_exhausted_total,
            "preclaim_dead_letter_total": preclaim_dead_letter_total,
        }

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
        with self._watchdog_lock:
            if not self._watchdog_started:
                watchdog = threading.Thread(target=self._watchdog_loop, name="miniapp-job-watchdog", daemon=True)
                watchdog.start()
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
        execute_chat_job(
            self,
            job,
            retryable_error_cls=JobRetryableError,
            non_retryable_error_cls=JobNonRetryableError,
            client_error_cls=HermesClientError,
        )

    def _safe_add_system_message(self, user_id: str, chat_id: int, text: str) -> None:
        try:
            self.store.add_message(user_id=user_id, chat_id=chat_id, role="system", body=text)
        except Exception as exc:  # noqa: BLE001 - broad-except-policy: best-effort UX status message should never crash worker
            self._record_best_effort_failure(
                "system_message_write",
                user_id=user_id,
                chat_id=int(chat_id),
                text_len=len(text),
                error=type(exc).__name__,
            )
            LOGGER.debug(
                "safe_add_system_message_exception user_id=%s chat_id=%s",
                user_id,
                chat_id,
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
                    text=f"Hermes timed out after {self.job_stall_timeout_seconds}s with no progress. Please retry.",
                )

    def _watchdog_loop(self) -> None:
        while True:
            time.sleep(JOB_WATCHDOG_SLEEP_SECONDS)
            self._sweep_stale_running_jobs()

    def _worker_loop(self) -> None:
        while True:
            self.wake_event.wait(timeout=JOB_WORKER_WAIT_TIMEOUT_SECONDS)
            self.wake_event.clear()
            self._process_available_jobs_once()

    def _process_available_jobs_once(self) -> None:
        self._sweep_stale_running_jobs()

        while True:
            job = self.store.claim_next_job()
            if not job:
                break

            job_id = int(job["id"])
            user_id = str(job["user_id"])
            chat_id = int(job["chat_id"])
            attempts = int(job.get("attempts") or 0)
            max_attempts = int(job.get("max_attempts") or 1)

            try:
                self.run_chat_job(job)
            except JobNonRetryableError as exc:
                error_text = str(exc)
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
                self._safe_add_system_message(user_id=user_id, chat_id=chat_id, text=f"Hermes failed permanently: {error_text}")
                self.publish_job_event(job_id, JOB_EVENT_ERROR, {"error": error_text, "chat_id": chat_id, "retrying": False})
            except JobRetryableError as exc:
                error_text = str(exc)
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
                    self._safe_add_system_message(user_id=user_id, chat_id=chat_id, text=f"Hermes failed after {display_attempts} attempts: {error_text}")
                    self.publish_job_event(job_id, JOB_EVENT_ERROR, {"error": error_text, "chat_id": chat_id, "retrying": False})
            except Exception as exc:  # noqa: BLE001 - broad-except-policy: worker loop must quarantine unexpected failures per job
                if self.is_stale_chat_job_error(exc):
                    error_text = f"Stale chat job dropped: {exc}"
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
                self._safe_add_system_message(user_id=user_id, chat_id=chat_id, text=error_text)
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
