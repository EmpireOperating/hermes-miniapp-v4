from __future__ import annotations

import sqlite3

from store import SessionStore


def _store(tmp_path) -> SessionStore:
    return SessionStore(tmp_path / "sessions.db")


def test_store_init_creates_media_project_tables_and_indexes(tmp_path) -> None:
    db_path = tmp_path / "sessions.db"

    SessionStore(db_path)

    conn = sqlite3.connect(db_path)
    table_names = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'media_project%'"
        ).fetchall()
    }
    project_columns = {row[1] for row in conn.execute("PRAGMA table_info(media_projects)").fetchall()}
    track_columns = {row[1] for row in conn.execute("PRAGMA table_info(media_project_tracks)").fetchall()}
    clip_columns = {row[1] for row in conn.execute("PRAGMA table_info(media_project_clips)").fetchall()}
    project_indexes = {row[1] for row in conn.execute("PRAGMA index_list('media_projects')").fetchall()}
    conn.close()

    assert table_names == {
        "media_project_assets",
        "media_project_clips",
        "media_project_export_jobs",
        "media_project_operations",
        "media_project_suggestion_batches",
        "media_project_tracks",
        "media_projects",
    }
    assert {
        "project_id",
        "user_id",
        "chat_id",
        "title",
        "aspect_ratio",
        "resolution_json",
        "fps",
        "duration_ms",
        "status",
        "metadata_json",
        "created_at",
        "updated_at",
    }.issubset(project_columns)
    assert {"track_id", "project_id", "kind", "position", "label", "created_at", "updated_at"}.issubset(track_columns)
    assert {
        "clip_id",
        "project_id",
        "track_id",
        "asset_id",
        "kind",
        "start_ms",
        "duration_ms",
        "source_in_ms",
        "source_out_ms",
        "z_index",
        "params_json",
    }.issubset(clip_columns)
    assert "idx_media_projects_user_chat" in project_indexes


def test_media_project_export_jobs_track_status_and_output(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Export draft")

    job = store.create_media_project_export_job(
        project_id=project["project_id"],
        status="rendering",
        metadata={"format": "mp4"},
    )

    assert job["status"] == "rendering"
    assert job["metadata"]["format"] == "mp4"
    assert job["output_path"] == ""

    completed = store.update_media_project_export_job(
        project_id=project["project_id"],
        export_job_id=job["export_job_id"],
        status="completed",
        output_path="/api/media-projects/proj/export-jobs/job/output.mp4",
        metadata={"format": "mp4", "duration_ms": 2000},
    )

    assert completed["export_job_id"] == job["export_job_id"]
    assert completed["status"] == "completed"
    assert completed["output_path"].endswith("output.mp4")
    assert completed["metadata"]["duration_ms"] == 2000
    assert store.list_media_project_export_jobs(project["project_id"])[0]["export_job_id"] == job["export_job_id"]


def test_ensure_media_project_for_chat_bootstraps_default_tracks(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)

    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    tracks = store.list_media_project_tracks(project["project_id"])

    assert project["chat_id"] == chat_id
    assert project["title"] == "Video editor"
    assert project["aspect_ratio"] == "9:16"
    assert project["resolution"] == {"width": 1080, "height": 1920}
    assert [track["kind"] for track in tracks] == ["visual", "text", "audio"]
    assert [track["label"] for track in tracks] == ["Visual", "Text", "Audio"]

    same_project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Ignored rename")
    assert same_project["project_id"] == project["project_id"]



def test_apply_media_project_operations_create_update_delete_text_clip(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    text_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "text")

    create_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_text_clip",
        payload={
            "track_id": text_track["track_id"],
            "text": "Opening hook",
            "start_ms": 500,
            "duration_ms": 2500,
        },
    )
    created_clip = create_result["clip"]

    assert created_clip["kind"] == "text"
    assert created_clip["track_id"] == text_track["track_id"]
    assert created_clip["start_ms"] == 500
    assert created_clip["duration_ms"] == 2500
    assert created_clip["params"]["text"] == "Opening hook"
    assert store.get_media_project(project["project_id"])["duration_ms"] == 3000

    update_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="update_clip",
        payload={
            "clip_id": created_clip["clip_id"],
            "start_ms": 1000,
            "duration_ms": 3000,
            "source_in_ms": 250,
            "source_out_ms": 3250,
            "params": {"text": "Punchier hook", "font_size": 72},
        },
    )

    assert update_result["clip"]["start_ms"] == 1000
    assert update_result["clip"]["duration_ms"] == 3000
    assert update_result["clip"]["source_in_ms"] == 250
    assert update_result["clip"]["source_out_ms"] == 3250
    assert update_result["clip"]["params"] == {"text": "Punchier hook", "font_size": 72}
    assert store.get_media_project(project["project_id"])["duration_ms"] == 4000

    delete_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="delete_clip",
        payload={"clip_id": created_clip["clip_id"]},
    )

    assert delete_result["deleted_clip_id"] == created_clip["clip_id"]
    assert store.list_media_project_clips(project["project_id"]) == []
    assert [operation["kind"] for operation in store.list_media_project_operations(project["project_id"])] == [
        "delete_clip",
        "update_clip",
        "create_text_clip",
    ]


