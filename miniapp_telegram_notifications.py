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

    def get_last_read_message_id(self, user_id: str, chat_id: int) -> int: ...

    def count_telegram_notification_send_attempts(self, user_id: str, chat_id: int, unread_streak_key: int) -> int: ...

    def has_successful_telegram_notification_for_streak(self, user_id: str, chat_id: int, unread_streak_key: int) -> bool: ...

    def record_telegram_notification_attempt(
        self,
        *,
        user_id: str,
        chat_id: int,
        unread_streak_key: int,
        prior_unread_count: int,
        notifications_enabled: bool,
        active_chat_id: int | None,
        visibly_open_chat_id: int | None,
        decision_reason: str,
        send_attempted: bool,
        send_ok: bool,
        status_code: int | None,
        error: str | None,
        response_text: str | None,
    ) -> int: ...


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
    send_attempt_count_for_streak: int,
    successful_send_already_recorded: bool,
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
    if successful_send_already_recorded:
        return TelegramUnreadNotificationDecision(False, "already_notified")
    if int(prior_unread_count or 0) <= 0:
        return TelegramUnreadNotificationDecision(True, "send")
    if int(send_attempt_count_for_streak or 0) <= 1:
        return TelegramUnreadNotificationDecision(True, "send_retry")
    return TelegramUnreadNotificationDecision(False, "retry_budget_exhausted")


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
        visibly_open_chat_id = None
        if self.presence is not None and self.presence.is_chat_visibly_open(user_id, chat_id):
            visibly_open_chat_id = int(chat_id)
        notifications_enabled = self.store.get_telegram_unread_notifications_enabled(user_id)
        active_chat_id = self.store.get_active_chat(user_id)
        unread_streak_key = self.store.get_last_read_message_id(user_id, chat_id)
        send_attempt_count_for_streak = self.store.count_telegram_notification_send_attempts(
            user_id,
            chat_id,
            unread_streak_key,
        )
        successful_send_already_recorded = self.store.has_successful_telegram_notification_for_streak(
            user_id,
            chat_id,
            unread_streak_key,
        )
        decision = should_send_unread_reply_notification(
            notifications_enabled=notifications_enabled,
            prior_unread_count=prior_unread_count,
            active_chat_id=active_chat_id,
            visibly_open_chat_id=visibly_open_chat_id,
            chat_id=chat_id,
            send_attempt_count_for_streak=send_attempt_count_for_streak,
            successful_send_already_recorded=successful_send_already_recorded,
        )
        if not decision.should_send:
            result = TelegramNotificationResult(ok=False, error=f"suppressed:{decision.reason}")
            self._record_attempt(
                user_id=user_id,
                chat_id=chat_id,
                unread_streak_key=unread_streak_key,
                prior_unread_count=prior_unread_count,
                notifications_enabled=notifications_enabled,
                active_chat_id=active_chat_id,
                visibly_open_chat_id=visibly_open_chat_id,
                decision_reason=decision.reason,
                send_attempted=False,
                result=result,
            )
            return result
        result = self.sender.send_text(
            chat_id=user_id,
            text=build_unread_reply_notification_text(chat_title=chat_title),
        )
        self._record_attempt(
            user_id=user_id,
            chat_id=chat_id,
            unread_streak_key=unread_streak_key,
            prior_unread_count=prior_unread_count,
            notifications_enabled=notifications_enabled,
            active_chat_id=active_chat_id,
            visibly_open_chat_id=visibly_open_chat_id,
            decision_reason=decision.reason,
            send_attempted=True,
            result=result,
        )
        return result

    def _record_attempt(
        self,
        *,
        user_id: str,
        chat_id: int,
        unread_streak_key: int,
        prior_unread_count: int,
        notifications_enabled: bool,
        active_chat_id: int | None,
        visibly_open_chat_id: int | None,
        decision_reason: str,
        send_attempted: bool,
        result: TelegramNotificationResult,
    ) -> None:
        try:
            self.store.record_telegram_notification_attempt(
                user_id=user_id,
                chat_id=chat_id,
                unread_streak_key=unread_streak_key,
                prior_unread_count=prior_unread_count,
                notifications_enabled=notifications_enabled,
                active_chat_id=active_chat_id,
                visibly_open_chat_id=visibly_open_chat_id,
                decision_reason=decision_reason,
                send_attempted=send_attempted,
                send_ok=bool(getattr(result, "ok", False)),
                status_code=getattr(result, "status_code", None),
                error=getattr(result, "error", None),
                response_text=getattr(result, "response_text", None),
            )
        except Exception:
            return


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
