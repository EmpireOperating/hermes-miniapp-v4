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


def test_unsubscribe_clears_terminal_history_when_last_listener_leaves() -> None:
    broker = JobEventBroker(event_buffer_cap=4, history_max_jobs=10, history_ttl_seconds=300)
    subscriber = broker.subscribe(22)
    broker.publish(22, "chunk", {"text": "x"})
    broker.publish(22, "done", {"reply": "ok"})

    broker.unsubscribe(22, subscriber)

    assert 22 not in broker._event_queues
    assert 22 not in broker._event_history
    assert 22 not in broker._event_timestamps


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
