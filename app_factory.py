from __future__ import annotations

from pathlib import Path

from flask import Flask
from werkzeug.middleware.proxy_fix import ProxyFix


def create_flask_app(
    *,
    base_dir: Path,
    trust_proxy_headers: bool,
    max_content_length: int,
    debug: bool,
    dev_reload: bool,
) -> Flask:
    app = Flask(__name__, template_folder=str(base_dir / "templates"), static_folder=str(base_dir / "static"))
    if trust_proxy_headers:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)  # type: ignore[assignment]
    app.config["MAX_CONTENT_LENGTH"] = max_content_length
    app.config["TEMPLATES_AUTO_RELOAD"] = debug or dev_reload
    app.jinja_env.auto_reload = debug or dev_reload
    return app
