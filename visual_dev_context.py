from __future__ import annotations

import json
from typing import Any

_ALLOWED_SELECTION_KEYS = (
    "selectionType",
    "selection_type",
    "label",
    "selector",
    "tagName",
    "tag_name",
    "text",
    "source",
    "clip_id",
    "clipId",
    "track_id",
    "trackId",
    "clip_kind",
    "clipKind",
    "start_ms",
    "startMs",
    "duration_ms",
    "durationMs",
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


def _is_media_editor_clip_selection(selection: dict[str, str]) -> bool:
    return (
        selection.get("selectionType") == "media_editor_clip"
        or selection.get("selection_type") == "media_editor_clip"
        or selection.get("tagName") == "media-editor-clip"
        or selection.get("tag_name") == "media-editor-clip"
        or bool(selection.get("clip_id") or selection.get("clipId"))
    )


def _int_text(value: Any) -> int:
    try:
        return max(int(float(str(value or "0").strip() or "0")), 0)
    except (TypeError, ValueError):
        return 0


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
    media_editor_context = False
    selection = context.get("selection") or {}
    if selection:
        if _is_media_editor_clip_selection(selection):
            media_editor_context = True
            start_ms = _int_text(selection.get("start_ms") or selection.get("startMs"))
            duration_ms = _int_text(selection.get("duration_ms") or selection.get("durationMs"))
            end_ms = start_ms + duration_ms
            clip_id = selection.get("clip_id") or selection.get("clipId")
            track_id = selection.get("track_id") or selection.get("trackId")
            clip_kind = selection.get("clip_kind") or selection.get("clipKind")
            lines.append("Media editor context for this turn:")
            if selection.get("label"):
                lines.append(f"- Selected clip: {selection['label']}")
            lines.append(f"- Timing: {start_ms}–{end_ms}ms (duration {duration_ms}ms)")
            if clip_id:
                lines.append(f"- Clip ID: {clip_id}")
            if track_id:
                lines.append(f"- Track ID: {track_id}")
            if clip_kind:
                lines.append(f"- Clip kind: {clip_kind}")
            if selection.get("selector"):
                lines.append(f"- Selector: {selection['selector']}")
            if selection.get("text"):
                lines.append(f"- Visible text: {selection['text']}")
        else:
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

    if media_editor_context:
        lines.append(
            "If you want to propose timeline edits, include one hidden proposal block exactly like this; "
            "the app will turn it into a pending suggestion batch instead of requiring manual copying:"
        )
        lines.append("```media-project-suggestions")
        lines.append('{"summary":"Short human summary","operations":[{"kind":"create_text_clip","payload":{"track_id":"<text_track_id>","text":"New title","start_ms":0,"duration_ms":1500}},{"kind":"create_image_clip","payload":{"track_id":"<visual_track_id>","storage_path":"https://example.test/image.png","label":"Image label","start_ms":0,"duration_ms":3000}},{"kind":"create_video_clip","payload":{"track_id":"<visual_track_id>","storage_path":"/api/media-projects/<project_id>/uploaded-assets/clip.mp4","label":"Video label","start_ms":0,"duration_ms":3000}},{"kind":"create_clip_from_asset","payload":{"track_id":"<visual_track_id>","asset_id":"<existing_asset_id>","start_ms":0,"duration_ms":3000}},{"kind":"duplicate_clip","payload":{"clip_id":"<existing_clip_id>","start_ms":3000}},{"kind":"split_clip","payload":{"clip_id":"<existing_clip_id>","split_ms":1500}}]}')
        lines.append("```")
        lines.append("Supported operation kinds: create_text_clip, create_image_clip, create_audio_clip, create_video_clip, create_clip_from_asset, duplicate_clip, split_clip, update_clip, delete_clip.")

    lines.append("Use this visual context when interpreting the operator's request.")
    return "\n".join(lines)
