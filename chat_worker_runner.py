from __future__ import annotations

from typing import TYPE_CHECKING

from job_runtime_chat_job import execute_chat_job

if TYPE_CHECKING:
    from job_runtime import JobRuntime


def run_chat_worker_job(
    runtime: "JobRuntime",
    job: dict[str, object],
    *,
    retryable_error_cls: type[Exception],
    non_retryable_error_cls: type[Exception],
    client_error_cls: type[Exception],
    stream_events_fn=None,
) -> None:
    """Execute one claimed chat job.

    This module is an explicit runner boundary for future worker-process isolation.
    Current behavior remains in-process and delegates to execute_chat_job.
    """

    execute_chat_job(
        runtime,
        job,
        retryable_error_cls=retryable_error_cls,
        non_retryable_error_cls=non_retryable_error_cls,
        client_error_cls=client_error_cls,
        stream_events_fn=stream_events_fn,
    )
