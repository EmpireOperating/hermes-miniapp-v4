from __future__ import annotations

import base64
from pathlib import Path

from server_test_utils import load_server, patch_verified_user


PNG_1X1_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgq8AAAAASUVORK5CYII="
)


def _visual_dev_client(monkeypatch, tmp_path, *, authed: bool = True):
    monkeypatch.setenv("MINI_APP_VISUAL_DEV_ENABLED", "1")
    monkeypatch.setenv("MINI_APP_OPERATOR_API_TOKEN", "operator-secret")
    monkeypatch.setenv("MINI_APP_VISUAL_DEV_ALLOWED_PREVIEW_ORIGINS", "https://preview.example.com")
    monkeypatch.setenv("MINI_APP_VISUAL_DEV_BRIDGE_ALLOWED_PARENTS", "https://miniapp.example.com")
    monkeypatch.setenv("MINI_APP_VISUAL_DEV_ARTIFACT_DIR", str(tmp_path / "visual-dev-artifacts"))
    server = load_server(monkeypatch, tmp_path)
    client = server.app.test_client()
    if authed:
        patch_verified_user(monkeypatch, server)
    return server, client


def _operator_headers() -> dict[str, str]:
    return {"X-Hermes-Operator-Token": "operator-secret"}


def _visual_dev_body(**payload):
    body = {"init_data": "ok"}
    body.update(payload)
    return body


def _attach_visual_dev_session(client, chat_id: int, **payload):
    body = {
        "chat_id": chat_id,
        "session_id": "session-1",
        "preview_url": "https://preview.example.com/app",
        "preview_title": "Preview title",
        "bridge_parent_origin": "https://miniapp.example.com",
    }
    body.update(payload)
    return client.post(
        "/api/visual-dev/session/attach",
        json=_visual_dev_body(**body),
        headers=_operator_headers(),
    )


def test_visual_dev_attach_state_lookup_and_detach(monkeypatch, tmp_path) -> None:
    server, client = _visual_dev_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")

    attach_response = _attach_visual_dev_session(client, chat_id, metadata={"branch": "feat/visual-dev"})

    assert attach_response.status_code == 200
    attach_payload = attach_response.get_json()
    assert attach_payload["ok"] is True
    assert attach_payload["session"]["session_id"] == "session-1"
    assert attach_payload["session"]["chat_id"] == chat_id
    assert attach_payload["session"]["preview_origin"] == "https://preview.example.com"
    assert attach_payload["session"]["runtime"]["state"] == "connecting"

    state_response = client.get("/api/visual-dev/state", query_string={"init_data": "ok"}, headers=_operator_headers())

    assert state_response.status_code == 200
    state_payload = state_response.get_json()
    assert state_payload["ok"] is True
    assert state_payload["enabled"] is True
    assert state_payload["sessions"][0]["session_id"] == "session-1"
    assert state_payload["sessions"][0]["metadata"]["branch"] == "feat/visual-dev"

    session_response = client.get(
        f"/api/visual-dev/session/{chat_id}",
        query_string={"init_data": "ok"},
        headers=_operator_headers(),
    )

    assert session_response.status_code == 200
    session_payload = session_response.get_json()
    assert session_payload["ok"] is True
    assert session_payload["session"]["session_id"] == "session-1"
    assert session_payload["latest_selection"] is None
    assert session_payload["artifacts"] == []
    assert session_payload["console_events"] == []

    detach_response = client.post(
        "/api/visual-dev/session/detach",
        json=_visual_dev_body(session_id="session-1"),
        headers=_operator_headers(),
    )

    assert detach_response.status_code == 200
    detach_payload = detach_response.get_json()
    assert detach_payload["ok"] is True
    assert detach_payload["session_id"] == "session-1"
    assert server.store.get_visual_dev_session("session-1")["status"] == "detached"


def test_visual_dev_attach_rejects_untrusted_preview_origin(monkeypatch, tmp_path) -> None:
    server, client = _visual_dev_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")

    response = _attach_visual_dev_session(client, chat_id, preview_url="https://evil.example.com/app")

    assert response.status_code == 400
    assert response.get_json()["error"] == "Untrusted preview url origin"


