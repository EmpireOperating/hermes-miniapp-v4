from __future__ import annotations

from typing import Callable, Iterable


def register_meta_routes(
    api_bp,
    *,
    allowed_skins: Iterable[str],
    bootstrap_version_fn: Callable[[], str],
) -> None:
    @api_bp.get("/state")
    def state() -> tuple[dict[str, object], int]:
        return {
            "ok": True,
            "skins": sorted(allowed_skins),
            "bootstrap_version": str(bootstrap_version_fn() or ""),
        }, 200
