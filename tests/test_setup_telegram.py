from __future__ import annotations

from pathlib import Path

from scripts import setup_telegram


def test_healthcheck_url_uses_origin_root() -> None:
    assert setup_telegram.healthcheck_url("https://mini.example.com/app") == "https://mini.example.com/health"
    assert setup_telegram.healthcheck_url("https://mini.example.com/nested/app?x=1") == "https://mini.example.com/health"


def test_main_success_validates_url_and_configures_menu_button(monkeypatch, tmp_path: Path, capsys) -> None:
    (tmp_path / ".env").write_text(
        "TELEGRAM_BOT_TOKEN=123456:real-token\n"
        "MINI_APP_URL=https://mini.example.com/app\n"
        "HERMES_API_URL=https://hermes.example.com/api\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(setup_telegram, "project_root", lambda: tmp_path)

    http_calls: list[str] = []

    def fake_http_get(url: str, *, timeout: float = 10.0) -> setup_telegram.HttpCheck:
        http_calls.append(url)
        return setup_telegram.HttpCheck(url=url, status=200, ok=True)

    telegram_calls: list[tuple[str, dict | None]] = []

    def fake_telegram_call(token: str, method: str, payload: dict | None = None, *, timeout: float = 10.0) -> dict:
        assert token == "123456:real-token"
        telegram_calls.append((method, payload))
        if method == "getMe":
            return {"ok": True, "result": {"id": 1, "username": "miniapp_demo_bot"}}
        if method == "setChatMenuButton":
            return {"ok": True, "result": True}
        if method == "getChatMenuButton":
            return {
                "ok": True,
                "result": {
                    "type": "web_app",
                    "text": "Open App",
                    "web_app": {"url": "https://mini.example.com/app"},
                },
            }
        raise AssertionError(f"unexpected Telegram method: {method}")

    monkeypatch.setattr(setup_telegram, "http_get", fake_http_get)
    monkeypatch.setattr(setup_telegram, "telegram_api_call", fake_telegram_call)

    exit_code = setup_telegram.main([])

    assert exit_code == 0
    assert http_calls == [
        "https://mini.example.com/app",
        "https://mini.example.com/health",
    ]
    assert telegram_calls == [
        ("getMe", None),
        (
            "setChatMenuButton",
            {
                "menu_button": {
                    "type": "web_app",
                    "text": "Open App",
                    "web_app": {"url": "https://mini.example.com/app"},
                }
            },
        ),
        ("getChatMenuButton", None),
    ]
    output = capsys.readouterr().out
    assert "Telegram bot verified: @miniapp_demo_bot" in output
    assert "Configured Telegram menu button to open https://mini.example.com/app" in output
    assert "Open the bot in Telegram and tap the menu button" in output


def test_main_fails_when_public_url_is_not_reachable(monkeypatch, tmp_path: Path, capsys) -> None:
    (tmp_path / ".env").write_text(
        "TELEGRAM_BOT_TOKEN=123456:real-token\n"
        "MINI_APP_URL=https://mini.example.com/app\n"
        "HERMES_API_URL=https://hermes.example.com/api\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(setup_telegram, "project_root", lambda: tmp_path)
    monkeypatch.setattr(
        setup_telegram,
        "http_get",
        lambda url, *, timeout=10.0: setup_telegram.HttpCheck(url=url, status=None, ok=False, detail="temporary TLS failure"),
    )

    exit_code = setup_telegram.main([])

    assert exit_code == 1
    output = capsys.readouterr().out
    assert "Could not reach MINI_APP_URL over HTTPS" in output
    assert "temporary TLS failure" in output


def test_main_fails_when_menu_button_verification_does_not_match(monkeypatch, tmp_path: Path, capsys) -> None:
    (tmp_path / ".env").write_text(
        "TELEGRAM_BOT_TOKEN=123456:real-token\n"
        "MINI_APP_URL=https://mini.example.com/app\n"
        "HERMES_API_URL=https://hermes.example.com/api\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(setup_telegram, "project_root", lambda: tmp_path)
    monkeypatch.setattr(
        setup_telegram,
        "http_get",
        lambda url, *, timeout=10.0: setup_telegram.HttpCheck(url=url, status=200, ok=True),
    )

    def fake_telegram_call(token: str, method: str, payload: dict | None = None, *, timeout: float = 10.0) -> dict:
        if method == "getMe":
            return {"ok": True, "result": {"id": 1, "username": "miniapp_demo_bot"}}
        if method == "setChatMenuButton":
            return {"ok": True, "result": True}
        if method == "getChatMenuButton":
            return {
                "ok": True,
                "result": {
                    "type": "default",
                },
            }
        raise AssertionError(f"unexpected Telegram method: {method}")

    monkeypatch.setattr(setup_telegram, "telegram_api_call", fake_telegram_call)

    exit_code = setup_telegram.main([])

    assert exit_code == 1
    output = capsys.readouterr().out
    assert "Telegram menu button verification failed" in output
