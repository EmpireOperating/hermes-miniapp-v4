from __future__ import annotations

from types import SimpleNamespace

from routes_chat_management_service import build_chat_management_service
from server_test_utils import load_server



def _serialize_chat(chat) -> dict[str, object]:
    return {
        "id": chat.id,
        "title": chat.title,
        "parent_chat_id": chat.parent_chat_id,
        "unread_count": chat.unread_count,
        "newest_unread_message_id": chat.newest_unread_message_id,
        "pending": chat.pending,
        "is_pinned": chat.is_pinned,
        "updated_at": chat.updated_at,
        "created_at": chat.created_at,
    }



def _build_service(server):
    return build_chat_management_service(
        store_getter=lambda: server.store,
        client_getter=lambda: server.client,
        runtime_getter=lambda: server.runtime,
        serialize_chat_fn=_serialize_chat,
        session_id_builder_fn=lambda user_id, chat_id: f"miniapp-{user_id}-{chat_id}",
        json_error_fn=lambda message, status: ({"ok": False, "error": message}, status),
    )



def test_create_chat_response_sets_active_chat_and_returns_serialized_history(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    service = _build_service(server)

    payload, status = service.create_chat_response(user_id="123", title="Feature")

    assert status == 201
    assert payload["ok"] is True
    assert payload["chat"]["title"] == "Feature"
    assert payload["history"] == []
    assert server.store.get_active_chat("123") == payload["chat"]["id"]



def test_branch_chat_response_allows_open_job_and_cuts_branch_at_last_assistant_message(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    service = _build_service(server)

    source_chat = server.store.create_chat("123", "Busy")
    server.store.add_message("123", source_chat.id, "operator", "prior")
    server.store.add_message("123", source_chat.id, "hermes", "done")
    operator_message_id = server.store.add_message("123", source_chat.id, "operator", "still working")
    server.store.enqueue_chat_job("123", source_chat.id, operator_message_id)
    server.store.set_runtime_checkpoint(
        session_id=f"miniapp-123-{source_chat.id}",
        user_id="123",
        chat_id=source_chat.id,
        pending_tool_lines=["read_file"],
        pending_assistant="Thinking",
    )

    payload, status = service.branch_chat_response(user_id="123", chat_id=source_chat.id, requested_title="Busy alt")

    assert status == 201
    assert payload["chat"]["title"] == "Busy alt"
    assert payload["chat"]["pending"] is False
    assert [item["body"] for item in payload["history"]] == ["prior", "done"]
    assert all(not item.get("pending") for item in payload["history"])



def test_branch_chat_response_returns_conflict_when_no_completed_assistant_message_exists(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    service = _build_service(server)

    source_chat = server.store.create_chat("123", "Busy")
    operator_message_id = server.store.add_message("123", source_chat.id, "operator", "still working")
    server.store.enqueue_chat_job("123", source_chat.id, operator_message_id)

    payload, status = service.branch_chat_response(user_id="123", chat_id=source_chat.id, requested_title="Busy alt")

    assert status == 409
    assert payload == {"ok": False, "error": "Nothing completed yet to branch from."}


def test_remove_chat_response_evicts_runtime_and_can_leave_no_active_chat(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    service = _build_service(server)

    only_chat_id = server.store.ensure_default_chat("123")
    server.store.set_active_chat("123", only_chat_id)
    evicted: list[tuple[str, str]] = []
    deleted_checkpoints: list[str] = []
    monkeypatch.setattr(server.client, "evict_session", lambda session_id, reason="explicit_eviction": evicted.append((session_id, reason)) or True)
    monkeypatch.setattr(server.store, "delete_runtime_checkpoint", lambda session_id: deleted_checkpoints.append(session_id) or True)

    payload, status = service.remove_chat_response(user_id="123", chat_id=only_chat_id, allow_empty=True)

    assert status == 200
    assert payload["ok"] is True
    assert payload["removed_chat_id"] == only_chat_id
    assert payload["active_chat_id"] is None
    assert payload["active_chat"] is None
    assert payload["history"] == []
    assert payload["chats"] == []
    assert evicted == [(f"miniapp-123-{only_chat_id}", "invalidated_by_remove")]
    assert deleted_checkpoints == [f"miniapp-123-{only_chat_id}"]



def test_remove_chat_response_can_skip_full_state_payload(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)

    first_chat_id = server.store.ensure_default_chat("123")
    second_chat = server.store.create_chat("123", "Next")
    server.store.set_active_chat("123", second_chat.id)

    serialized_calls: list[int] = []

    def serialize_chat(chat) -> dict[str, object]:
        serialized_calls.append(chat.id)
        return _serialize_chat(chat)

    service = build_chat_management_service(
        store_getter=lambda: server.store,
        client_getter=lambda: server.client,
        runtime_getter=lambda: server.runtime,
        serialize_chat_fn=serialize_chat,
        session_id_builder_fn=lambda user_id, chat_id: f"miniapp-{user_id}-{chat_id}",
        json_error_fn=lambda message, status: ({"ok": False, "error": message}, status),
    )

    payload, status = service.remove_chat_response(
        user_id="123",
        chat_id=second_chat.id,
        allow_empty=True,
        include_full_state=False,
    )

    assert status == 200
    assert payload == {
        "ok": True,
        "removed_chat_id": second_chat.id,
        "active_chat_id": first_chat_id,
    }
    assert serialized_calls == []


def test_remove_chat_response_prefers_requested_replacement_chat_when_it_still_exists(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    service = _build_service(server)

    left_chat_id = server.store.ensure_default_chat("123")
    closing_chat = server.store.create_chat("123", "Current")
    right_chat = server.store.create_chat("123", "Right")
    server.store.set_active_chat("123", closing_chat.id)

    payload, status = service.remove_chat_response(
        user_id="123",
        chat_id=closing_chat.id,
        allow_empty=True,
        include_full_state=False,
        preferred_chat_id=right_chat.id,
    )

    assert status == 200
    assert payload == {
        "ok": True,
        "removed_chat_id": closing_chat.id,
        "active_chat_id": right_chat.id,
    }
    assert server.store.get_active_chat("123") == right_chat.id


def test_chat_history_payload_with_activate_false_preserves_unread_state(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    service = _build_service(server)

    chat_id = server.store.ensure_default_chat("123")
    server.store.add_message("123", chat_id, "hermes", "Unread reply")
    before = server.store.get_chat("123", chat_id)
    assert before.unread_count == 1

    payload = service.chat_history_payload(user_id="123", chat_id=chat_id, activate=False)

    after = server.store.get_chat("123", chat_id)
    assert payload["chat"]["unread_count"] == 1
    assert after.unread_count == 1


def test_chat_history_payload_includes_runtime_pending_checkpoint_state(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    service = _build_service(server)

    chat_id = server.store.ensure_default_chat("123")
    server.store.add_message("123", chat_id, "operator", "still working")
    server.store.set_runtime_checkpoint(
        session_id=f"miniapp-123-{chat_id}",
        user_id="123",
        chat_id=chat_id,
        pending_tool_lines=["read_file", "search_files"],
        pending_assistant="Thinking",
    )

    payload = service.chat_history_payload(user_id="123", chat_id=chat_id, activate=True)

    pending_entries = [item for item in payload["history"] if item.get("pending")]
    assert any(item["role"] == "tool" and item["body"] == "read_file\nsearch_files" for item in pending_entries)
    assert any(item["role"] == "assistant" and item["body"] == "Thinking" for item in pending_entries)


def test_chat_history_payload_with_activate_true_sets_active_chat_without_consuming_unread(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path)
    service = _build_service(server)

    main_chat_id = server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")
    server.store.add_message("123", alt_chat.id, "hermes", "Unread reply")
    server.store.set_active_chat("123", main_chat_id)

    payload = service.chat_history_payload(user_id="123", chat_id=alt_chat.id, activate=True)

    after = server.store.get_chat("123", alt_chat.id)
    assert payload["chat"]["unread_count"] == 1
    assert payload["chat"]["newest_unread_message_id"] > 0
    assert after.unread_count == 1
    assert server.store.get_active_chat("123") == alt_chat.id
