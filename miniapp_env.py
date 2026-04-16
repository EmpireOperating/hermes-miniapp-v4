from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping

SHARED_TELEGRAM_TOKEN_OPT_IN_KEY = "MINI_APP_USE_HERMES_TELEGRAM_BOT_TOKEN"
PLACEHOLDER_TELEGRAM_TOKEN_FRAGMENTS = (
    "replace",
    "your-token",
    "your_token",
    "example",
    "paste",
)


def _parse_env_lines(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def parse_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    return _parse_env_lines(path.read_text(encoding="utf-8"))


def _is_truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def shared_telegram_token_opt_in_enabled(
    env_values: Mapping[str, str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> bool:
    values = env_values or {}
    environ = environ or os.environ
    return _is_truthy(values.get(SHARED_TELEGRAM_TOKEN_OPT_IN_KEY) or environ.get(SHARED_TELEGRAM_TOKEN_OPT_IN_KEY))


def default_hermes_home(*, environ: Mapping[str, str] | None = None) -> Path:
    environ = environ or os.environ
    configured = str(environ.get("HERMES_HOME") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".hermes"


def default_hermes_env_path(*, environ: Mapping[str, str] | None = None) -> Path:
    return default_hermes_home(environ=environ) / ".env"


def is_placeholder_telegram_token(token: str | None) -> bool:
    value = str(token or "").strip()
    if not value:
        return True
    lowered = value.lower()
    if '...' in value:
        return True
    if all(ch == '*' for ch in value):
        return True
    return any(fragment in lowered for fragment in PLACEHOLDER_TELEGRAM_TOKEN_FRAGMENTS)


def resolve_telegram_bot_token(
    env_values: Mapping[str, str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> tuple[str, str | None]:
    values = env_values or {}
    environ = environ or os.environ

    explicit_token = str(values.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if explicit_token and not is_placeholder_telegram_token(explicit_token):
        return explicit_token, ".env"

    if env_values is None:
        ambient_token = str(environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
        if ambient_token and not is_placeholder_telegram_token(ambient_token):
            return ambient_token, "environment"

    if not shared_telegram_token_opt_in_enabled(values, environ=environ):
        return "", None

    hermes_env = parse_env_file(default_hermes_env_path(environ=environ))
    shared_token = str(hermes_env.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if not shared_token or is_placeholder_telegram_token(shared_token):
        return "", None
    return shared_token, "hermes_shared_env"


def load_env_file_into_environ(
    path: Path,
    *,
    overwrite: bool = False,
    preserve_alias_groups: tuple[tuple[str, ...], ...] = (),
) -> dict[str, str]:
    os.environ.setdefault("FLASK_SKIP_DOTENV", "1")
    if not path.exists():
        return {}
    parsed = parse_env_file(path)
    protected_keys: set[str] = set()
    for group in preserve_alias_groups:
        alias_group = tuple(str(key) for key in group if str(key).strip())
        if not alias_group:
            continue
        if any(key in os.environ for key in alias_group):
            protected_keys.update(alias_group)
    applied: dict[str, str] = {}
    for key, value in parsed.items():
        if not overwrite and (key in os.environ or key in protected_keys):
            continue
        os.environ[key] = value
        applied[key] = value
    token, source = resolve_telegram_bot_token(parsed)
    current_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if source == "hermes_shared_env" and (overwrite or is_placeholder_telegram_token(current_token)):
        os.environ["TELEGRAM_BOT_TOKEN"] = token
        applied["TELEGRAM_BOT_TOKEN"] = token
    return applied
