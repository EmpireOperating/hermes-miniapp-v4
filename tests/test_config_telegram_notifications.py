from __future__ import annotations

import pytest

from miniapp_config import MiniAppConfig


@pytest.fixture(autouse=True)
def _clear_notification_env(monkeypatch) -> None:
    monkeypatch.delenv("MINI_APP_TELEGRAM_NOTIFICATION_TIMEOUT_SECONDS", raising=False)


def _cfg() -> MiniAppConfig:
    return MiniAppConfig.from_env()


def test_config_reads_telegram_notification_timeout_seconds(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_TELEGRAM_NOTIFICATION_TIMEOUT_SECONDS", "11")

    cfg = _cfg()

    assert cfg.telegram_notification_send_timeout_seconds == 11


def test_config_rejects_invalid_telegram_notification_timeout_seconds(monkeypatch) -> None:
    monkeypatch.setenv("MINI_APP_TELEGRAM_NOTIFICATION_TIMEOUT_SECONDS", "0")

    with pytest.raises(ValueError, match="MINI_APP_TELEGRAM_NOTIFICATION_TIMEOUT_SECONDS"):
        _cfg()
