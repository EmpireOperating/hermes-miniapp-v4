from __future__ import annotations

import queue

from server_test_utils import load_server, patch_verified_user


def _authed_client(monkeypatch, tmp_path, **load_kwargs):
    server = load_server(monkeypatch, tmp_path, **load_kwargs)
    client = server.app.test_client()
    patch_verified_user(monkeypatch, server)
    return server, client


def _post_chat_endpoint(client, endpoint: str, **payload):
    body = {"init_data": "ok"}
    body.update(payload)
    return client.post(endpoint, json=body)


def _assert_missing_chat_404(client, endpoint: str) -> None:
    response = _post_chat_endpoint(client, endpoint, chat_id=999999)
    assert response.status_code == 404
    assert "not found" in response.get_json()["error"].lower()


def test_chat_rejects_oversized_message_before_auth(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path, max_message_len=5)
    client = server.app.test_client()

    response = client.post("/api/chat", json={"message": "abcdef"})

    assert response.status_code == 400
    assert "exceeds" in response.get_json()["error"]

def test_create_chat_rejects_oversized_title_before_auth(monkeypatch, tmp_path) -> None:
    server = load_server(monkeypatch, tmp_path, max_title_len=4)
    client = server.app.test_client()

    response = client.post("/api/chats", json={"title": "abcde"})

    assert response.status_code == 400
    assert "Title exceeds" in response.get_json()["error"]

def test_remove_chat_returns_replacement_active_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    first_chat_id = server.store.ensure_default_chat("123")
    second_chat = server.store.create_chat("123", "Second")
    server.store.add_message("123", second_chat.id, "operator", "hello")

    response = client.post("/api/chats/remove", json={"init_data": "ok", "chat_id": second_chat.id})

    assert response.status_code == 200
    data = response.get_json()
    assert data["removed_chat_id"] == second_chat.id
    assert data["active_chat_id"] == first_chat_id
    assert data["active_chat"]["id"] == first_chat_id
    assert [chat["id"] for chat in data["chats"]] == [first_chat_id]
    assert data["history"] == []
    assert server.store.get_turn_count("123", second_chat.id) == 1


def test_pin_close_and_reopen_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    main_chat_id = server.store.ensure_default_chat("123")
    feature_chat = server.store.create_chat("123", "Feature")

    pin_response = client.post("/api/chats/pin", json={"init_data": "ok", "chat_id": feature_chat.id})
    assert pin_response.status_code == 200
    pinned_payload = pin_response.get_json()
    assert pinned_payload["chat"]["is_pinned"] is True
    assert [chat["id"] for chat in pinned_payload["pinned_chats"]] == [feature_chat.id]

    remove_response = client.post("/api/chats/remove", json={"init_data": "ok", "chat_id": feature_chat.id})
    assert remove_response.status_code == 200
    remove_payload = remove_response.get_json()
    assert remove_payload["active_chat_id"] == main_chat_id
    assert [chat["id"] for chat in remove_payload["pinned_chats"]] == [feature_chat.id]

    reopen_response = client.post("/api/chats/reopen", json={"init_data": "ok", "chat_id": feature_chat.id})
    assert reopen_response.status_code == 200
    reopen_payload = reopen_response.get_json()
    assert reopen_payload["chat"]["id"] == feature_chat.id
    assert reopen_payload["active_chat_id"] == feature_chat.id
    assert any(chat["id"] == feature_chat.id for chat in reopen_payload["chats"])


