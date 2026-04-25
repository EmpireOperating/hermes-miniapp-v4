from __future__ import annotations

import base64
import os
from flask import Response

from miniapp_config import normalize_origin


def generate_csp_nonce() -> str:
    return base64.urlsafe_b64encode(os.urandom(18)).decode("ascii").rstrip("=")


def _frame_ancestors_value(
    *,
    request_origin: str | None,
    visual_dev_enabled: bool,
    visual_dev_allowed_preview_origins: set[str] | frozenset[str] | tuple[str, ...],
    visual_dev_allowed_parent_origins: set[str] | frozenset[str] | tuple[str, ...],
) -> str:
    ancestors = ["https://web.telegram.org", "https://*.telegram.org"]
    candidate_origin = normalize_origin(request_origin)
    allowed_preview_origins = set(visual_dev_allowed_preview_origins or ())
    allowed_parent_origins = sorted(set(visual_dev_allowed_parent_origins or ()))
    if visual_dev_enabled and candidate_origin and candidate_origin in allowed_preview_origins:
        ancestors.extend(allowed_parent_origins)
    return " ".join(dict.fromkeys(ancestors))


def apply_security_headers(
    response: Response,
    *,
    csp_nonce: str | None,
    enable_hsts: bool,
    request_origin: str | None = None,
    visual_dev_enabled: bool = False,
    visual_dev_allowed_preview_origins: set[str] | frozenset[str] | tuple[str, ...] = (),
    visual_dev_allowed_parent_origins: set[str] | frozenset[str] | tuple[str, ...] = (),
) -> Response:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    # Do NOT send X-Frame-Options for Telegram Mini App pages.
    # Telegram Web can render mini apps inside an iframe, and XFO=DENY blocks
    # the app with a blank page even when CSP frame-ancestors allows Telegram.
    # We rely on CSP frame-ancestors below for precise embedding control.
    response.headers.pop("X-Frame-Options", None)
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")

    script_src = "script-src 'self' https://telegram.org"
    if csp_nonce:
        script_src = f"{script_src} 'nonce-{csp_nonce}'"

    frame_ancestors = _frame_ancestors_value(
        request_origin=request_origin,
        visual_dev_enabled=visual_dev_enabled,
        visual_dev_allowed_preview_origins=visual_dev_allowed_preview_origins,
        visual_dev_allowed_parent_origins=visual_dev_allowed_parent_origins,
    )

    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        f"{script_src}; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: https:; "
        "media-src 'self' data: blob: https:; "
        "connect-src 'self'; "
        f"frame-ancestors {frame_ancestors}; "
        "base-uri 'self'; "
        "form-action 'self'",
    )

    if enable_hsts:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

    return response
