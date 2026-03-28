from pathlib import Path


def _read_static(name: str) -> str:
    return Path("static", name).read_text(encoding="utf-8")


def test_app_wires_stream_state_helper_before_stream_lifecycle_calls():
    app_js = _read_static("app.js")

    assert "HermesMiniappStreamState is required before app.js" in app_js
    assert "HermesMiniappStreamController is required before app.js" in app_js
    assert "HermesMiniappComposerState is required before app.js" in app_js
    assert "composerStateHelpers.deriveComposerState({" in app_js
    assert "composerStateHelpers.applyComposerState({" in app_js
    assert "streamControllerHelpers.createController({" in app_js
    assert "markChatStreamPending({" in app_js
    assert "finalizeChatStreamState({" in app_js
    assert "clearChatStreamState({" in app_js


def test_stream_state_helper_exports_phase_api_and_guardrails():
    helper_js = _read_static("stream_state_helpers.js")

    assert "const STREAM_PHASES = Object.freeze(" in helper_js
    assert "function normalizeStreamPhase(value)" in helper_js
    assert "function getStreamPhase({ streamPhaseByChat, chatId })" in helper_js
    assert "function setStreamPhase({ streamPhaseByChat, chatId, phase })" in helper_js
    assert "function isPatchPhaseAllowed(phase)" in helper_js
    assert "function markChatStreamPending({ chatId, pendingChats, chats, setStreamPhase: setStreamPhaseFn })" in helper_js
    assert "function finalizeChatStreamState({ chatId, wasAborted, pendingChats, chats, setStreamPhase: setStreamPhaseFn })" in helper_js
    assert "function clearChatStreamState({ chatId, pendingChats, streamPhaseByChat, unseenStreamChats })" in helper_js


def test_stream_controller_module_exports_core_api():
    controller_js = _read_static("stream_controller.js")

    assert "HermesMiniappStreamController" in controller_js
    assert "function createController(deps)" in controller_js
    assert "function setStreamAbortController(chatId, controller)" in controller_js
    assert "function consumeStreamResponse(chatId, response, builtReplyRef" in controller_js
    assert "function finalizeStreamLifecycle(chatId, streamController, { wasAborted })" in controller_js


def test_composer_state_helper_exports_state_api():
    helper_js = _read_static("composer_state_helpers.js")

    assert "HermesMiniappComposerState" in helper_js
    assert "function deriveComposerState({ activeChatId, pendingChats, chats, isAuthenticated })" in helper_js
    assert "function applyComposerState({" in helper_js


def test_job_runtime_event_buffers_do_not_use_hardcoded_512_caps():
    runtime_source = Path("job_runtime.py").read_text(encoding="utf-8")

    assert "maxsize=512" not in runtime_source
    assert "len(history) > 512" not in runtime_source
