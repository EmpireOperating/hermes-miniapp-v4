from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

from routes_auth_service import AuthBootstrapService


@dataclass
class _Turn:
    id: int
    chat_id: int
    role: str
    body: str
    created_at: str


class _StoreStub:
    def __init__(self, checkpoint_state=None):
        self._checkpoint_state = checkpoint_state

    def get_runtime_checkpoint_state(self, _session_id: str):
        return self._checkpoint_state


class _PinnedSummaryStoreStub(_StoreStub):
    def __init__(self):
        super().__init__(checkpoint_state=None)
        self.list_pinned_chat_summaries_calls = 0
        self.list_pinned_chats_calls = 0

    def prune_expired_auth_sessions(self, _now_ts: int) -> None:
        return None

    def list_chats(self, *, user_id: str):
        assert user_id == "123"
        return [{"id": 7, "title": "Main", "pending": False, "unread_count": 0, "is_pinned": False}]

    def list_pinned_chat_summaries(self, *, user_id: str):
        assert user_id == "123"
        self.list_pinned_chat_summaries_calls += 1
        return [{"id": 42, "title": "Pinned only", "pending": False, "unread_count": 0, "is_pinned": True}]

    def list_pinned_chats(self, *, user_id: str):
        assert user_id == "123"
        self.list_pinned_chats_calls += 1
        raise AssertionError("heavy pinned query should not be used for auth bootstrap")

    def get_active_chat(self, user_id: str):
        assert user_id == "123"
        return None

    def has_explicit_empty_chat_state(self, user_id: str) -> bool:
        assert user_id == "123"
        return False

    def ensure_default_chat(self, user_id: str) -> int:
        assert user_id == "123"
        return 7

    def get_skin(self, user_id: str) -> str:
        assert user_id == "123"
        return "terminal"

    def get_telegram_unread_notifications_enabled(self, user_id: str) -> bool:
        assert user_id == "123"
        return False


class _UnreadBootstrapStoreStub(_StoreStub):
    def __init__(self):
        super().__init__(checkpoint_state=None)
        self.mark_chat_read_calls = 0
        self.mark_chat_read_through_calls = 0
        self.active_chat_id = 7

    def prune_expired_auth_sessions(self, _now_ts: int) -> None:
        return None

    def list_chats(self, *, user_id: str):
        assert user_id == "123"
        return [{
            "id": 7,
            "title": "Ideas",
            "pending": False,
            "unread_count": 1,
            "newest_unread_message_id": 11,
            "is_pinned": False,
        }]

    def list_pinned_chat_summaries(self, *, user_id: str):
        assert user_id == "123"
        return []

    def get_active_chat(self, user_id: str):
        assert user_id == "123"
        return self.active_chat_id

    def has_explicit_empty_chat_state(self, user_id: str) -> bool:
        assert user_id == "123"
        return False

    def ensure_default_chat(self, user_id: str) -> int:
        assert user_id == "123"
        return 7

    def get_skin(self, user_id: str) -> str:
        assert user_id == "123"
        return "terminal"

    def get_telegram_unread_notifications_enabled(self, user_id: str) -> bool:
        assert user_id == "123"
        return False

    def get_history(self, *, user_id: str, chat_id: int, limit: int = 120):
        assert user_id == "123"
        assert chat_id == 7
        assert limit == 120
        return [_Turn(id=11, chat_id=7, role="hermes", body="Final reply", created_at="2026-04-10T00:00:00Z")]

    def set_active_chat(self, *, user_id: str, chat_id: int) -> None:
        assert user_id == "123"
        self.active_chat_id = chat_id

    def mark_chat_read(self, *, user_id: str, chat_id: int) -> None:
        self.mark_chat_read_calls += 1

    def mark_chat_read_through(self, *, user_id: str, chat_id: int, message_id: int) -> None:
        self.mark_chat_read_through_calls += 1


