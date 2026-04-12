from __future__ import annotations

import os
import time
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from job_runtime import JobRuntime


DEAD_LETTER_COUNTER_KEYS = {
    "retry_exhausted_dead",
    "non_retryable_dead",
    "unexpected_dead",
    "stale_chat_dead",
    "stale_timeout_dead",
}


def rate_windows() -> dict[str, int]:
    return {"5m": 300, "15m": 900, "60m": 3600}


def runtime_rate_windows(runtime: "JobRuntime", *, monotonic_fn: Callable[[], float] = time.monotonic) -> dict[str, dict[str, int]]:
    windows = rate_windows()
    now = monotonic_fn()
    with runtime._runtime_counter_lock:
        timeline = list(runtime._runtime_counter_timeline)

    result: dict[str, dict[str, int]] = {}
    for label, window_seconds in windows.items():
        retry_scheduled = 0
        dead_letter = 0
        for ts, key, delta in timeline:
            if now - ts > window_seconds:
                continue
            if key == "retry_scheduled":
                retry_scheduled += int(delta)
            if key in DEAD_LETTER_COUNTER_KEYS:
                dead_letter += int(delta)
        result[label] = {
            "retry_scheduled": int(retry_scheduled),
            "dead_letter": int(dead_letter),
        }
    return result


