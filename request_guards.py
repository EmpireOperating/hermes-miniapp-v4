from __future__ import annotations

from collections.abc import Callable

from flask import Response, g, jsonify, request


def resolve_rate_limit_identity(
    *,
    remote_addr: str,
    auth_cookie_name: str,
    verify_auth_session_token_fn: Callable[[str], str | None],
) -> str:
    token = str(request.cookies.get(auth_cookie_name, "") or "").strip()
    if token:
        user_id = verify_auth_session_token_fn(token)
        if user_id:
            return f"user:{user_id}|ip:{remote_addr}"
    return f"ip:{remote_addr}"


def enforce_api_request_guards(
    *,
    origin_allowed_fn: Callable[[], bool],
    check_rate_limit_fn: Callable[[str, int, int], bool],
    rate_limit_window_seconds: int,
    rate_limit_api_requests: int,
    rate_limit_stream_requests: int,
    new_request_id_fn: Callable[[], str],
    now_ms_fn: Callable[[], float],
    auth_cookie_name: str,
    verify_auth_session_token_fn: Callable[[str], str | None],
) -> Response | None:
    g.request_id = new_request_id_fn()
    g.request_started_ms = now_ms_fn()

    if request.path.startswith("/api") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if request.mimetype != "application/json":
            return jsonify({"ok": False, "error": "Content-Type must be application/json."}), 415
        if not origin_allowed_fn():
            return jsonify({"ok": False, "error": "Origin not allowed."}), 403

    if not request.path.startswith("/api"):
        return None

    remote = (request.remote_addr or "unknown").strip()
    identity = resolve_rate_limit_identity(
        remote_addr=remote,
        auth_cookie_name=auth_cookie_name,
        verify_auth_session_token_fn=verify_auth_session_token_fn,
    )

    if request.path in {"/api/chat/stream", "/api/chat/stream/resume"}:
        ok = check_rate_limit_fn(f"stream:{identity}", rate_limit_stream_requests, rate_limit_window_seconds)
    else:
        ok = check_rate_limit_fn(f"api:{identity}", rate_limit_api_requests, rate_limit_window_seconds)

    if not ok:
        return jsonify({"ok": False, "error": "Rate limit exceeded. Please slow down."}), 429

    return None
