from __future__ import annotations

import importlib
from types import SimpleNamespace


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
    # persistent-session or warm-worker toggles do not silently change thread/process
    # startup behavior under test.
    for key in (
        "MINI_APP_PERSISTENT_SESSIONS",
        "MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP",
        "MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP_REQUESTED",
        "MINI_APP_JOB_WORKER_LAUNCHER",
        "MINI_APP_WARM_WORKER_REUSE",
        "MINI_APP_WARM_WORKER_SAME_CHAT_ONLY",
        "MINI_APP_WARM_WORKER_IDLE_TTL_SECONDS",
        "MINI_APP_WARM_WORKER_MAX_IDLE",
        "MINI_APP_WARM_WORKER_MAX_TOTAL",
    ):
        monkeypatch.delenv(key, raising=False)
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

    import server  # noqa: PLC0415
    import store as store_mod  # noqa: PLC0415

    module = importlib.reload(server)
    module.store = store_mod.SessionStore(tmp_path / "sessions.db")
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