def test_visual_dev_selection_console_and_screenshot_ingest(monkeypatch, tmp_path) -> None:
    _server, client = _visual_dev_client(monkeypatch, tmp_path)
    chat_id = _server.store.ensure_default_chat("123")
    attach_response = _attach_visual_dev_session(client, chat_id)
    assert attach_response.status_code == 200

    select_response = client.post(
        "/api/visual-dev/session/select",
        json=_visual_dev_body(
            session_id="session-1",
            selection_type="dom",
            payload={"selector": "#toolbar", "text": "Toolbar", "bounds": {"x": 10, "y": 20}},
        ),
        headers=_operator_headers(),
    )

    assert select_response.status_code == 200
    assert select_response.get_json()["selection"]["payload"]["selector"] == "#toolbar"

    console_response = client.post(
        "/api/visual-dev/session/console",
        json=_visual_dev_body(
            session_id="session-1",
            event_type="console",
            level="error",
            message="Build exploded",
            metadata={"source": "vite"},
        ),
        headers=_operator_headers(),
    )

    assert console_response.status_code == 200
    console_payload = console_response.get_json()
    assert console_payload["ok"] is True
    assert console_payload["accepted"] is True
    assert console_payload["runtime"]["state"] == "runtime_error"

    screenshot_response = client.post(
        "/api/visual-dev/session/screenshot",
        json=_visual_dev_body(
            session_id="session-1",
            content_type="image/png",
            bytes_b64=base64.b64encode(PNG_1X1_BYTES).decode("ascii"),
            metadata={"capture": "full", "width": 1, "height": 1},
        ),
        headers=_operator_headers(),
    )

    assert screenshot_response.status_code == 201
    screenshot_payload = screenshot_response.get_json()
    assert screenshot_payload["ok"] is True
    artifact = screenshot_payload["artifact"]
    assert artifact["artifact_kind"] == "screenshot"
    assert artifact["content_type"] == "image/png"
    assert artifact["byte_size"] == len(PNG_1X1_BYTES)
    assert Path(artifact["storage_path"]).exists()

    region_screenshot_response = client.post(
        "/api/visual-dev/session/screenshot",
        json=_visual_dev_body(
            session_id="session-1",
            content_type="image/png",
            bytes_b64=base64.b64encode(PNG_1X1_BYTES).decode("ascii"),
            metadata={
                "capture": "region",
                "label": "toolbar region",
                "region": {"left": 10, "top": 20, "width": 120, "height": 48},
            },
        ),
        headers=_operator_headers(),
    )

    assert region_screenshot_response.status_code == 201
    region_artifact = region_screenshot_response.get_json()["artifact"]
    assert region_artifact["metadata"]["capture"] == "region"
    assert region_artifact["metadata"]["region"]["width"] == 120

    session_response = client.get(
        f"/api/visual-dev/session/{chat_id}",
        query_string={"init_data": "ok"},
        headers=_operator_headers(),
    )

    assert session_response.status_code == 200
    session_payload = session_response.get_json()
    assert session_payload["latest_selection"]["selection_type"] == "dom"
    assert session_payload["console_events"][0]["message"] == "Build exploded"
    assert session_payload["artifacts"][0]["artifact_kind"] == "screenshot"
    assert session_payload["artifacts"][0]["metadata"]["capture"] == "region"
    assert session_payload["session"]["runtime"]["state"] == "runtime_error"


def test_visual_dev_command_updates_runtime_state(monkeypatch, tmp_path) -> None:
    server, client = _visual_dev_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")
    attach_response = _attach_visual_dev_session(client, chat_id)
    assert attach_response.status_code == 200

    response = client.post(
        "/api/visual-dev/session/command",
        json=_visual_dev_body(
            session_id="session-1",
            command="build-state",
            payload={"state": "reloading", "message": "rebundling"},
        ),
        headers=_operator_headers(),
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["runtime"]["state"] == "reloading"
    assert server.visual_dev_runtime.get_session_state("session-1")["state"] == "reloading"


def test_visual_dev_routes_allow_authenticated_miniapp_requests_without_operator_token(monkeypatch, tmp_path) -> None:
    server, client = _visual_dev_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")

    response = client.post(
        "/api/visual-dev/session/attach",
        json=_visual_dev_body(
            chat_id=chat_id,
            session_id="session-1",
            preview_url="https://preview.example.com/app",
            preview_title="Preview title",
            bridge_parent_origin="https://miniapp.example.com",
        ),
    )

    assert response.status_code == 200
    assert response.get_json()["session"]["session_id"] == "session-1"



def test_visual_dev_get_routes_allow_authenticated_miniapp_requests_without_operator_token(monkeypatch, tmp_path) -> None:
    server, client = _visual_dev_client(monkeypatch, tmp_path)
    chat_id = server.store.ensure_default_chat("123")

    attach_response = client.post(
        "/api/visual-dev/session/attach",
        json=_visual_dev_body(
            chat_id=chat_id,
            session_id="session-1",
            preview_url="https://preview.example.com/app",
            preview_title="Preview title",
            bridge_parent_origin="https://miniapp.example.com",
        ),
    )

    assert attach_response.status_code == 200

    state_response = client.get("/api/visual-dev/state")
    assert state_response.status_code == 200
    assert state_response.get_json()["sessions"][0]["session_id"] == "session-1"

    session_response = client.get(f"/api/visual-dev/session/{chat_id}")
    assert session_response.status_code == 200
    assert session_response.get_json()["session"]["session_id"] == "session-1"


def test_visual_dev_routes_hide_operator_only_surface_from_unauthenticated_requests(monkeypatch, tmp_path) -> None:
    server, client = _visual_dev_client(monkeypatch, tmp_path, authed=False)
    chat_id = server.store.ensure_default_chat("123")

    response = client.post(
        "/api/visual-dev/session/attach",
        json=_visual_dev_body(
            chat_id=chat_id,
            session_id="session-1",
            preview_url="https://preview.example.com/app",
            preview_title="Preview title",
            bridge_parent_origin="https://miniapp.example.com",
        ),
    )

    assert response.status_code == 404
    assert response.get_json()["error"] == "Not found."
