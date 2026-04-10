from __future__ import annotations

import json
import time
from typing import Any, Callable, Iterable

from flask import jsonify, request


def register_meta_routes(
    api_bp,
    *,
    allowed_skins: Iterable[str],
    bootstrap_version_fn: Callable[[], str],
    runtime_status_fn: Callable[[], dict[str, Any]] | None = None,
    record_boot_summary_fn: Callable[[dict[str, Any]], None] | None = None,
    recent_boot_summaries_fn: Callable[[], list[dict[str, Any]]] | None = None,
    operator_token: str = "",
) -> None:
    def _sanitize_boot_summary(raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict):
            return {}
        cleaned: dict[str, Any] = {}
        for key, value in raw.items():
            normalized_key = str(key or "").strip()
            if not normalized_key:
                continue
            if isinstance(value, bool) or value is None:
                cleaned[normalized_key] = value
                continue
            if isinstance(value, (int, float)):
                cleaned[normalized_key] = value
                continue
            if isinstance(value, str):
                cleaned[normalized_key] = value[:256]
        return cleaned

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
        if callable(recent_boot_summaries_fn):
            payload["recent_client_boot_summaries"] = list(recent_boot_summaries_fn() or [])
        payload.update({"ok": True})
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store, max-age=0"
        return response

    @api_bp.post("/telemetry/boot")
    def boot_telemetry() -> tuple[dict[str, object], int]:
        if not callable(record_boot_summary_fn):
            return {"ok": False, "error": "Not found."}, 404
        payload: Any = {}
        raw_body = request.get_data(cache=True, as_text=True) or ""
        if raw_body:
            try:
                payload = json.loads(raw_body)
            except Exception:
                payload = {}
        if not isinstance(payload, dict):
            payload = {}
        if not payload:
            try:
                payload = request.get_json(silent=True) or {}
            except Exception:
                payload = {}
        summary = _sanitize_boot_summary(payload)
        if not summary:
            return {"ok": False, "error": "Invalid boot summary."}, 400
        summary.update(
            {
                "serverRecordedAtMs": int(time.time() * 1000),
                "remoteAddr": str(request.headers.get("CF-Connecting-IP") or request.headers.get("X-Forwarded-For") or request.remote_addr or "")[:128],
                "userAgent": str(request.headers.get("User-Agent") or "")[:256],
            }
        )
        record_boot_summary_fn(summary)
        response = jsonify({"ok": True})
        response.headers["Cache-Control"] = "no-store, max-age=0"
        return response, 200
