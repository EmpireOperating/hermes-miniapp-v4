from __future__ import annotations

import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import pytest

from auth import TelegramAuthError, verify_telegram_init_data


def _build_init_data(bot_token: str, *, auth_date: int | str, user: dict, query_id: str = "q1") -> str:
    pairs = {
        "auth_date": str(auth_date),
        "query_id": query_id,
        "user": json.dumps(user, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    digest = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    pairs["hash"] = digest
    return urlencode(pairs)


def test_verify_telegram_init_data_valid() -> None:
    bot_token = "test-token"
    init_data = _build_init_data(
        bot_token,
        auth_date=int(time.time()),
        user={"id": 42, "first_name": "Josh", "username": "josh"},
    )

    verified = verify_telegram_init_data(init_data, bot_token)
    assert verified.user.id == 42
    assert verified.user.first_name == "Josh"


def test_verify_telegram_init_data_rejects_future_auth_date() -> None:
    bot_token = "test-token"
    init_data = _build_init_data(
        bot_token,
        auth_date=int(time.time()) + 120,
        user={"id": 1},
    )

    with pytest.raises(TelegramAuthError, match="future"):
        verify_telegram_init_data(init_data, bot_token)


def test_verify_telegram_init_data_rejects_invalid_auth_date() -> None:
    bot_token = "test-token"
    init_data = _build_init_data(
        bot_token,
        auth_date="not-an-int",
        user={"id": 1},
    )

    with pytest.raises(TelegramAuthError, match="invalid"):
        verify_telegram_init_data(init_data, bot_token)
