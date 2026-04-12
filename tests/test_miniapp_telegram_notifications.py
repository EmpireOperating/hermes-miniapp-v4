from __future__ import annotations

from types import SimpleNamespace

import requests

from miniapp_telegram_notifications import (
    TelegramNotificationSender,
    TelegramUnreadReplyNotifier,
    build_unread_reply_notification_text,
    should_send_unread_reply_notification,
)


class _StubStore:
    def __init__(
        self,
        *,
        enabled: bool,
        active_chat_id: int | None,
        last_read_message_id: int = 0,
        send_attempt_count_for_streak: int = 0,
        successful_send_already_recorded: bool = False,
    ) -> None:
        self.enabled = enabled
        self.active_chat_id = active_chat_id
        self.last_read_message_id = last_read_message_id
        self.send_attempt_count_for_streak = send_attempt_count_for_streak
        self.successful_send_already_recorded = successful_send_already_recorded
        self.recorded_attempts: list[dict[str, object]] = []

    def get_telegram_unread_notifications_enabled(self, user_id: str) -> bool:
        return self.enabled

    def get_active_chat(self, user_id: str) -> int | None:
        return self.active_chat_id

    def get_last_read_message_id(self, user_id: str, chat_id: int) -> int:
        return self.last_read_message_id

    def count_telegram_notification_send_attempts(self, user_id: str, chat_id: int, unread_streak_key: int) -> int:
        return self.send_attempt_count_for_streak

    def has_successful_telegram_notification_for_streak(self, user_id: str, chat_id: int, unread_streak_key: int) -> bool:
        return self.successful_send_already_recorded

    def record_telegram_notification_attempt(self, **kwargs) -> int:
        self.recorded_attempts.append(dict(kwargs))
        return len(self.recorded_attempts)


class _StubPresence:
    def __init__(self, *, visibly_open: bool) -> None:
        self.visibly_open = visibly_open

    def is_chat_visibly_open(self, user_id: str, chat_id: int) -> bool:
        return self.visibly_open


class _StubSender:
    def __init__(self, *, ok: bool = True, error: str | None = None) -> None:
        self.calls: list[dict[str, object]] = []
        self.ok = ok
        self.error = error

    def send_text(self, *, chat_id: int | str, text: str):
        self.calls.append({"chat_id": chat_id, "text": text})
        return SimpleNamespace(ok=self.ok, error=self.error, status_code=None, response_text=None)


def test_build_unread_reply_notification_text_uses_plain_minimal_template() -> None:
    assert build_unread_reply_notification_text(chat_title="Main") == "🔔 Main — New unread reply"
    assert build_unread_reply_notification_text(chat_title="") == "🔔 Chat — New unread reply"


def test_should_send_unread_reply_notification_handles_retry_and_suppression_reasons() -> None:
    assert should_send_unread_reply_notification(
        notifications_enabled=False,
        prior_unread_count=0,
        active_chat_id=None,
        visibly_open_chat_id=None,
        chat_id=7,
        send_attempt_count_for_streak=0,
        successful_send_already_recorded=False,
    ).reason == "disabled"
    assert should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=0,
        active_chat_id=7,
        visibly_open_chat_id=7,
        chat_id=7,
        send_attempt_count_for_streak=0,
        successful_send_already_recorded=False,
    ).reason == "chat_active"
    assert should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=2,
        active_chat_id=None,
        visibly_open_chat_id=None,
        chat_id=7,
        send_attempt_count_for_streak=0,
        successful_send_already_recorded=True,
    ).reason == "already_notified"
    assert should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=2,
        active_chat_id=None,
        visibly_open_chat_id=None,
        chat_id=7,
        send_attempt_count_for_streak=0,
        successful_send_already_recorded=False,
    ).reason == "send_retry"
    assert should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=2,
        active_chat_id=None,
        visibly_open_chat_id=None,
        chat_id=7,
        send_attempt_count_for_streak=1,
        successful_send_already_recorded=False,
    ).reason == "send_retry"
    assert should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=2,
        active_chat_id=None,
        visibly_open_chat_id=None,
        chat_id=7,
        send_attempt_count_for_streak=2,
        successful_send_already_recorded=False,
    ).reason == "retry_budget_exhausted"
    decision = should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=0,
        active_chat_id=7,
        visibly_open_chat_id=None,
        chat_id=7,
        send_attempt_count_for_streak=0,
        successful_send_already_recorded=False,
    )
    assert decision.should_send is True
    assert decision.reason == "send"


