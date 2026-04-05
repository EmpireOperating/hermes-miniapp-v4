from __future__ import annotations

import queue

import store as store_mod

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


def test_remove_chat_can_return_no_active_chat_when_allow_empty_requested(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    only_chat_id = server.store.ensure_default_chat("123")
    server.store.set_active_chat("123", only_chat_id)

    response = client.post(
        "/api/chats/remove",
        json={"init_data": "ok", "chat_id": only_chat_id, "allow_empty": True},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["active_chat_id"] is None
    assert payload["active_chat"] is None
    assert payload["history"] == []
    assert payload["chats"] == []


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


def test_reopen_chat_from_zero_tabs_does_not_create_main_backup_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    main_chat_id = server.store.ensure_default_chat("123")
    feature_chat = server.store.create_chat("123", "Feature")
    server.store.set_chat_pinned("123", feature_chat.id, is_pinned=True)

    # Archive feature, then archive main so the user is in a true zero-tab state.
    close_feature = client.post(
        "/api/chats/remove",
        json={"init_data": "ok", "chat_id": feature_chat.id, "allow_empty": True},
    )
    assert close_feature.status_code == 200
    close_main = client.post(
        "/api/chats/remove",
        json={"init_data": "ok", "chat_id": main_chat_id, "allow_empty": True},
    )
    assert close_main.status_code == 200
    assert close_main.get_json()["chats"] == []

    reopen_response = client.post(
        "/api/chats/reopen",
        json={"init_data": "ok", "chat_id": feature_chat.id},
    )
    assert reopen_response.status_code == 200
    payload = reopen_response.get_json()

    chat_ids = [chat["id"] for chat in payload["chats"]]
    assert chat_ids == [feature_chat.id]
    assert payload["active_chat_id"] == feature_chat.id


def test_fork_chat_creates_new_chat_with_source_history(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path, max_title_len=32)

    source_chat = server.store.create_chat("123", "Feature")
    server.store.add_message("123", source_chat.id, "operator", "check /tmp/source.py:7")
    server.store.add_message("123", source_chat.id, "hermes", "ack")

    response = client.post(
        "/api/chats/fork",
        json={"init_data": "ok", "chat_id": source_chat.id, "title": "Feature alt"},
    )

    assert response.status_code == 201
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["chat"]["id"] != source_chat.id
    assert payload["chat"]["title"] == "Feature alt"
    assert payload["active_chat_id"] == payload["chat"]["id"]
    assert payload["forked_from_chat_id"] == source_chat.id
    assert [turn["body"] for turn in payload["history"]] == ["check /tmp/source.py:7", "ack"]
    assert len(payload["history"][0].get("file_refs") or []) == 1
    assert any(chat["id"] == source_chat.id for chat in payload["chats"])
    assert any(chat["id"] == payload["chat"]["id"] for chat in payload["chats"])


def test_fork_chat_rejects_active_work(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    source_chat = server.store.create_chat("123", "Busy")
    operator_message_id = server.store.add_message("123", source_chat.id, "operator", "still working")
    server.store.enqueue_chat_job("123", source_chat.id, operator_message_id)

    response = client.post(
        "/api/chats/fork",
        json={"init_data": "ok", "chat_id": source_chat.id, "title": "Busy alt"},
    )

    assert response.status_code == 409
    payload = response.get_json()
    assert "finish before forking" in payload["error"].lower()
    assert [chat.title for chat in server.store.list_chats("123")] == ["Busy"]


def test_chat_routes_use_current_server_store_after_swap(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    original_chat = server.store.create_chat("123", "Original")
    assert original_chat.id == 1

    server.store = store_mod.SessionStore(tmp_path / "replacement.db")

    response = client.post("/api/chats", json={"init_data": "ok", "title": "Fresh"})

    assert response.status_code == 201
    payload = response.get_json()
    assert payload["chat"]["title"] == "Fresh"
    assert payload["chat"]["id"] == 1
    assert [chat.title for chat in server.store.list_chats("123")] == ["Fresh"]


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

    captured = {"session_id": None, "reason": None}
    monkeypatch.setattr(server.client, "evict_session", lambda session_id, reason="explicit_eviction": captured.update({"session_id": session_id, "reason": reason}) or True)

    chat_id = server.store.ensure_default_chat("123")
    server.store.add_message("123", chat_id, "operator", "x")

    response = client.post("/api/chats/clear", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 200
    assert captured["session_id"] == f"miniapp-123-{chat_id}"
    assert captured["reason"] == "invalidated_by_clear"

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

    captured = {"session_id": None, "reason": None}
    monkeypatch.setattr(server.client, "evict_session", lambda session_id, reason="explicit_eviction": captured.update({"session_id": session_id, "reason": reason}) or True)

    default_chat_id = server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")

    response = client.post("/api/chats/remove", json={"init_data": "ok", "chat_id": alt_chat.id})

    assert response.status_code == 200
    assert captured["session_id"] == f"miniapp-123-{alt_chat.id}"
    assert captured["reason"] == "invalidated_by_remove"
    assert response.get_json()["active_chat_id"] == default_chat_id

def test_file_preview_reads_allowed_path(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(tmp_path))
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    target = tmp_path / "demo.py"
    target.write_text("a\nb\nc\n", encoding="utf-8")

    response = client.post(
        "/api/chats/file-preview",
        json={"init_data": "ok", "chat_id": chat_id, "path": str(target), "line_start": 2},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["preview"]["path"] == str(target)
    assert payload["preview"]["line_start"] == 2
    assert payload["preview"]["window_start"] == 1
    assert payload["preview"]["window_end"] == 3
    assert payload["preview"]["total_lines"] == 3
    assert payload["preview"]["is_truncated"] is False
    assert payload["preview"]["can_expand_up"] is False
    assert payload["preview"]["can_expand_down"] is False
    assert payload["preview"]["can_load_full_file"] is True
    assert payload["preview"]["full_file_loaded"] is False
    assert any(line["line"] == 2 and line["text"] == "b" for line in payload["preview"]["lines"])


def test_file_preview_reads_by_ref_id(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(tmp_path))
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    target = tmp_path / "demo.py"
    target.write_text("a\nb\nc\n", encoding="utf-8")
    server.store.add_message("123", chat_id, "hermes", f"See {target}:2")

    history_response = client.post(
        "/api/chats/history",
        json={"init_data": "ok", "chat_id": chat_id},
    )
    assert history_response.status_code == 200
    history_payload = history_response.get_json()
    refs = history_payload["history"][-1].get("file_refs") or []
    assert refs
    ref_id = refs[0]["ref_id"]

    response = client.post(
        "/api/chats/file-preview",
        json={"init_data": "ok", "chat_id": chat_id, "ref_id": ref_id},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["preview"]["path"] == str(target)
    assert payload["preview"]["line_start"] == 2
    assert payload["preview"]["total_lines"] == 3
    assert payload["preview"]["is_truncated"] is False


def test_file_preview_history_extracts_dotfiles_and_common_root_files(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(tmp_path))
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    env_file = tmp_path / ".env"
    env_file.write_text("ONE=1\nTWO=2\n", encoding="utf-8")
    dockerfile = tmp_path / "Dockerfile"
    dockerfile.write_text("FROM python:3.12\nRUN echo ok\n", encoding="utf-8")
    server.store.add_message("123", chat_id, "hermes", "Check .env:2 and Dockerfile:1")

    history_response = client.post(
        "/api/chats/history",
        json={"init_data": "ok", "chat_id": chat_id},
    )

    assert history_response.status_code == 200
    history_payload = history_response.get_json()
    refs = history_payload["history"][-1].get("file_refs") or []
    assert [ref["path"] for ref in refs] == [".env", "Dockerfile"]
    assert [ref["line_start"] for ref in refs] == [2, 1]


def test_file_preview_reads_relative_path_within_allowed_root(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(tmp_path))
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    nested = tmp_path / "src" / "demo.py"
    nested.parent.mkdir(parents=True, exist_ok=True)
    nested.write_text("one\ntwo\nthree\n", encoding="utf-8")

    response = client.post(
        "/api/chats/file-preview",
        json={"init_data": "ok", "chat_id": chat_id, "path": "src/demo.py", "line_start": 3},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["preview"]["path"] == str(nested)
    assert payload["preview"]["line_start"] == 3
    assert any(line["line"] == 3 and line["text"] == "three" for line in payload["preview"]["lines"])


def test_file_preview_expands_context_window_on_request(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(tmp_path))
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    target = tmp_path / "demo.py"
    target.write_text("\n".join(f"line-{index}" for index in range(1, 201)) + "\n", encoding="utf-8")

    response = client.post(
        "/api/chats/file-preview",
        json={
            "init_data": "ok",
            "chat_id": chat_id,
            "path": str(target),
            "line_start": 100,
            "window_start": 70,
            "window_end": 130,
        },
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["preview"]["window_start"] == 70
    assert payload["preview"]["window_end"] == 130
    assert payload["preview"]["is_truncated"] is True
    assert payload["preview"]["can_expand_up"] is True
    assert payload["preview"]["can_expand_down"] is True
    assert payload["preview"]["can_load_full_file"] is True
    assert payload["preview"]["full_file_loaded"] is False
    assert payload["preview"]["lines"][0]["line"] == 70
    assert payload["preview"]["lines"][-1]["line"] == 130


def test_file_preview_loads_full_file_when_within_safe_limits(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(tmp_path))
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    target = tmp_path / "demo.py"
    target.write_text("\n".join(f"line-{index}" for index in range(1, 121)) + "\n", encoding="utf-8")

    response = client.post(
        "/api/chats/file-preview",
        json={
            "init_data": "ok",
            "chat_id": chat_id,
            "path": str(target),
            "line_start": 60,
            "full_file": True,
        },
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["preview"]["window_start"] == 1
    assert payload["preview"]["window_end"] == 120
    assert payload["preview"]["is_truncated"] is False
    assert payload["preview"]["can_expand_up"] is False
    assert payload["preview"]["can_expand_down"] is False
    assert payload["preview"]["can_load_full_file"] is False
    assert payload["preview"]["full_file_loaded"] is True
    assert payload["preview"]["lines"][0]["line"] == 1
    assert payload["preview"]["lines"][-1]["line"] == 120



def test_file_preview_rejects_full_file_load_when_file_exceeds_safe_limits(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(tmp_path))
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    target = tmp_path / "large.py"
    target.write_text("\n".join(f"line-{index}" for index in range(1, 2502)) + "\n", encoding="utf-8")

    response = client.post(
        "/api/chats/file-preview",
        json={
            "init_data": "ok",
            "chat_id": chat_id,
            "path": str(target),
            "line_start": 100,
            "full_file": True,
        },
    )

    assert response.status_code == 400
    assert "too large to load fully" in response.get_json()["error"].lower()



def test_file_preview_rejects_relative_path_that_escapes_allowed_root(monkeypatch, tmp_path) -> None:
    allowed_root = tmp_path / "allowed"
    allowed_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(allowed_root))
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")

    response = client.post(
        "/api/chats/file-preview",
        json={"init_data": "ok", "chat_id": chat_id, "path": "../outside.py", "line_start": 1},
    )

    assert response.status_code == 400
    assert "allowed root" in response.get_json()["error"].lower()


def test_file_preview_rejects_path_outside_allowed_roots(monkeypatch, tmp_path) -> None:
    allowed_root = tmp_path / "allowed"
    allowed_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(allowed_root))
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    outside = tmp_path / "outside.py"
    outside.write_text("print('x')\n", encoding="utf-8")

    response = client.post(
        "/api/chats/file-preview",
        json={"init_data": "ok", "chat_id": chat_id, "path": str(outside), "line_start": 1},
    )

    assert response.status_code == 403
    assert "outside allowed roots" in response.get_json()["error"].lower()


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


def test_stream_chat_allows_other_chat_while_first_chat_has_open_job(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    first_chat_id = server.store.ensure_default_chat("123")
    second_chat = server.store.create_chat("123", "Second")

    first_operator_message_id = server.store.add_message("123", first_chat_id, "operator", "first still running")
    first_job_id = server.store.enqueue_chat_job("123", first_chat_id, first_operator_message_id)

    class _SingleDoneSubscriber:
        def __init__(self, payload: dict[str, object]):
            self._payload = payload
            self._sent = False

        def get(self, timeout=None):
            if self._sent:
                raise queue.Empty
            self._sent = True
            return {
                "event": "done",
                "event_id": 1,
                "payload": dict(self._payload),
            }

    subscribers: dict[int, _SingleDoneSubscriber] = {}

    def _subscribe_job_events(job_id: int, after_event_id: int = 0):
        if after_event_id:
            raise AssertionError("new stream should not request replay cursor")
        subscribers[job_id] = _SingleDoneSubscriber(
            {"chat_id": second_chat.id, "reply": "second ok", "latency_ms": 1}
        )
        return subscribers[job_id]

    monkeypatch.setattr(server.runtime, "subscribe_job_events", _subscribe_job_events)
    monkeypatch.setattr(server.runtime, "unsubscribe_job_events", lambda _job_id, _subscriber: None)

    response = client.post(
        "/api/chat/stream",
        json={"init_data": "ok", "chat_id": second_chat.id, "message": "second can still run"},
    )

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "event: done" in body
    assert '"reply": "second ok"' in body

    first_state = server.store.get_job_state(first_job_id)
    assert first_state is not None
    assert first_state["status"] in {"queued", "open", "running"}

    open_first = server.store.get_open_job(user_id="123", chat_id=first_chat_id)
    open_second = server.store.get_open_job(user_id="123", chat_id=second_chat.id)
    assert open_first is not None
    assert open_first["id"] == first_job_id
    assert open_second is not None
    assert int(open_second["id"]) != first_job_id
    assert server.store.get_active_chat("123") == second_chat.id


def test_stream_resume_rejects_when_no_open_job(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    response = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 409
    body = response.get_data(as_text=True)
    assert "No active Hermes job" in body


def test_stream_resume_without_open_job_does_not_change_active_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    main_chat_id = server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")
    server.store.set_active_chat("123", main_chat_id)

    response = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": alt_chat.id})

    assert response.status_code == 409
    assert server.store.get_active_chat("123") == main_chat_id


def test_stream_resume_dead_letters_stale_open_job_before_409(monkeypatch, tmp_path) -> None:
    import sqlite3

    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "resume stale")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id)

    conn = sqlite3.connect(server.store.db_path)
    conn.execute("UPDATE chat_jobs SET updated_at = datetime('now', '-600 seconds') WHERE id = ?", (job_id,))
    conn.commit()
    conn.close()

    response = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 409
    body = response.get_data(as_text=True)
    assert "No active Hermes job" in body

    state = server.store.get_job_state(job_id)
    assert state is not None
    assert state["status"] == "dead"


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
    assert "event: tool\ndata:" in body
    assert '"_event_id": 1' in body
    assert '"_event_id": 2' in body
    assert "\\ndata:" not in body


def test_stream_resume_with_open_job_does_not_change_active_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    main_chat_id = server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")
    server.store.set_active_chat("123", main_chat_id)
    operator_message_id = server.store.add_message("123", alt_chat.id, "operator", "resume this")
    job_id = server.store.enqueue_chat_job("123", alt_chat.id, operator_message_id)
    claimed = server.store.claim_next_job()
    assert claimed is not None
    assert claimed["id"] == job_id

    server._publish_job_event(job_id, "done", {"chat_id": alt_chat.id, "reply": "ok", "latency_ms": 1})

    response = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": alt_chat.id})

    assert response.status_code == 200
    assert server.store.get_active_chat("123") == main_chat_id


def test_stream_resume_can_request_only_events_after_last_seen_cursor(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "resume this")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id)
    server.store.claim_next_job()

    server._publish_job_event(job_id, "tool", {"chat_id": chat_id, "display": "tool call"})
    server._publish_job_event(job_id, "chunk", {"chat_id": chat_id, "text": "partial"})
    server._publish_job_event(job_id, "done", {"chat_id": chat_id, "reply": "ok", "latency_ms": 1})

    response = client.post(
        "/api/chat/stream/resume",
        json={"init_data": "ok", "chat_id": chat_id, "after_event_id": 1},
    )
    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "tool call" not in body
    assert '"text": "partial"' in body
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
    monkeypatch.setattr(server.runtime, "subscribe_job_events", lambda _job_id, after_event_id=0: _AlwaysEmptySubscriber())
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


def test_stream_resume_emits_done_for_dead_job_with_live_warm_handoff(monkeypatch, tmp_path) -> None:
    import routes_chat_stream

    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "resume this")
    _job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id)
    claimed = server.store.claim_next_job()
    assert claimed is not None

    class _AlwaysEmptySubscriber:
        def get(self, timeout=None):
            raise queue.Empty

    monotonic_ticks = iter([0.0, 5.0, 10.0, 15.0])
    monkeypatch.setattr(routes_chat_stream.time, "monotonic", lambda: next(monotonic_ticks, 20.0))
    monkeypatch.setattr(server.runtime, "subscribe_job_events", lambda _job_id, after_event_id=0: _AlwaysEmptySubscriber())
    monkeypatch.setattr(server.runtime, "unsubscribe_job_events", lambda _job_id, _subscriber: None)
    monkeypatch.setattr(
        server.store,
        "get_job_state",
        lambda _job_id: {"status": "dead", "error": None, "attempts": 1, "max_attempts": 1},
    )
    monkeypatch.setattr(
        server.client,
        "select_warm_session_candidate",
        lambda session_id: {
            "session_id": session_id,
            "state": "attachable_running",
            "attach_worker_endpoint": "/tmp/test.sock",
            "attach_resume_token": "token-123",
        },
    )

    response = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "event: done" in body
    assert '"job_status": "dead"' in body
    assert '"warm_handoff": true' in body
    assert '"persistent_mode": "warm-detached"' in body
    assert 'stream detached to warm owner' in body


def test_stream_efficiency_mode_throttles_job_state_db_reads(monkeypatch, tmp_path) -> None:
    import routes_chat_stream

    monkeypatch.setenv("MINI_APP_STREAM_EFFICIENCY_MODE", "1")
    monkeypatch.setenv("MINI_APP_STREAM_METRICS_REFRESH_SECONDS", "10")
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    operator_message_id = server.store.add_message("123", chat_id, "operator", "resume this")
    job_id = server.store.enqueue_chat_job("123", chat_id, operator_message_id)
    claimed = server.store.claim_next_job()
    assert claimed is not None

    class _AlwaysEmptySubscriber:
        def get(self, timeout=None):
            raise queue.Empty

    monotonic_ticks = iter([0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0])
    monkeypatch.setattr(routes_chat_stream.time, "monotonic", lambda: next(monotonic_ticks, 12.0))
    monkeypatch.setattr(server.runtime, "subscribe_job_events", lambda _job_id, after_event_id=0: _AlwaysEmptySubscriber())
    monkeypatch.setattr(server.runtime, "unsubscribe_job_events", lambda _job_id, _subscriber: None)

    polls = {"count": 0}

    def _get_job_state(_job_id: int):
        polls["count"] += 1
        if polls["count"] < 2:
            return {
                "status": "running",
                "error": None,
                "queued_ahead": 0,
                "running_total": 1,
                "attempts": 1,
                "max_attempts": 4,
                "started_at": None,
                "created_at": None,
            }
        return {
            "status": "done",
            "error": None,
            "attempts": 1,
            "max_attempts": 4,
            "started_at": None,
            "created_at": None,
        }

    monkeypatch.setattr(server.store, "get_job_state", _get_job_state)

    response = client.post("/api/chat/stream/resume", json={"init_data": "ok", "chat_id": chat_id})

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "event: done" in body
    assert '"synthetic": true' in body
    assert polls["count"] == 2


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


def test_rename_chat_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/rename")


def test_chat_history_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/history")


def test_chat_history_without_chat_id_uses_active_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    main_chat_id = server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")
    server.store.add_message("123", alt_chat.id, "operator", "from active chat")
    server.store.set_active_chat("123", alt_chat.id)

    response = _post_chat_endpoint(client, "/api/chats/history")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["chat"]["id"] == alt_chat.id
    assert payload["history"][-1]["body"] == "from active chat"
    assert payload["chat"]["id"] != main_chat_id
    assert server.store.get_active_chat("123") == alt_chat.id



def test_chat_history_without_chat_id_preserves_explicit_zero_chat_state(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    only_chat_id = server.store.ensure_default_chat("123")
    server.store.set_active_chat("123", only_chat_id)
    server.store.remove_chat("123", only_chat_id, allow_empty=True)

    response = _post_chat_endpoint(client, "/api/chats/history")

    assert response.status_code == 404
    assert "not found" in response.get_json()["error"].lower()
    assert server.store.get_active_chat("123") is None
    assert server.store.list_chats("123") == []



def test_chat_history_without_chat_id_keeps_legacy_default_chat_for_brand_new_user(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = _post_chat_endpoint(client, "/api/chats/history")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["chat"]["title"] == "Main"
    assert payload["history"] == []

    chats = server.store.list_chats("123")
    assert len(chats) == 1
    assert chats[0].title == "Main"



def test_chat_history_with_zero_chat_id_uses_active_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")
    server.store.add_message("123", alt_chat.id, "operator", "from zero chat id")
    server.store.set_active_chat("123", alt_chat.id)

    response = _post_chat_endpoint(client, "/api/chats/history", chat_id=0)

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["chat"]["id"] == alt_chat.id
    assert payload["history"][-1]["body"] == "from zero chat id"
    assert server.store.get_active_chat("123") == alt_chat.id



def test_chat_history_with_empty_string_chat_id_uses_active_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")
    server.store.add_message("123", alt_chat.id, "operator", "from empty string chat id")
    server.store.set_active_chat("123", alt_chat.id)

    response = _post_chat_endpoint(client, "/api/chats/history", chat_id="")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["chat"]["id"] == alt_chat.id
    assert payload["history"][-1]["body"] == "from empty string chat id"
    assert server.store.get_active_chat("123") == alt_chat.id



def test_chat_history_with_string_zero_chat_id_uses_active_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    server.store.ensure_default_chat("123")
    alt_chat = server.store.create_chat("123", "Alt")
    server.store.add_message("123", alt_chat.id, "operator", "from string zero chat id")
    server.store.set_active_chat("123", alt_chat.id)

    response = _post_chat_endpoint(client, "/api/chats/history", chat_id="0")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["chat"]["id"] == alt_chat.id
    assert payload["history"][-1]["body"] == "from string zero chat id"
    assert server.store.get_active_chat("123") == alt_chat.id



def test_chat_history_with_zero_chat_id_preserves_explicit_zero_chat_state(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    only_chat_id = server.store.ensure_default_chat("123")
    server.store.set_active_chat("123", only_chat_id)
    server.store.remove_chat("123", only_chat_id, allow_empty=True)

    response = _post_chat_endpoint(client, "/api/chats/history", chat_id=0)

    assert response.status_code == 404
    assert "not found" in response.get_json()["error"].lower()
    assert server.store.list_chats("123") == []



def test_chat_history_returns_400_for_invalid_activate_flag(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    chat_id = server.store.ensure_default_chat("123")
    response = _post_chat_endpoint(client, "/api/chats/history", chat_id=chat_id, activate="false")

    assert response.status_code == 400
    assert "activate" in response.get_json()["error"].lower()


def test_mark_read_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/mark-read")


def test_pin_chat_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/pin")


def test_unpin_chat_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/unpin")


def test_reopen_chat_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/reopen")


def test_fork_chat_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    _assert_missing_chat_404(client, "/api/chats/fork")


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


def test_chat_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = _post_chat_endpoint(client, "/api/chat", chat_id=999999, message="hello")

    assert response.status_code == 404
    assert "not found" in response.get_json()["error"].lower()


def test_stream_chat_returns_400_for_invalid_chat_id(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = _post_chat_endpoint(client, "/api/chat/stream", chat_id="invalid", message="hello")

    assert response.status_code == 400
    assert "Invalid chat_id." in response.get_data(as_text=True)


def test_stream_chat_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = _post_chat_endpoint(client, "/api/chat/stream", chat_id=999999, message="hello")

    assert response.status_code == 404
    assert "not found" in response.get_data(as_text=True).lower()


def test_stream_resume_returns_400_for_invalid_chat_id(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = _post_chat_endpoint(client, "/api/chat/stream/resume", chat_id="invalid")

    assert response.status_code == 400
    assert "Invalid chat_id." in response.get_data(as_text=True)


def test_stream_resume_returns_404_for_missing_chat(monkeypatch, tmp_path) -> None:
    server, client = _authed_client(monkeypatch, tmp_path)

    response = _post_chat_endpoint(client, "/api/chat/stream/resume", chat_id=999999)

    assert response.status_code == 404
    assert "not found" in response.get_data(as_text=True).lower()
