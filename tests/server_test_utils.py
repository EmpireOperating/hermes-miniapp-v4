from __future__ import annotations

import importlib
import os
from types import SimpleNamespace


def _env_was_explicitly_set(monkeypatch, key: str) -> bool:
    notset = getattr(monkeypatch, "notset", object())
    current = os.environ.get(key, notset)
    for entry in reversed(getattr(monkeypatch, "_setitem", [])):
        mapping, mapped_key, original = entry
        if mapping is os.environ and mapped_key == key:
            return original is notset or original != current
    return False


def load_server(
    monkeypatch,
    tmp_path,
    *,
    max_message_len: int = 20,
    max_title_len: int = 10,
    max_content_length: int = 2048,
    isolate_security_env: bool = True,
    isolate_dev_env: bool = True,
):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-token")
    monkeypatch.setenv("MAX_MESSAGE_LEN", str(max_message_len))
    monkeypatch.setenv("MAX_TITLE_LEN", str(max_title_len))
    monkeypatch.setenv("MAX_CONTENT_LENGTH", str(max_content_length))

    # Isolate tests from host/service hardening env (e.g. production origin allowlists).
    # Some tests can opt out to validate origin enforcement behavior.
    if isolate_security_env:
        monkeypatch.setenv("MINI_APP_ENFORCE_ORIGIN_CHECK", "0")
        monkeypatch.setenv("MINI_APP_ALLOWED_ORIGINS", "")

    # Isolate server reload/import tests from ambient host/service runtime env so
    # persistent-session or warm-worker toggles do not silently change behavior under
    # test. Preserve explicit per-test overrides set via monkeypatch.setenv(...).
    runtime_defaults = {
        "MINI_APP_PERSISTENT_SESSIONS": "0",
        "MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP": "auto",
        "MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP_REQUESTED": "auto",
        "MINI_APP_JOB_WORKER_LAUNCHER": "inline",
        "MINI_APP_JOB_WORKER_SUBPROCESS_MEMORY_LIMIT_MB": "1024",
        "MINI_APP_JOB_WORKER_SUBPROCESS_MAX_TASKS": "64",
        "MINI_APP_JOB_WORKER_SUBPROCESS_MAX_OPEN_FILES": "256",
        "MINI_APP_WARM_WORKER_REUSE": "0",
        "MINI_APP_WARM_WORKER_SAME_CHAT_ONLY": "1",
        "MINI_APP_WARM_WORKER_IDLE_TTL_SECONDS": "180",
        "MINI_APP_WARM_WORKER_MAX_IDLE": "2",
        "MINI_APP_WARM_WORKER_MAX_TOTAL": "4",
    }
    explicit_runtime_overrides = {
        key: os.environ[key]
        for key in runtime_defaults
        if _env_was_explicitly_set(monkeypatch, key) and key in os.environ
    }
    for key, default_value in runtime_defaults.items():
        monkeypatch.delenv(key, raising=False)
        monkeypatch.setenv(key, default_value)
    for key, value in explicit_runtime_overrides.items():
        monkeypatch.setenv(key, value)

    if isolate_dev_env:
        for key in (
            "MINIAPP_DEV_BYPASS",
            "MINI_APP_DEV_BYPASS",
            "MINIAPP_DEV_BYPASS_EXPIRES_AT",
            "MINI_APP_DEV_BYPASS_EXPIRES_AT",
            "MINIAPP_DEV_SECRET",
            "MINI_APP_DEV_SECRET",
            "MINI_APP_DEV_AUTH_SECRET",
        ):
            monkeypatch.delenv(key, raising=False)

    session_store_path = tmp_path / "sessions.db"
    monkeypatch.setenv("MINI_APP_SESSION_STORE_PATH", str(session_store_path))

    import server  # noqa: PLC0415

    module = importlib.reload(server)
    return module


def patch_verified_user(
    monkeypatch,
    server,
    *,
    user_id: int = 123,
    first_name: str = "Test",
    username: str = "test",
):
    verified = SimpleNamespace(user=SimpleNamespace(id=user_id, first_name=first_name, username=username))
    monkeypatch.setattr(server, "_verify_from_payload", lambda payload: verified)
    return verified
