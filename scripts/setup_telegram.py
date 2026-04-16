from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, request
from urllib.parse import urlparse, urlunparse

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from miniapp_env import default_hermes_env_path, resolve_telegram_bot_token

if __package__ in {None, ""}:
    from scripts import setup_doctor
else:  # pragma: no cover
    from scripts import setup_doctor

DEFAULT_MENU_BUTTON_TEXT = "Open Hermes"


@dataclass
class HttpCheck:
    url: str
    status: int | None
    ok: bool
    detail: str | None = None


class TelegramSetupError(RuntimeError):
    pass


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def healthcheck_url(mini_app_url: str) -> str:
    parsed = urlparse(mini_app_url)
    return urlunparse((parsed.scheme, parsed.netloc, "/health", "", "", ""))


def http_get(url: str, *, timeout: float = 10.0) -> HttpCheck:
    req = request.Request(
        url,
        headers={
            "User-Agent": "HermesMiniAppSetup/1.0",
            "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        },
        method="GET",
    )
    try:
        with request.urlopen(req, timeout=timeout) as response:
            status = getattr(response, "status", None) or response.getcode()
            return HttpCheck(url=url, status=status, ok=200 <= int(status) < 400)
    except error.HTTPError as exc:
        return HttpCheck(url=url, status=exc.code, ok=False, detail=f"HTTP {exc.code}")
    except Exception as exc:  # pragma: no cover - exercised via monkeypatched tests
        return HttpCheck(url=url, status=None, ok=False, detail=str(exc))


def telegram_api_call(token: str, method: str, payload: dict[str, Any] | None = None, *, timeout: float = 10.0) -> dict[str, Any]:
    body = None
    headers = {"User-Agent": "HermesMiniAppSetup/1.0"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=body,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    try:
        with request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise TelegramSetupError(f"Telegram API {method} failed with HTTP {exc.code}: {detail}") from exc
    except Exception as exc:  # pragma: no cover - network/runtime failure path
        raise TelegramSetupError(f"Telegram API {method} failed: {exc}") from exc


def resolve_menu_button_text(env_values: dict[str, str], override: str | None = None) -> str:
    text = (override or env_values.get("MINI_APP_MENU_BUTTON_TEXT") or DEFAULT_MENU_BUTTON_TEXT).strip()
    return text or DEFAULT_MENU_BUTTON_TEXT


def preflight_failures(root: Path, env_values: dict[str, str]) -> list[setup_doctor.CheckResult]:
    checks = [
        setup_doctor.check_env_file(root),
        setup_doctor.check_telegram_bot_token(env_values),
        setup_doctor.check_mini_app_url(env_values),
        setup_doctor.check_hermes_backend(env_values),
        setup_doctor.check_platform_mode(env_values),
    ]
    return [check for check in checks if check.status == "FAIL"]


def verify_public_endpoints(mini_app_url: str, *, timeout: float = 10.0) -> tuple[HttpCheck, HttpCheck]:
    app_check = http_get(mini_app_url, timeout=timeout)
    if not app_check.ok:
        detail = app_check.detail or f"status={app_check.status}"
        raise TelegramSetupError(f"Could not reach MINI_APP_URL over HTTPS: {mini_app_url} ({detail})")

    health_url = healthcheck_url(mini_app_url)
    health_check = http_get(health_url, timeout=timeout)
    if not health_check.ok:
        detail = health_check.detail or f"status={health_check.status}"
        raise TelegramSetupError(f"Could not reach the Mini App health endpoint: {health_url} ({detail})")
    return app_check, health_check


def verify_bot_token(token: str, *, timeout: float = 10.0) -> dict[str, Any]:
    response = telegram_api_call(token, "getMe", timeout=timeout)
    if not response.get("ok"):
        raise TelegramSetupError(f"Telegram bot token verification failed: {response}")
    result = response.get("result") or {}
    username = result.get("username")
    if not username:
        raise TelegramSetupError("Telegram bot token verification failed: getMe returned no username.")
    return result


def configure_menu_button(token: str, mini_app_url: str, menu_button_text: str, *, timeout: float = 10.0) -> None:
    payload = {
        "menu_button": {
            "type": "web_app",
            "text": menu_button_text,
            "web_app": {"url": mini_app_url},
        }
    }
    response = telegram_api_call(token, "setChatMenuButton", payload, timeout=timeout)
    if not response.get("ok"):
        raise TelegramSetupError(f"Telegram menu button configuration failed: {response}")


def verify_menu_button(token: str, mini_app_url: str, menu_button_text: str, *, timeout: float = 10.0) -> dict[str, Any]:
    response = telegram_api_call(token, "getChatMenuButton", timeout=timeout)
    if not response.get("ok"):
        raise TelegramSetupError(f"Telegram menu button verification failed: {response}")
    result = response.get("result") or {}
    actual_url = (((result.get("web_app") or {}).get("url")) or "").strip()
    actual_text = (result.get("text") or "").strip()
    if result.get("type") != "web_app" or actual_url != mini_app_url or actual_text != menu_button_text:
        raise TelegramSetupError(
            "Telegram menu button verification failed: "
            f"expected type=web_app text={menu_button_text!r} url={mini_app_url!r}, "
            f"got {result!r}"
        )
    return result


def format_preflight_failures(failures: list[setup_doctor.CheckResult]) -> str:
    lines = ["Telegram finalize setup cannot continue until these blocking issues are fixed:"]
    for failure in failures:
        lines.append(f"- {failure.key}: {failure.summary}")
        if failure.fix:
            lines.append(f"  fix: {failure.fix}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate public Mini App readiness and configure the Telegram menu button.")
    parser.add_argument("--menu-button-text", default=None, help=f"Menu button label to use in Telegram (default: {DEFAULT_MENU_BUTTON_TEXT!r}).")
    parser.add_argument("--timeout", type=float, default=10.0, help="Network timeout in seconds for URL and Telegram API checks.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = project_root()
    env_values = setup_doctor.load_env_file(root / ".env")
    failures = preflight_failures(root, env_values)
    if failures:
        print(format_preflight_failures(failures))
        return 1

    token, token_source = resolve_telegram_bot_token(env_values)
    token = token.strip()
    mini_app_url = env_values["MINI_APP_URL"].strip()
    menu_button_text = resolve_menu_button_text(env_values, args.menu_button_text)

    try:
        verify_public_endpoints(mini_app_url, timeout=args.timeout)
        bot = verify_bot_token(token, timeout=args.timeout)
        configure_menu_button(token, mini_app_url, menu_button_text, timeout=args.timeout)
        verify_menu_button(token, mini_app_url, menu_button_text, timeout=args.timeout)
    except TelegramSetupError as exc:
        print(str(exc))
        return 1

    username = bot.get("username") or "unknown"
    print("Telegram finalize setup complete.")
    if token_source == "hermes_shared_env":
        print(f"Reused TELEGRAM_BOT_TOKEN from {default_hermes_env_path()}")
    print(f"Telegram bot verified: @{username}")
    print(f"Configured Telegram menu button to open {mini_app_url}")
    print(f"Telegram menu button label: {menu_button_text}")
    print(f"Next step: open @{username} in Telegram and tap {menu_button_text!r}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
