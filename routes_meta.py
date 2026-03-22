from __future__ import annotations

from typing import Iterable


def register_meta_routes(api_bp, *, allowed_skins: Iterable[str]) -> None:
    @api_bp.get("/state")
    def state() -> tuple[dict[str, object], int]:
        return {"ok": True, "skins": sorted(allowed_skins)}, 200
