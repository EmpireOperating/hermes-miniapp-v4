from __future__ import annotations

import logging
import sqlite3
import time
from typing import Any
from typing import TYPE_CHECKING

from job_status import JOB_EVENT_ERROR

if TYPE_CHECKING:
    from job_runtime import JobDuplicateRunnerSuppressed, JobNonRetryableError, JobRetryableError, JobRuntime


LOGGER = logging.getLogger(__name__)


def _safe_int(value: object) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None



def _safe_text(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None



def _matching_child_finish_event(runtime: "JobRuntime", *, job_id: int) -> dict[str, object]:
    diagnostics_getter = getattr(runtime.client, "child_spawn_diagnostics", None)
    diagnostics = diagnostics_getter() if callable(diagnostics_getter) else {}
    recent_events = ((diagnostics or {}).get("recent_events") if isinstance(diagnostics, dict) else None) or []
    matching: list[dict[str, object]] = []
    for item in recent_events:
        if not isinstance(item, dict):
            continue
        if str(item.get("event") or "") != "finish":
            continue
        if _safe_int(item.get("job_id")) != int(job_id):
            continue
        matching.append(dict(item))
    if not matching:
        return {}
    matching.sort(key=lambda item: _safe_int(item.get("monotonic_ms")) or -1)
    return matching[-1]



def _failure_kind_from_child_outcome(outcome: object) -> str | None:
    text = str(outcome or "").strip().lower()
    if not text:
        return None
    if text.endswith(":detached_warm_worker") or text.endswith(":completed"):
        return "completed"
    parts = [part for part in text.split(":") if part]
    if len(parts) >= 2 and parts[-2] == "failed":
        return parts[-1]
    return None



def _terminal_outcome_from_child_event(*, outcome: object, return_code: int | None) -> str | None:
    text = str(outcome or "").strip().lower()
    failure_kind = _failure_kind_from_child_outcome(text)
    if text.endswith(":detached_warm_worker") or text.endswith(":completed"):
        return "success"
    if failure_kind == "timeout":
        return "timeout_killed"
    if return_code == 0 and text:
        return "success"
    if ":failed:" in text or failure_kind == "failed":
        return "retryable_failure"
    return None



def _classify_limit_breach(*, return_code: int | None, terminal_error: str | None, failure_kind: str | None, terminal_outcome: str | None) -> tuple[str | None, str | None]:
    text = str(terminal_error or "").lower()
    if "memoryerror" in text or "cannot allocate memory" in text or "out of memory" in text:
        return "memory", "stderr_oom"
    if "too many open files" in text:
        return "open_files", "stderr_emfile"
    if "resource temporarily unavailable" in text or "pthread_create" in text:
        return "tasks", "stderr_eagain"
    if return_code == -9 and (str(failure_kind or "") == "failed" or str(terminal_outcome or "") == "retryable_failure"):
        return "memory", "signal_kill_suspected_oom"
    return None, None



def _job_failure_metadata(runtime: "JobRuntime", *, job_id: int, error_text: str | None = None) -> dict[str, object]:
    launcher_describe = getattr(runtime.worker_launcher, "describe", None)
    launcher_info = dict(launcher_describe() if callable(launcher_describe) else {})
    child_event = _matching_child_finish_event(runtime, job_id=int(job_id))

    child_pid = _safe_int(child_event.get("pid"))
    child_transport = _safe_text(child_event.get("transport"))
    terminal_return_code = _safe_int(child_event.get("return_code"))
    terminal_failure_kind = _failure_kind_from_child_outcome(child_event.get("outcome"))
    terminal_outcome = _terminal_outcome_from_child_event(
        outcome=child_event.get("outcome"),
        return_code=terminal_return_code,
    )
    terminal_error = _safe_text(error_text) or _safe_text(launcher_info.get("last_terminal_error"))
    limit_breach, limit_breach_detail = _classify_limit_breach(
        return_code=terminal_return_code,
        terminal_error=terminal_error,
        failure_kind=terminal_failure_kind,
        terminal_outcome=terminal_outcome,
    )

    return {
        "child_pid": child_pid if child_pid is not None else _safe_int(launcher_info.get("last_child_pid")),
        "child_transport": child_transport or _safe_text(launcher_info.get("transport")) or _safe_text(launcher_info.get("name")),
        "terminal_return_code": terminal_return_code if terminal_return_code is not None else _safe_int(launcher_info.get("last_return_code")),
        "terminal_failure_kind": terminal_failure_kind or _safe_text(launcher_info.get("last_failure_kind")),
        "terminal_outcome": terminal_outcome or _safe_text(launcher_info.get("last_terminal_outcome")),
        "terminal_error": terminal_error,
        "limit_breach": limit_breach or _safe_text(launcher_info.get("last_limit_breach")),
        "limit_breach_detail": limit_breach_detail or _safe_text(launcher_info.get("last_limit_breach_detail")),
    }

def sweep_stale_running_jobs(runtime: "JobRuntime") -> None:
    stale_jobs = runtime.store.dead_letter_stale_running_jobs(
        timeout_seconds=runtime.job_stall_timeout_seconds,
        error=f"Job timed out after {runtime.job_stall_timeout_seconds}s without progress",
    )
    for stale in stale_jobs:
        stale_job_id = int(stale.get("id") or 0)
        stale_chat_id = int(stale.get("chat_id") or 0)
        stale_user_id = str(stale.get("user_id") or "")
        if stale_job_id:
            runtime._terminate_job_children(job_id=stale_job_id, reason="stale_timeout_dead")
            runtime._finish_job_runner(stale_job_id, outcome="stale_timeout_dead")
            runtime._record_runtime_counter("stale_timeout_dead")
            runtime.publish_job_event(
                stale_job_id,
                JOB_EVENT_ERROR,
                {
                    "chat_id": stale_chat_id,
                    "error": f"Job timed out after {runtime.job_stall_timeout_seconds}s without progress",
                    "retrying": False,
                },
            )
        if stale_user_id and stale_chat_id:
            runtime._safe_add_system_message(
                user_id=stale_user_id,
                chat_id=stale_chat_id,
                job_id=stale_job_id,
                text=f"Hermes timed out after {runtime.job_stall_timeout_seconds}s with no progress. Please retry.",
            )

    runtime._sweep_locally_orphaned_active_runners()


def sweep_locally_orphaned_active_runners(runtime: "JobRuntime", *, now_ts: int | None = None) -> None:
    now = int(time.time() if now_ts is None else now_ts)
    timeout = max(30, int(runtime.job_stall_timeout_seconds or 0))
    with runtime._active_job_runner_lock:
        active_records = [dict(record) for record in runtime._active_job_runner_records.values()]

    child_diag_fn = getattr(runtime.client, "child_spawn_diagnostics", None)
    child_diag = child_diag_fn() if callable(child_diag_fn) else {}
    descendant_active_by_job = dict((child_diag.get("descendant_active_by_job") if isinstance(child_diag, dict) else None) or {})
    warm_owner_state_fn = getattr(runtime.client, "warm_session_owner_state", None)
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

        state = runtime.store.get_job_state(job_id)
        if not state or str(state.get("status") or "") != "running":
            runtime._finish_job_runner(job_id, outcome="orphaned_runner_dead")
            continue

        error_text = (
            f"Job timed out after {runtime.job_stall_timeout_seconds}s without progress "
            f"(orphaned active runner after descendants exited)"
        )
        runtime._terminate_job_children(job_id=job_id, reason="orphaned_runner_dead")
        runtime._finish_job_runner(job_id, outcome="orphaned_runner_dead")
        retrying = runtime.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0, failure_metadata=_job_failure_metadata(runtime, job_id=job_id, error_text=error_text))
        runtime._record_runtime_counter("orphaned_runner_dead")
        if not retrying:
            runtime.publish_job_event(
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
                runtime._safe_add_system_message(
                    user_id=user_id,
                    chat_id=chat_id,
                    job_id=job_id,
                    text=f"Hermes failed after 1 attempts: {error_text}",
                )


def process_available_jobs_once(
    runtime: "JobRuntime",
    *,
    duplicate_runner_error_cls: type["JobDuplicateRunnerSuppressed"],
    non_retryable_error_cls: type["JobNonRetryableError"],
    retryable_error_cls: type["JobRetryableError"],
) -> None:
    if runtime._shutdown_event.is_set():
        return

    runtime._sweep_stale_running_jobs()

    while not runtime._shutdown_event.is_set():
        try:
            job = runtime.store.claim_next_job()
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
            runtime.run_chat_job(job)
        except duplicate_runner_error_cls as exc:
            runtime._clear_touch_tracking(job_id)
            fd_open, fd_limit_soft = runtime._fd_metrics()
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
            runtime.publish_job_event(
                job_id,
                "meta",
                {
                    "chat_id": chat_id,
                    "source": "duplicate-runner",
                    "detail": str(exc),
                },
            )
            continue
        except non_retryable_error_cls as exc:
            error_text = str(exc)
            runtime._terminate_job_children(job_id=job_id, reason="non_retryable_dead")
            runtime.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0, failure_metadata=_job_failure_metadata(runtime, job_id=job_id, error_text=error_text))
            runtime._record_runtime_counter("non_retryable_dead")
            runtime._clear_touch_tracking(job_id)
            fd_open, fd_limit_soft = runtime._fd_metrics()
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
            runtime._safe_add_system_message(user_id=user_id, chat_id=chat_id, job_id=job_id, text=f"Hermes failed permanently: {error_text}")
            runtime.publish_job_event(job_id, JOB_EVENT_ERROR, {"error": error_text, "chat_id": chat_id, "retrying": False})
        except retryable_error_cls as exc:
            error_text = str(exc)
            runtime._terminate_job_children(job_id=job_id, reason="retryable_error")
            retrying = runtime.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=runtime.job_retry_base_seconds, failure_metadata=_job_failure_metadata(runtime, job_id=job_id, error_text=error_text))
            fd_open, fd_limit_soft = runtime._fd_metrics()
            if retrying:
                runtime._record_runtime_counter("retry_scheduled")
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
                runtime.publish_job_event(
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
                runtime.wake_event.set()
            else:
                runtime._record_runtime_counter("retry_exhausted_dead")
                runtime._clear_touch_tracking(job_id)
                state_after_retry = runtime.store.get_job_state(job_id) or {}
                interrupted_replacement = (
                    str(state_after_retry.get("status") or "") == "dead"
                    and str(state_after_retry.get("error") or "") == "interrupted_by_new_message"
                )
                if interrupted_replacement:
                    LOGGER.info(
                        "job_retry_exhausted_suppressed_interrupt job_id=%s user_id=%s chat_id=%s attempts=%s max_attempts=%s error=%s",
                        job_id,
                        user_id,
                        chat_id,
                        attempts,
                        max_attempts,
                        error_text,
                    )
                else:
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
                    display_attempts = runtime._bounded_attempts_for_display(attempts, max_attempts)
                    runtime._safe_add_system_message(user_id=user_id, chat_id=chat_id, job_id=job_id, text=f"Hermes failed after {display_attempts} attempts: {error_text}")
                    runtime.publish_job_event(job_id, JOB_EVENT_ERROR, {"error": error_text, "chat_id": chat_id, "retrying": False})
        except Exception as exc:  # noqa: BLE001 - broad-except-policy: worker loop must quarantine unexpected failures per job
            if runtime.is_stale_chat_job_error(exc):
                error_text = f"Stale chat job dropped: {exc}"
                runtime._terminate_job_children(job_id=job_id, reason="stale_chat_dead")
                runtime.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0, failure_metadata=_job_failure_metadata(runtime, job_id=job_id, error_text=error_text))
                runtime._record_runtime_counter("stale_chat_dead")
                runtime._clear_touch_tracking(job_id)
                fd_open, fd_limit_soft = runtime._fd_metrics()
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
                runtime.publish_job_event(job_id, "meta", {"chat_id": chat_id, "source": "stale-chat", "detail": str(exc)})
                continue
            error_text = f"Unexpected worker failure: {exc}"
            runtime._terminate_job_children(job_id=job_id, reason="unexpected_dead")
            runtime.store.retry_or_dead_letter_job(job_id, error_text, retry_base_seconds=0, failure_metadata=_job_failure_metadata(runtime, job_id=job_id, error_text=error_text))
            runtime._record_runtime_counter("unexpected_dead")
            runtime._clear_touch_tracking(job_id)
            fd_open, fd_limit_soft = runtime._fd_metrics()
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
            runtime._safe_add_system_message(user_id=user_id, chat_id=chat_id, job_id=job_id, text=error_text)
            runtime.publish_job_event(job_id, JOB_EVENT_ERROR, {"error": error_text, "chat_id": chat_id, "retrying": False})
