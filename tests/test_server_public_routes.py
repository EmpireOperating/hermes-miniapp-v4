from __future__ import annotations

from flask import Blueprint, Flask

import server_public_routes
from server_public_routes import register_public_routes


def _build_app(tmp_path, *, dev_reload: bool = False):
    static_dir = tmp_path / "static"
    static_dir.mkdir(parents=True, exist_ok=True)
    (static_dir / "app.js").write_text("console.log('ok')", encoding="utf-8")

    # Disable Flask's built-in /static route so the blueprint handler is the one under test.
    app = Flask(__name__, static_folder=None, template_folder=str(tmp_path))
    app.static_folder = str(static_dir)
    public_bp = Blueprint("public", __name__)

    return app, public_bp


def test_register_public_routes_root_and_health(tmp_path) -> None:
    app, public_bp = _build_app(tmp_path)

    register_public_routes(
        public_bp,
        app=app,
        allowed_skins={"terminal", "minimal"},
        skin_cookie_name="skin",
        max_message_len=4096,
        dev_reload=False,
        dev_reload_interval_ms=300,
        request_debug=False,
        static_no_store_filenames={"app.js"},
        asset_version_fn=lambda _: "v1",
        dev_reload_version_fn=lambda: "r1",
        ensure_csp_nonce_fn=lambda: "nonce",
    )
    app.register_blueprint(public_bp)
    client = app.test_client()

    root = client.get("/")
    health = client.get("/health")

    assert root.status_code == 200
    assert root.get_json()["status"] == "ok"
    assert health.status_code == 200


def test_mini_app_route_falls_back_invalid_skin_and_sets_no_store(monkeypatch, tmp_path) -> None:
    app, public_bp = _build_app(tmp_path)

    captured: dict[str, object] = {}

    def fake_render_template(_name: str, **kwargs):
        captured.update(kwargs)
        return "<html>ok</html>"

    monkeypatch.setattr(server_public_routes, "render_template", fake_render_template)

    register_public_routes(
        public_bp,
        app=app,
        allowed_skins={"terminal", "minimal"},
        skin_cookie_name="skin",
        max_message_len=4096,
        dev_reload=False,
        dev_reload_interval_ms=300,
        request_debug=False,
        static_no_store_filenames={"app.js"},
        asset_version_fn=lambda _: "v1",
        dev_reload_version_fn=lambda: "r1",
        ensure_csp_nonce_fn=lambda: "nonce",
    )
    app.register_blueprint(public_bp)
    client = app.test_client()
    client.set_cookie("skin", "bad-value")

    response = client.get("/app")

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store, max-age=0"
    assert captured["boot_skin"] == "terminal"
    assert captured["bootstrap_version"] == "r1"


def test_dev_reload_state_and_static_cache_headers(tmp_path) -> None:
    app, public_bp = _build_app(tmp_path)

    register_public_routes(
        public_bp,
        app=app,
        allowed_skins={"terminal"},
        skin_cookie_name="skin",
        max_message_len=4096,
        dev_reload=True,
        dev_reload_interval_ms=123,
        request_debug=False,
        dev_auth_enabled=False,
        static_no_store_filenames={"app.js"},
        asset_version_fn=lambda _: "v1",
        dev_reload_version_fn=lambda: "ver-1",
        ensure_csp_nonce_fn=lambda: "nonce",
    )
    app.register_blueprint(public_bp)
    client = app.test_client()

    reload_state = client.get("/dev/reload-state")
    static_resp = client.get("/static/app.js")

    assert reload_state.status_code == 200
    assert reload_state.get_json()["enabled"] is True
    assert reload_state.get_json()["interval_ms"] == 123
    assert reload_state.headers["Cache-Control"] == "no-store, max-age=0"
    assert static_resp.status_code == 200
    assert static_resp.headers["Cache-Control"] == "no-store, max-age=0"


def test_mini_app_route_exposes_dev_auth_flag(monkeypatch, tmp_path) -> None:
    app, public_bp = _build_app(tmp_path)

    captured: dict[str, object] = {}

    def fake_render_template(_name: str, **kwargs):
        captured.update(kwargs)
        return "<html>ok</html>"

    monkeypatch.setattr(server_public_routes, "render_template", fake_render_template)

    register_public_routes(
        public_bp,
        app=app,
        allowed_skins={"terminal", "minimal"},
        skin_cookie_name="skin",
        max_message_len=4096,
        dev_reload=False,
        dev_reload_interval_ms=300,
        request_debug=False,
        dev_auth_enabled=True,
        static_no_store_filenames={"app.js"},
        asset_version_fn=lambda _: "v1",
        dev_reload_version_fn=lambda: "r1",
        ensure_csp_nonce_fn=lambda: "nonce",
    )
    app.register_blueprint(public_bp)
    client = app.test_client()

    response = client.get("/app")

    assert response.status_code == 200
    assert captured["dev_auth_enabled"] is True
    assert captured["bootstrap_version"] == "r1"



