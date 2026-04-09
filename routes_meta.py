from __future__ import annotations

from typing import Any, Callable, Iterable

from flask import jsonify, request


def register_meta_routes(
    api_bp,
    *,
    allowed_skins: Iterable[str],
    bootstrap_version_fn: Callable[[], str],
    runtime_status_fn: Callable[[], dict[str, Any]] | None = None,
    operator_token: str = "",
) -> None:
    @api_bp.get("/state")
    def state() -> tuple[dict[str, object], int]:
        return {
            "ok": True,
            "skins": sorted(allowed_skins),
            "bootstrap_version": str(bootstrap_version_fn() or ""),
        }, 200

    @api_bp.get("/_operator/runtime")
    def operator_runtime() -> tuple[dict[str, object], int] | Any:
        token = str(operator_token or "").strip()
        if not token or not callable(runtime_status_fn):
            return {"ok": False, "error": "Not found."}, 404
        presented = str(request.headers.get("X-Hermes-Operator-Token") or "").strip()
        if presented != token:
            return {"ok": False, "error": "Not found."}, 404
        payload = dict(runtime_status_fn() or {})
        payload.update({"ok": True})
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store, max-age=0"
        return response
