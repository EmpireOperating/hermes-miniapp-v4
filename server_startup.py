from __future__ import annotations

import json
from typing import Any

from logging import Logger


def startup_diagnostics_payload(
    *,
    client: Any,
    session_store_path: str,
    bot_token_configured: bool,
    debug: bool,
    dev_reload: bool,
    request_debug: bool,
    force_secure_cookies: bool,
    trust_proxy_headers: bool,
    enforce_origin_check: bool,
    allowed_origins_count: int,
    rate_limit_window_seconds: int,
    rate_limit_api_requests: int,
    rate_limit_stream_requests: int,
    assistant_chunk_len: int,
    assistant_hard_limit: int,
) -> dict[str, object]:
    runtime_status = client.runtime_status()
    startup = runtime_status.get("startup") if isinstance(runtime_status, dict) else {}
    startup = startup if isinstance(startup, dict) else {}
    startup_routing = startup.get("routing") if isinstance(startup, dict) else {}
    startup_routing = startup_routing if isinstance(startup_routing, dict) else {}
    startup_agent_runtime = startup.get("agent_runtime") if isinstance(startup, dict) else {}
    startup_agent_runtime = startup_agent_runtime if isinstance(startup_agent_runtime, dict) else {}
    persistent = runtime_status.get("persistent") if isinstance(runtime_status, dict) else {}
    persistent = persistent if isinstance(persistent, dict) else {}

    assistant_limits_valid = assistant_hard_limit >= assistant_chunk_len
    origin_allowlist_ready = (not enforce_origin_check) or bool(allowed_origins_count)

    return {
        "dependencies": {
            "telegram_bot_token_configured": bool(bot_token_configured),
            "session_store_path": session_store_path,
            "transport": str(startup_routing.get("selected_transport") or "unknown"),
            "stream_url_configured": bool(startup_routing.get("stream_url_configured")),
            "api_url_configured": bool(startup_routing.get("api_url_configured")),
            "direct_agent_enabled": bool(startup_routing.get("direct_agent_enabled")),
            "persistent_sessions_enabled": bool(startup_routing.get("persistent_sessions_enabled")),
            "session_db_available": bool(startup_agent_runtime.get("session_db_available")),
            "session_search_ready": bool(startup_agent_runtime.get("session_search_ready")),
            "agent_python_exists": bool(startup_agent_runtime.get("agent_python_exists")),
            "agent_workdir_exists": bool(startup_agent_runtime.get("agent_workdir_exists")),
        },
        "config": {
            "debug": debug,
            "dev_reload": dev_reload,
            "request_debug": request_debug,
            "force_secure_cookies": force_secure_cookies,
            "trust_proxy_headers": trust_proxy_headers,
            "enforce_origin_check": enforce_origin_check,
            "allowed_origin_count": allowed_origins_count,
            "rate_limit_window_seconds": rate_limit_window_seconds,
            "rate_limit_api_requests": rate_limit_api_requests,
            "rate_limit_stream_requests": rate_limit_stream_requests,
        },
        "invariants": {
            "assistant_hard_limit_gte_chunk_len": assistant_limits_valid,
            "origin_check_has_allowlist": origin_allowlist_ready,
            "rate_limit_api_gte_stream": rate_limit_api_requests >= rate_limit_stream_requests,
        },
        "persistent": {
            "enabled": bool(persistent.get("enabled")),
            "total": int(persistent.get("total", 0)),
            "bootstrapped": int(persistent.get("bootstrapped", 0)),
            "unbootstrapped": int(persistent.get("unbootstrapped", 0)),
        },
    }


def log_startup_diagnostics(*, logger: Logger, payload: dict[str, object]) -> None:
    logger.info("miniapp startup diagnostics %s", json.dumps(payload, sort_keys=True, separators=(",", ":")))

    failing_invariants = [name for name, ok in (payload.get("invariants") or {}).items() if ok is False]
    if failing_invariants:
        logger.warning("miniapp startup invariant check failed: %s", ",".join(sorted(failing_invariants)))
