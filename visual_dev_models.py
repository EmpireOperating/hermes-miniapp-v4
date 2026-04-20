from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class VisualDevSessionRecord:
    session_id: str
    user_id: str
    chat_id: int
    preview_url: str
    preview_origin: str
    preview_title: str
    bridge_parent_origin: str
    status: str
    metadata: dict[str, Any]
    created_at: str
    updated_at: str
    detached_at: str | None


@dataclass(slots=True)
class VisualDevSelectionRecord:
    id: int
    session_id: str
    selection_type: str
    payload: dict[str, Any]
    created_at: str


@dataclass(slots=True)
class VisualDevArtifactRecord:
    id: int
    session_id: str
    artifact_kind: str
    storage_path: str
    content_type: str
    byte_size: int
    metadata: dict[str, Any]
    created_at: str


@dataclass(slots=True)
class VisualDevConsoleEventRecord:
    id: int
    session_id: str
    event_type: str
    level: str
    message: str
    metadata: dict[str, Any]
    created_at: str



def dump_visual_dev_json(value: dict[str, Any] | None) -> str:
    return json.dumps(value or {}, ensure_ascii=False, sort_keys=True)



def load_visual_dev_json(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    return parsed
