from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import requests


@dataclass(frozen=True, slots=True)
class TelegramNotificationResult:
    ok: bool
    status_code: int | None = None
    error: str | None = None
    response_text: str | None = None


class TelegramUnreadNotificationStore(Protocol):
    def get_telegram_unread_notifications_enabled(self, user_id: str) -> bool: ...

    def get_active_chat(self, user_id: str) -> int | None: ...

    def get_oldest_unread_hermes_message_id(self, user_id: str, chat_id: int) -> int | None: ...

    def unread_reply_notification_sent_for_anchor(self, user_id: str, chat_id: int, unread_anchor_message_id: int | None) -> bool: ...

    def record_telegram_notification_attempt(
        self,
        *,
        user_id: str,
        chat_id: int,
        unread_anchor_message_id: int | None,
        prior_unread_count: int,
        decision_reason: str,
        result: "TelegramNotificationResult",
    ) -> None: ...


class TelegramUnreadNotificationPresence(Protocol):
    def is_chat_visibly_open(self, user_id: str, chat_id: int) -> bool: ...


class TelegramUnreadNotificationSender(Protocol):
    def send_text(self, *, chat_id: int | str, text: str) -> TelegramNotificationResult: ...


@dataclass(frozen=True, slots=True)
class TelegramUnreadNotificationDecision:
    should_send: bool
    reason: str


def build_unread_reply_notification_text(*, chat_title: str) -> str:
    title = str(chat_title or "").strip() or "Chat"
    return f"🔔 {title} — New unread reply"


def should_send_unread_reply_notification(
    *,
    notifications_enabled: bool,
    prior_unread_count: int,
    active_chat_id: int | None,
    visibly_open_chat_id: int | None,
    chat_id: int,
    already_sent_for_unread_streak: bool,
) -> TelegramUnreadNotificationDecision:
    if not notifications_enabled:
        return TelegramUnreadNotificationDecision(False, "disabled")
    if (
        active_chat_id is not None
        and visibly_open_chat_id is not None
        and int(active_chat_id) == int(chat_id)
        and int(visibly_open_chat_id) == int(chat_id)
    ):
        return TelegramUnreadNotificationDecision(False, "chat_active")
    if already_sent_for_unread_streak:
        return TelegramUnreadNotificationDecision(False, "already_notified")
    if int(prior_unread_count or 0) > 0:
        return TelegramUnreadNotificationDecision(True, "retry_pending_unread")
    return TelegramUnreadNotificationDecision(True, "send")


class TelegramUnreadReplyNotifier:
    def __init__(
        self,
        *,
        store: TelegramUnreadNotificationStore,
        sender: TelegramUnreadNotificationSender,
        presence: TelegramUnreadNotificationPresence | None = None,
    ) -> None:
        self.store = store
        self.sender = sender
        self.presence = presence

    def notify_if_needed(self, *, user_id: str, chat_id: int, chat_title: str, prior_unread_count: int) -> TelegramNotificationResult:
        unread_anchor_message_id = self.store.get_oldest_unread_hermes_message_id(user_id, chat_id)
        if unread_anchor_message_id is None:
            result = TelegramNotificationResult(ok=False, error="suppressed:no_unread")
            self.store.record_telegram_notification_attempt(
                user_id=user_id,
                chat_id=chat_id,
                unread_anchor_message_id=None,
                prior_unread_count=prior_unread_count,
                decision_reason="no_unread",
                result=result,
            )
            return result

        visibly_open_chat_id = None
        if self.presence is not None and self.presence.is_chat_visibly_open(user_id, chat_id):
            visibly_open_chat_id = int(chat_id)
        decision = should_send_unread_reply_notification(
            notifications_enabled=self.store.get_telegram_unread_notifications_enabled(user_id),
            prior_unread_count=prior_unread_count,
            active_chat_id=self.store.get_active_chat(user_id),
            visibly_open_chat_id=visibly_open_chat_id,
            chat_id=chat_id,
            already_sent_for_unread_streak=self.store.unread_reply_notification_sent_for_anchor(
                user_id,
                chat_id,
                unread_anchor_message_id,
            ),
        )
        if not decision.should_send:
            result = TelegramNotificationResult(ok=False, error=f"suppressed:{decision.reason}")
            self.store.record_telegram_notification_attempt(
                user_id=user_id,
                chat_id=chat_id,
                unread_anchor_message_id=unread_anchor_message_id,
                prior_unread_count=prior_unread_count,
                decision_reason=decision.reason,
                result=result,
            )
            return result
        result = self.sender.send_text(
            chat_id=user_id,
            text=build_unread_reply_notification_text(chat_title=chat_title),
        )
        self.store.record_telegram_notification_attempt(
            user_id=user_id,
            chat_id=chat_id,
            unread_anchor_message_id=unread_anchor_message_id,
            prior_unread_count=prior_unread_count,
            decision_reason=decision.reason,
            result=result,
        )
        return result


class TelegramNotificationSender:
    def __init__(self, *, bot_token: str, timeout_seconds: int = 8) -> None:
        self.bot_token = str(bot_token or "").strip()
        self.timeout_seconds = max(1, int(timeout_seconds or 8))

    @property
    def configured(self) -> bool:
        return bool(self.bot_token)

    def send_text(self, *, chat_id: int | str, text: str) -> TelegramNotificationResult:
        if not self.configured:
            return TelegramNotificationResult(ok=False, error="telegram_bot_token_missing")
        body = str(text or "").strip()
        if not body:
            return TelegramNotificationResult(ok=False, error="notification_text_missing")
        try:
            response = requests.post(
                f"https://api.telegram.org/bot{self.bot_token}/sendMessage",
                json={
                    "chat_id": int(chat_id),
                    "text": body,
                    "disable_web_page_preview": True,
                },
                timeout=self.timeout_seconds,
            )
        except requests.RequestException as exc:
            return TelegramNotificationResult(ok=False, error=str(exc))
        response_text = response.text
        if not response.ok:
            return TelegramNotificationResult(
                ok=False,
                status_code=response.status_code,
                error=f"telegram_send_failed:{response.status_code}",
                response_text=response_text,
            )
        return TelegramNotificationResult(ok=True, status_code=response.status_code, response_text=response_text)
