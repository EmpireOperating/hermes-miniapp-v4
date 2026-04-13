from __future__ import annotations

from miniapp_presence import MiniAppPresenceTracker


def test_mark_visible_opportunistically_prunes_expired_leases_for_other_users() -> None:
    tracker = MiniAppPresenceTracker(default_ttl_seconds=45, prune_interval_seconds=1)

    tracker.mark_visible("desktop-user", 11, instance_id="desktop", now=10)
    tracker.mark_visible("mobile-user", 22, instance_id="mobile", now=12)

    assert tracker.get_visible_chat_id("desktop-user", now=20) == 11
    assert tracker.get_visible_chat_id("mobile-user", now=20) == 22

    tracker.mark_visible("fresh-user", 33, instance_id="fresh", now=60)

    assert tracker.get_visible_chat_id("desktop-user", now=60) is None
    assert tracker.get_visible_chat_id("mobile-user", now=60) is None
    assert tracker.get_visible_chat_id("fresh-user", now=60) == 33
    assert set(tracker._visible_chat_by_user.keys()) == {"fresh-user"}


def test_mark_hidden_opportunistically_prunes_expired_leases_before_mutating() -> None:
    tracker = MiniAppPresenceTracker(default_ttl_seconds=45, prune_interval_seconds=1)

    tracker.mark_visible("desktop-user", 11, instance_id="desktop", now=10)
    tracker.mark_visible("mobile-user", 22, instance_id="mobile", now=12)

    tracker.mark_hidden("mobile-user", instance_id="mobile")

    assert tracker.get_visible_chat_id("mobile-user", now=10_000) is None
    assert tracker.get_visible_chat_id("desktop-user", now=10_000) is None
    assert tracker._visible_chat_by_user == {}


def test_mark_visible_skips_global_prune_until_interval_elapses() -> None:
    tracker = MiniAppPresenceTracker(default_ttl_seconds=45, prune_interval_seconds=100)

    tracker.mark_visible("desktop-user", 11, instance_id="desktop", now=10)
    tracker.mark_visible("fresh-user", 33, instance_id="fresh", now=60)

    assert set(tracker._visible_chat_by_user.keys()) == {"desktop-user", "fresh-user"}
    assert tracker.get_visible_chat_id("desktop-user", now=60) is None
    assert set(tracker._visible_chat_by_user.keys()) == {"fresh-user"}


def test_legacy_instance_ids_still_expire_and_prune() -> None:
    tracker = MiniAppPresenceTracker(default_ttl_seconds=5, prune_interval_seconds=1)

    tracker.mark_visible("legacy-user", 44, instance_id=None, now=10)

    assert tracker.get_visible_chat_id("legacy-user", now=12) == 44
    assert tracker.prune_expired(now=16) == 1
    assert tracker.get_visible_chat_id("legacy-user", now=16) is None
