from __future__ import annotations

from typing import Any


TOOL_EVENT_TYPES = {"tool.started", "tool.updated", "tool.completed"}
_DEFAULT_TOOL_EVENT_TYPE = "tool.started"


def _normalize_event_type(value: Any) -> str:
    event_type = str(value or _DEFAULT_TOOL_EVENT_TYPE).strip().lower()
    return event_type if event_type in TOOL_EVENT_TYPES else _DEFAULT_TOOL_EVENT_TYPE


def _normalize_phase(event_type: str) -> str:
    normalized = _normalize_event_type(event_type)
    return normalized.split(".", 1)[1]


def _normalize_metadata(candidate: Any) -> dict[str, Any]:
    return dict(candidate) if isinstance(candidate, dict) else {}


def normalize_tool_progress_callback_args(callback_args: tuple[Any, ...] | list[Any]) -> dict[str, Any] | None:
    if not callback_args:
        return None

    event_type = _DEFAULT_TOOL_EVENT_TYPE
    tool_name = None
    preview = None
    args: Any = None
    metadata: Any = None
    if len(callback_args) >= 4 and str(callback_args[0] or "").strip():
        raw_event_type = str(callback_args[0] or "").strip().lower()
        if raw_event_type.startswith("tool."):
            event_type = callback_args[0]
            tool_name = callback_args[1]
            preview = callback_args[2]
            args = callback_args[3]
            metadata = callback_args[4] if len(callback_args) >= 5 else None
        elif "." in raw_event_type:
            return None
        else:
            tool_name = callback_args[0]
            preview = callback_args[1] if len(callback_args) >= 2 else None
            args = callback_args[2] if len(callback_args) >= 3 else None
            metadata = callback_args[3] if len(callback_args) >= 4 else None
    else:
        tool_name = callback_args[0]
        preview = callback_args[1] if len(callback_args) >= 2 else None
        args = callback_args[2] if len(callback_args) >= 3 else None
        metadata = callback_args[3] if len(callback_args) >= 4 else None

    normalized_tool_name = str(tool_name or "").strip()
    if not normalized_tool_name:
        return None

    normalized_event_type = _normalize_event_type(event_type)
    normalized_args = _normalize_metadata(args)
    normalized_metadata = _normalize_metadata(metadata)

    tool_call_id = str(
        normalized_metadata.get("tool_call_id")
        or normalized_args.get("tool_call_id")
        or normalized_metadata.get("call_id")
        or normalized_args.get("call_id")
        or normalized_metadata.get("id")
        or normalized_args.get("id")
        or ""
    ).strip()
    message_id = normalized_metadata.get("message_id")
    if message_id is None:
        message_id = normalized_args.get("message_id")
    if message_id is None:
        message_id = normalized_metadata.get("msg_id")
    if message_id is None:
        message_id = normalized_args.get("msg_id")
    if message_id is None:
        message_id = normalized_metadata.get("assistant_message_id")
    if message_id is None:
        message_id = normalized_args.get("assistant_message_id")
    if message_id is None:
        message_id = normalized_metadata.get("turn_id")
    if message_id is None:
        message_id = normalized_args.get("turn_id")

    try:
        normalized_message_id = int(message_id) if message_id is not None else None
    except (TypeError, ValueError):
        normalized_message_id = None

    result = {
        "event_type": normalized_event_type,
        "phase": _normalize_phase(normalized_event_type),
        "tool_name": normalized_tool_name,
        "preview": preview or "",
        "args": normalized_args,
        "metadata": normalized_metadata,
    }
    if tool_call_id:
        result["tool_call_id"] = tool_call_id
    if isinstance(normalized_message_id, int) and normalized_message_id > 0:
        result["message_id"] = normalized_message_id
    return result


def tool_progress_dedupe_key(item: dict[str, Any], *, mode: str) -> str | None:
    normalized_mode = str(mode or "all").strip().lower()
    if normalized_mode != "new":
        return None
    tool_call_id = str(item.get("tool_call_id") or "").strip()
    if not tool_call_id:
        return None
    event_type = _normalize_event_type(item.get("event_type"))
    tool_name = str(item.get("tool_name") or "").strip()
    if not tool_name:
        return None
    return f"{event_type}::{tool_name}::{tool_call_id}"


def build_tool_progress_item(
    *,
    event_type: str,
    tool_name: str,
    preview: Any = None,
    args: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    display: str,
) -> dict[str, Any]:
    item = {
        "kind": "tool",
        "event_type": _normalize_event_type(event_type),
        "phase": _normalize_phase(event_type),
        "tool_name": str(tool_name or "").strip(),
        "preview": preview or "",
        "args": _normalize_metadata(args),
        "metadata": _normalize_metadata(metadata),
        "display": str(display or "").strip(),
    }
    tool_call_id = str(
        item["metadata"].get("tool_call_id")
        or item["args"].get("tool_call_id")
        or item["metadata"].get("call_id")
        or item["args"].get("call_id")
        or item["metadata"].get("id")
        or item["args"].get("id")
        or ""
    ).strip()
    if tool_call_id:
        item["tool_call_id"] = tool_call_id
    message_id = (
        item["metadata"].get("message_id")
        or item["args"].get("message_id")
        or item["metadata"].get("msg_id")
        or item["args"].get("msg_id")
        or item["metadata"].get("assistant_message_id")
        or item["args"].get("assistant_message_id")
        or item["metadata"].get("turn_id")
        or item["args"].get("turn_id")
    )
    try:
        normalized_message_id = int(message_id) if message_id is not None else None
    except (TypeError, ValueError):
        normalized_message_id = None
    if isinstance(normalized_message_id, int) and normalized_message_id > 0:
        item["message_id"] = normalized_message_id
    return item


def stream_event_from_tool_item(item: dict[str, Any], *, display_formatter) -> dict[str, Any]:
    event_type = _normalize_event_type(item.get("event_type"))
    tool_name = str(item.get("tool_name") or "").strip()
    preview = item.get("preview")
    args = _normalize_metadata(item.get("args"))
    metadata = _normalize_metadata(item.get("metadata"))
    event = {
        "type": "tool",
        "event_type": event_type,
        "tool_name": tool_name,
        "preview": preview,
        "args": args,
        "metadata": metadata,
        "phase": _normalize_phase(event_type),
        "display": item.get("display") or display_formatter(tool_name, preview=preview, args=args),
    }
    for key in ("tool_call_id", "message_id"):
        if key in item:
            event[key] = item[key]
    return event
