from __future__ import annotations

import base64
import os

from flask import Response


def generate_csp_nonce() -> str:
    return base64.urlsafe_b64encode(os.urandom(18)).decode("ascii").rstrip("=")


def apply_security_headers(response: Response, *, csp_nonce: str | None, enable_hsts: bool) -> Response:
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

    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        f"{script_src}; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: https:; "
        "connect-src 'self'; "
        "frame-ancestors https://web.telegram.org https://*.telegram.org; "
        "base-uri 'self'; "
        "form-action 'self'",
    )

    if enable_hsts:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

    return response
