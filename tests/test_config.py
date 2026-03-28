from __future__ import annotations

import pytest

from miniapp_config import MiniAppConfig
from runtime_limits import (
    DEFAULT_JOB_EVENT_HISTORY_MAX_JOBS,
    DEFAULT_JOB_EVENT_HISTORY_TTL_SECONDS,
    MIN_JOB_STALL_TIMEOUT_SECONDS,
)


def _cfg() -> MiniAppConfig:
    return MiniAppConfig.from_env()


def test_config_normalizes_allowed_origins(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_ALLOWED_ORIGINS", " https://APP.EXAMPLE.COM/ ,https://api.example.com ")

    cfg = _cfg()

    assert cfg.allowed_origins == {"https://app.example.com", "https://api.example.com"}


def test_config_rejects_invalid_allowed_origin(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_ALLOWED_ORIGINS", "not-a-url")

    with pytest.raises(ValueError, match="Invalid origin"):
        _cfg()


def test_config_rejects_non_positive_max_content_length(monkeypatch) -> None:
    monkeypatch.setenv("MAX_CONTENT_LENGTH", "0")

    with pytest.raises(ValueError, match="MAX_CONTENT_LENGTH"):
        _cfg()


def test_config_disables_proxy_header_trust_by_default(monkeypatch) -> None:
    monkeypatch.delenv("MINI_APP_TRUST_PROXY_HEADERS", raising=False)

    cfg = _cfg()

    assert cfg.trust_proxy_headers is False


def test_config_rejects_invalid_worker_concurrency(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_JOB_WORKER_CONCURRENCY", "0")

    with pytest.raises(ValueError, match="MINI_APP_JOB_WORKER_CONCURRENCY"):
        _cfg()


def test_config_rejects_invalid_rate_limit_window(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_RATE_LIMIT_WINDOW_SECONDS", "4")

    with pytest.raises(ValueError, match="MINI_APP_RATE_LIMIT_WINDOW_SECONDS"):
        _cfg()


def test_config_uses_centralized_runtime_limit_defaults(monkeypatch) -> None:
    monkeypatch.delenv("MINI_APP_JOB_EVENT_HISTORY_MAX_JOBS", raising=False)
    monkeypatch.delenv("MINI_APP_JOB_EVENT_HISTORY_TTL_SECONDS", raising=False)
    monkeypatch.delenv("MINI_APP_JOB_STALL_TIMEOUT_SECONDS", raising=False)

    cfg = _cfg()

    assert cfg.job_event_history_max_jobs == DEFAULT_JOB_EVENT_HISTORY_MAX_JOBS
    assert cfg.job_event_history_ttl_seconds == DEFAULT_JOB_EVENT_HISTORY_TTL_SECONDS
    assert cfg.job_stall_timeout_seconds >= MIN_JOB_STALL_TIMEOUT_SECONDS
