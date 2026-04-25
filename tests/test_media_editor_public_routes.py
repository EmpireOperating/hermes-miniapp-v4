from __future__ import annotations

from flask import Blueprint, Flask

import server_public_routes
from server_public_routes import register_public_routes


def _build_app(tmp_path):
    static_dir = tmp_path / "static"
    static_dir.mkdir(parents=True, exist_ok=True)
    (static_dir / "app.js").write_text("console.log('ok')", encoding="utf-8")
    (static_dir / "media_editor_app.js").write_text("console.log('editor')", encoding="utf-8")

    app = Flask(__name__, static_folder=None, template_folder=str(tmp_path))
    app.static_folder = str(static_dir)
    public_bp = Blueprint("public", __name__)
    return app, public_bp


def test_workspace_media_editor_route_renders_editor_shell(monkeypatch, tmp_path) -> None:
    app, public_bp = _build_app(tmp_path)
    captured: dict[str, object] = {}

    def fake_render_template(name: str, **kwargs):
        captured["name"] = name
        captured.update(kwargs)
        return "<html>editor</html>"

    monkeypatch.setattr(server_public_routes, "render_template", fake_render_template)

    register_public_routes(
        public_bp,
        app=app,
        allowed_skins={"terminal"},
        skin_cookie_name="skin",
        max_message_len=4096,
        dev_reload=False,
        dev_reload_interval_ms=300,
        request_debug=False,
        static_no_store_filenames={"app.js", "media_editor_app.js"},
        asset_version_fn=lambda _: "v1",
        dev_reload_version_fn=lambda: "r1",
        ensure_csp_nonce_fn=lambda: "nonce",
    )
    app.register_blueprint(public_bp)
    client = app.test_client()

    response = client.get("/workspace/media-editor")

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store, max-age=0"
    assert captured["name"] == "media_editor.html"
    assert captured["media_editor_app_version"] == "v1"
    assert captured["visual_dev_bridge_version"] == "v1"
    assert captured["csp_nonce"] == "nonce"


def test_workspace_media_editor_static_asset_is_no_store(tmp_path) -> None:
    app, public_bp = _build_app(tmp_path)

    register_public_routes(
        public_bp,
        app=app,
        allowed_skins={"terminal"},
        skin_cookie_name="skin",
        max_message_len=4096,
        dev_reload=False,
        dev_reload_interval_ms=300,
        request_debug=False,
        static_no_store_filenames={"app.js", "media_editor_app.js"},
        asset_version_fn=lambda _: "v1",
        dev_reload_version_fn=lambda: "r1",
        ensure_csp_nonce_fn=lambda: "nonce",
    )
    app.register_blueprint(public_bp)
    client = app.test_client()

    response = client.get("/static/media_editor_app.js")

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store, max-age=0"
