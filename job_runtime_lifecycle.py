from __future__ import annotations

import logging
import threading
import time
from typing import TYPE_CHECKING

from runtime_limits import JOB_WATCHDOG_SLEEP_SECONDS, JOB_WORKER_WAIT_TIMEOUT_SECONDS

if TYPE_CHECKING:
    from job_runtime import JobRuntime


LOGGER = logging.getLogger(__name__)


def start_runtime_once(runtime: "JobRuntime") -> None:
    if runtime._shutdown_event.is_set():
        LOGGER.info("job_runtime_start_skipped reason=shutdown")
        return

    with runtime._watchdog_lock:
        if not runtime._watchdog_started:
            watchdog = threading.Thread(target=runtime._watchdog_loop, name="miniapp-job-watchdog", daemon=True)
            watchdog.start()
            runtime._watchdog_thread = watchdog
            runtime._watchdog_started = True

    with runtime._worker_start_lock:
        alive_workers = [worker for worker in runtime._worker_threads if worker.is_alive()]
        runtime._worker_threads[:] = alive_workers

        missing = max(0, runtime.job_worker_concurrency - len(alive_workers))
        if missing <= 0:
            return

        for _ in range(missing):
            worker_index = len(runtime._worker_threads) + 1
            worker = threading.Thread(target=runtime._worker_loop, name=f"miniapp-job-worker-{worker_index}", daemon=True)
            worker.start()
            runtime._worker_threads.append(worker)

        runtime.wake_event.set()


def shutdown_runtime(runtime: "JobRuntime", *, reason: str = "shutdown", join_timeout: float = 1.0) -> None:
    with runtime._shutdown_lock:
        if runtime._shutdown_started:
            return
        runtime._shutdown_started = True
        runtime._shutdown_event.set()
        runtime.wake_event.set()

    with runtime._active_job_runner_lock:
        active_job_ids = sorted(int(job_id) for job_id in runtime._active_job_runner_records)

    for job_id in active_job_ids:
        runtime._terminate_job_children(job_id=job_id, reason=f"runtime_{reason}")

    threads: list[threading.Thread] = []
    with runtime._watchdog_lock:
        if runtime._watchdog_thread is not None:
            threads.append(runtime._watchdog_thread)
    with runtime._worker_start_lock:
        threads.extend(runtime._worker_threads)

    deadline = time.monotonic() + max(0.1, float(join_timeout))
    for thread in threads:
        if thread is None or not thread.is_alive():
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        thread.join(timeout=remaining)

    with runtime._watchdog_lock:
        if runtime._watchdog_thread is not None and not runtime._watchdog_thread.is_alive():
            runtime._watchdog_thread = None
            runtime._watchdog_started = False
    with runtime._worker_start_lock:
        runtime._worker_threads[:] = [worker for worker in runtime._worker_threads if worker.is_alive()]


def watchdog_loop(runtime: "JobRuntime") -> None:
    while not runtime._shutdown_event.wait(timeout=JOB_WATCHDOG_SLEEP_SECONDS):
        runtime._sweep_stale_running_jobs()


def worker_loop(runtime: "JobRuntime") -> None:
    while not runtime._shutdown_event.is_set():
        runtime.wake_event.wait(timeout=JOB_WORKER_WAIT_TIMEOUT_SECONDS)
        runtime.wake_event.clear()
        if runtime._shutdown_event.is_set():
            break
        runtime._process_available_jobs_once()


def ensure_pending_jobs(runtime: "JobRuntime", user_id: str) -> None:
    for chat_id, operator_message_id in runtime.store.list_recoverable_pending_turns(user_id):
        job_id = runtime.store.enqueue_chat_job(
            user_id=user_id,
            chat_id=chat_id,
            operator_message_id=operator_message_id,
            max_attempts=runtime.job_max_attempts,
        )
        runtime.publish_job_event(job_id, "meta", {"chat_id": chat_id, "source": "recovered"})
        runtime.wake_event.set()
