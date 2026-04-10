from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from job_runtime import JobRuntime


LOGGER = logging.getLogger(__name__)


def try_start_job_runner(runtime: "JobRuntime", *, job_id: int, user_id: str, chat_id: int) -> bool:
    safe_job_id = int(job_id)
    with runtime._active_job_runner_lock:
        if safe_job_id in runtime._active_job_runner_records:
            return False
        session_id = str(runtime.session_id_builder(str(user_id or ""), int(chat_id)) or "")
        runtime._active_job_runner_records[safe_job_id] = {
            "job_id": safe_job_id,
            "user_id": str(user_id or ""),
            "chat_id": int(chat_id),
            "session_id": session_id,
            "started_at": int(time.time()),
            "last_progress_at": int(time.time()),
        }
        note_started = getattr(runtime.client, "note_warm_session_worker_started", None)
        if callable(note_started):
            note_started(session_id=session_id, chat_id=int(chat_id), job_id=safe_job_id)
        return True


def finish_job_runner(runtime: "JobRuntime", job_id: int, *, outcome: str = "finished") -> None:
    with runtime._active_job_runner_lock:
        record = runtime._active_job_runner_records.pop(int(job_id), None)
    if not isinstance(record, dict):
        return
    note_finished = getattr(runtime.client, "note_warm_session_worker_finished", None)
    if callable(note_finished):
        note_finished(
            session_id=str(record.get("session_id") or ""),
            chat_id=int(record.get("chat_id") or 0),
            job_id=int(record.get("job_id") or 0),
            outcome=str(outcome or "finished"),
        )


def terminate_job_children(runtime: "JobRuntime", *, job_id: int, reason: str) -> None:
    terminator = getattr(runtime.client, "terminate_tracked_children", None)
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