def test_chats_status_returns_pinned_chats(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    server.store.ensure_default_chat("123")
    pinned_chat = server.store.create_chat("123", "Pinned")
    server.store.set_chat_pinned("123", pinned_chat.id, is_pinned=True)

    response = client.post("/api/chats/status", json={"init_data": "ok"})

    assert response.status_code == 200
    payload = response.get_json()
    assert any(chat["id"] == pinned_chat.id for chat in payload["chats"])
    assert [chat["id"] for chat in payload["pinned_chats"]] == [pinned_chat.id]


def test_remove_chat_cancels_open_stream_jobs(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    server.store.ensure_default_chat("123")
    removable = server.store.create_chat("123", "Busy")
    operator_message_id = server.store.add_message("123", removable.id, "operator", "in flight")
    job_id = server.store.enqueue_chat_job("123", removable.id, operator_message_id)

    response = client.post("/api/chats/remove", json={"init_data": "ok", "chat_id": removable.id})

    assert response.status_code == 200
    state = server.store.get_job_state(job_id)
    assert state is not None
    assert state["status"] == "dead"

def test_clear_chat_evicts_persistent_runtime(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    captured = {"session_id": None}
    monkeypatch.setattr(server.client, "evict_session", lambda session_id: captured.__setitem__("session_id", session_id) or True)

    chat_id = server.store.ensure_default_chat("123")
    server.store.add_message("123", chat_id, "operator", "x")

    response = client.post("/api/chats/clear", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 200
    assert captured["session_id"] == f"miniapp-123-{chat_id}"

def test_clear_chat_cancels_open_stream_jobs(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "in flight")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id)

    response = client.post("/api/chats/clear", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 200
    state = server.store.get_job_state(job_id)
    assert state is not None
    assert state["status"] == "dead"

def test_remove_chat_evicts_persistent_runtime(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    captured = {"session_id": None}
    monkeypatch.setattr(server.client, "evict_session", lambda session_id: captured.__setitem__("session_id", session_id) or True)

    default_chat_id = server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")

    response = client.post("/api/chats/remove", json={"init_data": "ok", "chat_id": alt_chat.id})

    assert response.status_code == 200
    assert captured["session_id"] == f"miniapp-123-{alt_chat.id}"
    assert response.get_json()["active_chat_id"] == default_chat_id

def test_stream_chat_rejects_when_open_job_exists(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "already running")
    server.store.enqueue_chat_job("123", chat_id, operator_message_id)

    response = client.post(
        "/api/chat/stream",
        json={"init_data": "ok", "chat_id": chat_id, "message": "second"},
    )

    assert response.status_code == 409
    body = response.get_data(as_text=True)
    assert "already working" in body

def test_stream_resume_rejects_when_no_open_job(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    response = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 409
    body = response.get_data(as_text=True)
    assert "No active Hermes job" in body

def test_stream_resume_replays_buffered_events_for_open_job(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "resume this")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id)
    claimed = server.store.claim_next_job()
    assert claimed is not None
    assert claimed["id"] == job_id

    server._publish_job_event(job_id, "tool", {"chat_id": chat_id, "display": "read_file: test"})
    server._publish_job_event(job_id, "done", {"chat_id": chat_id, "reply": "ok", "latency_ms": 1})

    response = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "event: tool" in body
    assert "read_file: test" in body
    assert "event: done" in body
    assert '"reply": "ok"' in body

def test_stream_resume_can_reconnect_multiple_times_to_same_open_job(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "resume this")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id)
    server.store.claim_next_job()

    server._publish_job_event(job_id, "tool", {"chat_id": chat_id, "display": "tool call"})
    server._publish_job_event(job_id, "done", {"chat_id": chat_id, "reply": "ok", "latency_ms": 1})

    first = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})
    assert first.status_code == 200
    assert "event: tool" in first.get_data(as_text=True)

    server._publish_job_event(job_id, "tool", {"chat_id": chat_id, "display": "tool call 2"})
    server._publish_job_event(job_id, "done", {"chat_id": chat_id, "reply": "ok", "latency_ms": 1})
    second = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})
    assert second.status_code == 200
    assert "event: tool" in second.get_data(as_text=True)


def test_stream_resume_emits_synthetic_terminal_when_queue_silent(monkeypatch, tmp_path) -> None:
    import routes_chat_stream

    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "resume this")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id)
    claimed = server.store.claim_next_job()
    assert claimed is not None

    class _AlwaysEmptySubscriber:
        def get(self, timeout=None):
            raise queue.Empty

    monotonic_ticks = iter([0.0, 5.0, 10.0, 15.0])
    monkeypatch.setattr(routes_chat_stream.time, "monotonic", lambda: next(monotonic_ticks, 20.0))
    monkeypatch.setattr(server.runtime, "subscribe_job_events", lambda _job_id: _AlwaysEmptySubscriber())
    monkeypatch.setattr(server.runtime, "unsubscribe_job_events", lambda _job_id, _subscriber: None)
    monkeypatch.setattr(
        server.store,
        "get_job_state",
        lambda _job_id: {"status": "done", "error": None, "attempts": 1, "max_attempts": 1},
    )

    response = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "event: done" in body
    assert '"synthetic": true' in body
    assert '"job_status": "done"' in body


def test_chat_history_endpoint_can_read_without_activating(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    main_chat_id = server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")
    server.store.add_message("123", alt_chat.id, "hermes", "new reply")
    server.store.set_active_chat("123", main_chat_id)

    response = client.post(
        "/api/chats/history",
        json={"init_data": "ok", "chat_id": alt_chat.id, "activate": False},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert data["chat"]["id"] == alt_chat.id
    assert data["history"][-1]["body"] == "new reply"
    assert server.store.get_active_chat("123") == main_chat_id
    assert server.store.get_chat("123", alt_chat.id).unread_count == 1


def test_open_chat_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/open")


def test_chat_history_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/history")


def test_mark_read_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/mark-read")


def test_clear_chat_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/clear")


def test_remove_chat_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/remove")


def test_chat_returns_400_for_invalid_chat_id(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = _post_chat_endpoint(client, "/api/chat", chat_id="invalid", message="hello")

    assert response.status_code == 400
    assert "Invalid chat_id." in response.get_json()["error"]


def test_stream_chat_returns_400_for_invalid_chat_id(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = _post_chat_endpoint(client, "/api/chat/stream", chat_id="invalid", message="hello")

    assert response.status_code == 400
    assert "Invalid chat_id." in response.get_data(as_text=True)


def test_stream_resume_returns_400_for_invalid_chat_id(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = _post_chat_endpoint(client, "/api/chat/stream/resume", chat_id="invalid")

    assert response.status_code == 400
    assert "Invalid chat_id." in response.get_data(as_text=True)
