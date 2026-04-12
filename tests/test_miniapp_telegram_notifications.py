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
        unread_anchor_message_id: int | None = 101,
        already_sent_for_anchor: bool = False,
    ) -> None:
        self.enabled = enabled
        self.active_chat_id = active_chat_id
        self.unread_anchor_message_id = unread_anchor_message_id
        self.already_sent_for_anchor = already_sent_for_anchor
        self.attempts: list[dict[str, object]] = []

    def get_telegram_unread_notifications_enabled(self, user_id: str) -> bool:
        return self.enabled

    def get_active_chat(self, user_id: str) -> int | None:
        return self.active_chat_id

    def get_oldest_unread_hermes_message_id(self, user_id: str, chat_id: int) -> int | None:
        return self.unread_anchor_message_id

    def unread_reply_notification_sent_for_anchor(self, user_id: str, chat_id: int, unread_anchor_message_id: int) -> bool:
        return self.already_sent_for_anchor

    def record_telegram_notification_attempt(
        self,
        *,
        user_id: str,
        chat_id: int,
        unread_anchor_message_id: int | None,
        prior_unread_count: int,
        decision_reason: str,
        result,
    ) -> None:
        self.attempts.append(
            {
                "user_id": user_id,
                "chat_id": chat_id,
                "unread_anchor_message_id": unread_anchor_message_id,
                "prior_unread_count": prior_unread_count,
                "decision_reason": decision_reason,
                "ok": result.ok,
                "status_code": result.status_code,
                "error": result.error,
            }
        )


class _StubPresence:
    def __init__(self, *, visibly_open: bool) -> None:
        self.visibly_open = visibly_open

    def is_chat_visibly_open(self, user_id: str, chat_id: int) -> bool:
        return self.visibly_open


class _StubSender:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def send_text(self, *, chat_id: int | str, text: str):
        self.calls.append({"chat_id": chat_id, "text": text})
        return SimpleNamespace(ok=True, error=None)


def test_build_unread_reply_notification_text_uses_plain_minimal_template() -> None:
    assert build_unread_reply_notification_text(chat_title="Main") == "🔔 Main — New unread reply"
    assert build_unread_reply_notification_text(chat_title="") == "🔔 Chat — New unread reply"


def test_should_send_unread_reply_notification_requires_enabled_transition_and_visible_active_chat() -> None:
    assert should_send_unread_reply_notification(
        notifications_enabled=False,
        prior_unread_count=0,
        active_chat_id=None,
        visibly_open_chat_id=None,
        chat_id=7,
        already_sent_for_unread_streak=False,
    ).reason == "disabled"
    assert should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=2,
        active_chat_id=None,
        visibly_open_chat_id=None,
        chat_id=7,
        already_sent_for_unread_streak=True,
    ).reason == "already_notified"
    assert should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=0,
        active_chat_id=7,
        visibly_open_chat_id=7,
        chat_id=7,
        already_sent_for_unread_streak=False,
    ).reason == "chat_active"
    retry_decision = should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=2,
        active_chat_id=7,
        visibly_open_chat_id=None,
        chat_id=7,
        already_sent_for_unread_streak=False,
    )
    assert retry_decision.should_send is True
    assert retry_decision.reason == "retry_pending_unread"
    decision = should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=0,
        active_chat_id=7,
        visibly_open_chat_id=None,
        chat_id=7,
        already_sent_for_unread_streak=False,
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
    assert store.attempts == [
        {
            "user_id": "123",
            "chat_id": 7,
            "unread_anchor_message_id": 101,
            "prior_unread_count": 0,
            "decision_reason": "send",
            "ok": True,
            "status_code": None,
            "error": None,
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
    assert store.attempts[0]["decision_reason"] == "chat_active"


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


def test_unread_reply_notifier_retries_pending_unread_streak_when_prior_attempt_never_succeeded() -> None:
    sender = _StubSender()
    store = _StubStore(enabled=True, active_chat_id=99, already_sent_for_anchor=False)
    notifier = TelegramUnreadReplyNotifier(store=store, sender=sender)

    result = notifier.notify_if_needed(user_id="123", chat_id=7, chat_title="Main", prior_unread_count=2)

    assert result.ok is True
    assert sender.calls == [{"chat_id": "123", "text": "🔔 Main — New unread reply"}]
    assert store.attempts[0]["decision_reason"] == "retry_pending_unread"


def test_unread_reply_notifier_suppresses_when_current_unread_streak_was_already_notified() -> None:
    sender = _StubSender()
    store = _StubStore(enabled=True, active_chat_id=99, already_sent_for_anchor=True)
    notifier = TelegramUnreadReplyNotifier(store=store, sender=sender)

    result = notifier.notify_if_needed(user_id="123", chat_id=7, chat_title="Main", prior_unread_count=3)

    assert result.ok is False
    assert result.error == "suppressed:already_notified"
    assert sender.calls == []
    assert store.attempts[0]["decision_reason"] == "already_notified"
