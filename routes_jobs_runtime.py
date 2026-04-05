from __future__ import annotations

from typing import Any, Callable

from job_status import JOB_STATUS_DEAD, JOB_STATUS_DONE, JOB_STATUS_ERROR, JOB_STATUS_QUEUED, JOB_STATUS_RUNNING
from validators import parse_bounded_int


def register_jobs_runtime_routes(
    api_bp,
    *,
    store_getter: Callable[[], Any],
    client_getter: Callable[[], Any],
    runtime_getter: Callable[[], Any],
    request_payload_fn: Callable[[], dict[str, object]],
    json_user_id_or_error_fn: Callable[[dict[str, object]], tuple[str | None, tuple[dict[str, object], int] | None]],
    verify_for_json_fn: Callable[[dict[str, object]], tuple[Any | None, tuple[dict[str, object], int] | None]],
) -> None:
    @api_bp.post("/jobs/status")
    def jobs_status() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error

        store = store_getter()
        limit, limit_error = parse_bounded_int(payload, "limit", default=25, min_value=1, max_value=200)
        if limit_error:
            return limit_error

        jobs = store.list_jobs(user_id=user_id, limit=limit)
        dead_letters = store.list_dead_letters(user_id=user_id, limit=limit)
        summary = {
            "queued": sum(1 for job in jobs if job["status"] == JOB_STATUS_QUEUED),
            "running": sum(1 for job in jobs if job["status"] == JOB_STATUS_RUNNING),
            "done": sum(1 for job in jobs if job["status"] == JOB_STATUS_DONE),
            "error": sum(1 for job in jobs if job["status"] == JOB_STATUS_ERROR),
            "dead": sum(1 for job in jobs if job["status"] == JOB_STATUS_DEAD),
            "dead_letter_count": len(dead_letters),
        }
        return {"ok": True, "summary": summary, "jobs": jobs, "dead_letters": dead_letters}, 200

    @api_bp.post("/jobs/cleanup")
    def jobs_cleanup() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error

        limit, limit_error = parse_bounded_int(payload, "limit", default=200, min_value=1, max_value=1000)
        if limit_error:
            return limit_error

        cleaned = store_getter().cleanup_stale_jobs(user_id=user_id, limit=limit)
        return {
            "ok": True,
            "cleaned_count": len(cleaned),
            "cleaned": cleaned,
        }, 200

    @api_bp.post("/runtime/status")
    def runtime_status() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        _, auth_error = verify_for_json_fn(payload)
        if auth_error:
            return auth_error

        runtime_payload = client_getter().runtime_status()
        runtime_diagnostics = runtime_getter().runtime_diagnostics()
        return {
            "ok": True,
            "persistent": runtime_payload.get("persistent") or {},
            "routing": runtime_payload.get("routing") or {},
            "warm_sessions": runtime_payload.get("warm_sessions") or {},
            "health": runtime_payload.get("health") or {},
            "runtime": runtime_diagnostics,
        }, 200
