from __future__ import annotations

from typing import Any


def parse_bounded_int(
    payload: dict[str, object],
    field: str,
    *,
    default: int,
    min_value: int,
    max_value: int,
) -> tuple[int | None, tuple[dict[str, object], int] | None]:
    raw_value = payload.get(field)
    if raw_value in (None, ""):
        return default, None

    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return None, ({"ok": False, "error": f"Invalid {field}. Must be an integer."}, 400)

    if value < min_value or value > max_value:
        return None, ({"ok": False, "error": f"Invalid {field}. Must be between {min_value} and {max_value}."}, 400)

    return value, None


def parse_chat_id(payload: dict[str, object], *, default_chat_id: int) -> int:
    raw_chat_id = payload.get("chat_id")
    if raw_chat_id in (None, "", 0):
        return int(default_chat_id)
    try:
        return int(raw_chat_id)
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid chat_id.") from exc


def validate_title(raw_title: Any, *, default: str, max_length: int) -> str:
    title = str(raw_title or "").strip() or default
    if len(title) > max_length:
        raise ValueError(f"Title exceeds {max_length} characters.")
    return title


def validate_message(raw_message: Any, *, max_length: int) -> str:
    message = str(raw_message or "").strip()
    if not message:
        raise ValueError("Message cannot be empty.")
    if len(message) > max_length:
        raise ValueError(f"Message exceeds {max_length} characters.")
    return message
