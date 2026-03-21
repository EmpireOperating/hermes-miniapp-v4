from __future__ import annotations

from rate_limiter import SlidingWindowRateLimiter


def test_sliding_window_rate_limiter_blocks_after_limit() -> None:
    limiter = SlidingWindowRateLimiter()
    now = 1000.0

    assert limiter.allow(key="api:1.2.3.4", limit=2, window_seconds=60, now=now) is True
    assert limiter.allow(key="api:1.2.3.4", limit=2, window_seconds=60, now=now + 1) is True
    assert limiter.allow(key="api:1.2.3.4", limit=2, window_seconds=60, now=now + 2) is False


def test_sliding_window_rate_limiter_expires_old_entries() -> None:
    limiter = SlidingWindowRateLimiter()

    assert limiter.allow(key="stream:1.2.3.4", limit=1, window_seconds=10, now=1000.0) is True
    assert limiter.allow(key="stream:1.2.3.4", limit=1, window_seconds=10, now=1011.0) is True
