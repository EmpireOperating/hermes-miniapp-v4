from __future__ import annotations

from flask import Blueprint


def create_public_blueprint() -> Blueprint:
    return Blueprint("public", __name__)


def create_api_blueprint() -> Blueprint:
    return Blueprint("api", __name__, url_prefix="/api")
