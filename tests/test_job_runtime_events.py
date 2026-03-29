from __future__ import annotations

import queue

from job_runtime_events import JobEventBroker


def test_terminal_event_is_forced_into_full_subscriber_queue() -> None:
    broker = JobEventBroker(event_buffer_cap=1, history_max_jobs=10, history_ttl_seconds=300)
    subscriber = broker.subscribe(101)

    subscriber.put_nowait({"event": "chunk", "payload": {"text": "old"}})
    broker.publish(101, "done", {"reply": "ok"})

    delivered = subscriber.get_nowait()
    assert delivered["event"] == "done"
    assert delivered["payload"]["reply"] == "ok"


def test_subscribe_replays_buffered_history() -> None:
    broker = JobEventBroker(event_buffer_cap=3, history_max_jobs=10, history_ttl_seconds=300)
    for idx in range(5):
        broker.publish(9, "chunk", {"index": idx})

    subscriber = broker.subscribe(9)
    replayed: list[dict[str, object]] = []
    while True:
        try:
            replayed.append(subscriber.get_nowait())
        except queue.Empty:
            break

    assert len(replayed) == 3
    assert replayed[0]["payload"]["index"] == 2
    assert replayed[-1]["payload"]["index"] == 4
    assert replayed[0]["payload"]["_event_id"] == 3
    assert replayed[-1]["payload"]["_event_id"] == 5


def test_publish_assigns_monotonic_event_ids_and_preserves_custom_ids() -> None:
    broker = JobEventBroker(event_buffer_cap=6, history_max_jobs=10, history_ttl_seconds=300)
    broker.publish(11, "tool", {"display": "read_file"})
    broker.publish(11, "tool", {"display": "search_files"})
    broker.publish(11, "meta", {"detail": "running", "_event_id": 999})

    subscriber = broker.subscribe(11)
    replayed: list[dict[str, object]] = []
    while True:
        try:
            replayed.append(subscriber.get_nowait())
        except queue.Empty:
            break

    assert replayed[0]["payload"]["_event_id"] == 1
    assert replayed[1]["payload"]["_event_id"] == 2
    assert replayed[2]["payload"]["_event_id"] == 999


def test_unsubscribe_clears_terminal_history_when_last_listener_leaves() -> None:
    broker = JobEventBroker(event_buffer_cap=4, history_max_jobs=10, history_ttl_seconds=300)
    subscriber = broker.subscribe(22)
    broker.publish(22, "chunk", {"text": "x"})
    broker.publish(22, "done", {"reply": "ok"})

    broker.unsubscribe(22, subscriber)

    assert 22 not in broker._event_queues
    assert 22 not in broker._event_history
    assert 22 not in broker._event_timestamps
    assert 22 not in broker._event_sequence


def test_terminal_rollup_summarizes_recent_terminal_events() -> None:
    broker = JobEventBroker(event_buffer_cap=6, history_max_jobs=10, history_ttl_seconds=300)
    broker.publish(8, "chunk", {"text": "partial"})
    broker.publish(8, "error", {"message": "upstream timeout", "retrying": False})
    broker.publish(9, "chunk", {"text": "partial"})
    broker.publish(9, "done", {"message": "ok"})

    rollup = broker.terminal_rollup(limit=5, error_limit=3)

    assert rollup["terminal_counts"]["error"] == 1
    assert rollup["terminal_counts"]["done"] == 1
    assert len(rollup["recent_terminal"]) == 2
    assert any(item["event"] == "error" and item["job_id"] == 8 for item in rollup["recent_terminal"])
    assert rollup["recent_error_messages"] == ["upstream timeout"]

    age_stats = rollup["age_stats_seconds"]
    assert age_stats["sample_size"] == 2
    assert age_stats["median"] >= 0
    assert age_stats["p95"] >= age_stats["median"]

    window_counts = rollup["window_counts"]
    assert window_counts["5m"]["error"] == 1
    assert window_counts["5m"]["done"] == 1


def test_prune_removes_expired_unsubscribed_jobs() -> None:
    broker = JobEventBroker(event_buffer_cap=4, history_max_jobs=2, history_ttl_seconds=1)
    broker.publish(1, "chunk", {"t": 1})
    broker.publish(2, "chunk", {"t": 2})
    broker.publish(3, "chunk", {"t": 3})

    # Simulate stale entries beyond TTL.
    broker._event_timestamps[1] = 0.0
    broker._event_timestamps[2] = 0.0
    broker._event_timestamps[3] = 0.0

    broker.prune()

    assert broker._event_history == {}
    assert broker._event_timestamps == {}
    assert broker._event_sequence == {}
