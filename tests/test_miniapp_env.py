from __future__ import annotations

import os
from pathlib import Path

from miniapp_env import load_env_file_into_environ, resolve_telegram_bot_token


def test_load_env_file_into_environ_sets_missing_values_without_overwriting(monkeypatch, tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text(
        "# comment\nTELEGRAM_BOT_TOKEN=123:abc\nMINI_APP_URL='https://mini.example.com/app'\nEMPTY=\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "keep-me")
    monkeypatch.delenv("MINI_APP_URL", raising=False)
    monkeypatch.delenv("EMPTY", raising=False)

    updates = load_env_file_into_environ(env_path)

    assert updates == {
        "MINI_APP_URL": "https://mini.example.com/app",
        "EMPTY": "",
    }
    assert os.environ["TELEGRAM_BOT_TOKEN"] == "keep-me"
    assert os.environ["MINI_APP_URL"] == "https://mini.example.com/app"
    assert os.environ["EMPTY"] == ""


def test_load_env_file_into_environ_skips_missing_file(tmp_path: Path) -> None:
    updates = load_env_file_into_environ(tmp_path / ".env")

    assert updates == {}


def test_load_env_file_into_environ_disables_flask_dotenv_autoload(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("FLASK_SKIP_DOTENV", raising=False)

    load_env_file_into_environ(tmp_path / ".env")

    assert os.environ["FLASK_SKIP_DOTENV"] == "1"


def test_load_env_file_into_environ_preserves_explicit_alias_group_values(monkeypatch, tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text(
        "MINIAPP_DEV_BYPASS=1\nMINIAPP_DEV_BYPASS_EXPIRES_AT=100\nMINIAPP_DEV_SECRET=file-secret\n",
        encoding="utf-8",
    )
    previous_expiry = os.environ.get("MINIAPP_DEV_BYPASS_EXPIRES_AT")
    previous_secret = os.environ.get("MINIAPP_DEV_SECRET")
    monkeypatch.setenv("MINIAPP_DEV_BYPASS", "1")

    updates = load_env_file_into_environ(
        env_path,
        preserve_alias_groups=((
            "MINIAPP_DEV_BYPASS",
            "MINI_APP_DEV_BYPASS",
            "MINIAPP_DEV_BYPASS_EXPIRES_AT",
            "MINI_APP_DEV_BYPASS_EXPIRES_AT",
            "MINIAPP_DEV_SECRET",
            "MINI_APP_DEV_SECRET",
            "MINI_APP_DEV_AUTH_SECRET",
        ),),
    )

    assert updates == {}
    assert os.environ.get("MINIAPP_DEV_BYPASS") == "1"
    assert os.environ.get("MINIAPP_DEV_BYPASS_EXPIRES_AT") == previous_expiry
    assert os.environ.get("MINIAPP_DEV_SECRET") == previous_secret


def test_load_env_file_into_environ_can_reuse_shared_hermes_telegram_token_with_opt_in(monkeypatch, tmp_path: Path) -> None:
    miniapp_env_path = tmp_path / ".env"
    miniapp_env_path.write_text(
        "MINI_APP_USE_HERMES_TELEGRAM_BOT_TOKEN=1\nMINI_APP_URL=https://mini.example.com/app\n",
        encoding="utf-8",
    )
    hermes_home = tmp_path / "hermes-home"
    hermes_home.mkdir()
    (hermes_home / ".env").write_text("TELEGRAM_BOT_TOKEN=123456:shared-token\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)

    updates = load_env_file_into_environ(miniapp_env_path)

    assert updates["TELEGRAM_BOT_TOKEN"] == "123456:shared-token"
    assert os.environ["TELEGRAM_BOT_TOKEN"] == "123456:shared-token"


def test_resolve_telegram_bot_token_uses_shared_hermes_env_only_with_opt_in(monkeypatch, tmp_path: Path) -> None:
    hermes_home = tmp_path / "hermes-home"
    hermes_home.mkdir()
    (hermes_home / ".env").write_text("TELEGRAM_BOT_TOKEN=123456:shared-token\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("MINI_APP_USE_HERMES_TELEGRAM_BOT_TOKEN", raising=False)

    token, source = resolve_telegram_bot_token({})
    assert token == ""
    assert source is None

    token, source = resolve_telegram_bot_token({"MINI_APP_USE_HERMES_TELEGRAM_BOT_TOKEN": "1"})
    assert token == "123456:shared-token"
    assert source == "hermes_shared_env"
