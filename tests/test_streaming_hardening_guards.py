from pathlib import Path


def _read_static(name: str) -> str:
    return Path("static", name).read_text(encoding="utf-8")


def test_app_wires_stream_state_helper_before_stream_lifecycle_calls():
    app_js = _read_static("app.js")
    chat_tabs_helper_js = _read_static("chat_tabs_helpers.js")

    assert "HermesMiniappStreamState is required before app.js" in app_js
    assert "HermesMiniappStreamController is required before app.js" in app_js
    assert "HermesMiniappComposerState is required before app.js" in app_js
    assert "composerStateHelpers.deriveComposerState({" in app_js
    assert "composerStateHelpers.applyComposerState({" in app_js
    assert "streamControllerHelpers.createController({" in app_js
    assert "markChatStreamPending({" in app_js
    assert "finalizeChatStreamState({" in app_js
    assert 'renderTraceLog("tab-badge-state"' in app_js
    assert 'renderTraceLog("tab-refresh-request"' in app_js
    assert 'renderTraceLog("stream-pending-finalize-before"' in app_js
    assert 'renderTraceLog("stream-pending-finalize-after"' in app_js
    assert "clearChatStreamState({" in app_js or "clearChatStreamState({" in chat_tabs_helper_js


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
    assert "function createToolTraceController({" in controller_js
    assert "function createController(deps)" in controller_js
    assert "function setStreamAbortController(chatId, controller)" in controller_js
    assert "function consumeStreamResponse(chatId, response, builtReplyRef" in controller_js
    assert "async function hydrateChatAfterGracefulResumeCompletion(chatId, { forceCompleted = false } = {})" in controller_js
    assert "async function consumeStreamWithReconnect(chatId, response, builtReplyRef" in controller_js
    assert "function finalizeStreamLifecycle(chatId, streamController, { wasAborted })" in controller_js
    assert 'renderTraceLog("stream-done-state"' in controller_js
    assert 'streamDebugLog("sse-read"' in controller_js
    assert 'chunkPreview:' not in controller_js
    assert 'tailPreview:' not in controller_js


def test_composer_state_helper_exports_state_api():
    helper_js = _read_static("composer_state_helpers.js")

    assert "HermesMiniappComposerState" in helper_js
    assert "function deriveComposerState({ activeChatId, pendingChats, chats, isAuthenticated })" in helper_js
    assert "function applyComposerState({" in helper_js


def test_app_resume_handles_no_active_job_reconnect_gracefully():
    app_js = _read_static("app.js")
    runtime_helpers_js = _read_static("runtime_helpers.js")
    bootstrap_auth_js = _read_static("bootstrap_auth_helpers.js")

    assert "const RESUME_RECOVERY_MAX_ATTEMPTS = 3;" in app_js
    assert "function isTransientResumeRecoveryError(error)" in app_js
    assert "function nextResumeRecoveryDelayMs(attempt)" in app_js
    assert "for (let attempt = 1; attempt <= RESUME_RECOVERY_MAX_ATTEMPTS; attempt += 1) {" in app_js
    assert "const noActiveJob = response.status === 409;" in app_js
    assert "function parseStreamErrorPayload(rawBody)" in bootstrap_auth_js
    assert "bootstrapAuthController.parseStreamErrorPayload(rawBody)" in app_js
    assert "const alreadyWorking = response.status === 409;" in app_js
    assert "await resumePendingChatStream(chatId, { force: true });" in app_js
    assert "await hydrateChatAfterGracefulResumeCompletion(key);" in app_js
    assert "triggerIncomingMessageHaptic(key, { fallbackToLatestHistory: true });" in app_js
    assert "streamActivityController.markResumeAlreadyComplete(key);" in app_js
    assert "const transientReconnectFailure = isTransientResumeRecoveryError(error);" in app_js
    assert "console.warn(`[W_STREAM_RECONNECT_RETRY] chat=${key} attempt=${attempt}/${RESUME_RECOVERY_MAX_ATTEMPTS}`, error);" in app_js
    assert "await delayMs(nextResumeRecoveryDelayMs(attempt));" in app_js
    assert "const stillPending = Boolean(chats.get(key)?.pending) || pendingChats.has(key);" in app_js
    assert "Reconnect recovery is paused for '${chatLabel(key)}'. Send a new message to try again." in app_js
    assert "setStreamStatus?.(`Stream already complete in ${chatLabel?.(key) || \"Chat\"}`);" in runtime_helpers_js
    assert "setActivityChip?.(latencyChip, \"latency: --\");" in runtime_helpers_js
    assert "setChatLatency?.(key, \"--\");" in runtime_helpers_js
    assert "setActivityChip?.(latencyChip, \"latency: reconnecting...\");" in runtime_helpers_js
    assert "setChatLatency?.(key, \"reconnecting...\");" in runtime_helpers_js
    assert "setStreamStatus?.(\"Reconnect recovery paused — action needed\");" in runtime_helpers_js
    assert "setActivityChip?.(streamChip, \"stream: recovery paused\");" in runtime_helpers_js
    assert "function createHapticUnreadController({" in runtime_helpers_js
    assert "consumeStreamWithReconnect(key, response, builtReplyRef" in app_js
    assert "await resumePendingChatStream(key, { force: true });" not in app_js
    assert "const reconnectResumeBlockedChats = new Set();" in app_js
    assert "if (reconnectResumeBlockedChats.has(key)) {" in app_js
    assert "blockReconnectResume(key);" in app_js
    assert "clearReconnectResumeBlock(chatId);" in app_js
    assert "console.warn(`[E_STREAM_RECONNECT_FAILED] chat=${key}`, error);" in app_js


