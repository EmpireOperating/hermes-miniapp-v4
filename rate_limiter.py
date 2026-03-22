from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


class SlidingWindowRateLimiter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buckets: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, *, key: str, limit: int, window_seconds: int, now: float | None = None) -> bool:
        effective_now = time.monotonic() if now is None else float(now)
        cutoff = effective_now - max(1, int(window_seconds))

        with self._lock:
            bucket = self._buckets[key]
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= max(1, int(limit)):
                return False
            bucket.append(effective_now)
            return True
