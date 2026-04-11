from __future__ import annotations

from dataclasses import dataclass

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


def _service(*, checkpoint_state=None) -> AuthBootstrapService:
    store = _StoreStub(checkpoint_state=checkpoint_state)
    return AuthBootstrapService(
        store_getter=lambda: store,
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