def test_app_persists_pending_stream_snapshot_for_pre_resume_rehydrate():
    app_js = _read_static("app.js")
    controller_js = _read_static("stream_controller.js")
    stream_state_js = _read_static("stream_state_helpers.js")

    assert "const PENDING_STREAM_SNAPSHOT_STORAGE_KEY = \"hermes_miniapp_pending_stream_snapshot_v1\";" in app_js
    assert "const streamPersistenceController = streamStateHelpers.createPersistenceController({" in app_js
    assert "function persistPendingStreamSnapshot(chatId)" in app_js
    assert "function restorePendingStreamSnapshot(chatId)" in app_js
    assert "streamPersistenceController.persistPendingStreamSnapshot(chatId)" in app_js
    assert "streamPersistenceController.restorePendingStreamSnapshot(chatId)" in app_js
    assert "function createPersistenceController({" in stream_state_js
    assert "tool_journal_lines" in stream_state_js
    assert "function mergeSnapshotToolJournalLines(existingLines, currentBody)" in stream_state_js
    assert "persistPendingStreamSnapshot(chatId);" in app_js
    assert "clearPendingStreamSnapshot(chatId);" in app_js
    assert "restorePendingStreamSnapshot(Number(data.active_chat_id))" in app_js
    assert "clearPendingStreamSnapshot?.(chatId);" in controller_js
    assert "clearPendingStreamSnapshot?.(key);" in controller_js


def test_app_sanitizes_upstream_error_pages_before_rendering_ui_errors():
    app_js = _read_static("app.js")
    bootstrap_auth_js = _read_static("bootstrap_auth_helpers.js")

    assert "function summarizeUiFailure(rawBody" in bootstrap_auth_js
    assert "normalizedStatus === 502 || normalizedStatus === 503 || normalizedStatus === 504" in bootstrap_auth_js
    assert "looksLikeHtml" in bootstrap_auth_js
    assert "looksLikeCss" in bootstrap_auth_js
    assert "Mini app backend temporarily unavailable. Please wait a moment and reopen if needed." in bootstrap_auth_js
    assert "bootstrapAuthController.summarizeUiFailure(rawBody, { status, fallback })" in app_js
    assert "sanitizedFallbackMessage" in app_js
    assert "sanitizedResumeFailure" in app_js


def test_routes_chat_stream_supports_mobile_segment_rollover_controls():
    stream_routes = Path("routes_chat_stream.py").read_text(encoding="utf-8")

    assert "MINI_APP_STREAM_SEGMENT_SECONDS" in stream_routes
    assert "MINI_APP_STREAM_SEGMENT_SECONDS_MOBILE" in stream_routes
    assert "stream_timing_debug = bool(context.stream_timing_debug)" in stream_routes
    assert "event=\"stream_segment_rollover\"" in stream_routes
    assert "segment_seconds=_stream_segment_seconds_for_request()" in stream_routes
    assert "request_id = str(getattr(g, \"request_id\", \"\")) or None" in stream_routes
    assert "event=\"stream_segment_rollover\",\n                                        request_id=request_id," in stream_routes


def test_job_runtime_event_buffers_do_not_use_hardcoded_512_caps():
    runtime_source = Path("job_runtime.py").read_text(encoding="utf-8")

    assert "maxsize=512" not in runtime_source
    assert "len(history) > 512" not in runtime_source
