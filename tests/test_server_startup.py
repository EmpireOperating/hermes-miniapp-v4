from __future__ import annotations

import logging

from server_startup import log_startup_diagnostics, startup_diagnostics_payload


class _Client:
    def __init__(self, payload):
        self._payload = payload

    def runtime_status(self):
        return self._payload


def test_startup_diagnostics_payload_maps_runtime_fields() -> None:
    client = _Client(
        {
            "startup": {
                "routing": {
                    "selected_transport": "agent-persistent",
                    "stream_url_configured": True,
                    "api_url_configured": False,
                    "direct_agent_enabled": True,
                    "persistent_sessions_requested": True,
                    "persistent_sessions_enabled": True,
                    "persistent_shared_backend_enabled": True,
                    "persistent_worker_owned_enabled": False,
                    "persistent_runtime_ownership_requested": "auto",
                    "persistent_runtime_ownership": "shared",
                    "persistent_sessions_enablement_reason": "shared_backend_runtime_enabled",
                },
                "agent_runtime": {
                    "session_db_available": True,
                    "session_search_ready": True,
                    "agent_python_exists": True,
                    "agent_workdir_exists": True,
                },
            },
            "persistent": {
                "requested": True,
                "enabled": True,
                "ownership": "shared",
                "total": 3,
                "bootstrapped": 2,
                "unbootstrapped": 1,
            },
        }
    )

    payload = startup_diagnostics_payload(
        client=client,
        session_store_path="/tmp/sessions.db",
        bot_token_configured=True,
        debug=False,
        dev_reload=False,
        operator_debug=False,
        request_debug=False,
        stream_timing_debug=False,
        force_secure_cookies=True,
        trust_proxy_headers=True,
        enforce_origin_check=True,
        allowed_origins_count=1,
        rate_limit_window_seconds=60,
        rate_limit_api_requests=20,
        rate_limit_stream_requests=10,
        assistant_chunk_len=1024,
        assistant_hard_limit=1200,
    )

    assert payload["dependencies"]["transport"] == "agent-persistent"
    assert payload["dependencies"]["telegram_bot_token_configured"] is True
    assert payload["dependencies"]["persistent_shared_backend_enabled"] is True
    assert payload["dependencies"]["persistent_worker_owned_enabled"] is False
    assert payload["dependencies"]["persistent_runtime_ownership_requested"] == "auto"
    assert payload["dependencies"]["persistent_runtime_ownership"] == "shared"
    assert payload["dependencies"]["persistent_sessions_enablement_reason"] == "shared_backend_runtime_enabled"
    assert payload["invariants"]["assistant_hard_limit_gte_chunk_len"] is True
    assert payload["invariants"]["origin_check_has_allowlist"] is True
    assert payload["persistent"]["requested"] is True
    assert payload["persistent"]["ownership"] == "shared"
    assert payload["persistent"]["total"] == 3


def test_log_startup_diagnostics_warns_on_failed_invariants(caplog) -> None:
    logger = logging.getLogger("test.server.startup")
    payload = {
        "dependencies": {},
        "config": {},
        "invariants": {
            "assistant_hard_limit_gte_chunk_len": False,
            "origin_check_has_allowlist": True,
        },
        "persistent": {},
    }

    with caplog.at_level(logging.INFO, logger="test.server.startup"):
        log_startup_diagnostics(logger=logger, payload=payload)

    assert any("miniapp startup diagnostics" in message for message in caplog.messages)
    assert any("miniapp startup invariant check failed" in message for message in caplog.messages)