def test_apply_media_project_operation_create_image_clip_imports_asset_on_visual_track(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    visual_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "visual")

    create_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_image_clip",
        payload={
            "track_id": visual_track["track_id"],
            "storage_path": "https://example.test/shot-01.png",
            "content_type": "image/png",
            "label": "Opening still",
            "start_ms": 1000,
            "duration_ms": 2500,
            "params": {"fit": "cover"},
        },
    )

    created_asset = create_result["asset"]
    created_clip = create_result["clip"]
    assert created_asset["kind"] == "image"
    assert created_asset["storage_path"] == "https://example.test/shot-01.png"
    assert created_asset["content_type"] == "image/png"
    assert created_asset["label"] == "Opening still"
    assert created_clip["kind"] == "image"
    assert created_clip["asset_id"] == created_asset["asset_id"]
    assert created_clip["track_id"] == visual_track["track_id"]
    assert created_clip["start_ms"] == 1000
    assert created_clip["duration_ms"] == 2500
    assert created_clip["params"] == {"fit": "cover"}
    assert store.list_media_project_assets(project["project_id"])[0]["asset_id"] == created_asset["asset_id"]
    assert store.get_media_project(project["project_id"])["duration_ms"] == 3500
    assert store.list_media_project_operations(project["project_id"])[0]["kind"] == "create_image_clip"


def test_apply_media_project_operation_create_clip_from_existing_asset_reuses_image_asset(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    visual_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "visual")
    create_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_image_clip",
        payload={
            "track_id": visual_track["track_id"],
            "storage_path": "/api/media-projects/proj/uploaded-assets/opening.png",
            "content_type": "image/png",
            "label": "Opening still",
            "start_ms": 0,
            "duration_ms": 2000,
        },
    )
    original_asset_id = create_result["asset"]["asset_id"]

    reuse_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_clip_from_asset",
        payload={
            "track_id": visual_track["track_id"],
            "asset_id": original_asset_id,
            "start_ms": 2500,
            "duration_ms": 1500,
            "params": {"fit": "contain"},
        },
    )

    assert reuse_result["asset"]["asset_id"] == original_asset_id
    assert reuse_result["clip"]["kind"] == "image"
    assert reuse_result["clip"]["asset_id"] == original_asset_id
    assert reuse_result["clip"]["track_id"] == visual_track["track_id"]
    assert reuse_result["clip"]["start_ms"] == 2500
    assert reuse_result["clip"]["duration_ms"] == 1500
    assert reuse_result["clip"]["params"] == {"fit": "contain"}
    assert len(store.list_media_project_assets(project["project_id"])) == 1
    assert store.get_media_project(project["project_id"])["duration_ms"] == 4000
    assert [operation["kind"] for operation in store.list_media_project_operations(project["project_id"])] == [
        "create_clip_from_asset",
        "create_image_clip",
    ]


def test_apply_media_project_operation_duplicate_clip_clones_timing_params_and_asset(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    visual_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "visual")
    create_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_image_clip",
        payload={
            "track_id": visual_track["track_id"],
            "storage_path": "/api/media-projects/proj/uploaded-assets/opening.png",
            "content_type": "image/png",
            "label": "Opening still",
            "start_ms": 500,
            "duration_ms": 1750,
            "params": {"fit": "contain", "opacity": 0.75},
        },
    )
    source_clip = create_result["clip"]

    duplicate_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="duplicate_clip",
        payload={"clip_id": source_clip["clip_id"], "start_ms": 3000},
    )

    duplicated_clip = duplicate_result["clip"]
    assert duplicated_clip["clip_id"] != source_clip["clip_id"]
    assert duplicated_clip["track_id"] == source_clip["track_id"]
    assert duplicated_clip["asset_id"] == source_clip["asset_id"]
    assert duplicated_clip["kind"] == "image"
    assert duplicated_clip["start_ms"] == 3000
    assert duplicated_clip["duration_ms"] == 1750
    assert duplicated_clip["params"] == {"fit": "contain", "opacity": 0.75}
    assert len(store.list_media_project_assets(project["project_id"])) == 1
    assert store.get_media_project(project["project_id"])["duration_ms"] == 4750
    assert [operation["kind"] for operation in store.list_media_project_operations(project["project_id"])] == [
        "duplicate_clip",
        "create_image_clip",
    ]


