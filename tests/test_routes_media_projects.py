from __future__ import annotations

from server_test_utils import load_server, patch_verified_user


def _media_project_client(monkeypatch, tmp_path):
    server = load_server(monkeypatch, tmp_path, max_title_len=80)
    client = server.app.test_client()
    patch_verified_user(monkeypatch, server)
    return server, client


def test_media_project_chat_bootstrap_route_returns_project_payload(monkeypatch, tmp_path) -> None:
    server, client = _media_project_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")
    server.store.rename_chat("123", chat_id, "[feat]Video editor")

    response = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["project"]["chat_id"] == chat_id
    assert payload["project"]["title"] == "[feat]Video editor"
    assert payload["project"]["aspect_ratio"] == "9:16"
    assert [track["kind"] for track in payload["tracks"]] == ["visual", "text", "audio"]
    assert payload["assets"] == []
    assert payload["clips"] == []
    assert payload["suggestion_batches"] == []
    assert payload["export_jobs"] == []


def test_media_project_export_route_creates_completed_job(monkeypatch, tmp_path) -> None:
    server, client = _media_project_client(monkeypatch, tmp_path)
    server.app.instance_path = str(tmp_path / "instance")
    chat_id = server.store.ensure_default_chat("123")
    project_payload = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"}).get_json()
    project_id = project_payload["project"]["project_id"]
    text_track = next(track for track in project_payload["tracks"] if track["kind"] == "text")
    client.post(
        f"/api/media-projects/{project_id}/operations",
        json={
            "init_data": "ok",
            "kind": "create_text_clip",
            "payload": {"track_id": text_track["track_id"], "text": "Export title", "start_ms": 0, "duration_ms": 1000},
        },
    )
    rendered = {}

    def fake_render(*, project, tracks, assets, clips, output_path, instance_path):
        rendered["project_id"] = project["project_id"]
        rendered["clips"] = clips
        output_path.write_bytes(b"fake mp4")
        return {"duration_ms": project["duration_ms"], "renderer": "fake"}

    import routes_media_projects

    monkeypatch.setattr(routes_media_projects, "render_media_project_to_mp4", fake_render)

    response = client.post(f"/api/media-projects/{project_id}/exports", json={"init_data": "ok"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["export_job"]["status"] == "completed"
    assert payload["export_job"]["output_path"].endswith("/output.mp4")
    assert payload["export_job"]["metadata"]["renderer"] == "fake"
    assert payload["export_jobs"][0]["export_job_id"] == payload["export_job"]["export_job_id"]
    assert rendered["project_id"] == project_id
    assert rendered["clips"][0]["params"]["text"] == "Export title"

    output_response = client.get(payload["export_job"]["output_path"], query_string={"init_data": "ok"})
    assert output_response.status_code == 200
    assert output_response.data == b"fake mp4"


def test_media_project_chat_bootstrap_route_reuses_existing_project(monkeypatch, tmp_path) -> None:
    server, client = _media_project_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")

    first = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"})
    second = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.get_json()["project"]["project_id"] == second.get_json()["project"]["project_id"]


def test_media_project_operation_route_persists_text_clip(monkeypatch, tmp_path) -> None:
    server, client = _media_project_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")
    project_payload = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"}).get_json()
    project_id = project_payload["project"]["project_id"]
    text_track = next(track for track in project_payload["tracks"] if track["kind"] == "text")

    response = client.post(
        f"/api/media-projects/{project_id}/operations",
        json={
            "init_data": "ok",
            "kind": "create_text_clip",
            "payload": {"track_id": text_track["track_id"], "text": "First title", "start_ms": 0, "duration_ms": 1800},
        },
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["operation"]["kind"] == "create_text_clip"
    assert payload["clips"][0]["params"]["text"] == "First title"
    assert payload["project"]["duration_ms"] == 1800

    reload_response = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"})
    assert reload_response.get_json()["clips"][0]["params"]["text"] == "First title"


def test_media_project_upload_image_asset_route_creates_visual_clip(monkeypatch, tmp_path) -> None:
    from io import BytesIO

    server, client = _media_project_client(monkeypatch, tmp_path)
    server.app.instance_path = str(tmp_path / "instance")
    chat_id = server.store.ensure_default_chat("123")
    project_payload = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"}).get_json()
    project_id = project_payload["project"]["project_id"]
    visual_track = next(track for track in project_payload["tracks"] if track["kind"] == "visual")

    response = client.post(
        f"/api/media-projects/{project_id}/image-assets",
        data={
            "init_data": "ok",
            "track_id": visual_track["track_id"],
            "start_ms": "750",
            "duration_ms": "2250",
            "file": (BytesIO(b"\x89PNG\r\n\x1a\n" + b"png-body"), "opening still.png"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["asset"]["kind"] == "image"
    assert payload["asset"]["content_type"] == "image/png"
    assert payload["asset"]["label"] == "opening still.png"
    assert payload["asset"]["storage_path"].startswith(f"/api/media-projects/{project_id}/uploaded-assets/")
    assert payload["clip"]["kind"] == "image"
    assert payload["clip"]["track_id"] == visual_track["track_id"]
    assert payload["clip"]["start_ms"] == 750
    assert payload["clip"]["duration_ms"] == 2250
    assert payload["operation"]["kind"] == "create_image_clip"
    assert payload["assets"][0]["asset_id"] == payload["asset"]["asset_id"]
    assert payload["clips"][0]["clip_id"] == payload["clip"]["clip_id"]

    uploaded = tmp_path / "instance" / "media_project_uploads" / project_id
    assert any(path.name.endswith("opening-still.png") for path in uploaded.iterdir())


def test_media_project_upload_image_asset_route_rejects_non_image(monkeypatch, tmp_path) -> None:
    from io import BytesIO

    server, client = _media_project_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")
    project_payload = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"}).get_json()
    project_id = project_payload["project"]["project_id"]
    visual_track = next(track for track in project_payload["tracks"] if track["kind"] == "visual")

    response = client.post(
        f"/api/media-projects/{project_id}/image-assets",
        data={
            "init_data": "ok",
            "track_id": visual_track["track_id"],
            "file": (BytesIO(b"not an image"), "notes.txt"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert "image" in response.get_json()["error"]


def test_media_project_upload_video_asset_route_creates_visual_clip(monkeypatch, tmp_path) -> None:
    from io import BytesIO

    server, client = _media_project_client(monkeypatch, tmp_path)
    server.app.instance_path = str(tmp_path / "instance")
    chat_id = server.store.ensure_default_chat("123")
    project_payload = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"}).get_json()
    project_id = project_payload["project"]["project_id"]
    visual_track = next(track for track in project_payload["tracks"] if track["kind"] == "visual")

    response = client.post(
        f"/api/media-projects/{project_id}/video-assets",
        data={
            "init_data": "ok",
            "track_id": visual_track["track_id"],
            "start_ms": "500",
            "duration_ms": "2500",
            "file": (BytesIO(b"\x00\x00\x00ftypisom" + b"video-body"), "opening shot.mp4"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["asset"]["kind"] == "video"
    assert payload["asset"]["content_type"] == "video/mp4"
    assert payload["asset"]["label"] == "opening shot.mp4"
    assert payload["asset"]["storage_path"].startswith(f"/api/media-projects/{project_id}/uploaded-assets/")
    assert payload["clip"]["kind"] == "video"
    assert payload["clip"]["track_id"] == visual_track["track_id"]
    assert payload["clip"]["start_ms"] == 500
    assert payload["clip"]["duration_ms"] == 2500
    assert payload["operation"]["kind"] == "create_video_clip"


def test_media_project_upload_video_asset_route_rejects_non_video(monkeypatch, tmp_path) -> None:
    from io import BytesIO

    server, client = _media_project_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")
    project_payload = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"}).get_json()
    project_id = project_payload["project"]["project_id"]
    visual_track = next(track for track in project_payload["tracks"] if track["kind"] == "visual")

    response = client.post(
        f"/api/media-projects/{project_id}/video-assets",
        data={
            "init_data": "ok",
            "track_id": visual_track["track_id"],
            "file": (BytesIO(b"not a video"), "notes.txt"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert "video" in response.get_json()["error"]


def test_media_project_uploaded_asset_requires_project_owner_auth(monkeypatch, tmp_path) -> None:
    from io import BytesIO
    from types import SimpleNamespace

    server, client = _media_project_client(monkeypatch, tmp_path)
    monkeypatch.setattr(
        server,
        "_verify_from_payload",
        lambda payload: SimpleNamespace(user=SimpleNamespace(id=123, first_name="Test", username="test"))
        if payload.get("init_data") == "ok"
        else (_ for _ in ()).throw(server.TelegramAuthError("Missing Telegram init data.")),
    )
    server.app.instance_path = str(tmp_path / "instance")
    chat_id = server.store.ensure_default_chat("123")
    project_payload = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"}).get_json()
    project_id = project_payload["project"]["project_id"]
    visual_track = next(track for track in project_payload["tracks"] if track["kind"] == "visual")
    upload_response = client.post(
        f"/api/media-projects/{project_id}/image-assets",
        data={
            "init_data": "ok",
            "track_id": visual_track["track_id"],
            "file": (BytesIO(b"\x89PNG\r\n\x1a\n" + b"png-body"), "owner.png"),
        },
        content_type="multipart/form-data",
    )
    storage_path = upload_response.get_json()["asset"]["storage_path"]

    unauthenticated = client.get(storage_path)
    authenticated = client.get(storage_path, query_string={"init_data": "ok"})

    assert unauthenticated.status_code == 401
    assert authenticated.status_code == 200
    assert authenticated.data.startswith(b"\x89PNG")


def test_media_project_uploaded_asset_rejects_invalid_project_path(monkeypatch, tmp_path) -> None:
    server, client = _media_project_client(monkeypatch, tmp_path)
    server.app.instance_path = str(tmp_path / "instance")

    response = client.get("/api/media-projects/../uploaded-assets/config.py", query_string={"init_data": "ok"})

    assert response.status_code in {400, 404}


def test_media_project_suggestion_batch_routes_accept_and_reject(monkeypatch, tmp_path) -> None:
    server, client = _media_project_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")
    project_payload = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"}).get_json()
    project_id = project_payload["project"]["project_id"]
    text_track = next(track for track in project_payload["tracks"] if track["kind"] == "text")

    create_response = client.post(
        f"/api/media-projects/{project_id}/suggestion-batches",
        json={
            "init_data": "ok",
            "summary": "Add a hook title",
            "operations": [
                {
                    "kind": "create_text_clip",
                    "payload": {
                        "track_id": text_track["track_id"],
                        "text": "Hermes hook",
                        "start_ms": 0,
                        "duration_ms": 1200,
                    },
                }
            ],
        },
    )

    assert create_response.status_code == 200
    created = create_response.get_json()
    batch_id = created["suggestion_batch"]["batch_id"]
    assert created["suggestion_batch"]["status"] == "pending"
    assert created["suggestion_batches"][0]["summary"] == "Add a hook title"

    accept_response = client.post(
        f"/api/media-projects/{project_id}/suggestion-batches/{batch_id}/accept",
        json={"init_data": "ok"},
    )

    assert accept_response.status_code == 200
    accepted = accept_response.get_json()
    assert accepted["suggestion_batch"]["status"] == "accepted"
    assert accepted["clips"][0]["params"]["text"] == "Hermes hook"
    assert accepted["suggestion_batches"][0]["status"] == "accepted"

    reject_create = client.post(
        f"/api/media-projects/{project_id}/suggestion-batches",
        json={
            "init_data": "ok",
            "summary": "Rejected edit",
            "operations": [
                {"kind": "create_text_clip", "payload": {"track_id": text_track["track_id"], "text": "Nope"}}
            ],
        },
    ).get_json()
    reject_batch_id = reject_create["suggestion_batch"]["batch_id"]

    reject_response = client.post(
        f"/api/media-projects/{project_id}/suggestion-batches/{reject_batch_id}/reject",
        json={"init_data": "ok"},
    )

    assert reject_response.status_code == 200
    rejected = reject_response.get_json()
    assert rejected["suggestion_batch"]["status"] == "rejected"
    assert [clip["params"]["text"] for clip in rejected["clips"]] == ["Hermes hook"]


def test_media_project_undo_redo_routes_restore_timeline_state(monkeypatch, tmp_path) -> None:
    server, client = _media_project_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")
    project_payload = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"}).get_json()
    project_id = project_payload["project"]["project_id"]
    text_track = next(track for track in project_payload["tracks"] if track["kind"] == "text")
    create_payload = client.post(
        f"/api/media-projects/{project_id}/operations",
        json={
            "init_data": "ok",
            "kind": "create_text_clip",
            "payload": {"track_id": text_track["track_id"], "text": "Undo route", "start_ms": 0, "duration_ms": 1000},
        },
    ).get_json()
    clip_id = create_payload["clip"]["clip_id"]
    client.post(
        f"/api/media-projects/{project_id}/operations",
        json={
            "init_data": "ok",
            "kind": "update_clip",
            "payload": {"clip_id": clip_id, "start_ms": 500, "duration_ms": 1500, "params": {"text": "Updated route"}},
        },
    )

    undo_response = client.post(f"/api/media-projects/{project_id}/undo", json={"init_data": "ok"})

    assert undo_response.status_code == 200
    undo_payload = undo_response.get_json()
    assert undo_payload["operation"]["status"] == "undone"
    assert undo_payload["clips"][0]["params"]["text"] == "Undo route"
    assert undo_payload["clips"][0]["start_ms"] == 0

    redo_response = client.post(f"/api/media-projects/{project_id}/redo", json={"init_data": "ok"})

    assert redo_response.status_code == 200
    redo_payload = redo_response.get_json()
    assert redo_payload["operation"]["status"] == "applied"
    assert redo_payload["clips"][0]["params"]["text"] == "Updated route"
    assert redo_payload["clips"][0]["start_ms"] == 500



def test_media_project_upload_audio_asset_route_creates_audio_clip(monkeypatch, tmp_path) -> None:
    from io import BytesIO

    server, client = _media_project_client(monkeypatch, tmp_path)
    server.app.instance_path = str(tmp_path / "instance")
    chat_id = server.store.ensure_default_chat("123")
    project_payload = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"}).get_json()
    project_id = project_payload["project"]["project_id"]
    audio_track = next(track for track in project_payload["tracks"] if track["kind"] == "audio")

    response = client.post(
        f"/api/media-projects/{project_id}/audio-assets",
        data={
            "init_data": "ok",
            "track_id": audio_track["track_id"],
            "start_ms": "1250",
            "duration_ms": "4000",
            "gain": "0.42",
            "file": (BytesIO(b"ID3" + b"\x00" * 32), "music bed.mp3"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["asset"]["kind"] == "audio"
    assert payload["asset"]["content_type"] == "audio/mpeg"
    assert payload["asset"]["label"] == "music bed.mp3"
    assert payload["asset"]["storage_path"].startswith(f"/api/media-projects/{project_id}/uploaded-assets/")
    assert payload["clip"]["kind"] == "audio"
    assert payload["clip"]["track_id"] == audio_track["track_id"]
    assert payload["clip"]["start_ms"] == 1250
    assert payload["clip"]["duration_ms"] == 4000
    assert payload["clip"]["params"] == {"gain": 0.42}
    assert payload["operation"]["kind"] == "create_audio_clip"
    uploaded = tmp_path / "instance" / "media_project_uploads" / project_id
    assert any(path.name.endswith("music-bed.mp3") for path in uploaded.iterdir())


def test_media_project_upload_audio_asset_route_rejects_non_audio(monkeypatch, tmp_path) -> None:
    from io import BytesIO

    server, client = _media_project_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")
    project_payload = client.get(f"/api/media-projects/chat/{chat_id}", query_string={"init_data": "ok"}).get_json()
    project_id = project_payload["project"]["project_id"]
    audio_track = next(track for track in project_payload["tracks"] if track["kind"] == "audio")

    response = client.post(
        f"/api/media-projects/{project_id}/audio-assets",
        data={"init_data": "ok", "track_id": audio_track["track_id"], "file": (BytesIO(b"not audio"), "notes.txt")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert "audio" in response.get_json()["error"]