def test_mini_app_route_exposes_mobile_tab_carousel_feature_flag(monkeypatch, tmp_path) -> None:
    app, public_bp = _build_app(tmp_path)

    captured: dict[str, object] = {}

    def fake_render_template(_name: str, **kwargs):
        captured.update(kwargs)
        return "<html>ok</html>"

    monkeypatch.setattr(server_public_routes, "render_template", fake_render_template)

    register_public_routes(
        public_bp,
        app=app,
        allowed_skins={"terminal", "minimal"},
        skin_cookie_name="skin",
        max_message_len=4096,
        dev_reload=False,
        dev_reload_interval_ms=300,
        request_debug=False,
        dev_auth_enabled=False,
        mobile_tab_carousel_enabled=True,
        static_no_store_filenames={"app.js"},
        asset_version_fn=lambda _: "v1",
        dev_reload_version_fn=lambda: "r1",
        ensure_csp_nonce_fn=lambda: "nonce",
    )
    app.register_blueprint(public_bp)
    client = app.test_client()

    response = client.get("/app")

    assert response.status_code == 200
    assert captured["mobile_tab_carousel_enabled"] is True


def test_mini_app_route_exposes_tab_actions_menu_feature_flag(monkeypatch, tmp_path) -> None:
    app, public_bp = _build_app(tmp_path)

    captured: dict[str, object] = {}

    def fake_render_template(_name: str, **kwargs):
        captured.update(kwargs)
        return "<html>ok</html>"

    monkeypatch.setattr(server_public_routes, "render_template", fake_render_template)

    register_public_routes(
        public_bp,
        app=app,
        allowed_skins={"terminal", "minimal"},
        skin_cookie_name="skin",
        max_message_len=4096,
        dev_reload=False,
        dev_reload_interval_ms=300,
        request_debug=False,
        dev_auth_enabled=False,
        tab_actions_menu_enabled=True,
        static_no_store_filenames={"app.js"},
        asset_version_fn=lambda _: "v1",
        dev_reload_version_fn=lambda: "r1",
        ensure_csp_nonce_fn=lambda: "nonce",
    )
    app.register_blueprint(public_bp)
    client = app.test_client()

    response = client.get("/app")

    assert response.status_code == 200
    assert captured["tab_actions_menu_enabled"] is True


def test_mini_app_route_exposes_visual_dev_config(monkeypatch, tmp_path) -> None:
    app, public_bp = _build_app(tmp_path)

    captured: dict[str, object] = {}

    def fake_render_template(_name: str, **kwargs):
        captured.update(kwargs)
        return "<html>ok</html>"

    monkeypatch.setattr(server_public_routes, "render_template", fake_render_template)

    register_public_routes(
        public_bp,
        app=app,
        allowed_skins={"terminal", "minimal"},
        skin_cookie_name="skin",
        max_message_len=4096,
        dev_reload=False,
        dev_reload_interval_ms=300,
        request_debug=False,
        dev_auth_enabled=False,
        visual_dev_enabled=True,
        visual_dev_operator_only=True,
        visual_dev_allowed_preview_origins=("https://preview.example.com",),
        visual_dev_allowed_parent_origins=("https://miniapp.example.com",),
        static_no_store_filenames={"app.js"},
        asset_version_fn=lambda _: "v1",
        dev_reload_version_fn=lambda: "r1",
        ensure_csp_nonce_fn=lambda: "nonce",
    )
    app.register_blueprint(public_bp)
    client = app.test_client()

    response = client.get("/app")

    assert response.status_code == 200
    assert captured["visual_dev_enabled"] is True
    assert captured["visual_dev_operator_only"] is True
    assert captured["visual_dev_allowed_preview_origins_json"] == '["https://preview.example.com"]'
    assert captured["visual_dev_attach_helpers_version"] == "v1"
    assert captured["visual_dev_prompt_context_helpers_version"] == "v1"
    assert captured["visual_dev_allowed_parent_origins_json"] == '["https://miniapp.example.com"]'

