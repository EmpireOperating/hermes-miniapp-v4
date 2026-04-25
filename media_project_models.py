from __future__ import annotations

import json
from typing import Any


DEFAULT_PROJECT_RESOLUTION = {"width": 1080, "height": 1920}
DEFAULT_PROJECT_ASPECT_RATIO = "9:16"
DEFAULT_PROJECT_FPS = 30
DEFAULT_TRACKS: tuple[tuple[str, str], ...] = (
    ("visual", "Visual"),
    ("text", "Text"),
    ("audio", "Audio"),
)


def dump_media_project_json(value: dict[str, Any] | list[Any] | None) -> str:
    payload = value if value is not None else {}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)



def load_media_project_json(value: Any, *, default: dict[str, Any] | list[Any] | None = None):
    fallback = {} if default is None else default
    if not value:
        return fallback
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback
    if default is not None and not isinstance(parsed, type(default)):
        return fallback
    return parsed
