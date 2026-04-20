from __future__ import annotations

import json
from typing import Any

_ALLOWED_SELECTION_KEYS = (
    "label",
    "selector",
    "tagName",
    "text",
    "source",
)
_ALLOWED_SCREENSHOT_KEYS = (
    "label",
    "storage_path",
    "artifact_path",
    "artifactPath",
    "content_type",
    "source",
)
_ALLOWED_PREVIEW_KEYS = (
    "preview_url",
    "previewUrl",
    "preview_title",
    "previewTitle",
    "url",
    "title",
    "source",
)
_ALLOWED_CONSOLE_KEYS = (
    "runtime_state",
    "runtimeState",
    "runtime_message",
    "runtimeMessage",
    "level",
    "message",
    "source",
)


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_section(payload: Any, *, allowed_keys: tuple[str, ...]) -> dict[str, str] | None:
    if not isinstance(payload, dict):
        return None
    normalized = {
        key: cleaned
        for key in allowed_keys
        if (cleaned := _clean_text(payload.get(key)))
    }
    return normalized or None


def normalize_visual_context(payload: Any) -> dict[str, dict[str, str]] | None:
    if not isinstance(payload, dict):
        return None
    selection = _normalize_section(payload.get("selection"), allowed_keys=_ALLOWED_SELECTION_KEYS)
    screenshot = _normalize_section(payload.get("screenshot"), allowed_keys=_ALLOWED_SCREENSHOT_KEYS)
    preview = _normalize_section(payload.get("preview"), allowed_keys=_ALLOWED_PREVIEW_KEYS)
    console = _normalize_section(payload.get("console"), allowed_keys=_ALLOWED_CONSOLE_KEYS)
    normalized: dict[str, dict[str, str]] = {}
    if selection:
        normalized["selection"] = selection
    if screenshot:
        normalized["screenshot"] = screenshot
    if preview:
        normalized["preview"] = preview
    if console:
        normalized["console"] = console
    return normalized or None


def serialize_visual_context(payload: Any) -> str | None:
    normalized = normalize_visual_context(payload)
    if not normalized:
        return None
    return json.dumps(normalized, sort_keys=True, separators=(",", ":"))


def deserialize_visual_context(payload: Any) -> dict[str, dict[str, str]] | None:
    if isinstance(payload, dict):
        return normalize_visual_context(payload)
    raw = _clean_text(payload)
    if not raw:
        return None
    try:
        decoded = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return normalize_visual_context(decoded)


def build_visual_context_message_block(payload: Any) -> str:
    context = deserialize_visual_context(payload)
    if not context:
        return ""

    lines: list[str] = ["[Visual context for this turn]"]
    selection = context.get("selection") or {}
    if selection:
        lines.append("Visual UI context for this turn:")
        if selection.get("label"):
            lines.append(f"- Selected element: {selection['label']}")
        if selection.get("selector"):
            lines.append(f"- Selector: {selection['selector']}")
        if selection.get("tagName"):
            lines.append(f"- Tag: {selection['tagName']}")
        if selection.get("text"):
            lines.append(f"- Visible text: {selection['text']}")

    screenshot = context.get("screenshot") or {}
    if screenshot:
        lines.append("Visual screenshot context for this turn:")
        if screenshot.get("label"):
            lines.append(f"- Latest screenshot: {screenshot['label']}")
        screenshot_path = screenshot.get("storage_path") or screenshot.get("artifact_path") or screenshot.get("artifactPath")
        if screenshot_path:
            lines.append(f"- Artifact path: {screenshot_path}")
        if screenshot.get("content_type"):
            lines.append(f"- Content type: {screenshot['content_type']}")

    preview = context.get("preview") or {}
    if preview:
        lines.append("Visual preview context for this turn:")
        preview_title = preview.get("preview_title") or preview.get("previewTitle") or preview.get("title")
        preview_url = preview.get("preview_url") or preview.get("previewUrl") or preview.get("url")
        if preview_title:
            lines.append(f"- Attached preview: {preview_title}")
        if preview_url:
            lines.append(f"- Preview URL: {preview_url}")

    console = context.get("console") or {}
    if console:
        lines.append("Visual runtime/debug context for this turn:")
        runtime_state = console.get("runtime_state") or console.get("runtimeState")
        runtime_message = console.get("runtime_message") or console.get("runtimeMessage")
        if runtime_state:
            lines.append(f"- Runtime state: {runtime_state}")
        if runtime_message:
            lines.append(f"- Runtime message: {runtime_message}")
        if console.get("level"):
            lines.append(f"- Console level: {console['level']}")
        if console.get("message"):
            lines.append(f"- Console message: {console['message']}")

    lines.append("Use this visual context when interpreting the operator's request.")
    return "\n".join(lines)