class _PendingRefreshStoreStub(_StoreStub):
    def __init__(self):
        super().__init__(checkpoint_state=None)
        self.list_chats_calls = 0

    def prune_expired_auth_sessions(self, _now_ts: int) -> None:
        return None

    def list_chats(self, *, user_id: str):
        assert user_id == "123"
        self.list_chats_calls += 1
        if self.list_chats_calls == 1:
            return [{
                "id": 7,
                "title": "Ideas",
                "pending": True,
                "unread_count": 1,
                "newest_unread_message_id": 11,
                "is_pinned": False,
            }]
        return [{
            "id": 7,
            "title": "Ideas",
            "pending": False,
            "unread_count": 0,
            "newest_unread_message_id": 0,
            "is_pinned": False,
        }]

    def list_pinned_chat_summaries(self, *, user_id: str):
        assert user_id == "123"
        return []

    def get_active_chat(self, user_id: str):
        assert user_id == "123"
        return 7

    def has_explicit_empty_chat_state(self, user_id: str) -> bool:
        assert user_id == "123"
        return False

    def ensure_default_chat(self, user_id: str) -> int:
        assert user_id == "123"
        return 7

    def get_skin(self, user_id: str) -> str:
        assert user_id == "123"
        return "terminal"

    def get_telegram_unread_notifications_enabled(self, user_id: str) -> bool:
        assert user_id == "123"
        return False

    def get_history(self, *, user_id: str, chat_id: int, limit: int = 120):
        assert user_id == "123"
        assert chat_id == 7
        assert limit == 120
        return [_Turn(id=11, chat_id=7, role="hermes", body="Recovered reply", created_at="2026-04-10T00:00:00Z")]


class _BootstrapHistoriesStoreStub(_StoreStub):
    def __init__(self):
        super().__init__(checkpoint_state=None)

    def prune_expired_auth_sessions(self, _now_ts: int) -> None:
        return None

    def list_chats(self, *, user_id: str):
        assert user_id == "123"
        return [
            {"id": 7, "title": "Ideas", "pending": False, "unread_count": 0, "is_pinned": False},
            {"id": 8, "title": "Spec", "pending": False, "unread_count": 0, "is_pinned": False},
            {"id": 9, "title": "Tests", "pending": True, "unread_count": 0, "is_pinned": False},
            {"id": 10, "title": "Notes", "pending": False, "unread_count": 0, "is_pinned": False},
            {"id": 11, "title": "Overflow", "pending": False, "unread_count": 0, "is_pinned": False},
        ]

    def list_pinned_chat_summaries(self, *, user_id: str):
        assert user_id == "123"
        return []

    def get_active_chat(self, user_id: str):
        assert user_id == "123"
        return 7

    def has_explicit_empty_chat_state(self, user_id: str) -> bool:
        assert user_id == "123"
        return False

    def ensure_default_chat(self, user_id: str) -> int:
        assert user_id == "123"
        return 7

    def get_skin(self, user_id: str) -> str:
        assert user_id == "123"
        return "terminal"

    def get_telegram_unread_notifications_enabled(self, user_id: str) -> bool:
        assert user_id == "123"
        return False

    def get_history(self, *, user_id: str, chat_id: int, limit: int = 120):
        assert user_id == "123"
        if chat_id == 7:
            assert limit == 120
            return [_Turn(id=70, chat_id=7, role="hermes", body="active history", created_at="2026-04-10T00:00:00Z")]
        assert limit == 40
        return [_Turn(id=chat_id * 10, chat_id=chat_id, role="hermes", body=f"bootstrap {chat_id}", created_at="2026-04-10T00:00:00Z")]

    def get_runtime_checkpoint_state(self, session_id: str):
        if session_id.endswith("-9"):
            return {
                "updated_at": "2026-04-10T00:00:01Z",
                "pending_tool_lines": ["read_file"],
                "pending_assistant": "still working",
            }
        return None


def _service(*, checkpoint_state=None, store=None) -> AuthBootstrapService:
    active_store = store or _StoreStub(checkpoint_state=checkpoint_state)
    return AuthBootstrapService(
        store_getter=lambda: active_store,
        runtime_getter=lambda: None,
        serialize_chat_fn=lambda chat: chat,
        session_id_builder_fn=lambda user_id, chat_id: f"miniapp-{user_id}-{chat_id}",
    )