def test_unread_reply_notifier_sends_expected_message_when_decision_allows() -> None:
    sender = _StubSender()
    store = _StubStore(enabled=True, active_chat_id=99)
    notifier = TelegramUnreadReplyNotifier(store=store, sender=sender)

    result = notifier.notify_if_needed(user_id="123", chat_id=7, chat_title="Main", prior_unread_count=0)

    assert result.ok is True
    assert sender.calls == [{"chat_id": "123", "text": "🔔 Main — New unread reply"}]
    assert store.recorded_attempts == [
        {
            "user_id": "123",
            "chat_id": 7,
            "unread_streak_key": 0,
            "prior_unread_count": 0,
            "notifications_enabled": True,
            "active_chat_id": 99,
            "visibly_open_chat_id": None,
            "decision_reason": "send",
            "send_attempted": True,
            "send_ok": True,
            "status_code": None,
            "error": None,
            "response_text": None,
        }
    ]


def test_unread_reply_notifier_suppresses_when_chat_is_active_and_visibly_open() -> None:
    sender = _StubSender()
    store = _StubStore(enabled=True, active_chat_id=7)
    notifier = TelegramUnreadReplyNotifier(
        store=store,
        sender=sender,
        presence=_StubPresence(visibly_open=True),
    )

    result = notifier.notify_if_needed(user_id="123", chat_id=7, chat_title="Main", prior_unread_count=0)

    assert result.ok is False
    assert result.error == "suppressed:chat_active"
    assert sender.calls == []
    assert store.recorded_attempts[0]["decision_reason"] == "chat_active"
    assert store.recorded_attempts[0]["send_attempted"] is False


def test_unread_reply_notifier_retries_one_failed_unread_streak_send() -> None:
    sender = _StubSender(ok=False, error="network down")
    store = _StubStore(enabled=True, active_chat_id=None, last_read_message_id=11)
    notifier = TelegramUnreadReplyNotifier(store=store, sender=sender)

    first = notifier.notify_if_needed(user_id="123", chat_id=7, chat_title="Main", prior_unread_count=0)
    assert first.ok is False
    assert first.error == "network down"
    assert sender.calls == [{"chat_id": "123", "text": "🔔 Main — New unread reply"}]
    assert store.recorded_attempts[0]["decision_reason"] == "send"
    assert store.recorded_attempts[0]["send_attempted"] is True

    retry_sender = _StubSender(ok=True)
    retry_store = _StubStore(
        enabled=True,
        active_chat_id=None,
        last_read_message_id=11,
        send_attempt_count_for_streak=1,
        successful_send_already_recorded=False,
    )
    retry_notifier = TelegramUnreadReplyNotifier(store=retry_store, sender=retry_sender)

    second = retry_notifier.notify_if_needed(user_id="123", chat_id=7, chat_title="Main", prior_unread_count=2)
    assert second.ok is True
    assert retry_sender.calls == [{"chat_id": "123", "text": "🔔 Main — New unread reply"}]
    assert retry_store.recorded_attempts[0]["decision_reason"] == "send_retry"

    exhausted_store = _StubStore(
        enabled=True,
        active_chat_id=None,
        last_read_message_id=11,
        send_attempt_count_for_streak=2,
        successful_send_already_recorded=False,
    )
    exhausted_notifier = TelegramUnreadReplyNotifier(store=exhausted_store, sender=_StubSender(ok=True))
    third = exhausted_notifier.notify_if_needed(user_id="123", chat_id=7, chat_title="Main", prior_unread_count=3)
    assert third.ok is False
    assert third.error == "suppressed:retry_budget_exhausted"
    assert exhausted_store.recorded_attempts[0]["decision_reason"] == "retry_budget_exhausted"


def test_send_text_posts_plain_message_to_telegram(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_post(url, *, json, timeout):
        captured["url"] = url
        captured["json"] = json
        captured["timeout"] = timeout
        return SimpleNamespace(ok=True, status_code=200, text='{"ok":true}')

    monkeypatch.setattr(requests, "post", fake_post)
    sender = TelegramNotificationSender(bot_token="bot-token", timeout_seconds=9)

    result = sender.send_text(chat_id="123", text="🔔 Main — New unread reply")

    assert result.ok is True
    assert captured["url"] == "https://api.telegram.org/botbot-token/sendMessage"
    assert captured["json"] == {
        "chat_id": 123,
        "text": "🔔 Main — New unread reply",
        "disable_web_page_preview": True,
    }
    assert captured["timeout"] == 9


def test_send_text_returns_structured_transport_error(monkeypatch) -> None:
    def fake_post(url, *, json, timeout):
        raise requests.RequestException("network down")

    monkeypatch.setattr(requests, "post", fake_post)
    sender = TelegramNotificationSender(bot_token="bot-token")

    result = sender.send_text(chat_id=123, text="hello")

    assert result.ok is False
    assert result.error == "network down"