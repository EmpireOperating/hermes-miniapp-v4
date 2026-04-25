from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from flask import current_app, request, send_file
from media_project_export import render_media_project_to_mp4
from media_project_service import build_media_project_service
from werkzeug.utils import secure_filename



def register_media_project_routes(
    api_bp,
    *,
    store_getter: Callable[[], Any],
    request_payload_fn: Callable[[], dict[str, object]],
    json_user_id_or_error_fn: Callable[[dict[str, object]], tuple[str | None, tuple[dict[str, object], int] | None]],
    json_error_fn: Callable[[str, int], tuple[dict[str, object], int]],
) -> None:
    service = build_media_project_service(store_getter=store_getter)

    def _payload() -> dict[str, object]:
        payload = dict(request_payload_fn() or {})
        if request.method == "GET":
            payload.update({key: value for key, value in request.args.items()})
        if request.form:
            payload.update({key: value for key, value in request.form.items()})
        return payload

    def _safe_project_path_id(project_id: str) -> str:
        normalized = str(project_id or "").strip()
        if not re.fullmatch(r"proj_[A-Za-z0-9]+", normalized):
            raise ValueError("invalid media project id")
        return normalized

    def _safe_export_job_path_id(export_job_id: str) -> str:
        normalized = str(export_job_id or "").strip()
        if not re.fullmatch(r"export_[A-Za-z0-9]+", normalized):
            raise ValueError("invalid media project export id")
        return normalized

    def _uploaded_assets_dir(project_id: str) -> Path:
        return Path(current_app.instance_path) / "media_project_uploads" / _safe_project_path_id(project_id)

    def _detect_image_content_type(raw_bytes: bytes) -> str | None:
        if raw_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if raw_bytes.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if raw_bytes.startswith((b"GIF87a", b"GIF89a")):
            return "image/gif"
        if len(raw_bytes) >= 12 and raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"WEBP":
            return "image/webp"
        return None

    def _detect_audio_content_type(raw_bytes: bytes) -> str | None:
        if raw_bytes.startswith(b"ID3") or raw_bytes[:2] in {b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"}:
            return "audio/mpeg"
        if len(raw_bytes) >= 12 and raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"WAVE":
            return "audio/wav"
        if raw_bytes.startswith(b"OggS"):
            return "audio/ogg"
        if len(raw_bytes) >= 12 and raw_bytes[4:8] == b"ftyp":
            return "audio/mp4"
        return None

    def _detect_video_content_type(raw_bytes: bytes) -> str | None:
        if len(raw_bytes) >= 12 and raw_bytes[4:8] == b"ftyp":
            return "video/mp4"
        if raw_bytes.startswith(b"\x1aE\xdf\xa3"):
            return "video/webm"
        if len(raw_bytes) >= 12 and raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"AVI ":
            return "video/x-msvideo"
        return None

    def _storage_path_for_upload(project_id: str, filename: str) -> str:
        return f"/api/media-projects/{project_id}/uploaded-assets/{filename}"

    def _export_jobs_dir(project_id: str, export_job_id: str) -> Path:
        return Path(current_app.instance_path) / "media_project_exports" / _safe_project_path_id(project_id) / _safe_export_job_path_id(export_job_id)

    def _export_output_path(project_id: str, export_job_id: str) -> str:
        return f"/api/media-projects/{project_id}/export-jobs/{export_job_id}/output.mp4"

    @api_bp.get("/media-projects/chat/<int:chat_id>")
    def media_project_for_chat(chat_id: int) -> tuple[dict[str, object], int]:
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        try:
            return service.chat_project_payload(user_id=str(user_id), chat_id=chat_id), 200
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

    @api_bp.post("/media-projects/<project_id>/operations")
    def media_project_operation(project_id: str) -> tuple[dict[str, object], int]:
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        operation_payload = payload.get("payload")
        if operation_payload is not None and not isinstance(operation_payload, dict):
            return json_error_fn("operation payload must be an object", 400)
        try:
            return (
                service.apply_operation_payload(
                    user_id=str(user_id),
                    project_id=str(project_id),
                    kind=str(payload.get("kind") or ""),
                    payload=operation_payload if isinstance(operation_payload, dict) else {},
                    author=str(payload.get("author") or "user"),
                ),
                200,
            )
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

    @api_bp.post("/media-projects/<project_id>/undo")
    def media_project_undo_operation(project_id: str) -> tuple[dict[str, object], int]:
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        try:
            return service.undo_operation_payload(user_id=str(user_id), project_id=str(project_id)), 200
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

    @api_bp.post("/media-projects/<project_id>/redo")
    def media_project_redo_operation(project_id: str) -> tuple[dict[str, object], int]:
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        try:
            return service.redo_operation_payload(user_id=str(user_id), project_id=str(project_id)), 200
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

    @api_bp.post("/media-projects/<project_id>/image-assets")
    def media_project_upload_image_asset(project_id: str) -> tuple[dict[str, object], int]:
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        upload = request.files.get("file")
        if upload is None or not str(upload.filename or "").strip():
            return json_error_fn("image file is required", 400)
        raw_bytes = upload.read()
        content_type = _detect_image_content_type(raw_bytes)
        if not content_type:
            return json_error_fn("uploaded file must be a supported image", 400)
        safe_name = (secure_filename(str(upload.filename or "image")) or "image").replace("_", "-")
        if "." not in safe_name:
            extension = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}.get(content_type, "img")
            safe_name = f"{safe_name}.{extension}"
        filename = f"{uuid4().hex[:12]}-{safe_name}"
        try:
            target_dir = _uploaded_assets_dir(str(project_id))
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = target_dir / filename
            target_path.write_bytes(raw_bytes)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        try:
            return (
                service.apply_operation_payload(
                    user_id=str(user_id),
                    project_id=str(project_id),
                    kind="create_image_clip",
                    payload={
                        "track_id": str(payload.get("track_id") or ""),
                        "storage_path": _storage_path_for_upload(str(project_id), filename),
                        "content_type": content_type,
                        "label": str(upload.filename or safe_name),
                        "start_ms": int(payload.get("start_ms") or 0),
                        "duration_ms": int(payload.get("duration_ms") or 3000),
                        "params": {"fit": "cover"},
                        "metadata": {
                            "original_filename": str(upload.filename or ""),
                            "stored_filename": filename,
                            "byte_size": len(raw_bytes),
                        },
                    },
                    author=str(payload.get("author") or "user"),
                ),
                200,
            )
        except KeyError as exc:
            target_path.unlink(missing_ok=True)
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            target_path.unlink(missing_ok=True)
            return json_error_fn(str(exc), 400)

    @api_bp.post("/media-projects/<project_id>/audio-assets")
    def media_project_upload_audio_asset(project_id: str) -> tuple[dict[str, object], int]:
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        upload = request.files.get("file")
        if upload is None or not str(upload.filename or "").strip():
            return json_error_fn("audio file is required", 400)
        raw_bytes = upload.read()
        content_type = _detect_audio_content_type(raw_bytes)
        if not content_type:
            return json_error_fn("uploaded file must be a supported audio file", 400)
        safe_name = (secure_filename(str(upload.filename or "audio")) or "audio").replace("_", "-")
        if "." not in safe_name:
            extension = {"audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a"}.get(content_type, "audio")
            safe_name = f"{safe_name}.{extension}"
        filename = f"{uuid4().hex[:12]}-{safe_name}"
        try:
            target_dir = _uploaded_assets_dir(str(project_id))
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = target_dir / filename
            target_path.write_bytes(raw_bytes)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        try:
            gain_raw = payload.get("gain")
            try:
                gain = float(gain_raw) if gain_raw is not None and str(gain_raw) != "" else 1.0
            except (TypeError, ValueError):
                gain = 1.0
            return (
                service.apply_operation_payload(
                    user_id=str(user_id),
                    project_id=str(project_id),
                    kind="create_audio_clip",
                    payload={
                        "track_id": str(payload.get("track_id") or ""),
                        "storage_path": _storage_path_for_upload(str(project_id), filename),
                        "content_type": content_type,
                        "label": str(upload.filename or safe_name),
                        "start_ms": int(payload.get("start_ms") or 0),
                        "duration_ms": int(payload.get("duration_ms") or 3000),
                        "params": {"gain": gain},
                        "metadata": {
                            "original_filename": str(upload.filename or ""),
                            "stored_filename": filename,
                            "byte_size": len(raw_bytes),
                        },
                    },
                    author=str(payload.get("author") or "user"),
                ),
                200,
            )
        except KeyError as exc:
            target_path.unlink(missing_ok=True)
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            target_path.unlink(missing_ok=True)
            return json_error_fn(str(exc), 400)

    @api_bp.post("/media-projects/<project_id>/video-assets")
    def media_project_upload_video_asset(project_id: str) -> tuple[dict[str, object], int]:
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        upload = request.files.get("file")
        if upload is None or not str(upload.filename or "").strip():
            return json_error_fn("video file is required", 400)
        raw_bytes = upload.read()
        content_type = _detect_video_content_type(raw_bytes)
        if not content_type:
            return json_error_fn("uploaded file must be a supported video file", 400)
        safe_name = (secure_filename(str(upload.filename or "video")) or "video").replace("_", "-")
        if "." not in safe_name:
            extension = {"video/mp4": "mp4", "video/webm": "webm", "video/x-msvideo": "avi"}.get(content_type, "video")
            safe_name = f"{safe_name}.{extension}"
        filename = f"{uuid4().hex[:12]}-{safe_name}"
        try:
            target_dir = _uploaded_assets_dir(str(project_id))
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = target_dir / filename
            target_path.write_bytes(raw_bytes)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        try:
            return (
                service.apply_operation_payload(
                    user_id=str(user_id),
                    project_id=str(project_id),
                    kind="create_video_clip",
                    payload={
                        "track_id": str(payload.get("track_id") or ""),
                        "storage_path": _storage_path_for_upload(str(project_id), filename),
                        "content_type": content_type,
                        "label": str(upload.filename or safe_name),
                        "start_ms": int(payload.get("start_ms") or 0),
                        "duration_ms": int(payload.get("duration_ms") or 3000),
                        "params": {"fit": "cover"},
                        "metadata": {
                            "original_filename": str(upload.filename or ""),
                            "stored_filename": filename,
                            "byte_size": len(raw_bytes),
                        },
                    },
                    author=str(payload.get("author") or "user"),
                ),
                200,
            )
        except KeyError as exc:
            target_path.unlink(missing_ok=True)
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            target_path.unlink(missing_ok=True)
            return json_error_fn(str(exc), 400)

    @api_bp.get("/media-projects/<project_id>/uploaded-assets/<path:filename>")
    def media_project_uploaded_asset(project_id: str, filename: str):
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        try:
            service._project_for_user_or_404(store=store_getter(), user_id=str(user_id), project_id=str(project_id))
            _safe_project_path_id(str(project_id))
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
        safe_name = secure_filename(str(filename or ""))
        if not safe_name or safe_name != filename:
            return json_error_fn("uploaded asset not found", 404)
        target_path = (_uploaded_assets_dir(str(project_id)) / safe_name).resolve()
        root = _uploaded_assets_dir(str(project_id)).resolve()
        if root not in target_path.parents or not target_path.is_file():
            return json_error_fn("uploaded asset not found", 404)
        raw_bytes = target_path.read_bytes()
        content_type = _detect_image_content_type(raw_bytes) or _detect_audio_content_type(raw_bytes) or _detect_video_content_type(raw_bytes) or "application/octet-stream"
        return send_file(target_path, mimetype=content_type)

    @api_bp.post("/media-projects/<project_id>/exports")
    def media_project_create_export(project_id: str) -> tuple[dict[str, object], int]:
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        try:
            created_payload = service.create_export_job_payload(
                user_id=str(user_id),
                project_id=str(project_id),
                metadata={"format": "mp4"},
            )
            export_job = created_payload["export_job"]
            export_job_id = str(export_job["export_job_id"])
            target_dir = _export_jobs_dir(str(project_id), export_job_id)
            target_dir.mkdir(parents=True, exist_ok=True)
            output_path = target_dir / "output.mp4"
            render_metadata = render_media_project_to_mp4(
                project=created_payload["project"],
                tracks=created_payload["tracks"],
                assets=created_payload["assets"],
                clips=created_payload["clips"],
                output_path=output_path,
                instance_path=Path(current_app.instance_path),
            )
            return (
                service.update_export_job_payload(
                    user_id=str(user_id),
                    project_id=str(project_id),
                    export_job_id=export_job_id,
                    status="completed",
                    output_path=_export_output_path(str(project_id), export_job_id),
                    metadata=render_metadata,
                ),
                200,
            )
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        except (RuntimeError, ValueError) as exc:
            try:
                if "export_job" in locals():
                    failed_payload = service.update_export_job_payload(
                        user_id=str(user_id),
                        project_id=str(project_id),
                        export_job_id=str(export_job["export_job_id"]),
                        status="failed",
                        metadata={"error": str(exc)},
                    )
                    return failed_payload, 500
            except Exception:
                pass
            return json_error_fn(str(exc), 400)

    @api_bp.get("/media-projects/<project_id>/export-jobs/<export_job_id>/output.mp4")
    def media_project_export_output(project_id: str, export_job_id: str):
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        try:
            project = service._project_for_user_or_404(store=store_getter(), user_id=str(user_id), project_id=str(project_id))
            if not project:
                return json_error_fn("media project not found", 404)
            export_job = store_getter().get_media_project_export_job(project_id=str(project_id), export_job_id=str(export_job_id))
            if not export_job or str(export_job.get("status")) != "completed":
                return json_error_fn("media project export not found", 404)
            target_path = (_export_jobs_dir(str(project_id), str(export_job_id)) / "output.mp4").resolve()
            root = _export_jobs_dir(str(project_id), str(export_job_id)).resolve()
            if root not in target_path.parents or not target_path.is_file():
                return json_error_fn("media project export not found", 404)
            return send_file(target_path, mimetype="video/mp4", as_attachment=False)
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

    @api_bp.post("/media-projects/<project_id>/suggestion-batches")
    def media_project_create_suggestion_batch(project_id: str) -> tuple[dict[str, object], int]:
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        operations = payload.get("operations")
        if not isinstance(operations, list):
            return json_error_fn("suggestion batch operations must be a list", 400)
        try:
            return (
                service.create_suggestion_batch_payload(
                    user_id=str(user_id),
                    project_id=str(project_id),
                    summary=str(payload.get("summary") or ""),
                    operations=operations,
                    author=str(payload.get("author") or "hermes"),
                ),
                200,
            )
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

    @api_bp.post("/media-projects/<project_id>/suggestion-batches/<batch_id>/accept")
    def media_project_accept_suggestion_batch(project_id: str, batch_id: str) -> tuple[dict[str, object], int]:
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        try:
            return (
                service.accept_suggestion_batch_payload(
                    user_id=str(user_id), project_id=str(project_id), batch_id=str(batch_id)
                ),
                200,
            )
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)

    @api_bp.post("/media-projects/<project_id>/suggestion-batches/<batch_id>/reject")
    def media_project_reject_suggestion_batch(project_id: str, batch_id: str) -> tuple[dict[str, object], int]:
        payload = _payload()
        user_id, auth_error = json_user_id_or_error_fn(payload)
        if auth_error:
            return auth_error
        try:
            return (
                service.reject_suggestion_batch_payload(
                    user_id=str(user_id), project_id=str(project_id), batch_id=str(batch_id)
                ),
                200,
            )
        except KeyError as exc:
            return json_error_fn(str(exc), 404)
        except ValueError as exc:
            return json_error_fn(str(exc), 400)