def test_apply_media_project_operation_split_clip_creates_second_half_at_playhead(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    text_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "text")
    create_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_text_clip",
        payload={
            "track_id": text_track["track_id"],
            "text": "Split me",
            "start_ms": 1000,
            "duration_ms": 3000,
            "params": {"font_size": 72},
        },
    )
    source_clip = create_result["clip"]

    split_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="split_clip",
        payload={"clip_id": source_clip["clip_id"], "split_ms": 2500},
    )

    left_clip = split_result["left_clip"]
    right_clip = split_result["right_clip"]
    assert left_clip["clip_id"] == source_clip["clip_id"]
    assert left_clip["start_ms"] == 1000
    assert left_clip["duration_ms"] == 1500
    assert left_clip["params"] == {"text": "Split me", "font_size": 72}
    assert right_clip["clip_id"] != source_clip["clip_id"]
    assert right_clip["track_id"] == source_clip["track_id"]
    assert right_clip["kind"] == "text"
    assert right_clip["start_ms"] == 2500
    assert right_clip["duration_ms"] == 1500
    assert right_clip["params"] == {"text": "Split me", "font_size": 72}
    assert store.get_media_project(project["project_id"])["duration_ms"] == 4000
    assert [operation["kind"] for operation in store.list_media_project_operations(project["project_id"])] == [
        "split_clip",
        "create_text_clip",
    ]


def test_media_project_suggestion_batch_accept_applies_operations_and_records_batch(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    text_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "text")

    batch = store.create_media_project_suggestion_batch(
        project_id=project["project_id"],
        author="hermes",
        summary="Add a hook title",
        operations=[
            {
                "kind": "create_text_clip",
                "payload": {
                    "track_id": text_track["track_id"],
                    "text": "Hermes opening hook",
                    "start_ms": 250,
                    "duration_ms": 1750,
                },
            }
        ],
    )

    assert batch["status"] == "pending"
    assert batch["summary"] == "Add a hook title"
    assert batch["operations"][0]["kind"] == "create_text_clip"

    accepted = store.accept_media_project_suggestion_batch(
        project_id=project["project_id"],
        batch_id=batch["batch_id"],
    )

    assert accepted["status"] == "accepted"
    clips = store.list_media_project_clips(project["project_id"])
    assert len(clips) == 1
    assert clips[0]["params"]["text"] == "Hermes opening hook"
    operations = store.list_media_project_operations(project["project_id"])
    assert operations[0]["batch_id"] == batch["batch_id"]
    assert operations[0]["author"] == "hermes"


def test_media_project_suggestion_batch_reject_does_not_apply_operations(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    text_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "text")
    batch = store.create_media_project_suggestion_batch(
        project_id=project["project_id"],
        author="hermes",
        summary="Add a hook title",
        operations=[
            {
                "kind": "create_text_clip",
                "payload": {"track_id": text_track["track_id"], "text": "Should not appear"},
            }
        ],
    )

    rejected = store.reject_media_project_suggestion_batch(project_id=project["project_id"], batch_id=batch["batch_id"])

    assert rejected["status"] == "rejected"
    assert store.list_media_project_clips(project["project_id"]) == []
    assert store.list_media_project_operations(project["project_id"]) == []


