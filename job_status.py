from __future__ import annotations

JOB_STATUS_QUEUED = "queued"
JOB_STATUS_RUNNING = "running"
JOB_STATUS_DONE = "done"
JOB_STATUS_ERROR = "error"
JOB_STATUS_DEAD = "dead"

JOB_STATUS_ALL: tuple[str, ...] = (
    JOB_STATUS_QUEUED,
    JOB_STATUS_RUNNING,
    JOB_STATUS_DONE,
    JOB_STATUS_ERROR,
    JOB_STATUS_DEAD,
)

JOB_STATUS_OPEN: frozenset[str] = frozenset({JOB_STATUS_QUEUED, JOB_STATUS_RUNNING})
JOB_STATUS_TERMINAL: frozenset[str] = frozenset({JOB_STATUS_DONE, JOB_STATUS_ERROR, JOB_STATUS_DEAD})
JOB_STATUS_RETRYABLE: frozenset[str] = frozenset({JOB_STATUS_QUEUED, JOB_STATUS_RUNNING})

JOB_EVENT_DONE = "done"
JOB_EVENT_ERROR = "error"
JOB_EVENT_TERMINAL: frozenset[str] = frozenset({JOB_EVENT_DONE, JOB_EVENT_ERROR})


def is_open_job_status(status: object) -> bool:
    return str(status or "") in JOB_STATUS_OPEN


def is_terminal_job_status(status: object) -> bool:
    return str(status or "") in JOB_STATUS_TERMINAL


def sql_status_list(statuses: tuple[str, ...] | frozenset[str]) -> str:
    return ", ".join(f"'{status}'" for status in statuses)


SQL_JOB_STATUS_ALL = f"({sql_status_list(JOB_STATUS_ALL)})"
SQL_JOB_STATUS_OPEN = f"({sql_status_list((JOB_STATUS_QUEUED, JOB_STATUS_RUNNING))})"
SQL_JOB_STATUS_TERMINAL = f"({sql_status_list((JOB_STATUS_DONE, JOB_STATUS_ERROR, JOB_STATUS_DEAD))})"
