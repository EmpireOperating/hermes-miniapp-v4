from __future__ import annotations

import logging
import os
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from job_runtime import JobRuntime


LOGGER = logging.getLogger(__name__)


def clear_touch_tracking(runtime: "JobRuntime", job_id: int) -> None:
    with runtime._touch_lock:
        runtime._last_touch_by_job.pop(int(job_id), None)


def record_best_effort_failure(runtime: "JobRuntime", kind: str, **context: object) -> int:
    with runtime._best_effort_failure_lock:
        next_count = int(runtime._best_effort_failure_counts.get(kind, 0)) + 1
        runtime._best_effort_failure_counts[kind] = next_count

    details = " ".join(f"{key}={value}" for key, value in sorted(context.items()))
    if details:
        LOGGER.warning("best_effort_write_failure kind=%s count=%s %s", kind, next_count, details)
    else:
        LOGGER.warning("best_effort_write_failure kind=%s count=%s", kind, next_count)
    return next_count


def best_effort_failure_counts(runtime: "JobRuntime") -> dict[str, int]:
    with runtime._best_effort_failure_lock:
        return dict(runtime._best_effort_failure_counts)


def record_runtime_counter(runtime: "JobRuntime", key: str, delta: int = 1) -> None:
    now = time.monotonic()
    with runtime._runtime_counter_lock:
        safe_delta = int(delta)
        next_value = int(runtime._runtime_counters.get(key, 0)) + safe_delta
        runtime._runtime_counters[key] = next_value
        runtime._runtime_counter_timeline.append((now, str(key), safe_delta))


def touch_job_best_effort(runtime: "JobRuntime", job_id: int, *, force: bool = False) -> None:
    job_id = int(job_id)
    now = time.monotonic()
    if not force:
        with runtime._touch_lock:
            last = runtime._last_touch_by_job.get(job_id, 0.0)
            if now - last < runtime.job_touch_min_interval_seconds:
                return
            runtime._last_touch_by_job[job_id] = now
    else:
        with runtime._touch_lock:
            runtime._last_touch_by_job[job_id] = now

    try:
        runtime.store.touch_job(job_id)
    except Exception as exc:  # noqa: BLE001 - broad-except-policy: best-effort liveness write should not fail active jobs
        runtime._record_best_effort_failure("touch_job_write", job_id=job_id, force=bool(force), error=type(exc).__name__)
        LOGGER.debug("touch_job_best_effort_exception job_id=%s", job_id, exc_info=exc)


def is_stale_chat_job_error(exc: Exception) -> bool:
    if not isinstance(exc, KeyError):
        return False
    text = str(exc)
    return "Chat" in text and "not found" in text


def bounded_attempts_for_display(attempts: int, max_attempts: int) -> int:
    safe_max = max(1, int(max_attempts or 1))
    safe_attempts = max(1, int(attempts or 0))
    return min(safe_attempts, safe_max)


def fd_metrics() -> tuple[int | None, int | None]:
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


def safe_add_system_message(runtime: "JobRuntime", user_id: str, chat_id: int, text: str, *, job_id: int | None = None) -> None:
    safe_job_id = int(job_id or 0)
    if safe_job_id > 0:
        with runtime._terminal_system_message_lock:
            if safe_job_id in runtime._terminal_system_message_job_ids:
                return
            runtime._terminal_system_message_job_ids.add(safe_job_id)
    try:
        runtime.store.add_message(user_id=user_id, chat_id=chat_id, role="system", body=text)
    except Exception as exc:  # noqa: BLE001 - broad-except-policy: best-effort UX status message should never crash worker
        if safe_job_id > 0:
            with runtime._terminal_system_message_lock:
                runtime._terminal_system_message_job_ids.discard(safe_job_id)
        runtime._record_best_effort_failure(
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