def test_media_project_undo_redo_restores_timeline_snapshots(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    text_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "text")

    create_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_text_clip",
        payload={
            "track_id": text_track["track_id"],
            "text": "Undo me",
            "start_ms": 0,
            "duration_ms": 2000,
        },
    )
    clip_id = create_result["clip"]["clip_id"]
    store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="update_clip",
        payload={"clip_id": clip_id, "start_ms": 1000, "duration_ms": 3000, "params": {"text": "Updated"}},
    )

    undo_update = store.undo_media_project_operation(project_id=project["project_id"])

    clips_after_first_undo = store.list_media_project_clips(project["project_id"])
    assert undo_update["operation"]["kind"] == "update_clip"
    assert undo_update["operation"]["status"] == "undone"
    assert len(clips_after_first_undo) == 1
    assert clips_after_first_undo[0]["clip_id"] == clip_id
    assert clips_after_first_undo[0]["start_ms"] == 0
    assert clips_after_first_undo[0]["duration_ms"] == 2000
    assert clips_after_first_undo[0]["params"]["text"] == "Undo me"
    assert store.get_media_project(project["project_id"])["duration_ms"] == 2000

    undo_create = store.undo_media_project_operation(project_id=project["project_id"])

    assert undo_create["operation"]["kind"] == "create_text_clip"
    assert store.list_media_project_clips(project["project_id"]) == []
    assert store.get_media_project(project["project_id"])["duration_ms"] == 0

    redo_create = store.redo_media_project_operation(project_id=project["project_id"])

    assert redo_create["operation"]["kind"] == "create_text_clip"
    assert redo_create["operation"]["status"] == "applied"
    assert store.list_media_project_clips(project["project_id"])[0]["params"]["text"] == "Undo me"

    redo_update = store.redo_media_project_operation(project_id=project["project_id"])

    assert redo_update["operation"]["kind"] == "update_clip"
    clips_after_redo = store.list_media_project_clips(project["project_id"])
    assert clips_after_redo[0]["start_ms"] == 1000
    assert clips_after_redo[0]["duration_ms"] == 3000
    assert clips_after_redo[0]["params"]["text"] == "Updated"
    assert store.get_media_project(project["project_id"])["duration_ms"] == 4000


def test_media_project_new_operation_after_undo_clears_redo_stack(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    text_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "text")

    store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_text_clip",
        payload={"track_id": text_track["track_id"], "text": "First", "start_ms": 0, "duration_ms": 1000},
    )
    store.undo_media_project_operation(project_id=project["project_id"])
    store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_text_clip",
        payload={"track_id": text_track["track_id"], "text": "Second", "start_ms": 0, "duration_ms": 1000},
    )

    try:
        store.redo_media_project_operation(project_id=project["project_id"])
    except ValueError as exc:
        assert "nothing to redo" in str(exc)
    else:
        raise AssertionError("expected redo to be unavailable after a new edit")

    assert [clip["params"]["text"] for clip in store.list_media_project_clips(project["project_id"])] == ["Second"]



def test_apply_media_project_operation_create_audio_clip_imports_asset_on_audio_track(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    audio_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "audio")

    create_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_audio_clip",
        payload={
            "track_id": audio_track["track_id"],
            "storage_path": "/api/media-projects/proj/uploaded-assets/music.mp3",
            "content_type": "audio/mpeg",
            "label": "Soft music bed",
            "start_ms": 500,
            "duration_ms": 4500,
            "params": {"gain": 0.35},
        },
    )

    created_asset = create_result["asset"]
    created_clip = create_result["clip"]
    assert created_asset["kind"] == "audio"
    assert created_asset["content_type"] == "audio/mpeg"
    assert created_asset["label"] == "Soft music bed"
    assert created_clip["kind"] == "audio"
    assert created_clip["asset_id"] == created_asset["asset_id"]
    assert created_clip["track_id"] == audio_track["track_id"]
    assert created_clip["start_ms"] == 500
    assert created_clip["duration_ms"] == 4500
    assert created_clip["params"] == {"gain": 0.35}
    assert store.get_media_project(project["project_id"])["duration_ms"] == 5000
    assert store.list_media_project_operations(project["project_id"])[0]["kind"] == "create_audio_clip"


def test_apply_media_project_operation_create_clip_from_existing_audio_asset_uses_audio_track(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    audio_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "audio")
    create_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_audio_clip",
        payload={
            "track_id": audio_track["track_id"],
            "storage_path": "/api/media-projects/proj/uploaded-assets/voice.wav",
            "content_type": "audio/wav",
            "label": "Voiceover",
            "start_ms": 0,
            "duration_ms": 2000,
        },
    )
    original_asset_id = create_result["asset"]["asset_id"]

    reuse_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_clip_from_asset",
        payload={
            "track_id": audio_track["track_id"],
            "asset_id": original_asset_id,
            "start_ms": 3000,
            "duration_ms": 1500,
            "params": {"gain": 0.8},
        },
    )

    assert reuse_result["asset"]["asset_id"] == original_asset_id
    assert reuse_result["clip"]["kind"] == "audio"
    assert reuse_result["clip"]["asset_id"] == original_asset_id
    assert reuse_result["clip"]["track_id"] == audio_track["track_id"]
    assert reuse_result["clip"]["start_ms"] == 3000
    assert reuse_result["clip"]["duration_ms"] == 1500
    assert reuse_result["clip"]["params"] == {"gain": 0.8}
    assert len(store.list_media_project_assets(project["project_id"])) == 1


