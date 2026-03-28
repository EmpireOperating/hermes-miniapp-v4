from __future__ import annotations

import logging
import queue
import threading
import time


LOGGER = logging.getLogger(__name__)


class JobEventBroker:
    def __init__(self, *, event_buffer_cap: int, history_max_jobs: int, history_ttl_seconds: int) -> None:
        self.event_buffer_cap = int(event_buffer_cap)
        self.history_max_jobs = int(history_max_jobs)
        self.history_ttl_seconds = int(history_ttl_seconds)

        self._event_lock = threading.Lock()
        self._event_queues: dict[int, list[queue.Queue[dict[str, object]]]] = {}
        self._event_history: dict[int, list[dict[str, object]]] = {}
        self._event_timestamps: dict[int, float] = {}

    def publish(self, job_id: int, event_name: str, payload: dict[str, object]) -> None:
        event = {"event": event_name, "payload": payload}
        terminal_events = {"done", "error"}

        with self._event_lock:
            history = self._event_history.setdefault(job_id, [])
            history.append(event)
            if len(history) > self.event_buffer_cap:
                del history[: len(history) - self.event_buffer_cap]
            self._event_timestamps[job_id] = time.monotonic()
            subscribers = list(self._event_queues.get(job_id, []))

        self.prune()

        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
                continue
            except queue.Full:
                pass

            if event_name not in terminal_events:
                # Non-terminal events can be dropped under backpressure.
                continue

            # Terminal events must be delivered so stream consumers can close.
            delivered = False
            for _ in range(4):
                try:
                    subscriber.get_nowait()
                except queue.Empty:
                    break
                try:
                    subscriber.put_nowait(event)
                    delivered = True
                    break
                except queue.Full:
                    continue

            if not delivered:
                LOGGER.warning("job_event_terminal_drop job_id=%s event=%s", job_id, event_name)

    def subscribe(self, job_id: int) -> queue.Queue[dict[str, object]]:
        subscriber: queue.Queue[dict[str, object]] = queue.Queue(maxsize=self.event_buffer_cap)
        with self._event_lock:
            history = list(self._event_history.get(job_id, []))
            self._event_queues.setdefault(job_id, []).append(subscriber)

        for event in history:
            try:
                subscriber.put_nowait(event)
            except queue.Full:
                break
        return subscriber

    def unsubscribe(self, job_id: int, subscriber: queue.Queue[dict[str, object]]) -> None:
        with self._event_lock:
            listeners = self._event_queues.get(job_id, [])
            if subscriber in listeners:
                listeners.remove(subscriber)
            if not listeners:
                self._event_queues.pop(job_id, None)
                terminal_events = {"done", "error"}
                history = self._event_history.get(job_id, [])
                if history and str(history[-1].get("event") or "") in terminal_events:
                    self._event_history.pop(job_id, None)
                    self._event_timestamps.pop(job_id, None)

    def prune(self) -> None:
        now = time.monotonic()
        cutoff = now - self.history_ttl_seconds
        with self._event_lock:
            removable: list[tuple[int, float]] = []
            for job_id, timestamp in self._event_timestamps.items():
                has_subscribers = bool(self._event_queues.get(job_id))
                if not has_subscribers and timestamp < cutoff:
                    removable.append((job_id, timestamp))

            if len(self._event_history) > self.history_max_jobs:
                overage = len(self._event_history) - self.history_max_jobs
                for job_id, _ in sorted(removable, key=lambda item: item[1])[:overage]:
                    self._event_history.pop(job_id, None)
                    self._event_timestamps.pop(job_id, None)

            for job_id, _ in removable:
                if job_id not in self._event_queues:
                    self._event_history.pop(job_id, None)
                    self._event_timestamps.pop(job_id, None)