def severity_hint(
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


def worker_isolation_boundary_signal(launcher_info: dict[str, object], *, os_name: str = os.name) -> dict[str, object]:
    info = dict(launcher_info or {})
    launcher_name = str(info.get("name") or "").strip().lower()
    isolation_mode = str(info.get("isolation") or "").strip().lower()

    boundary_active = bool(launcher_name == "subprocess" or isolation_mode == "process")

    limits_payload = info.get("limits") if isinstance(info.get("limits"), dict) else {}
    required_limits = ("memory_mb", "max_tasks", "max_open_files")
    limits_present = all(int(limits_payload.get(key, 0) or 0) > 0 for key in required_limits)

    boundary_enforced = bool(boundary_active and limits_present and os_name == "posix")

    if boundary_enforced:
        reason = "process_boundary_with_posix_rlimits"
    elif boundary_active and not limits_present:
        reason = "process_boundary_missing_limits"
    elif boundary_active and os_name != "posix":
        reason = "process_boundary_without_posix_rlimits"
    else:
        reason = "in_process_launcher"

    return {
        "active": boundary_active,
        "enforced": boundary_enforced,
        "reason": reason,
    }


def _is_transport_fallback(transition: dict[str, object]) -> bool:
    previous_path = str((transition or {}).get("previous_path") or "").strip().lower()
    next_path = str((transition or {}).get("next_path") or "").strip().lower()
    if not next_path or next_path == previous_path:
        return False
    return previous_path not in {"", "none"}


def _active_job_current_path(record: dict[str, object]) -> str:
    transitions = list((record or {}).get("recent_transport_transitions") or [])
    if transitions:
        latest = dict(transitions[-1] or {})
        current_path = str(latest.get("next_path") or "").strip()
        if current_path:
            return current_path
    return "unknown"


def build_operator_summary(
    *,
    active_job_transport_snapshots: list[dict[str, object]],
    recent_transport_transitions: list[dict[str, object]],
    child_timeouts: dict[str, object],
    launcher_info: dict[str, object],
    queue_diagnostics: dict[str, object],
    severity: dict[str, str],
    now: int,
) -> dict[str, object]:
    active_paths: dict[str, int] = {}
    active_latest_transition_reasons: dict[str, int] = {}
    active_resume_job_total = 0
    suspicious_active_jobs: list[dict[str, object]] = []

    for record in active_job_transport_snapshots:
        current_path = _active_job_current_path(record)
        active_paths[current_path] = int(active_paths.get(current_path, 0)) + 1

        transitions = [dict(item or {}) for item in list(record.get("recent_transport_transitions") or [])]
        latest_transition = transitions[-1] if transitions else None
        latest_transition_reason = str((latest_transition or {}).get("reason") or "").strip() or None
        if latest_transition_reason is not None:
            active_latest_transition_reasons[latest_transition_reason] = (
                int(active_latest_transition_reasons.get(latest_transition_reason, 0)) + 1
            )
            if "resume" in latest_transition_reason.lower():
                active_resume_job_total += 1

        fallback_transitions = [item for item in transitions if _is_transport_fallback(item)]
        latest_fallback = fallback_transitions[-1] if fallback_transitions else None
        last_progress_at = int(record.get("last_progress_at") or record.get("started_at") or 0)
        idle_seconds = max(0, int(now - last_progress_at)) if last_progress_at > 0 else None

        suspicion_reasons: list[str] = []
        if latest_fallback is not None:
            suspicion_reasons.append("recent_transport_fallback")
        if current_path == "cli":
            suspicion_reasons.append("active_on_cli_path")
        if idle_seconds is not None and idle_seconds >= 30:
            suspicion_reasons.append("idle_without_progress_30s")

        if suspicion_reasons:
            suspicious_active_jobs.append(
                {
                    "job_id": record.get("job_id"),
                    "chat_id": record.get("chat_id"),
                    "session_id": record.get("session_id"),
                    "current_path": current_path,
                    "latest_transition_reason": latest_transition_reason,
                    "idle_seconds": idle_seconds,
                    "suspicion_reasons": suspicion_reasons,
                    "latest_fallback_reason": str((latest_fallback or {}).get("reason") or "") or None,
                }
            )

    fallback_transitions = [dict(item or {}) for item in recent_transport_transitions if _is_transport_fallback(dict(item or {}))]
    cli_fallbacks = [
        item for item in fallback_transitions if str((item or {}).get("next_path") or "").strip().lower() == "cli"
    ]
    recent_fallback_reasons: dict[str, int] = {}
    for item in fallback_transitions:
        reason = str((item or {}).get("reason") or "unknown").strip() or "unknown"
        recent_fallback_reasons[reason] = int(recent_fallback_reasons.get(reason, 0)) + 1

    timeout_jobs = sorted(str(key) for key in dict(child_timeouts.get("by_job") or {}).keys())
    timeout_chats = sorted(str(key) for key in dict(child_timeouts.get("by_chat") or {}).keys())
    last_limit_breach = str((launcher_info or {}).get("last_limit_breach") or "").strip() or None
    last_limit_breach_detail = str((launcher_info or {}).get("last_limit_breach_detail") or "").strip() or None
    startup_recovered_running_total = int((queue_diagnostics or {}).get("startup_recovered_running_total", 0) or 0)
    startup_clamped_exhausted_total = int((queue_diagnostics or {}).get("startup_clamped_exhausted_total", 0) or 0)
    preclaim_dead_letter_total = int((queue_diagnostics or {}).get("preclaim_dead_letter_total", 0) or 0)

    return {
        "generated_at": int(now),
        "status": dict(severity or {}),
        "active_job_total": len(active_job_transport_snapshots),
        "active_paths": active_paths,
        "active_latest_transition_reasons": active_latest_transition_reasons,
        "active_resume_job_total": int(active_resume_job_total),
        "fallback_transition_total_recent": len(fallback_transitions),
        "cli_fallback_total_recent": len(cli_fallbacks),
        "recent_fallback_reasons": recent_fallback_reasons,
        "child_timeout_total": int(child_timeouts.get("total", 0) or 0),
        "timeout_affected_jobs": timeout_jobs,
        "timeout_affected_chats": timeout_chats,
        "startup_recovered_running_total": startup_recovered_running_total,
        "startup_clamped_exhausted_total": startup_clamped_exhausted_total,
        "preclaim_dead_letter_total": preclaim_dead_letter_total,
        "launcher_limit_breach": last_limit_breach,
        "launcher_limit_breach_detail": last_limit_breach_detail,
        "suspicious_active_jobs": suspicious_active_jobs,
    }


def build_runtime_diagnostics(
    runtime: "JobRuntime",
    *,
    time_fn: Callable[[], float] = time.time,
    monotonic_fn: Callable[[], float] = time.monotonic,
) -> dict[str, object]:
    fd_open, fd_limit_soft = runtime._fd_metrics()
    with runtime._runtime_counter_lock:
        counters = dict(runtime._runtime_counters)

    child_diagnostics_getter = getattr(runtime.client, "child_spawn_diagnostics", None)
    child_diagnostics = child_diagnostics_getter() if callable(child_diagnostics_getter) else {}

    dead_letter_total = sum(int(counters.get(key, 0)) for key in DEAD_LETTER_COUNTER_KEYS)

    queue_diagnostics = runtime.store.job_queue_diagnostics() if hasattr(runtime.store, "job_queue_diagnostics") else {}
    startup_recovered_running_total = int(queue_diagnostics.get("startup_recovered_running_total", 0) or 0)
    startup_clamped_exhausted_total = int(queue_diagnostics.get("startup_clamped_exhausted_total", 0) or 0)
    preclaim_dead_letter_total = int(queue_diagnostics.get("preclaim_dead_letter_total", 0) or 0)
    notification_attempts = (
        runtime.store.list_telegram_notification_attempts(limit=10)
        if hasattr(runtime.store, "list_telegram_notification_attempts")
        else []
    )

    with runtime._worker_start_lock:
        worker_alive = sum(1 for worker in runtime._worker_threads if worker.is_alive())

    with runtime._active_job_runner_lock:
        active_job_records = [dict(record) for _job_id, record in sorted(runtime._active_job_runner_records.items())]

    terminal_events = runtime._event_broker.terminal_rollup(limit=12, error_limit=6)
    runtime_windows = runtime_rate_windows(runtime, monotonic_fn=monotonic_fn)
    terminal_windows = runtime._event_broker.terminal_window_counts(windows=rate_windows())
    severity = severity_hint(
        worker_alive=worker_alive,
        worker_configured=runtime.job_worker_concurrency,
        terminal_window_5m=terminal_windows.get("5m", {}),
        runtime_window_5m=runtime_windows.get("5m", {}),
    )

    launcher_describe = getattr(runtime.worker_launcher, "describe", None)
    launcher_info = launcher_describe() if callable(launcher_describe) else {"name": type(runtime.worker_launcher).__name__}
    isolation_boundary = worker_isolation_boundary_signal(launcher_info)
    child_timeouts = (child_diagnostics.get("timeouts") if isinstance(child_diagnostics, dict) else None) or {}
    child_timeouts_total = int(child_timeouts.get("total", 0) or 0)
    recent_transport_transitions = list(
        (child_diagnostics.get("recent_transport_transitions") if isinstance(child_diagnostics, dict) else None) or []
    )
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

    generated_at = int(time_fn())
    operator_summary = build_operator_summary(
        active_job_transport_snapshots=active_job_transport_snapshots,
        recent_transport_transitions=recent_transport_transitions,
        child_timeouts=child_timeouts,
        launcher_info=launcher_info,
        queue_diagnostics=queue_diagnostics,
        severity=severity,
        now=generated_at,
    )

    incident_snapshot = {
        "generated_at": generated_at,
        "telegram_notifications": {
            "recent_attempts": notification_attempts,
        },
        "workers": {
            "configured": int(runtime.job_worker_concurrency),
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
        "wake_event_set": bool(runtime.wake_event.is_set()),
        "terminal_events": terminal_events,
        "rate_windows": {
            "runtime": runtime_windows,
            "terminal": terminal_windows,
        },
        "severity_hint": severity,
        "operator_summary": operator_summary,
    }

    return {
        "fd_open": fd_open,
        "fd_limit_soft": fd_limit_soft,
        "retry_scheduled_total": int(counters.get("retry_scheduled", 0)),
        "dead_letter_total": int(dead_letter_total),
        "counters": counters,
        "best_effort_failures": runtime.best_effort_failure_counts(),
        "telegram_notifications": {
            "recent_attempts": notification_attempts,
        },
        "queue_diagnostics": {
            "startup_recovered_running_total": startup_recovered_running_total,
            "startup_clamped_exhausted_total": startup_clamped_exhausted_total,
            "preclaim_dead_letter_total": preclaim_dead_letter_total,
        },
        "children": child_diagnostics,
        "child_timeouts": child_timeouts,
        "isolation_boundary": isolation_boundary,
        "operator_summary": operator_summary,
        "incident_snapshot": incident_snapshot,
        "startup_recovered_running_total": startup_recovered_running_total,
        "startup_clamped_exhausted_total": startup_clamped_exhausted_total,
        "preclaim_dead_letter_total": preclaim_dead_letter_total,
    }
