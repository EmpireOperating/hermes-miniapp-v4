from __future__ import annotations

import importlib

def load_server(
    monkeypatch,
    tmp_path,
    *,
    max_message_len: int = 20,
    max_title_len: int = 10,
    max_content_length: int = 2048,
):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-token")
    monkeypatch.setenv("MAX_MESSAGE_LEN", str(max_message_len))
    monkeypatch.setenv("MAX_TITLE_LEN", str(max_title_len))
    monkeypatch.setenv("MAX_CONTENT_LENGTH", str(max_content_length))

    import server  # noqa: PLC0415
    import store as store_mod  # noqa: PLC0415

    module = importlib.reload(server)
    module.store = store_mod.SessionStore(tmp_path / "sessions.db")
    return module
