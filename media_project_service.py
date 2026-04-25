from __future__ import annotations

from typing import Any, Callable


class MediaProjectService:
    def __init__(self, *, store_getter: Callable[[], Any]) -> None:
        self._store_getter = store_getter

    def chat_project_payload(self, *, user_id: str, chat_id: int) -> dict[str, object]:
        store = self._store_getter()
        chat = store.get_chat(user_id, chat_id)
        project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title=chat.title)
        return self.project_state_payload(project_id=str(project["project_id"]), store=store)

    def project_state_payload(self, *, project_id: str, store: Any | None = None) -> dict[str, object]:
        resolved_store = store or self._store_getter()
        project = resolved_store.get_media_project(project_id)
        if not project:
            raise KeyError("media project not found")
        return {
            "ok": True,
            "project": project,
            "tracks": resolved_store.list_media_project_tracks(project_id),
            "assets": resolved_store.list_media_project_assets(project_id),
            "clips": resolved_store.list_media_project_clips(project_id),
            "suggestion_batches": resolved_store.list_media_project_suggestion_batches(project_id),
            "export_jobs": resolved_store.list_media_project_export_jobs(project_id),
        }

    def apply_operation_payload(
        self,
        *,
        user_id: str,
        project_id: str,
        kind: str,
        payload: dict[str, Any] | None,
        author: str = "user",
    ) -> dict[str, object]:
        store = self._store_getter()
        self._project_for_user_or_404(store=store, user_id=user_id, project_id=project_id)
        operation_result = store.apply_media_project_operation(
            project_id=project_id,
            author=author,
            kind=kind,
            payload=payload or {},
        )
        state = self.project_state_payload(project_id=project_id, store=store)
        state["operation"] = operation_result["operation"]
        for key in ("asset", "clip", "deleted_clip_id"):
            if key in operation_result:
                state[key] = operation_result[key]
        return state

    def create_suggestion_batch_payload(
        self,
        *,
        user_id: str,
        project_id: str,
        summary: str,
        operations: list[dict[str, Any]],
        author: str = "hermes",
    ) -> dict[str, object]:
        store = self._store_getter()
        self._project_for_user_or_404(store=store, user_id=user_id, project_id=project_id)
        batch = store.create_media_project_suggestion_batch(
            project_id=project_id,
            author=author,
            summary=summary,
            operations=operations,
        )
        state = self.project_state_payload(project_id=project_id, store=store)
        state["suggestion_batch"] = batch
        return state

    def accept_suggestion_batch_payload(self, *, user_id: str, project_id: str, batch_id: str) -> dict[str, object]:
        store = self._store_getter()
        self._project_for_user_or_404(store=store, user_id=user_id, project_id=project_id)
        batch = store.accept_media_project_suggestion_batch(project_id=project_id, batch_id=batch_id)
        state = self.project_state_payload(project_id=project_id, store=store)
        state["suggestion_batch"] = batch
        return state

    def reject_suggestion_batch_payload(self, *, user_id: str, project_id: str, batch_id: str) -> dict[str, object]:
        store = self._store_getter()
        self._project_for_user_or_404(store=store, user_id=user_id, project_id=project_id)
        batch = store.reject_media_project_suggestion_batch(project_id=project_id, batch_id=batch_id)
        state = self.project_state_payload(project_id=project_id, store=store)
        state["suggestion_batch"] = batch
        return state

    def undo_operation_payload(self, *, user_id: str, project_id: str) -> dict[str, object]:
        store = self._store_getter()
        self._project_for_user_or_404(store=store, user_id=user_id, project_id=project_id)
        undo_result = store.undo_media_project_operation(project_id=project_id)
        state = self.project_state_payload(project_id=project_id, store=store)
        state["operation"] = undo_result["operation"]
        return state

    def redo_operation_payload(self, *, user_id: str, project_id: str) -> dict[str, object]:
        store = self._store_getter()
        self._project_for_user_or_404(store=store, user_id=user_id, project_id=project_id)
        redo_result = store.redo_media_project_operation(project_id=project_id)
        state = self.project_state_payload(project_id=project_id, store=store)
        state["operation"] = redo_result["operation"]
        return state

    def create_export_job_payload(self, *, user_id: str, project_id: str, metadata: dict[str, Any] | None = None) -> dict[str, object]:
        store = self._store_getter()
        self._project_for_user_or_404(store=store, user_id=user_id, project_id=project_id)
        export_job = store.create_media_project_export_job(
            project_id=project_id,
            status="rendering",
            metadata=metadata if isinstance(metadata, dict) else {"format": "mp4"},
        )
        state = self.project_state_payload(project_id=project_id, store=store)
        state["export_job"] = export_job
        return state

    def update_export_job_payload(
        self,
        *,
        user_id: str,
        project_id: str,
        export_job_id: str,
        status: str,
        output_path: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, object]:
        store = self._store_getter()
        self._project_for_user_or_404(store=store, user_id=user_id, project_id=project_id)
        export_job = store.update_media_project_export_job(
            project_id=project_id,
            export_job_id=export_job_id,
            status=status,
            output_path=output_path,
            metadata=metadata,
        )
        state = self.project_state_payload(project_id=project_id, store=store)
        state["export_job"] = export_job
        return state

    def _project_for_user_or_404(self, *, store: Any, user_id: str, project_id: str) -> dict[str, object]:
        project = store.get_media_project(project_id)
        if not project:
            raise KeyError("media project not found")
        if str(project.get("user_id")) != str(user_id):
            raise KeyError("media project not found")
        return project


def build_media_project_service(*, store_getter: Callable[[], Any]) -> MediaProjectService:
    return MediaProjectService(store_getter=store_getter)
