from __future__ import annotations

import pytest

from miniapp_config import MiniAppConfig


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