def test_parse_allow_empty_flag_rejects_non_boolean_values() -> None:
    allow_empty, error = AuthBootstrapService.parse_allow_empty_flag({"allow_empty": "yes"})

    assert allow_empty is None
    assert error == ({"ok": False, "error": "Invalid allow_empty flag. Expected boolean."}, 400)


def test_parse_preferred_chat_id_rejects_invalid_values() -> None:
    preferred_chat_id, error = AuthBootstrapService.parse_preferred_chat_id({"preferred_chat_id": "abc"})
    assert preferred_chat_id is None
    assert error == ({"ok": False, "error": "Invalid preferred_chat_id. Expected positive integer."}, 400)

    preferred_chat_id, error = AuthBootstrapService.parse_preferred_chat_id({"preferred_chat_id": 0})
    assert preferred_chat_id is None
    assert error == ({"ok": False, "error": "Invalid preferred_chat_id. Expected positive integer."}, 400)


def test_build_dev_verified_user_rejects_non_positive_or_non_integer_ids() -> None:
    verified, error = AuthBootstrapService.build_dev_verified_user({"user_id": "abc"})
    assert verified is None
    assert error == ({"ok": False, "error": "Invalid dev user id."}, 400)

    verified, error = AuthBootstrapService.build_dev_verified_user({"user_id": 0})
    assert verified is None
    assert error == ({"ok": False, "error": "Invalid dev user id."}, 400)


def test_augment_history_with_runtime_pending_dedupes_existing_pending_entries() -> None:
    service = _service(
        checkpoint_state={
            "updated_at": "2026-04-10T00:00:00Z",
            "pending_tool_lines": ["read_file", "search_files"],
            "pending_assistant": "Still working",
        }
    )
    history = [
        {
            "id": 0,
            "chat_id": 7,
            "role": "tool",
            "body": "already there",
            "created_at": "2026-04-10T00:00:00Z",
            "pending": True,
        },
        {
            "id": 0,
            "chat_id": 7,
            "role": "assistant",
            "body": "still here",
            "created_at": "2026-04-10T00:00:00Z",
            "pending": True,
        },
    ]

    result = service.augment_history_with_runtime_pending(
        user_id="123",
        chat_id=7,
        history=history,
        chat_pending=True,
    )

    assert result == history


def test_serialize_turn_only_adds_previewable_file_refs_when_present(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(tmp_path))
    service = _service()
    previewable = tmp_path / "demo.txt"
    previewable.write_text("ok\n", encoding="utf-8")

    result = service.serialize_turn(
        _Turn(
            id=11,
            chat_id=7,
            role="assistant",
            body=f"Look at {previewable} and /var/log/app.log",
            created_at="2026-04-10T00:00:00Z",
        )
    )

    assert result["id"] == 11
    assert result["body"] == f"Look at {previewable} and /var/log/app.log"
    assert [ref["path"] for ref in result["file_refs"]] == [str(previewable)]


def test_auth_success_state_prefers_lightweight_pinned_chat_summaries() -> None:
    store = _PinnedSummaryStoreStub()
    service = _service(store=store)

    result = service.auth_success_state(
        SimpleNamespace(id=123, first_name="Operator", username="operator"),
        auth_mode="telegram",
        allow_empty=True,
    )

    assert result["payload"]["pinned_chats"] == [
        {"id": 42, "title": "Pinned only", "pending": False, "unread_count": 0, "is_pinned": True}
    ]
    assert store.list_pinned_chat_summaries_calls == 1
    assert store.list_pinned_chats_calls == 0



def test_auth_success_state_does_not_consume_active_chat_unread_on_bootstrap() -> None:
    store = _UnreadBootstrapStoreStub()
    service = _service(store=store)

    result = service.auth_success_state(
        SimpleNamespace(id=123, first_name="Operator", username="operator"),
        auth_mode="telegram",
        allow_empty=False,
    )

    payload = result["payload"]
    assert payload["active_chat_id"] == 7
    assert payload["history"][-1]["body"] == "Final reply"
    active_chat = next(chat for chat in payload["chats"] if chat["id"] == 7)
    assert active_chat["unread_count"] == 1
    assert active_chat["newest_unread_message_id"] == 11
    assert store.mark_chat_read_calls == 0
    assert store.mark_chat_read_through_calls == 0


