from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl


class TelegramAuthError(ValueError):
    """Raised when Telegram Mini App init data is invalid."""


@dataclass(slots=True)
class TelegramUser:
    """Normalized Telegram Mini App user payload."""

    id: int
    first_name: str | None
    last_name: str | None
    username: str | None
    language_code: str | None
    is_premium: bool | None


@dataclass(slots=True)
class VerifiedTelegramInitData:
    """Verified Telegram Mini App init data."""

    auth_date: int
    query_id: str | None
    user: TelegramUser
    raw: str


def _build_data_check_string(pairs: list[tuple[str, str]]) -> str:
    filtered = [(key, value) for key, value in pairs if key != "hash"]
    filtered.sort(key=lambda item: item[0])
    return "\n".join(f"{key}={value}" for key, value in filtered)


def verify_telegram_init_data(
    init_data: str,
    bot_token: str,
    max_age_seconds: int = 3600,
) -> VerifiedTelegramInitData:
    """Verify Telegram Mini App init data and return normalized user info."""
    if not init_data:
        raise TelegramAuthError("Missing Telegram init data.")

    pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=False)
    values = dict(pairs)
    received_hash = values.get("hash")
    if not received_hash:
        raise TelegramAuthError("Telegram init data is missing the hash.")

    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    data_check_string = _build_data_check_string(pairs)
    expected_hash = hmac.new(
        secret_key,
        data_check_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(received_hash, expected_hash):
        raise TelegramAuthError("Telegram init data hash check failed.")

    auth_date_raw = values.get("auth_date")
    if auth_date_raw is None:
        raise TelegramAuthError("Telegram init data is missing auth_date.")

    try:
        auth_date = int(auth_date_raw)
    except (TypeError, ValueError) as exc:
        raise TelegramAuthError("Telegram init data auth_date is invalid.") from exc

    now = int(time.time())
    if auth_date > now + 30:
        raise TelegramAuthError("Telegram init data auth_date is in the future.")
    if now - auth_date > max_age_seconds:
        raise TelegramAuthError("Telegram init data is too old.")

    user_raw = values.get("user")
    if not user_raw:
        raise TelegramAuthError("Telegram init data is missing the user payload.")

    try:
        user_payload: dict[str, Any] = json.loads(user_raw)
    except json.JSONDecodeError as exc:
        raise TelegramAuthError("Telegram user payload is invalid JSON.") from exc

    user = TelegramUser(
        id=int(user_payload["id"]),
        first_name=user_payload.get("first_name"),
        last_name=user_payload.get("last_name"),
        username=user_payload.get("username"),
        language_code=user_payload.get("language_code"),
        is_premium=user_payload.get("is_premium"),
    )
    return VerifiedTelegramInitData(
        auth_date=auth_date,
        query_id=values.get("query_id"),
        user=user,
        raw=init_data,
    )
