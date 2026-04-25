from __future__ import annotations

import mimetypes
import os
import uuid
from pathlib import Path
from typing import Any

from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_TEXT_EXTENSIONS = {".pdf", ".txt", ".md", ".json", ".csv", ".tsv", ".log", ".yaml", ".yml"}
_ALLOWED_EXTENSIONS = _IMAGE_EXTENSIONS | _TEXT_EXTENSIONS
_DEFAULT_MAX_BYTES = 10 * 1024 * 1024


def attachment_upload_root() -> Path:
    explicit = str(os.environ.get("MINI_APP_ATTACHMENT_UPLOAD_ROOT") or "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    session_store_path = Path(str(os.environ.get("MINI_APP_SESSION_STORE_PATH") or "sessions.db")).expanduser().resolve()
    return (session_store_path.parent / "miniapp-attachments").resolve()


def attachment_max_bytes() -> int:
    raw = str(os.environ.get("MINI_APP_ATTACHMENT_MAX_BYTES") or "").strip()
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        parsed = _DEFAULT_MAX_BYTES
    return max(1, parsed)


def _normalized_extension(filename: str) -> str:
    return Path(str(filename or "").strip()).suffix.lower()


def guess_content_type(filename: str, provided_content_type: str | None = None) -> str:
    guessed = mimetypes.guess_type(str(filename or ""))[0]
    provided = str(provided_content_type or "").strip().lower()
    if guessed:
        return guessed
    if provided and provided != "application/octet-stream":
        return provided
    extension = _normalized_extension(filename)
    if extension == ".md":
        return "text/markdown"
    if extension in {".yaml", ".yml"}:
        return "application/yaml"
    if extension == ".log":
        return "text/plain"
    return "application/octet-stream"


def attachment_kind(filename: str, content_type: str) -> str:
    extension = _normalized_extension(filename)
    if str(content_type or "").startswith("image/") or extension in _IMAGE_EXTENSIONS:
        return "image"
    return "file"


def validate_upload(file_storage: FileStorage | None) -> tuple[str | None, str | None]:
    if file_storage is None:
        return None, "Missing file upload."
    filename = secure_filename(str(file_storage.filename or "").strip())
    if not filename:
        return None, "Missing file upload."
    extension = _normalized_extension(filename)
    if extension not in _ALLOWED_EXTENSIONS:
        return None, "Unsupported file type."
    return filename, None


def save_upload(*, file_storage: FileStorage, user_id: str, chat_id: int) -> dict[str, Any]:
    filename, validation_error = validate_upload(file_storage)
    if validation_error:
        raise ValueError(validation_error)
    assert filename is not None

    payload = file_storage.stream.read()
    if not payload:
        raise ValueError("Uploaded file is empty.")
    if len(payload) > attachment_max_bytes():
        raise ValueError("File too large.")

    root = attachment_upload_root()
    chat_root = root / f"user-{user_id}" / f"chat-{int(chat_id)}"
    chat_root.mkdir(parents=True, exist_ok=True)

    attachment_id = f"att_{uuid.uuid4().hex}"
    storage_name = f"{attachment_id}-{filename}"
    storage_path = (chat_root / storage_name).resolve()
    storage_path.write_bytes(payload)

    content_type = guess_content_type(filename, file_storage.content_type)
    kind = attachment_kind(filename, content_type)
    return {
        "id": attachment_id,
        "user_id": str(user_id),
        "chat_id": int(chat_id),
        "message_id": None,
        "filename": filename,
        "content_type": content_type,
        "size_bytes": len(payload),
        "storage_path": str(storage_path),
        "kind": kind,
        "width": None,
        "height": None,
    }


def normalize_attachment_record(
    record: dict[str, Any] | None,
    *,
    include_storage_path: bool = False,
) -> dict[str, Any] | None:
    if not record:
        return None
    attachment_id = str(record.get("id") or "").strip()
    if not attachment_id:
        return None
    normalized = {
        "id": attachment_id,
        "kind": str(record.get("kind") or attachment_kind(str(record.get("filename") or ""), str(record.get("content_type") or ""))),
        "filename": str(record.get("filename") or "").strip(),
        "content_type": str(record.get("content_type") or guess_content_type(str(record.get("filename") or ""))).strip(),
        "size_bytes": int(record.get("size_bytes") or 0),
        "preview_url": f"/api/chats/attachments/{attachment_id}/content",
        "download_url": f"/api/chats/attachments/{attachment_id}/content",
    }
    if include_storage_path:
        normalized["storage_path"] = str(record.get("storage_path") or "")
    width = record.get("width")
    height = record.get("height")
    if width not in (None, ""):
        normalized["width"] = int(width)
    if height not in (None, ""):
        normalized["height"] = int(height)
    return normalized


def normalize_attachment_list(
    records: list[dict[str, Any]] | None,
    *,
    include_storage_path: bool = False,
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for record in records or []:
        current = normalize_attachment_record(record, include_storage_path=include_storage_path)
        if current:
            normalized.append(current)
    return normalized
