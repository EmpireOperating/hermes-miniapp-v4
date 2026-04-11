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
    def __init__(self, *, enabled: bool, active_chat_id: int | None) -> None:
        self.enabled = enabled
        self.active_chat_id = active_chat_id

    def get_telegram_unread_notifications_enabled(self, user_id: str) -> bool:
        return self.enabled

    def get_active_chat(self, user_id: str) -> int | None:
        return self.active_chat_id


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
    ).reason == "disabled"
    assert should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=2,
        active_chat_id=None,
        visibly_open_chat_id=None,
        chat_id=7,
    ).reason == "already_unread"
    assert should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=0,
        active_chat_id=7,
        visibly_open_chat_id=7,
        chat_id=7,
    ).reason == "chat_active"
    decision = should_send_unread_reply_notification(
        notifications_enabled=True,
        prior_unread_count=0,
        active_chat_id=7,
        visibly_open_chat_id=None,
        chat_id=7,
    )
    assert decision.should_send is True
    assert decision.reason == "send"


def test_unread_reply_notifier_sends_expected_message_when_decision_allows() -> None:
    sender = _StubSender()
    notifier = TelegramUnreadReplyNotifier(store=_StubStore(enabled=True, active_chat_id=99), sender=sender)

    result = notifier.notify_if_needed(user_id="123", chat_id=7, chat_title="Main", prior_unread_count=0)

    assert result.ok is True
    assert sender.calls == [{"chat_id": "123", "text": "🔔 Main — New unread reply"}]


def test_unread_reply_notifier_suppresses_when_chat_is_active_and_visibly_open() -> None:
    sender = _StubSender()
    notifier = TelegramUnreadReplyNotifier(
        store=_StubStore(enabled=True, active_chat_id=7),
        sender=sender,
        presence=_StubPresence(visibly_open=True),
    )

    result = notifier.notify_if_needed(user_id="123", chat_id=7, chat_title="Main", prior_unread_count=0)

    assert result.ok is False
    assert result.error == "suppressed:chat_active"
    assert sender.calls == []


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