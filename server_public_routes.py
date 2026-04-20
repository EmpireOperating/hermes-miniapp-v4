from __future__ import annotations

import json
from typing import Callable

from flask import Blueprint, Flask, Response, jsonify, make_response, render_template, request, send_from_directory


def register_public_routes(
    public_bp: Blueprint,
    *,
    app: Flask,
    allowed_skins: set[str],
    skin_cookie_name: str,
    max_message_len: int,
    dev_reload: bool,
    dev_reload_interval_ms: int,
    request_debug: bool,
    dev_auth_enabled: bool | None = None,
    dev_auth_enabled_fn: Callable[[], bool] = lambda: False,
    mobile_tab_carousel_enabled: bool = False,
    tab_actions_menu_enabled: bool = False,
    file_preview_enabled: bool = False,
    file_preview_allowed_roots: tuple[str, ...] = (),
    visual_dev_enabled: bool = False,
    visual_dev_operator_only: bool = True,
    visual_dev_allowed_preview_origins: tuple[str, ...] = (),
    visual_dev_allowed_parent_origins: tuple[str, ...] = (),
    static_no_store_filenames: set[str] | frozenset[str] = frozenset(),
    asset_version_fn: Callable[[str], str],
    dev_reload_version_fn: Callable[[], str],
    ensure_csp_nonce_fn: Callable[[], str],
) -> None:
    resolved_dev_auth_enabled_fn = (
        (lambda: bool(dev_auth_enabled))
        if dev_auth_enabled is not None
        else dev_auth_enabled_fn
    )

    @public_bp.get("/")
    def root() -> tuple[dict[str, str], int]:
        return {"status": "ok", "service": "hermes-miniapp"}, 200

    @public_bp.get("/app")
    def mini_app() -> Response:
        boot_skin = str(request.cookies.get(skin_cookie_name, "terminal")).strip().lower()
        if boot_skin not in allowed_skins:
            boot_skin = "terminal"

        response = make_response(
            render_template(
                "app.html",
                css_version=asset_version_fn("app.css"),
                runtime_attention_effects_version=asset_version_fn("runtime_attention_effects.js"),
                runtime_read_state_version=asset_version_fn("runtime_read_state.js"),
                runtime_chat_history_sync_version=asset_version_fn("runtime_chat_history_sync.js"),
                runtime_visible_history_sync_version=asset_version_fn("runtime_visible_history_sync.js"),
                runtime_hydration_state_version=asset_version_fn("runtime_hydration_state.js"),
                runtime_hydration_apply_version=asset_version_fn("runtime_hydration_apply.js"),
                runtime_visible_hydration_version=asset_version_fn("runtime_visible_hydration.js"),
                runtime_hydration_flow_version=asset_version_fn("runtime_hydration_flow.js"),
                runtime_open_flow_version=asset_version_fn("runtime_open_flow.js"),
                runtime_chat_meta_version=asset_version_fn("runtime_chat_meta.js"),
                runtime_local_mutation_version=asset_version_fn("runtime_local_mutation.js"),
                runtime_unread_helpers_version=asset_version_fn("runtime_unread_helpers.js"),
                runtime_latency_helpers_version=asset_version_fn("runtime_latency_helpers.js"),
                runtime_history_helpers_version=asset_version_fn("runtime_history_helpers.js"),
                helpers_version=asset_version_fn("runtime_helpers.js"),
                shared_utils_version=asset_version_fn("app_shared_utils.js"),
                chat_ui_helpers_version=asset_version_fn("chat_ui_helpers.js"),
                chat_tabs_helpers_version=asset_version_fn("chat_tabs_helpers.js"),
                message_actions_helpers_version=asset_version_fn("message_actions_helpers.js"),
                stream_state_helpers_version=asset_version_fn("stream_state_helpers.js"),
                runtime_transcript_authority_version=asset_version_fn("runtime_transcript_authority.js"),
                stream_controller_version=asset_version_fn("stream_controller.js"),
                composer_state_helpers_version=asset_version_fn("composer_state_helpers.js"),
                keyboard_shortcuts_helpers_version=asset_version_fn("keyboard_shortcuts_helpers.js"),
                interaction_helpers_version=asset_version_fn("interaction_helpers.js"),
                bootstrap_auth_helpers_version=asset_version_fn("bootstrap_auth_helpers.js"),
                chat_history_helpers_version=asset_version_fn("chat_history_helpers.js"),
                chat_admin_helpers_version=asset_version_fn("chat_admin_helpers.js"),
                shell_ui_helpers_version=asset_version_fn("shell_ui_helpers.js"),
                composer_viewport_helpers_version=asset_version_fn("composer_viewport_helpers.js"),
                visibility_skin_helpers_version=asset_version_fn("visibility_skin_helpers.js"),
                startup_bindings_helpers_version=asset_version_fn("startup_bindings_helpers.js"),
                startup_metrics_helpers_version=asset_version_fn("startup_metrics_helpers.js"),
                render_trace_text_helpers_version=asset_version_fn("render_trace_text_helpers.js"),
                render_trace_debug_helpers_version=asset_version_fn("render_trace_debug_helpers.js"),
                render_trace_message_helpers_version=asset_version_fn("render_trace_message_helpers.js"),
                render_trace_history_helpers_version=asset_version_fn("render_trace_history_helpers.js"),
                render_trace_helpers_version=asset_version_fn("render_trace_helpers.js"),
                file_preview_helpers_version=asset_version_fn("file_preview_helpers.js"),
                visual_dev_shell_helpers_version=asset_version_fn("visual_dev_shell_helpers.js"),
                visual_dev_preview_helpers_version=asset_version_fn("visual_dev_preview_helpers.js"),
                visual_dev_mode_helpers_version=asset_version_fn("visual_dev_mode_helpers.js"),
                visual_dev_attach_helpers_version=asset_version_fn("visual_dev_attach_helpers.js"),
                visual_dev_prompt_context_helpers_version=asset_version_fn("visual_dev_prompt_context_helpers.js"),
                visual_dev_bridge_version=asset_version_fn("visual_dev_bridge.js"),
                app_js_version=asset_version_fn("app.js"),
                bootstrap_version=dev_reload_version_fn(),
                dev_reload=dev_reload,
                dev_reload_interval_ms=dev_reload_interval_ms,
                dev_reload_version=dev_reload_version_fn(),
                request_debug=request_debug,
                dev_auth_enabled=resolved_dev_auth_enabled_fn(),
                mobile_tab_carousel_enabled=mobile_tab_carousel_enabled,
                tab_actions_menu_enabled=tab_actions_menu_enabled,
                file_preview_enabled=file_preview_enabled,
                file_preview_allowed_roots_json=json.dumps(list(file_preview_allowed_roots)),
                visual_dev_enabled=visual_dev_enabled,
                visual_dev_operator_only=visual_dev_operator_only,
                visual_dev_allowed_preview_origins_json=json.dumps(list(visual_dev_allowed_preview_origins)),
                visual_dev_allowed_parent_origins_json=json.dumps(list(visual_dev_allowed_parent_origins)),
                boot_skin=boot_skin,
                csp_nonce=ensure_csp_nonce_fn(),
                max_message_len=max_message_len,
            )
        )
        response.headers["Cache-Control"] = "no-store, max-age=0"
        return response

    @public_bp.get("/health")
    def health() -> tuple[dict[str, str], int]:
        return {"status": "ok"}, 200

    @public_bp.get("/dev/reload-state")
    def dev_reload_state() -> Response | tuple[dict[str, object], int]:
        if not dev_reload:
            return {"ok": False, "enabled": False}, 404
        response = jsonify(
            {
                "ok": True,
                "enabled": True,
                "version": dev_reload_version_fn(),
                "interval_ms": dev_reload_interval_ms,
            }
        )
        response.headers["Cache-Control"] = "no-store, max-age=0"
        return response

    @public_bp.get("/static/<path:filename>")
    def static_files(filename: str):
        response = send_from_directory(app.static_folder, filename)
        if filename in static_no_store_filenames:
            response.headers["Cache-Control"] = "no-store, max-age=0"
        return response