def test_auth_success_state_refreshes_chats_after_pending_recovery() -> None:
    store = _PendingRefreshStoreStub()
    ensure_pending_jobs_calls = []
    service = AuthBootstrapService(
        store_getter=lambda: store,
        runtime_getter=lambda: SimpleNamespace(ensure_pending_jobs=lambda user_id: ensure_pending_jobs_calls.append(user_id)),
        serialize_chat_fn=lambda chat: chat,
        session_id_builder_fn=lambda user_id, chat_id: f"miniapp-{user_id}-{chat_id}",
    )

    result = service.auth_success_state(
        SimpleNamespace(id=123, first_name="Operator", username="operator"),
        auth_mode="telegram",
        allow_empty=False,
    )

    payload = result["payload"]
    assert ensure_pending_jobs_calls == ["123"]
    assert store.list_chats_calls == 2
    active_chat = next(chat for chat in payload["chats"] if chat["id"] == 7)
    assert active_chat["pending"] is False
    assert active_chat["unread_count"] == 0
    assert active_chat["newest_unread_message_id"] == 0
    assert payload["history"][-1]["body"] == "Recovered reply"


def test_auth_success_state_includes_bootstrap_histories_for_initial_visible_inactive_chats() -> None:
    store = _BootstrapHistoriesStoreStub()
    service = AuthBootstrapService(
        store_getter=lambda: store,
        runtime_getter=lambda: SimpleNamespace(ensure_pending_jobs=lambda _user_id: None),
        serialize_chat_fn=lambda chat: chat,
        session_id_builder_fn=lambda user_id, chat_id: f"miniapp-{user_id}-{chat_id}",
    )

    result = service.auth_success_state(
        SimpleNamespace(id=123, first_name="Operator", username="operator"),
        auth_mode="telegram",
        allow_empty=False,
    )

    payload = result["payload"]
    assert payload["active_chat_id"] == 7
    assert payload["history"][-1]["body"] == "active history"
    assert payload["bootstrap_histories"] == {
        "8": [{"id": 80, "chat_id": 8, "role": "hermes", "body": "bootstrap 8", "created_at": "2026-04-10T00:00:00Z"}],
        "9": [
            {"id": 90, "chat_id": 9, "role": "hermes", "body": "bootstrap 9", "created_at": "2026-04-10T00:00:00Z"},
            {"id": 0, "chat_id": 9, "role": "tool", "body": "read_file", "created_at": "2026-04-10T00:00:01Z", "pending": True},
            {"id": 0, "chat_id": 9, "role": "assistant", "body": "still working", "created_at": "2026-04-10T00:00:01Z", "pending": True},
        ],
        "10": [{"id": 100, "chat_id": 10, "role": "hermes", "body": "bootstrap 10", "created_at": "2026-04-10T00:00:00Z"}],
    }


def test_auth_success_state_prefers_preferred_chat_without_overwriting_shared_active_chat() -> None:
    store = _UnreadBootstrapStoreStub()
    service = _service(store=store)
    store.active_chat_id = 7

    def list_chats(*, user_id: str):
        assert user_id == "123"
        return [
            {"id": 7, "title": "Ideas", "pending": False, "unread_count": 0, "is_pinned": False},
            {"id": 9, "title": "Mobile", "pending": False, "unread_count": 0, "is_pinned": False},
        ]

    def get_history(*, user_id: str, chat_id: int, limit: int = 120):
        assert user_id == "123"
        assert limit in {40, 120}
        return [_Turn(id=chat_id, chat_id=chat_id, role="hermes", body=f"history {chat_id}", created_at="2026-04-10T00:00:00Z")]

    store.list_chats = list_chats
    store.get_history = get_history

    result = service.auth_success_state(
        SimpleNamespace(id=123, first_name="Operator", username="operator"),
        auth_mode="telegram",
        allow_empty=False,
        preferred_chat_id=9,
    )

    payload = result["payload"]
    assert payload["active_chat_id"] == 9
    assert payload["history"][-1]["body"] == "history 9"
    assert store.active_chat_id == 7