def test_apply_media_project_operation_create_video_clip_imports_asset_on_visual_track(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    visual_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "visual")

    create_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_video_clip",
        payload={
            "track_id": visual_track["track_id"],
            "storage_path": "/api/media-projects/proj/uploaded-assets/shot.mp4",
            "content_type": "video/mp4",
            "label": "Opening shot",
            "start_ms": 1000,
            "duration_ms": 2500,
            "params": {"fit": "cover"},
        },
    )

    created_asset = create_result["asset"]
    created_clip = create_result["clip"]
    assert created_asset["kind"] == "video"
    assert created_asset["content_type"] == "video/mp4"
    assert created_asset["label"] == "Opening shot"
    assert created_clip["kind"] == "video"
    assert created_clip["asset_id"] == created_asset["asset_id"]
    assert created_clip["track_id"] == visual_track["track_id"]
    assert created_clip["start_ms"] == 1000
    assert created_clip["duration_ms"] == 2500
    assert created_clip["params"] == {"fit": "cover"}
    assert store.get_media_project(project["project_id"])["duration_ms"] == 3500
    assert store.list_media_project_operations(project["project_id"])[0]["kind"] == "create_video_clip"


def test_apply_media_project_operation_create_clip_from_existing_video_asset_uses_visual_track(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    visual_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "visual")
    create_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_video_clip",
        payload={
            "track_id": visual_track["track_id"],
            "storage_path": "/api/media-projects/proj/uploaded-assets/shot.webm",
            "content_type": "video/webm",
            "label": "B-roll",
            "start_ms": 0,
            "duration_ms": 2000,
        },
    )
    original_asset_id = create_result["asset"]["asset_id"]

    reuse_result = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_clip_from_asset",
        payload={
            "track_id": visual_track["track_id"],
            "asset_id": original_asset_id,
            "start_ms": 3000,
            "duration_ms": 1500,
            "params": {"fit": "contain"},
        },
    )

    assert reuse_result["asset"]["asset_id"] == original_asset_id
    assert reuse_result["clip"]["kind"] == "video"
    assert reuse_result["clip"]["asset_id"] == original_asset_id
    assert reuse_result["clip"]["track_id"] == visual_track["track_id"]
    assert reuse_result["clip"]["start_ms"] == 3000
    assert reuse_result["clip"]["duration_ms"] == 1500
    assert reuse_result["clip"]["params"] == {"fit": "contain"}
    assert len(store.list_media_project_assets(project["project_id"])) == 1


def test_accept_suggestion_batch_supersedes_undone_redo_stack(tmp_path) -> None:
    store = _store(tmp_path)
    user_id = "media-user"
    chat_id = store.ensure_default_chat(user_id)
    project = store.ensure_media_project_for_chat(user_id=user_id, chat_id=chat_id, title="Video editor")
    text_track = next(track for track in store.list_media_project_tracks(project["project_id"]) if track["kind"] == "text")
    original = store.apply_media_project_operation(
        project_id=project["project_id"],
        author="user",
        kind="create_text_clip",
        payload={"track_id": text_track["track_id"], "text": "Old draft", "start_ms": 0, "duration_ms": 1000},
    )
    store.undo_media_project_operation(project_id=project["project_id"])
    batch = store.create_media_project_suggestion_batch(
        project_id=project["project_id"],
        author="hermes",
        summary="New direction",
        operations=[{"kind": "create_text_clip", "payload": {"track_id": text_track["track_id"], "text": "Hermes draft", "start_ms": 0, "duration_ms": 1000}}],
    )

    store.accept_media_project_suggestion_batch(project_id=project["project_id"], batch_id=batch["batch_id"])

    clips = store.list_media_project_clips(project["project_id"])
    assert [clip["params"].get("text") for clip in clips] == ["Hermes draft"]
    try:
        store.redo_media_project_operation(project_id=project["project_id"])
    except ValueError as exc:
        assert "nothing to redo" in str(exc)
    else:
        raise AssertionError("redo should have been superseded after accepting a suggestion batch")
    assert [clip["params"].get("text") for clip in store.list_media_project_clips(project["project_id"])] == ["Hermes draft"]
