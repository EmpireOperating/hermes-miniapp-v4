from __future__ import annotations

from typing import Any, Callable


def register_jobs_runtime_routes(
    api_bp,
    *,
    store_getter: Callable[[], Any],
    client_getter: Callable[[], Any],
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
        limit = int(payload.get("limit") or 25)
        jobs = store.list_jobs(user_id=user_id, limit=limit)
        dead_letters = store.list_dead_letters(user_id=user_id, limit=limit)
        summary = {
            "queued": sum(1 for job in jobs if job["status"] == "queued"),
            "running": sum(1 for job in jobs if job["status"] == "running"),
            "done": sum(1 for job in jobs if job["status"] == "done"),
            "error": sum(1 for job in jobs if job["status"] == "error"),
            "dead": sum(1 for job in jobs if job["status"] == "dead"),
            "dead_letter_count": len(dead_letters),
        }
        return {"ok": True, "summary": summary, "jobs": jobs, "dead_letters": dead_letters}, 200

    @api_bp.post("/jobs/cleanup")
    def jobs_cleanup() -> tuple[dict[str, object], int]:
        payload = request_payload_fn()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error

        limit = int(payload.get("limit") or 200)
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
        return {
            "ok": True,
            "persistent": runtime_payload.get("persistent") or {},
            "routing": runtime_payload.get("routing") or {},
        }, 200
