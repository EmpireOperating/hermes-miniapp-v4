from __future__ import annotations

import pytest

from store import SessionStore


def _store(tmp_path) -> SessionStore:
    return SessionStore(tmp_path / "sessions.db")


def test_unread_count_and_mark_read(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u1"
    chat_id = store.ensure_default_chat(user_id)

    store.add_message(user_id, chat_id, "operator", "hello")
    store.add_message(user_id, chat_id, "hermes", "reply 1")
    store.add_message(user_id, chat_id, "hermes", "reply 2")

    chat = store.get_chat(user_id, chat_id)
    assert chat.unread_count == 2

    store.mark_chat_read(user_id, chat_id)
    chat = store.get_chat(user_id, chat_id)
    assert chat.unread_count == 0


def test_store_rejects_overlong_title(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u2"

    with pytest.raises(ValueError, match="Title exceeds"):
        store.create_chat(user_id, "x" * 121)


def test_store_rejects_overlong_message(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u3"
    chat_id = store.ensure_default_chat(user_id)

    with pytest.raises(ValueError, match="exceeds"):
        store.add_message(user_id, chat_id, "operator", "x" * 4001)


def test_store_accepts_long_assistant_message(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u3b"
    chat_id = store.ensure_default_chat(user_id)

    long_reply = "x" * 12000
    message_id = store.add_message(user_id, chat_id, "hermes", long_reply)

    assert message_id > 0
    history = store.get_history(user_id, chat_id)
    assert history[-1].role == "hermes"
    assert history[-1].body == long_reply


def test_remove_chat_archives_thread_and_keeps_messages_while_hiding_it(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u4"
    first_chat_id = store.ensure_default_chat(user_id)
    second_chat = store.create_chat(user_id, "Second")
    store.add_message(user_id, second_chat.id, "operator", "hello")

    next_chat_id = store.remove_chat(user_id, second_chat.id)

    assert next_chat_id == first_chat_id
    archived_chat = store.get_chat(user_id, second_chat.id)
    assert archived_chat.title == "Second"
    assert store.get_turn_count(user_id, second_chat.id) == 1
    assert [chat.id for chat in store.list_chats(user_id)] == [first_chat_id]


def test_pinned_chat_remains_recoverable_after_close_and_can_reopen(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u4b"
    main_chat_id = store.ensure_default_chat(user_id)
    feature_chat = store.create_chat(user_id, "Feature MVP")
    store.add_message(user_id, feature_chat.id, "operator", "save this")

    pinned = store.set_chat_pinned(user_id, feature_chat.id, is_pinned=True)
    assert pinned.is_pinned is True
    assert [chat.id for chat in store.list_pinned_chats(user_id)] == [feature_chat.id]

    next_chat_id = store.remove_chat(user_id, feature_chat.id)
    assert next_chat_id == main_chat_id
    assert [chat.id for chat in store.list_chats(user_id)] == [main_chat_id]
    assert [chat.id for chat in store.list_pinned_chats(user_id)] == [feature_chat.id]

    reopened = store.reopen_chat(user_id, feature_chat.id)
    assert reopened.id == feature_chat.id
    assert [chat.id for chat in store.list_chats(user_id)] == [main_chat_id, feature_chat.id]


def test_remove_last_visible_chat_creates_fresh_default_chat(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u5"
    chat_id = store.ensure_default_chat(user_id)
    store.add_message(user_id, chat_id, "operator", "saved")

    next_chat_id = store.remove_chat(user_id, chat_id)

    assert next_chat_id != chat_id
    replacement = store.get_chat(user_id, next_chat_id)
    assert replacement.title == "Main"
    assert store.get_turn_count(user_id, chat_id) == 1


def test_remove_chat_cancels_open_jobs(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u5b"
    active_chat_id = store.ensure_default_chat(user_id)
    removable_chat = store.create_chat(user_id, "Removable")
    operator_message_id = store.add_message(user_id, removable_chat.id, "operator", "queued")
    job_id = store.enqueue_chat_job(user_id, removable_chat.id, operator_message_id)

    replacement_id = store.remove_chat(user_id, removable_chat.id)

    assert replacement_id == active_chat_id
    state = store.get_job_state(job_id)
    assert state is not None
    assert state["status"] == "dead"
    dead_letters = store.list_dead_letters(user_id, limit=10)
    matching = [item for item in dead_letters if item["job_id"] == job_id]
    assert matching
    assert "archived" in str(matching[0]["error"] or "").lower()


def test_store_tracks_active_chat_preference(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u6"
    main_chat_id = store.ensure_default_chat(user_id)
    alt_chat = store.create_chat(user_id, "Alt")

    assert store.get_active_chat(user_id) is None

    store.set_active_chat(user_id, alt_chat.id)
    assert store.get_active_chat(user_id) == alt_chat.id

    store.set_active_chat(user_id, main_chat_id)
    assert store.get_active_chat(user_id) == main_chat_id


def test_pending_flag_reflects_latest_operator_turn(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u7"
    chat_id = store.ensure_default_chat(user_id)

    initial = store.get_chat(user_id, chat_id)
    assert initial.pending is False

    store.add_message(user_id, chat_id, "operator", "hello")
    pending_chat = store.get_chat(user_id, chat_id)
    assert pending_chat.pending is True

    store.add_message(user_id, chat_id, "hermes", "hi")
    resolved_chat = store.get_chat(user_id, chat_id)
    assert resolved_chat.pending is False


def test_chat_job_queue_lifecycle(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u8"
    chat_id = store.ensure_default_chat(user_id)
    operator_message_id = store.add_message(user_id, chat_id, "operator", "run job")

    job_id = store.enqueue_chat_job(user_id, chat_id, operator_message_id)
    assert store.has_open_job(user_id, chat_id) is True
    queued_open = store.get_open_job(user_id, chat_id)
    assert queued_open is not None
    assert queued_open["id"] == job_id
    assert queued_open["status"] == "queued"

    claimed = store.claim_next_job()
    assert claimed is not None
    assert claimed["id"] == job_id
    assert claimed["operator_message_id"] == operator_message_id

    running_open = store.get_open_job(user_id, chat_id)
    assert running_open is not None
    assert running_open["id"] == job_id
    assert running_open["status"] == "running"

    assert store.has_open_job(user_id, chat_id) is True
    store.complete_job(job_id)
    assert store.has_open_job(user_id, chat_id) is False
    assert store.get_open_job(user_id, chat_id) is None


def test_claim_next_job_skips_same_chat_when_one_is_running(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u9"

    chat1 = store.ensure_default_chat(user_id)
    op1a = store.add_message(user_id, chat1, "operator", "first")
    op1b = store.add_message(user_id, chat1, "operator", "second")

    chat2 = store.create_chat(user_id, "Other")
    op2 = store.add_message(user_id, chat2.id, "operator", "other chat")

    first_job = store.enqueue_chat_job(user_id, chat1, op1a)
    second_same_chat_job = store.enqueue_chat_job(user_id, chat1, op1b)
    other_chat_job = store.enqueue_chat_job(user_id, chat2.id, op2)

    first_claim = store.claim_next_job()
    assert first_claim is not None
    assert first_claim["id"] == first_job

    second_claim = store.claim_next_job()
    assert second_claim is not None
    assert second_claim["id"] == other_chat_job

    third_claim = store.claim_next_job()
    assert third_claim is None

    # Once chat1 running job completes, its queued sibling becomes claimable.
    store.complete_job(first_job)
    final_claim = store.claim_next_job()
    assert final_claim is not None
    assert final_claim["id"] == second_same_chat_job


def test_claim_next_job_skips_jobs_for_archived_chats(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u9a"

    chat1 = store.ensure_default_chat(user_id)
    op1 = store.add_message(user_id, chat1, "operator", "stale")
    stale_job_id = store.enqueue_chat_job(user_id, chat1, op1)

    chat2 = store.create_chat(user_id, "Live")
    op2 = store.add_message(user_id, chat2.id, "operator", "live")
    live_job_id = store.enqueue_chat_job(user_id, chat2.id, op2)

    # Simulate legacy data where a queued job exists for an archived chat.
    import sqlite3

    conn = sqlite3.connect(store.db_path)
    conn.execute("UPDATE chat_threads SET is_archived = 1 WHERE user_id = ? AND id = ?", (user_id, chat1))
    conn.commit()
    conn.close()

    claimed = store.claim_next_job()
    assert claimed is not None
    assert claimed["id"] == live_job_id

    state = store.get_job_state(stale_job_id)
    assert state is not None
    assert state["status"] == "queued"


def test_list_recoverable_pending_turns_excludes_open_jobs(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u9b"
    chat_id = store.ensure_default_chat(user_id)
    operator_message_id = store.add_message(user_id, chat_id, "operator", "stuck")

    recoverable = store.list_recoverable_pending_turns(user_id)
    assert (chat_id, operator_message_id) in recoverable

    store.enqueue_chat_job(user_id, chat_id, operator_message_id)
    recoverable_after_enqueue = store.list_recoverable_pending_turns(user_id)
    assert (chat_id, operator_message_id) not in recoverable_after_enqueue


def test_retry_or_dead_letter_job_retries_then_dead_letters(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u10"
    chat_id = store.ensure_default_chat(user_id)
    operator_message_id = store.add_message(user_id, chat_id, "operator", "retry me")

    job_id = store.enqueue_chat_job(user_id, chat_id, operator_message_id, max_attempts=2)

    first_claim = store.claim_next_job()
    assert first_claim is not None
    assert first_claim["attempts"] == 1
    assert store.retry_or_dead_letter_job(job_id, "temporary", retry_base_seconds=1) is True

    second_claim = store.claim_next_job()
    assert second_claim is None  # delayed by next_attempt_at

    # Force immediate retry for test determinism.
    import sqlite3
    conn = sqlite3.connect(store.db_path)
    conn.execute("UPDATE chat_jobs SET next_attempt_at = CURRENT_TIMESTAMP WHERE id = ?", (job_id,))
    conn.commit()
    conn.close()

    second_claim = store.claim_next_job()
    assert second_claim is not None
    assert second_claim["attempts"] == 2

    retried = store.retry_or_dead_letter_job(job_id, "still failing", retry_base_seconds=1)
    assert retried is False


def test_complete_job_only_applies_to_running_state(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u11"
    chat_id = store.ensure_default_chat(user_id)
    op_id = store.add_message(user_id, chat_id, "operator", "run")

    job_id = store.enqueue_chat_job(user_id, chat_id, op_id)
    # Should not complete while still queued.
    store.complete_job(job_id)
    state = store.get_job_state(job_id)
    assert state is not None
    assert state["status"] == "queued"

    claimed = store.claim_next_job()
    assert claimed is not None
    assert claimed["id"] == job_id
    store.complete_job(job_id)
    state_after = store.get_job_state(job_id)
    assert state_after is not None
    assert state_after["status"] == "done"


def test_dead_letter_stale_running_jobs_marks_old_running(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u12"
    chat_id = store.ensure_default_chat(user_id)
    op_id = store.add_message(user_id, chat_id, "operator", "run")

    job_id = store.enqueue_chat_job(user_id, chat_id, op_id)
    claimed = store.claim_next_job()
    assert claimed is not None

    import sqlite3

    conn = sqlite3.connect(store.db_path)
    conn.execute("UPDATE chat_jobs SET updated_at = datetime('now', '-600 seconds') WHERE id = ?", (job_id,))
    conn.commit()
    conn.close()

    stale = store.dead_letter_stale_running_jobs(240, "timeout")
    assert any(item["id"] == job_id for item in stale)

    state = store.get_job_state(job_id)
    assert state is not None
    assert state["status"] == "dead"


def test_cleanup_stale_jobs_dead_letters_invalid_open_jobs(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u13"
    keep_chat_id = store.ensure_default_chat(user_id)
    keep_msg_id = store.add_message(user_id, keep_chat_id, "operator", "valid")
    keep_job_id = store.enqueue_chat_job(user_id, keep_chat_id, keep_msg_id)

    stale_chat = store.create_chat(user_id, "Stale")
    stale_msg_id = store.add_message(user_id, stale_chat.id, "operator", "stale")
    stale_chat_job_id = store.enqueue_chat_job(user_id, stale_chat.id, stale_msg_id)

    # Archive chat after enqueue to simulate stale queued job.
    store.remove_chat(user_id, stale_chat.id)

    # Create a missing-operator job by deleting the operator message row directly.
    import sqlite3

    dangling_chat = store.create_chat(user_id, "Dangling")
    dangling_msg_id = store.add_message(user_id, dangling_chat.id, "operator", "to delete")
    dangling_job_id = store.enqueue_chat_job(user_id, dangling_chat.id, dangling_msg_id)

    conn = sqlite3.connect(store.db_path)
    conn.execute("DELETE FROM chat_messages WHERE user_id = ? AND chat_id = ? AND id = ?", (user_id, dangling_chat.id, dangling_msg_id))
    conn.commit()
    conn.close()

    cleaned = store.cleanup_stale_jobs(user_id, limit=50)

    cleaned_job_ids = {item["job_id"] for item in cleaned}
    assert dangling_job_id in cleaned_job_ids
    assert keep_job_id not in cleaned_job_ids
    # Archived chat job may already be dead-lettered by remove_chat(), but if present here it must be stale.
    if stale_chat_job_id in cleaned_job_ids:
        stale_item = next(item for item in cleaned if item["job_id"] == stale_chat_job_id)
        assert "archived" in stale_item["reason"].lower()

    dangling_state = store.get_job_state(dangling_job_id)
    assert dangling_state is not None
    assert dangling_state["status"] == "dead"


def test_runtime_checkpoint_round_trip_and_delete(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "u13"
    chat_id = store.ensure_default_chat(user_id)
    session_id = f"miniapp-{user_id}-{chat_id}"

    history = [
        {"role": "system", "content": "You are Hermes."},
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi"},
    ]

    store.set_runtime_checkpoint(session_id=session_id, user_id=user_id, chat_id=chat_id, history=history)
    loaded = store.get_runtime_checkpoint(session_id)
    assert loaded == history

    store.delete_runtime_checkpoint(session_id)
    assert store.get_runtime_checkpoint(session_id) is None


def test_auth_session_round_trip_and_revoke(tmp_path) -> None:
    store = _store(tmp_path)
    store.upsert_auth_session(session_id="s1", user_id="u1", nonce_hash="n1", expires_at=200)

    assert store.is_auth_session_active(session_id="s1", user_id="u1", nonce_hash="n1", now_epoch=100) is True

    store.revoke_auth_session("s1")
    assert store.is_auth_session_active(session_id="s1", user_id="u1", nonce_hash="n1", now_epoch=100) is False


def test_revoke_all_auth_sessions_and_prune(tmp_path) -> None:
    store = _store(tmp_path)
    store.upsert_auth_session(session_id="s1", user_id="u1", nonce_hash="n1", expires_at=200)
    store.upsert_auth_session(session_id="s2", user_id="u1", nonce_hash="n2", expires_at=50)

    revoked = store.revoke_all_auth_sessions("u1")
    assert revoked == 2

    assert store.is_auth_session_active(session_id="s1", user_id="u1", nonce_hash="n1", now_epoch=100) is False

    deleted = store.prune_expired_auth_sessions(100)
    assert deleted >= 1
