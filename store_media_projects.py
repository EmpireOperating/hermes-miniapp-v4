from __future__ import annotations

from typing import Any
from uuid import uuid4

from media_project_models import (
    DEFAULT_PROJECT_ASPECT_RATIO,
    DEFAULT_PROJECT_FPS,
    DEFAULT_PROJECT_RESOLUTION,
    DEFAULT_TRACKS,
    dump_media_project_json,
    load_media_project_json,
)


class StoreMediaProjectsMixin:
    def ensure_media_project_for_chat(
        self,
        *,
        user_id: str,
        chat_id: int,
        title: str,
        aspect_ratio: str = DEFAULT_PROJECT_ASPECT_RATIO,
        resolution: dict[str, int] | None = None,
        fps: int = DEFAULT_PROJECT_FPS,
    ) -> dict[str, Any]:
        resolved_resolution = dict(DEFAULT_PROJECT_RESOLUTION)
        if isinstance(resolution, dict):
            resolved_resolution.update(
                {
                    "width": max(int(resolution.get("width") or DEFAULT_PROJECT_RESOLUTION["width"]), 1),
                    "height": max(int(resolution.get("height") or DEFAULT_PROJECT_RESOLUTION["height"]), 1),
                }
            )
        with self._connect() as conn:
            self._ensure_chat_exists(conn, user_id, chat_id)
            existing = conn.execute(
                "SELECT * FROM media_projects WHERE user_id = ? AND chat_id = ? LIMIT 1",
                (user_id, int(chat_id)),
            ).fetchone()
            if existing:
                return self._media_project_row_to_dict(existing)
            project_id = f"proj_{uuid4().hex[:12]}"
            conn.execute(
                """
                INSERT INTO media_projects (
                    project_id,
                    user_id,
                    chat_id,
                    title,
                    aspect_ratio,
                    resolution_json,
                    fps,
                    duration_ms,
                    status,
                    metadata_json,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'draft', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    project_id,
                    user_id,
                    int(chat_id),
                    str(title or "Untitled").strip() or "Untitled",
                    str(aspect_ratio or DEFAULT_PROJECT_ASPECT_RATIO).strip() or DEFAULT_PROJECT_ASPECT_RATIO,
                    dump_media_project_json(resolved_resolution),
                    max(int(fps or DEFAULT_PROJECT_FPS), 1),
                ),
            )
            for position, (kind, label) in enumerate(DEFAULT_TRACKS):
                conn.execute(
                    """
                    INSERT INTO media_project_tracks (
                        track_id,
                        project_id,
                        kind,
                        position,
                        label,
                        created_at,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (f"{project_id}:{kind}", project_id, kind, position, label),
                )
            row = conn.execute(
                "SELECT * FROM media_projects WHERE project_id = ? LIMIT 1",
                (project_id,),
            ).fetchone()
        return self._media_project_row_to_dict(row)

    def get_media_project_by_chat(self, *, user_id: str, chat_id: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM media_projects WHERE user_id = ? AND chat_id = ? LIMIT 1",
                (user_id, int(chat_id)),
            ).fetchone()
        if not row:
            return None
        return self._media_project_row_to_dict(row)

    def list_media_project_tracks(self, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM media_project_tracks WHERE project_id = ? ORDER BY position ASC, track_id ASC",
                (project_id,),
            ).fetchall()
        return [self._media_project_track_row_to_dict(row) for row in rows]

    def list_media_project_assets(self, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM media_project_assets WHERE project_id = ? ORDER BY created_at DESC, asset_id DESC",
                (project_id,),
            ).fetchall()
        return [self._media_project_asset_row_to_dict(row) for row in rows]

    def list_media_project_clips(self, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM media_project_clips WHERE project_id = ? ORDER BY start_ms ASC, clip_id ASC",
                (project_id,),
            ).fetchall()
        return [self._media_project_clip_row_to_dict(row) for row in rows]

    def list_media_project_suggestion_batches(self, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM media_project_suggestion_batches
                WHERE project_id = ?
                ORDER BY created_at DESC, batch_id DESC
                """,
                (project_id,),
            ).fetchall()
        return [self._media_project_suggestion_batch_row_to_dict(row) for row in rows]

    def list_media_project_export_jobs(self, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM media_project_export_jobs
                WHERE project_id = ?
                ORDER BY created_at DESC, export_job_id DESC
                """,
                (str(project_id),),
            ).fetchall()
        return [self._media_project_export_job_row_to_dict(row) for row in rows]

    def create_media_project_export_job(
        self,
        *,
        project_id: str,
        status: str = "queued",
        output_path: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        normalized_project_id = str(project_id)
        normalized_status = str(status or "queued").strip() or "queued"
        if normalized_status not in {"queued", "rendering", "completed", "failed"}:
            raise ValueError("unsupported export job status")
        export_job_id = f"export_{uuid4().hex[:12]}"
        with self._connect() as conn:
            project = conn.execute(
                "SELECT project_id FROM media_projects WHERE project_id = ? LIMIT 1",
                (normalized_project_id,),
            ).fetchone()
            if not project:
                raise KeyError("media project not found")
            conn.execute(
                """
                INSERT INTO media_project_export_jobs (
                    export_job_id, project_id, status, output_path, metadata_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    export_job_id,
                    normalized_project_id,
                    normalized_status,
                    str(output_path or ""),
                    dump_media_project_json(metadata if isinstance(metadata, dict) else {}),
                ),
            )
            row = conn.execute(
                "SELECT * FROM media_project_export_jobs WHERE export_job_id = ? LIMIT 1",
                (export_job_id,),
            ).fetchone()
        return self._media_project_export_job_row_to_dict(row)

    def update_media_project_export_job(
        self,
        *,
        project_id: str,
        export_job_id: str,
        status: str,
        output_path: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        normalized_status = str(status or "").strip()
        if normalized_status not in {"queued", "rendering", "completed", "failed"}:
            raise ValueError("unsupported export job status")
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM media_project_export_jobs WHERE project_id = ? AND export_job_id = ? LIMIT 1",
                (str(project_id), str(export_job_id)),
            ).fetchone()
            if not row:
                raise KeyError("media project export job not found")
            next_metadata = load_media_project_json(row["metadata_json"], default={})
            if isinstance(metadata, dict):
                next_metadata.update(metadata)
            next_output_path = str(row["output_path"] or "") if output_path is None else str(output_path or "")
            conn.execute(
                """
                UPDATE media_project_export_jobs
                SET status = ?, output_path = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP
                WHERE project_id = ? AND export_job_id = ?
                """,
                (
                    normalized_status,
                    next_output_path,
                    dump_media_project_json(next_metadata if isinstance(next_metadata, dict) else {}),
                    str(project_id),
                    str(export_job_id),
                ),
            )
            updated = conn.execute(
                "SELECT * FROM media_project_export_jobs WHERE project_id = ? AND export_job_id = ? LIMIT 1",
                (str(project_id), str(export_job_id)),
            ).fetchone()
        return self._media_project_export_job_row_to_dict(updated)

    def get_media_project_export_job(self, *, project_id: str, export_job_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM media_project_export_jobs WHERE project_id = ? AND export_job_id = ? LIMIT 1",
                (str(project_id), str(export_job_id)),
            ).fetchone()
        if not row:
            return None
        return self._media_project_export_job_row_to_dict(row)

    def get_media_project(self, project_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM media_projects WHERE project_id = ? LIMIT 1",
                (str(project_id),),
            ).fetchone()
        if not row:
            return None
        return self._media_project_row_to_dict(row)

    def list_media_project_operations(self, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM media_project_operations
                WHERE project_id = ?
                ORDER BY rowid DESC
                """,
                (str(project_id),),
            ).fetchall()
        return [self._media_project_operation_row_to_dict(row) for row in rows]

    def apply_media_project_operation(
        self,
        *,
        project_id: str,
        author: str,
        kind: str,
        payload: dict[str, Any] | None,
        batch_id: str | None = None,
    ) -> dict[str, Any]:
        operation_kind = str(kind or "").strip()
        if operation_kind not in {"create_text_clip", "create_image_clip", "create_audio_clip", "create_video_clip", "create_clip_from_asset", "duplicate_clip", "split_clip", "update_clip", "delete_clip"}:
            raise ValueError(f"unsupported media project operation: {operation_kind}")
        operation_payload = payload if isinstance(payload, dict) else {}
        with self._connect() as conn:
            project = conn.execute(
                "SELECT * FROM media_projects WHERE project_id = ? LIMIT 1",
                (str(project_id),),
            ).fetchone()
            if not project:
                raise KeyError("media project not found")
            before_state = self._snapshot_media_project_state(conn, str(project_id))
            conn.execute(
                "UPDATE media_project_operations SET status = 'superseded' WHERE project_id = ? AND status = 'undone'",
                (str(project_id),),
            )
            result: dict[str, Any]
            if operation_kind == "create_text_clip":
                result = self._apply_create_text_clip(conn, str(project_id), operation_payload)
            elif operation_kind == "create_image_clip":
                result = self._apply_create_image_clip(conn, str(project_id), operation_payload)
            elif operation_kind == "create_audio_clip":
                result = self._apply_create_audio_clip(conn, str(project_id), operation_payload)
            elif operation_kind == "create_video_clip":
                result = self._apply_create_video_clip(conn, str(project_id), operation_payload)
            elif operation_kind == "create_clip_from_asset":
                result = self._apply_create_clip_from_asset(conn, str(project_id), operation_payload)
            elif operation_kind == "duplicate_clip":
                result = self._apply_duplicate_clip(conn, str(project_id), operation_payload)
            elif operation_kind == "split_clip":
                result = self._apply_split_clip(conn, str(project_id), operation_payload)
            elif operation_kind == "update_clip":
                result = self._apply_update_clip(conn, str(project_id), operation_payload)
            else:
                result = self._apply_delete_clip(conn, str(project_id), operation_payload)
            self._refresh_media_project_duration(conn, str(project_id))
            after_state = self._snapshot_media_project_state(conn, str(project_id))
            operation_id = self._insert_media_project_operation(
                conn,
                project_id=str(project_id),
                author=str(author or "user").strip() or "user",
                kind=operation_kind,
                payload=operation_payload,
                batch_id=str(batch_id or "").strip() or None,
                before_state=before_state,
                after_state=after_state,
            )
            operation_row = conn.execute(
                "SELECT * FROM media_project_operations WHERE operation_id = ? LIMIT 1",
                (operation_id,),
            ).fetchone()
            result["operation"] = self._media_project_operation_row_to_dict(operation_row)
        return result

    def create_media_project_suggestion_batch(
        self,
        *,
        project_id: str,
        author: str,
        summary: str,
        operations: list[dict[str, Any]],
    ) -> dict[str, Any]:
        normalized_operations = self._normalize_suggestion_operations(operations)
        with self._connect() as conn:
            project = conn.execute(
                "SELECT project_id FROM media_projects WHERE project_id = ? LIMIT 1",
                (str(project_id),),
            ).fetchone()
            if not project:
                raise KeyError("media project not found")
            batch_id = f"batch_{uuid4().hex[:12]}"
            conn.execute(
                """
                INSERT INTO media_project_suggestion_batches (
                    batch_id, project_id, author, status, summary, operations_json, created_at, updated_at
                ) VALUES (?, ?, ?, 'pending', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    batch_id,
                    str(project_id),
                    str(author or "hermes").strip() or "hermes",
                    str(summary or "").strip(),
                    dump_media_project_json(normalized_operations),
                ),
            )
            row = conn.execute(
                "SELECT * FROM media_project_suggestion_batches WHERE batch_id = ? LIMIT 1",
                (batch_id,),
            ).fetchone()
        return self._media_project_suggestion_batch_row_to_dict(row)

    def accept_media_project_suggestion_batch(self, *, project_id: str, batch_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = self._get_pending_suggestion_batch_row(conn, project_id, batch_id)
            operations = load_media_project_json(row["operations_json"], default=[])
            author = str(row["author"] or "hermes")
            conn.execute(
                "UPDATE media_project_operations SET status = 'superseded' WHERE project_id = ? AND status = 'undone'",
                (str(project_id),),
            )
            for operation in self._normalize_suggestion_operations(operations):
                kind = str(operation.get("kind") or "").strip()
                payload = operation.get("payload") if isinstance(operation.get("payload"), dict) else {}
                before_state = self._snapshot_media_project_state(conn, str(project_id))
                if kind == "create_text_clip":
                    self._apply_create_text_clip(conn, str(project_id), payload)
                elif kind == "create_image_clip":
                    self._apply_create_image_clip(conn, str(project_id), payload)
                elif kind == "create_audio_clip":
                    self._apply_create_audio_clip(conn, str(project_id), payload)
                elif kind == "create_video_clip":
                    self._apply_create_video_clip(conn, str(project_id), payload)
                elif kind == "create_clip_from_asset":
                    self._apply_create_clip_from_asset(conn, str(project_id), payload)
                elif kind == "duplicate_clip":
                    self._apply_duplicate_clip(conn, str(project_id), payload)
                elif kind == "split_clip":
                    self._apply_split_clip(conn, str(project_id), payload)
                elif kind == "update_clip":
                    self._apply_update_clip(conn, str(project_id), payload)
                elif kind == "delete_clip":
                    self._apply_delete_clip(conn, str(project_id), payload)
                else:
                    raise ValueError(f"unsupported media project operation: {kind}")
                self._refresh_media_project_duration(conn, str(project_id))
                after_state = self._snapshot_media_project_state(conn, str(project_id))
                self._insert_media_project_operation(
                    conn,
                    project_id=str(project_id),
                    author=author,
                    kind=kind,
                    payload=payload,
                    batch_id=str(batch_id),
                    before_state=before_state,
                    after_state=after_state,
                )
            self._refresh_media_project_duration(conn, str(project_id))
            conn.execute(
                """
                UPDATE media_project_suggestion_batches
                SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
                WHERE project_id = ? AND batch_id = ?
                """,
                (str(project_id), str(batch_id)),
            )
            accepted = conn.execute(
                "SELECT * FROM media_project_suggestion_batches WHERE project_id = ? AND batch_id = ? LIMIT 1",
                (str(project_id), str(batch_id)),
            ).fetchone()
        return self._media_project_suggestion_batch_row_to_dict(accepted)

    def reject_media_project_suggestion_batch(self, *, project_id: str, batch_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            self._get_pending_suggestion_batch_row(conn, project_id, batch_id)
            conn.execute(
                """
                UPDATE media_project_suggestion_batches
                SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
                WHERE project_id = ? AND batch_id = ?
                """,
                (str(project_id), str(batch_id)),
            )
            rejected = conn.execute(
                "SELECT * FROM media_project_suggestion_batches WHERE project_id = ? AND batch_id = ? LIMIT 1",
                (str(project_id), str(batch_id)),
            ).fetchone()
        return self._media_project_suggestion_batch_row_to_dict(rejected)

    def _normalize_suggestion_operations(self, operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not isinstance(operations, list) or not operations:
            raise ValueError("suggestion batch operations must be a non-empty list")
        normalized: list[dict[str, Any]] = []
        for operation in operations:
            if not isinstance(operation, dict):
                raise ValueError("suggestion batch operations must be objects")
            kind = str(operation.get("kind") or "").strip()
            if kind not in {"create_text_clip", "create_image_clip", "create_audio_clip", "create_video_clip", "create_clip_from_asset", "duplicate_clip", "split_clip", "update_clip", "delete_clip"}:
                raise ValueError(f"unsupported media project operation: {kind}")
            payload = operation.get("payload") if isinstance(operation.get("payload"), dict) else {}
            normalized.append({"kind": kind, "payload": payload})
        return normalized

    def _get_pending_suggestion_batch_row(self, conn, project_id: str, batch_id: str):
        row = conn.execute(
            "SELECT * FROM media_project_suggestion_batches WHERE project_id = ? AND batch_id = ? LIMIT 1",
            (str(project_id), str(batch_id)),
        ).fetchone()
        if not row:
            raise KeyError("media project suggestion batch not found")
        if str(row["status"] or "pending") != "pending":
            raise ValueError("media project suggestion batch is not pending")
        return row

    def _insert_media_project_operation(
        self,
        conn,
        *,
        project_id: str,
        author: str,
        kind: str,
        payload: dict[str, Any],
        batch_id: str | None = None,
        before_state: dict[str, Any] | None = None,
        after_state: dict[str, Any] | None = None,
    ) -> str:
        operation_id = f"op_{uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO media_project_operations (
                operation_id, project_id, batch_id, author, kind, payload_json,
                status, before_state_json, after_state_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'applied', ?, ?, CURRENT_TIMESTAMP)
            """,
            (
                operation_id,
                str(project_id),
                str(batch_id or "").strip() or None,
                str(author or "user").strip() or "user",
                str(kind or "").strip(),
                dump_media_project_json(payload if isinstance(payload, dict) else {}),
                dump_media_project_json(before_state if isinstance(before_state, dict) else {}),
                dump_media_project_json(after_state if isinstance(after_state, dict) else {}),
            ),
        )
        return operation_id

    def undo_media_project_operation(self, *, project_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM media_project_operations
                WHERE project_id = ? AND status = 'applied'
                ORDER BY rowid DESC
                LIMIT 1
                """,
                (str(project_id),),
            ).fetchone()
            if not row:
                raise ValueError("nothing to undo")
            before_state = load_media_project_json(row["before_state_json"], default={})
            if not isinstance(before_state, dict):
                before_state = {"assets": [], "clips": []}
            self._restore_media_project_state(conn, str(project_id), before_state)
            self._refresh_media_project_duration(conn, str(project_id))
            conn.execute(
                "UPDATE media_project_operations SET status = 'undone' WHERE operation_id = ?",
                (row["operation_id"],),
            )
            updated = conn.execute(
                "SELECT * FROM media_project_operations WHERE operation_id = ? LIMIT 1",
                (row["operation_id"],),
            ).fetchone()
        return {"operation": self._media_project_operation_row_to_dict(updated)}

    def redo_media_project_operation(self, *, project_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM media_project_operations
                WHERE project_id = ? AND status = 'undone'
                ORDER BY rowid ASC
                LIMIT 1
                """,
                (str(project_id),),
            ).fetchone()
            if not row:
                raise ValueError("nothing to redo")
            after_state = load_media_project_json(row["after_state_json"], default={})
            if not isinstance(after_state, dict):
                after_state = {"assets": [], "clips": []}
            self._restore_media_project_state(conn, str(project_id), after_state)
            self._refresh_media_project_duration(conn, str(project_id))
            conn.execute(
                "UPDATE media_project_operations SET status = 'applied' WHERE operation_id = ?",
                (row["operation_id"],),
            )
            updated = conn.execute(
                "SELECT * FROM media_project_operations WHERE operation_id = ? LIMIT 1",
                (row["operation_id"],),
            ).fetchone()
        return {"operation": self._media_project_operation_row_to_dict(updated)}

    def _snapshot_media_project_state(self, conn, project_id: str) -> dict[str, Any]:
        asset_rows = conn.execute(
            "SELECT * FROM media_project_assets WHERE project_id = ? ORDER BY asset_id ASC",
            (str(project_id),),
        ).fetchall()
        clip_rows = conn.execute(
            "SELECT * FROM media_project_clips WHERE project_id = ? ORDER BY clip_id ASC",
            (str(project_id),),
        ).fetchall()
        return {
            "assets": [self._media_project_asset_row_to_dict(row) for row in asset_rows],
            "clips": [self._media_project_clip_row_to_dict(row) for row in clip_rows],
        }

    def _restore_media_project_state(self, conn, project_id: str, snapshot: dict[str, Any]) -> None:
        assets = snapshot.get("assets") if isinstance(snapshot.get("assets"), list) else []
        clips = snapshot.get("clips") if isinstance(snapshot.get("clips"), list) else []
        conn.execute("DELETE FROM media_project_clips WHERE project_id = ?", (str(project_id),))
        conn.execute("DELETE FROM media_project_assets WHERE project_id = ?", (str(project_id),))
        for asset in assets:
            if not isinstance(asset, dict):
                continue
            conn.execute(
                """
                INSERT INTO media_project_assets (
                    asset_id, project_id, kind, storage_path, content_type, label, metadata_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(asset.get("asset_id") or ""),
                    str(project_id),
                    str(asset.get("kind") or "asset"),
                    str(asset.get("storage_path") or ""),
                    str(asset.get("content_type") or ""),
                    str(asset.get("label") or ""),
                    dump_media_project_json(asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}),
                    str(asset.get("created_at") or ""),
                    str(asset.get("updated_at") or ""),
                ),
            )
        for clip in clips:
            if not isinstance(clip, dict):
                continue
            conn.execute(
                """
                INSERT INTO media_project_clips (
                    clip_id, project_id, track_id, asset_id, kind, start_ms, duration_ms,
                    source_in_ms, source_out_ms, z_index, params_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(clip.get("clip_id") or ""),
                    str(project_id),
                    str(clip.get("track_id") or ""),
                    str(clip.get("asset_id") or "").strip() or None,
                    str(clip.get("kind") or "asset"),
                    max(int(clip.get("start_ms") or 0), 0),
                    max(int(clip.get("duration_ms") or 0), 0),
                    max(int(clip.get("source_in_ms") or 0), 0),
                    max(int(clip.get("source_out_ms") or 0), 0),
                    int(clip.get("z_index") or 0),
                    dump_media_project_json(clip.get("params") if isinstance(clip.get("params"), dict) else {}),
                    str(clip.get("created_at") or ""),
                    str(clip.get("updated_at") or ""),
                ),
            )

    def _apply_create_text_clip(self, conn, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        track_id = str(payload.get("track_id") or "").strip()
        track = conn.execute(
            "SELECT * FROM media_project_tracks WHERE project_id = ? AND track_id = ? AND kind = 'text' LIMIT 1",
            (project_id, track_id),
        ).fetchone()
        if not track:
            raise ValueError("text track not found")
        start_ms = max(int(payload.get("start_ms") or 0), 0)
        duration_ms = max(int(payload.get("duration_ms") or 2000), 1)
        params = dict(payload.get("params") or {}) if isinstance(payload.get("params"), dict) else {}
        text = str(payload.get("text") or params.get("text") or "New text clip")
        params["text"] = text
        clip_id = f"clip_{uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO media_project_clips (
                clip_id, project_id, track_id, kind, start_ms, duration_ms, params_json, created_at, updated_at
            ) VALUES (?, ?, ?, 'text', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (clip_id, project_id, track_id, start_ms, duration_ms, dump_media_project_json(params)),
        )
        row = conn.execute("SELECT * FROM media_project_clips WHERE clip_id = ? LIMIT 1", (clip_id,)).fetchone()
        return {"clip": self._media_project_clip_row_to_dict(row)}

    def _apply_create_image_clip(self, conn, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        track_id = str(payload.get("track_id") or "").strip()
        track = conn.execute(
            "SELECT * FROM media_project_tracks WHERE project_id = ? AND track_id = ? AND kind = 'visual' LIMIT 1",
            (project_id, track_id),
        ).fetchone()
        if not track:
            raise ValueError("visual track not found")
        storage_path = str(payload.get("storage_path") or payload.get("url") or "").strip()
        if not storage_path:
            raise ValueError("image storage_path is required")
        content_type = str(payload.get("content_type") or "image/*").strip() or "image/*"
        label = str(payload.get("label") or storage_path.rsplit("/", 1)[-1] or "Image clip").strip() or "Image clip"
        metadata = dict(payload.get("metadata") or {}) if isinstance(payload.get("metadata"), dict) else {}
        asset_id = f"asset_{uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO media_project_assets (
                asset_id, project_id, kind, storage_path, content_type, label, metadata_json, created_at, updated_at
            ) VALUES (?, ?, 'image', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (asset_id, project_id, storage_path, content_type, label, dump_media_project_json(metadata)),
        )
        start_ms = max(int(payload.get("start_ms") or 0), 0)
        duration_ms = max(int(payload.get("duration_ms") or 3000), 1)
        params = dict(payload.get("params") or {}) if isinstance(payload.get("params"), dict) else {}
        params.setdefault("fit", "cover")
        clip_id = f"clip_{uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO media_project_clips (
                clip_id, project_id, track_id, asset_id, kind, start_ms, duration_ms, params_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'image', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (clip_id, project_id, track_id, asset_id, start_ms, duration_ms, dump_media_project_json(params)),
        )
        asset_row = conn.execute("SELECT * FROM media_project_assets WHERE asset_id = ? LIMIT 1", (asset_id,)).fetchone()
        clip_row = conn.execute("SELECT * FROM media_project_clips WHERE clip_id = ? LIMIT 1", (clip_id,)).fetchone()
        return {"asset": self._media_project_asset_row_to_dict(asset_row), "clip": self._media_project_clip_row_to_dict(clip_row)}

    def _apply_create_audio_clip(self, conn, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        track_id = str(payload.get("track_id") or "").strip()
        track = conn.execute(
            "SELECT * FROM media_project_tracks WHERE project_id = ? AND track_id = ? AND kind = 'audio' LIMIT 1",
            (project_id, track_id),
        ).fetchone()
        if not track:
            raise ValueError("audio track not found")
        storage_path = str(payload.get("storage_path") or payload.get("url") or "").strip()
        if not storage_path:
            raise ValueError("audio storage_path is required")
        content_type = str(payload.get("content_type") or "audio/*").strip() or "audio/*"
        label = str(payload.get("label") or storage_path.rsplit("/", 1)[-1] or "Audio clip").strip() or "Audio clip"
        metadata = dict(payload.get("metadata") or {}) if isinstance(payload.get("metadata"), dict) else {}
        asset_id = f"asset_{uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO media_project_assets (
                asset_id, project_id, kind, storage_path, content_type, label, metadata_json, created_at, updated_at
            ) VALUES (?, ?, 'audio', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (asset_id, project_id, storage_path, content_type, label, dump_media_project_json(metadata)),
        )
        start_ms = max(int(payload.get("start_ms") or 0), 0)
        duration_ms = max(int(payload.get("duration_ms") or 3000), 1)
        params = dict(payload.get("params") or {}) if isinstance(payload.get("params"), dict) else {}
        params.setdefault("gain", 1)
        clip_id = f"clip_{uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO media_project_clips (
                clip_id, project_id, track_id, asset_id, kind, start_ms, duration_ms, params_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'audio', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (clip_id, project_id, track_id, asset_id, start_ms, duration_ms, dump_media_project_json(params)),
        )
        asset_row = conn.execute("SELECT * FROM media_project_assets WHERE asset_id = ? LIMIT 1", (asset_id,)).fetchone()
        clip_row = conn.execute("SELECT * FROM media_project_clips WHERE clip_id = ? LIMIT 1", (clip_id,)).fetchone()
        return {"asset": self._media_project_asset_row_to_dict(asset_row), "clip": self._media_project_clip_row_to_dict(clip_row)}

    def _apply_create_video_clip(self, conn, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        track_id = str(payload.get("track_id") or "").strip()
        track = conn.execute(
            "SELECT * FROM media_project_tracks WHERE project_id = ? AND track_id = ? AND kind = 'visual' LIMIT 1",
            (project_id, track_id),
        ).fetchone()
        if not track:
            raise ValueError("visual track not found")
        storage_path = str(payload.get("storage_path") or payload.get("url") or "").strip()
        if not storage_path:
            raise ValueError("video storage_path is required")
        content_type = str(payload.get("content_type") or "video/*").strip() or "video/*"
        label = str(payload.get("label") or storage_path.rsplit("/", 1)[-1] or "Video clip").strip() or "Video clip"
        metadata = dict(payload.get("metadata") or {}) if isinstance(payload.get("metadata"), dict) else {}
        asset_id = f"asset_{uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO media_project_assets (
                asset_id, project_id, kind, storage_path, content_type, label, metadata_json, created_at, updated_at
            ) VALUES (?, ?, 'video', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (asset_id, project_id, storage_path, content_type, label, dump_media_project_json(metadata)),
        )
        start_ms = max(int(payload.get("start_ms") or 0), 0)
        duration_ms = max(int(payload.get("duration_ms") or 3000), 1)
        params = dict(payload.get("params") or {}) if isinstance(payload.get("params"), dict) else {}
        params.setdefault("fit", "cover")
        clip_id = f"clip_{uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO media_project_clips (
                clip_id, project_id, track_id, asset_id, kind, start_ms, duration_ms, params_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'video', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (clip_id, project_id, track_id, asset_id, start_ms, duration_ms, dump_media_project_json(params)),
        )
        asset_row = conn.execute("SELECT * FROM media_project_assets WHERE asset_id = ? LIMIT 1", (asset_id,)).fetchone()
        clip_row = conn.execute("SELECT * FROM media_project_clips WHERE clip_id = ? LIMIT 1", (clip_id,)).fetchone()
        return {"asset": self._media_project_asset_row_to_dict(asset_row), "clip": self._media_project_clip_row_to_dict(clip_row)}

    def _apply_create_clip_from_asset(self, conn, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        track_id = str(payload.get("track_id") or "").strip()
        track = conn.execute(
            "SELECT * FROM media_project_tracks WHERE project_id = ? AND track_id = ? LIMIT 1",
            (project_id, track_id),
        ).fetchone()
        if not track:
            raise ValueError("media track not found")
        asset_id = str(payload.get("asset_id") or "").strip()
        asset = conn.execute(
            "SELECT * FROM media_project_assets WHERE project_id = ? AND asset_id = ? LIMIT 1",
            (project_id, asset_id),
        ).fetchone()
        if not asset:
            raise KeyError("media asset not found")
        asset_kind = str(asset["kind"] or "")
        track_kind = str(track["kind"] or "")
        if asset_kind in {"image", "video"} and track_kind != "visual":
            raise ValueError(f"{asset_kind} assets must be placed on the visual track")
        if asset_kind == "audio" and track_kind != "audio":
            raise ValueError("audio assets must be placed on the audio track")
        if asset_kind not in {"image", "audio", "video"}:
            raise ValueError("only image, video and audio assets can be placed on the timeline")
        start_ms = max(int(payload.get("start_ms") or 0), 0)
        duration_ms = max(int(payload.get("duration_ms") or 3000), 1)
        params = dict(payload.get("params") or {}) if isinstance(payload.get("params"), dict) else {}
        if asset_kind in {"image", "video"}:
            params.setdefault("fit", "cover")
        if asset_kind == "audio":
            params.setdefault("gain", 1)
        clip_id = f"clip_{uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO media_project_clips (
                clip_id, project_id, track_id, asset_id, kind, start_ms, duration_ms, params_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (clip_id, project_id, track_id, asset_id, asset_kind, start_ms, duration_ms, dump_media_project_json(params)),
        )
        clip_row = conn.execute("SELECT * FROM media_project_clips WHERE clip_id = ? LIMIT 1", (clip_id,)).fetchone()
        return {"asset": self._media_project_asset_row_to_dict(asset), "clip": self._media_project_clip_row_to_dict(clip_row)}

    def _apply_duplicate_clip(self, conn, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        source_clip_id = str(payload.get("clip_id") or payload.get("source_clip_id") or "").strip()
        source = conn.execute(
            "SELECT * FROM media_project_clips WHERE project_id = ? AND clip_id = ? LIMIT 1",
            (project_id, source_clip_id),
        ).fetchone()
        if not source:
            raise KeyError("media clip not found")
        track_id = str(payload.get("track_id") or source["track_id"] or "").strip()
        track = conn.execute(
            "SELECT track_id FROM media_project_tracks WHERE project_id = ? AND track_id = ? LIMIT 1",
            (project_id, track_id),
        ).fetchone()
        if not track:
            raise ValueError("target track not found")
        source_start_ms = int(source["start_ms"] or 0)
        source_duration_ms = max(int(source["duration_ms"] or 1), 1)
        default_start_ms = source_start_ms + source_duration_ms
        start_ms = max(int(payload.get("start_ms", default_start_ms) or 0), 0)
        duration_ms = max(int(payload.get("duration_ms", source_duration_ms) or 1), 1)
        params = load_media_project_json(source["params_json"], default={})
        if isinstance(payload.get("params"), dict):
            params.update(payload["params"])
        clip_id = f"clip_{uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO media_project_clips (
                clip_id, project_id, track_id, asset_id, kind, start_ms, duration_ms,
                source_in_ms, source_out_ms, z_index, params_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (
                clip_id,
                project_id,
                track_id,
                source["asset_id"],
                source["kind"],
                start_ms,
                duration_ms,
                source["source_in_ms"],
                source["source_out_ms"],
                source["z_index"],
                dump_media_project_json(params),
            ),
        )
        row = conn.execute("SELECT * FROM media_project_clips WHERE clip_id = ? LIMIT 1", (clip_id,)).fetchone()
        return {"clip": self._media_project_clip_row_to_dict(row)}

    def _apply_split_clip(self, conn, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        source_clip_id = str(payload.get("clip_id") or "").strip()
        source = conn.execute(
            "SELECT * FROM media_project_clips WHERE project_id = ? AND clip_id = ? LIMIT 1",
            (project_id, source_clip_id),
        ).fetchone()
        if not source:
            raise KeyError("media clip not found")
        start_ms = int(source["start_ms"] or 0)
        duration_ms = max(int(source["duration_ms"] or 1), 1)
        end_ms = start_ms + duration_ms
        split_ms = int(payload.get("split_ms", payload.get("playhead_ms", 0)) or 0)
        if split_ms <= start_ms or split_ms >= end_ms:
            raise ValueError("split point must be inside the clip")
        left_duration_ms = max(split_ms - start_ms, 1)
        right_duration_ms = max(end_ms - split_ms, 1)
        source_in_ms = int(source["source_in_ms"] or 0)
        source_out_ms = int(source["source_out_ms"] or 0)
        right_source_in_ms = source_in_ms + left_duration_ms if source_in_ms or source_out_ms else source_in_ms
        left_source_out_ms = right_source_in_ms if source_in_ms or source_out_ms else source_out_ms
        params = load_media_project_json(source["params_json"], default={})
        conn.execute(
            """
            UPDATE media_project_clips
            SET duration_ms = ?, source_out_ms = ?, updated_at = CURRENT_TIMESTAMP
            WHERE project_id = ? AND clip_id = ?
            """,
            (left_duration_ms, left_source_out_ms, project_id, source_clip_id),
        )
        right_clip_id = f"clip_{uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO media_project_clips (
                clip_id, project_id, track_id, asset_id, kind, start_ms, duration_ms,
                source_in_ms, source_out_ms, z_index, params_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (
                right_clip_id,
                project_id,
                source["track_id"],
                source["asset_id"],
                source["kind"],
                split_ms,
                right_duration_ms,
                right_source_in_ms,
                source_out_ms,
                source["z_index"],
                dump_media_project_json(params),
            ),
        )
        left_row = conn.execute("SELECT * FROM media_project_clips WHERE clip_id = ? LIMIT 1", (source_clip_id,)).fetchone()
        right_row = conn.execute("SELECT * FROM media_project_clips WHERE clip_id = ? LIMIT 1", (right_clip_id,)).fetchone()
        return {"left_clip": self._media_project_clip_row_to_dict(left_row), "right_clip": self._media_project_clip_row_to_dict(right_row)}

    def _apply_update_clip(self, conn, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        clip_id = str(payload.get("clip_id") or "").strip()
        existing = conn.execute(
            "SELECT * FROM media_project_clips WHERE project_id = ? AND clip_id = ? LIMIT 1",
            (project_id, clip_id),
        ).fetchone()
        if not existing:
            raise KeyError("media clip not found")
        start_ms = max(int(payload.get("start_ms", existing["start_ms"]) or 0), 0)
        duration_ms = max(int(payload.get("duration_ms", existing["duration_ms"]) or 1), 1)
        source_in_ms = max(int(payload.get("source_in_ms", existing["source_in_ms"]) or 0), 0)
        source_out_ms = max(int(payload.get("source_out_ms", existing["source_out_ms"]) or 0), 0)
        params = load_media_project_json(existing["params_json"], default={})
        if isinstance(payload.get("params"), dict):
            params.update(payload["params"])
        if "text" in payload:
            params["text"] = str(payload.get("text") or "")
        conn.execute(
            """
            UPDATE media_project_clips
            SET start_ms = ?, duration_ms = ?, source_in_ms = ?, source_out_ms = ?, params_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE project_id = ? AND clip_id = ?
            """,
            (start_ms, duration_ms, source_in_ms, source_out_ms, dump_media_project_json(params), project_id, clip_id),
        )
        row = conn.execute("SELECT * FROM media_project_clips WHERE clip_id = ? LIMIT 1", (clip_id,)).fetchone()
        return {"clip": self._media_project_clip_row_to_dict(row)}

    def _apply_delete_clip(self, conn, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        clip_id = str(payload.get("clip_id") or "").strip()
        existing = conn.execute(
            "SELECT clip_id FROM media_project_clips WHERE project_id = ? AND clip_id = ? LIMIT 1",
            (project_id, clip_id),
        ).fetchone()
        if not existing:
            raise KeyError("media clip not found")
        conn.execute("DELETE FROM media_project_clips WHERE project_id = ? AND clip_id = ?", (project_id, clip_id))
        return {"deleted_clip_id": clip_id}

    def _refresh_media_project_duration(self, conn, project_id: str) -> None:
        row = conn.execute(
            "SELECT COALESCE(MAX(start_ms + duration_ms), 0) AS duration_ms FROM media_project_clips WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        duration_ms = int((row["duration_ms"] if row else 0) or 0)
        conn.execute(
            "UPDATE media_projects SET duration_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?",
            (duration_ms, project_id),
        )

    def _media_project_row_to_dict(self, row) -> dict[str, Any]:
        return {
            "project_id": str(row["project_id"]),
            "user_id": str(row["user_id"]),
            "chat_id": int(row["chat_id"]),
            "title": str(row["title"] or ""),
            "aspect_ratio": str(row["aspect_ratio"] or DEFAULT_PROJECT_ASPECT_RATIO),
            "resolution": load_media_project_json(row["resolution_json"], default=dict(DEFAULT_PROJECT_RESOLUTION)),
            "fps": int(row["fps"] or DEFAULT_PROJECT_FPS),
            "duration_ms": int(row["duration_ms"] or 0),
            "status": str(row["status"] or "draft"),
            "metadata": load_media_project_json(row["metadata_json"], default={}),
            "created_at": str(row["created_at"] or ""),
            "updated_at": str(row["updated_at"] or ""),
        }

    def _media_project_track_row_to_dict(self, row) -> dict[str, Any]:
        return {
            "track_id": str(row["track_id"]),
            "project_id": str(row["project_id"]),
            "kind": str(row["kind"]),
            "position": int(row["position"] or 0),
            "label": str(row["label"] or ""),
            "created_at": str(row["created_at"] or ""),
            "updated_at": str(row["updated_at"] or ""),
        }

    def _media_project_asset_row_to_dict(self, row) -> dict[str, Any]:
        return {
            "asset_id": str(row["asset_id"]),
            "project_id": str(row["project_id"]),
            "kind": str(row["kind"]),
            "storage_path": str(row["storage_path"] or ""),
            "content_type": str(row["content_type"] or ""),
            "label": str(row["label"] or ""),
            "metadata": load_media_project_json(row["metadata_json"], default={}),
            "created_at": str(row["created_at"] or ""),
            "updated_at": str(row["updated_at"] or ""),
        }

    def _media_project_clip_row_to_dict(self, row) -> dict[str, Any]:
        return {
            "clip_id": str(row["clip_id"]),
            "project_id": str(row["project_id"]),
            "track_id": str(row["track_id"]),
            "asset_id": str(row["asset_id"] or ""),
            "kind": str(row["kind"] or "asset"),
            "start_ms": int(row["start_ms"] or 0),
            "duration_ms": int(row["duration_ms"] or 0),
            "source_in_ms": int(row["source_in_ms"] or 0),
            "source_out_ms": int(row["source_out_ms"] or 0),
            "z_index": int(row["z_index"] or 0),
            "params": load_media_project_json(row["params_json"], default={}),
            "created_at": str(row["created_at"] or ""),
            "updated_at": str(row["updated_at"] or ""),
        }

    def _media_project_operation_row_to_dict(self, row) -> dict[str, Any]:
        return {
            "operation_id": str(row["operation_id"]),
            "project_id": str(row["project_id"]),
            "batch_id": str(row["batch_id"] or ""),
            "author": str(row["author"] or "user"),
            "kind": str(row["kind"] or ""),
            "status": str(row["status"] or "applied"),
            "payload": load_media_project_json(row["payload_json"], default={}),
            "before_state": load_media_project_json(row["before_state_json"], default={}),
            "after_state": load_media_project_json(row["after_state_json"], default={}),
            "created_at": str(row["created_at"] or ""),
        }

    def _media_project_suggestion_batch_row_to_dict(self, row) -> dict[str, Any]:
        return {
            "batch_id": str(row["batch_id"]),
            "project_id": str(row["project_id"]),
            "author": str(row["author"] or "hermes"),
            "status": str(row["status"] or "pending"),
            "summary": str(row["summary"] or ""),
            "operations": load_media_project_json(row["operations_json"], default=[]),
            "created_at": str(row["created_at"] or ""),
            "updated_at": str(row["updated_at"] or ""),
        }

    def _media_project_export_job_row_to_dict(self, row) -> dict[str, Any]:
        return {
            "export_job_id": str(row["export_job_id"]),
            "project_id": str(row["project_id"]),
            "status": str(row["status"] or "queued"),
            "output_path": str(row["output_path"] or ""),
            "metadata": load_media_project_json(row["metadata_json"], default={}),
            "created_at": str(row["created_at"] or ""),
            "updated_at": str(row["updated_at"] or ""),
        }
