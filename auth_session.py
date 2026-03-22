from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Callable

from auth import TelegramAuthError, TelegramUser, VerifiedTelegramInitData, verify_telegram_init_data


def session_secret_key(bot_token: str) -> bytes:
    return hmac.new(b"HermesMiniAppSession", bot_token.encode("utf-8"), hashlib.sha256).digest()


def nonce_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def create_auth_session_token(
    user_id: str,
    *,
    bot_token: str,
    auth_session_max_age_seconds: int,
    upsert_auth_session_fn: Callable[..., None],
) -> str:
    expires_at = int(time.time()) + max(60, auth_session_max_age_seconds)
    session_id = os.urandom(8).hex()
    nonce = os.urandom(8).hex()
    payload = f"{user_id}:{session_id}:{expires_at}:{nonce}"
    signature = hmac.new(session_secret_key(bot_token), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    upsert_auth_session_fn(
        session_id=session_id,
        user_id=user_id,
        nonce_hash=nonce_hash(nonce),
        expires_at=expires_at,
    )
    return f"{payload}:{signature}"


def verify_auth_session_token(
    token: str,
    *,
    bot_token: str,
    is_auth_session_active_fn: Callable[..., bool],
) -> str | None:
    value = str(token or "").strip()
    if not value:
        return None

    parts = value.split(":")
    if len(parts) != 5:
        return None

    user_id, session_id, expires_raw, nonce, signature = parts
    if not user_id or not session_id or not expires_raw or not nonce or not signature:
        return None

    payload = f"{user_id}:{session_id}:{expires_raw}:{nonce}"
    expected_sig = hmac.new(session_secret_key(bot_token), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected_sig):
        return None

    try:
        expires_at = int(expires_raw)
    except ValueError:
        return None

    now_epoch = int(time.time())
    if expires_at < now_epoch:
        return None

    if not is_auth_session_active_fn(
        session_id=session_id,
        user_id=user_id,
        nonce_hash=nonce_hash(nonce),
        now_epoch=now_epoch,
    ):
        return None

    return user_id


def verified_from_session_cookie(
    *,
    token: str,
    verify_auth_session_token_fn: Callable[[str], str | None],
) -> VerifiedTelegramInitData | None:
    user_id = verify_auth_session_token_fn(token)
    if not user_id:
        return None

    try:
        numeric_user_id = int(user_id)
    except ValueError:
        return None

    now = int(time.time())
    return VerifiedTelegramInitData(
        auth_date=now,
        query_id=None,
        user=TelegramUser(
            id=numeric_user_id,
            first_name=None,
            last_name=None,
            username=None,
            language_code=None,
            is_premium=None,
        ),
        raw="cookie-session",
    )


def verify_from_payload(
    payload: dict[str, object],
    *,
    bot_token: str,
    telegram_init_data_max_age_seconds: int,
    verified_from_session_cookie_fn: Callable[[], VerifiedTelegramInitData | None],
    verify_telegram_init_data_fn: Callable[..., VerifiedTelegramInitData] = verify_telegram_init_data,
) -> VerifiedTelegramInitData:
    if not bot_token:
        raise TelegramAuthError("Server is missing TELEGRAM_BOT_TOKEN.")

    init_data = str(payload.get("init_data", ""))
    if init_data.strip():
        return verify_telegram_init_data_fn(
            init_data=init_data,
            bot_token=bot_token,
            max_age_seconds=telegram_init_data_max_age_seconds,
        )

    cached = verified_from_session_cookie_fn()
    if cached is not None:
        return cached

    return verify_telegram_init_data_fn(
        init_data=init_data,
        bot_token=bot_token,
        max_age_seconds=telegram_init_data_max_age_seconds,
    )
