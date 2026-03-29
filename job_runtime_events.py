from __future__ import annotations

import logging
import queue
import threading
import time
from collections import deque


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
        self._event_sequence: dict[int, int] = {}
        self._terminal_timeline: deque[tuple[float, str]] = deque(maxlen=max(512, self.event_buffer_cap * 8))

    def publish(self, job_id: int, event_name: str, payload: dict[str, object]) -> None:
        terminal_events = {"done", "error"}

        with self._event_lock:
            next_event_id = int(self._event_sequence.get(job_id, 0)) + 1
            self._event_sequence[job_id] = next_event_id
            payload_with_event_id = dict(payload or {})
            payload_with_event_id.setdefault("_event_id", next_event_id)
            event = {"event": event_name, "payload": payload_with_event_id, "event_id": next_event_id}

            history = self._event_history.setdefault(job_id, [])
            history.append(event)
            if len(history) > self.event_buffer_cap:
                del history[: len(history) - self.event_buffer_cap]
            event_ts = time.monotonic()
            self._event_timestamps[job_id] = event_ts
            if event_name in terminal_events:
                self._terminal_timeline.append((event_ts, event_name))
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
                    self._event_sequence.pop(job_id, None)

    @staticmethod
    def _age_stats(ages: list[int]) -> dict[str, int]:
        if not ages:
            return {"sample_size": 0, "median": 0, "p95": 0}

        ordered = sorted(int(max(0, age)) for age in ages)
        sample_size = len(ordered)
        median = ordered[(sample_size - 1) // 2]
        p95_index = max(0, int((sample_size - 1) * 0.95))
        p95 = ordered[p95_index]
        return {
            "sample_size": int(sample_size),
            "median": int(median),
            "p95": int(p95),
        }

    def terminal_window_counts(self, *, windows: dict[str, int] | None = None) -> dict[str, dict[str, int]]:
        safe_windows = windows or {"5m": 300, "15m": 900, "60m": 3600}
        normalized_windows = {
            str(label): max(1, int(seconds))
            for label, seconds in safe_windows.items()
        }
        now = time.monotonic()
        with self._event_lock:
            timeline = list(self._terminal_timeline)

        result: dict[str, dict[str, int]] = {}
        for label, window_seconds in normalized_windows.items():
            done = 0
            error = 0
            for ts, event_name in timeline:
                if now - ts > window_seconds:
                    continue
                if event_name == "done":
                    done += 1
                elif event_name == "error":
                    error += 1
            result[label] = {"done": int(done), "error": int(error)}
        return result

    def terminal_rollup(self, *, limit: int = 12, error_limit: int = 6) -> dict[str, object]:
        terminal_events = {"done", "error"}
        safe_limit = max(1, int(limit))
        safe_error_limit = max(1, int(error_limit))
        now = time.monotonic()

        with self._event_lock:
            timeline: list[tuple[float, int, str, dict[str, object]]] = []
            for job_id, history in self._event_history.items():
                last_ts = float(self._event_timestamps.get(job_id, now))
                for event in reversed(history):
                    event_name = str(event.get("event") or "")
                    if event_name in terminal_events:
                        payload = event.get("payload") or {}
                        if not isinstance(payload, dict):
                            payload = {}
                        timeline.append((last_ts, int(job_id), event_name, payload))
                        break

        timeline.sort(key=lambda item: item[0], reverse=True)

        recent_terminal: list[dict[str, object]] = []
        error_messages: list[str] = []
        terminal_counts = {"done": 0, "error": 0}
        terminal_ages: list[int] = []
        for ts, job_id, event_name, payload in timeline:
            terminal_counts[event_name] = int(terminal_counts.get(event_name, 0)) + 1
            age_seconds = max(0, int(round(now - ts)))
            terminal_ages.append(age_seconds)
            if len(recent_terminal) < safe_limit:
                recent_terminal.append(
                    {
                        "job_id": int(job_id),
                        "event": event_name,
                        "age_seconds": age_seconds,
                        "message": str(payload.get("message") or ""),
                        "retrying": bool(payload.get("retrying")) if event_name == "error" else False,
                    }
                )
            if event_name == "error":
                msg = str(payload.get("message") or "").strip() or "(no error message)"
                if msg not in error_messages and len(error_messages) < safe_error_limit:
                    error_messages.append(msg)

        return {
            "terminal_counts": {
                "done": int(terminal_counts.get("done", 0)),
                "error": int(terminal_counts.get("error", 0)),
            },
            "recent_terminal": recent_terminal,
            "recent_error_messages": error_messages,
            "age_stats_seconds": self._age_stats(terminal_ages),
            "window_counts": self.terminal_window_counts(),
        }

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
                    self._event_sequence.pop(job_id, None)

            for job_id, _ in removable:
                if job_id not in self._event_queues:
                    self._event_history.pop(job_id, None)
                    self._event_timestamps.pop(job_id, None)
                    self._event_sequence.pop(job_id, None)
