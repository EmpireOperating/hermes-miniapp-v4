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


def test_serialize_turn_adds_file_refs_when_present() -> None:
    service = _service()

    result = service.serialize_turn(
        _Turn(
            id=11,
            chat_id=7,
            role="assistant",
            body="Look at /tmp/demo.txt and /var/log/app.log",
            created_at="2026-04-10T00:00:00Z",
        )
    )

    assert result["id"] == 11
    assert result["body"] == "Look at /tmp/demo.txt and /var/log/app.log"
    assert result["file_refs"][0]["path"] == "/tmp/demo.txt"
    assert result["file_refs"][1]["path"] == "/var/log/app.log"


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
