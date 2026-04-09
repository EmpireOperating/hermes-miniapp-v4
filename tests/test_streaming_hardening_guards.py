from pathlib import Path


def _read_static(name: str) -> str:
    return Path("static", name).read_text(encoding="utf-8")


def test_app_wires_stream_state_helper_before_stream_lifecycle_calls():
    app_js = _read_static("app.js")
    chat_tabs_helper_js = _read_static("chat_tabs_helpers.js")
    stream_state_js = _read_static("stream_state_helpers.js")

    assert "HermesMiniappStreamState is required before app.js" in app_js
    assert "HermesMiniappStreamController is required before app.js" in app_js
    assert "HermesMiniappComposerState is required before app.js" in app_js
    assert "const composerStateController = composerStateHelpers.createController({" in app_js
    assert "return composerStateController.updateComposerState();" in app_js
    assert "const streamPhaseController = streamStateHelpers.createPhaseController({" in app_js
    assert "return streamPhaseController.getStreamPhase(chatId);" in app_js
    assert "return streamPhaseController.setStreamPhase(chatId, phase);" in app_js
    assert "streamControllerHelpers.createController({" in app_js
    assert "function markChatStreamPending({ chatId, pendingChats, chats, setStreamPhase: setStreamPhaseFn })" in stream_state_js
    assert "function finalizeChatStreamState({ chatId, wasAborted, pendingChats, chats, setStreamPhase: setStreamPhaseFn })" in stream_state_js
    assert 'renderTraceLog?.(\'tab-badge-state\'' in chat_tabs_helper_js
    assert 'renderTraceLog?.(\'tab-refresh-request\'' in chat_tabs_helper_js
    assert 'stream-pending-finalize-before' not in app_js
    assert "renderTraceLog?.('stream-pending-finalize-before'" in stream_state_js
    assert "renderTraceLog?.('stream-pending-finalize-after'" in stream_state_js
    assert "function createLifecycleController({" in stream_state_js
    assert "clearChatStreamState({" in stream_state_js or "clearChatStreamState({" in chat_tabs_helper_js


def test_stream_state_helper_exports_phase_api_and_guardrails():
    helper_js = _read_static("stream_state_helpers.js")

    assert "const STREAM_PHASES = Object.freeze(" in helper_js
    assert "function normalizeStreamPhase(value)" in helper_js
    assert "function getStreamPhase({ streamPhaseByChat, chatId })" in helper_js
    assert "function setStreamPhase({ streamPhaseByChat, chatId, phase })" in helper_js
    assert "function createPhaseController({" in helper_js
    assert "function createLifecycleController({" in helper_js
    assert "renderTraceLog?.(\"stream-phase\", { chatId: key, phase: next });" in helper_js
    assert "function isPatchPhaseAllowed(phase)" in helper_js
    assert "function createController({" in _read_static("composer_state_helpers.js")
    assert "function updateComposerState() {" in _read_static("composer_state_helpers.js")
    assert "function markChatStreamPending({ chatId, pendingChats, chats, setStreamPhase: setStreamPhaseFn })" in helper_js
    assert "function finalizeChatStreamState({ chatId, wasAborted, pendingChats, chats, setStreamPhase: setStreamPhaseFn })" in helper_js
    assert "function clearChatStreamState({ chatId, pendingChats, streamPhaseByChat, unseenStreamChats })" in helper_js


def test_stream_controller_module_exports_core_api():
    controller_js = _read_static("stream_controller.js")
    shared_utils_js = _read_static("app_shared_utils.js")

    assert "const totalSeconds = Math.max(0, Math.ceil(ms / 1000));" in shared_utils_js
    assert "if (totalSeconds < 60) return `${totalSeconds}s`;" in shared_utils_js
    assert "const fallbackSeconds = `${Math.max(0, Math.ceil(elapsedMs / 1000))}s`;" in _read_static("runtime_helpers.js")

    assert "HermesMiniappStreamController" in controller_js
    assert "function createToolTraceController({" in controller_js
    assert "function createStreamSessionController({" in controller_js
    assert "function createStreamTranscriptController(deps, sessionController)" in controller_js
    assert "function createStreamLifecycleController(deps, sessionController, transcriptController)" in controller_js
    assert "function createController(deps)" in controller_js
    assert "const sessionController = createStreamSessionController({" in controller_js
    assert "const transcriptController = createStreamTranscriptController(deps, sessionController);" in controller_js
    assert "const lifecycleController = createStreamLifecycleController(deps, sessionController, transcriptController);" in controller_js
    assert "function setStreamAbortController(chatId, controller)" in controller_js
    assert "function consumeStreamResponse(chatId, response, builtReplyRef" in controller_js
    assert "async function hydrateChatAfterGracefulResumeCompletion(chatId, { forceCompleted = false } = {})" in controller_js
    assert "async function consumeStreamWithReconnect(chatId, response, builtReplyRef" in controller_js
    assert "async function finalizeStreamLifecycle(chatId, streamController, { wasAborted })" in controller_js
    assert "if (typeof deps.markToolActivity === \"function\") {" in controller_js
    assert "if (typeof deps.markStreamComplete === \"function\") {" in controller_js
    assert 'renderTraceLog("stream-done-state"' in controller_js
    assert 'syncActiveMessageView(chatId, { preserveViewport: true });' in controller_js
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
    stream_controller_js = _read_static("stream_controller.js")
    chat_tabs_helper_js = _read_static("chat_tabs_helpers.js")

    assert "function createResumeRecoveryPolicy" in stream_controller_js
    assert "const resumeRecoveryPolicy = streamControllerHelpers.createResumeRecoveryPolicy({" in app_js
    assert "RESUME_RECOVERY_MAX_ATTEMPTS: resumeRecoveryPolicy.RESUME_RECOVERY_MAX_ATTEMPTS" in app_js
    assert "isTransientResumeRecoveryError: resumeRecoveryPolicy.isTransientResumeRecoveryError" in app_js
    assert "nextResumeRecoveryDelayMs: resumeRecoveryPolicy.nextResumeRecoveryDelayMs" in app_js
    assert "delayMs: resumeRecoveryPolicy.delayMs" in app_js
    assert "for (let attempt = 1; attempt <= RESUME_RECOVERY_MAX_ATTEMPTS; attempt += 1) {" in stream_controller_js
    assert "const noActiveJob = response.status === 409" in stream_controller_js
    assert "&& /no active hermes job/i.test(parsedResumeError.error || fallback || \"\")" in stream_controller_js
    assert "function parseStreamErrorPayload(rawBody)" in bootstrap_auth_js
    assert "bootstrapAuthController.parseStreamErrorPayload(rawBody)" in app_js
    assert "const parsedResumeError = parseStreamErrorPayload(fallback);" in stream_controller_js
    assert "const alreadyWorking = response.status === 409;" in stream_controller_js
    assert "await resumePendingChatStream(chatId, { force: true });" in stream_controller_js
    assert "await hydrateChatAfterGracefulResumeCompletion(key);" in stream_controller_js
    assert "triggerIncomingMessageHaptic(key, { fallbackToLatestHistory: true });" in stream_controller_js
    assert "deps.markResumeAlreadyComplete?.(key);" in stream_controller_js
    assert "const transientReconnectFailure = isTransientResumeRecoveryError(error);" in stream_controller_js
    assert "console.warn(`[W_STREAM_RECONNECT_RETRY] chat=${key} attempt=${attempt}/${RESUME_RECOVERY_MAX_ATTEMPTS}`, error);" in stream_controller_js
    assert "await delayMs(nextResumeRecoveryDelayMs(attempt));" in stream_controller_js
    assert "const stillPending = Boolean(chats.get(key)?.pending) || pendingChats.has(key);" in stream_controller_js
    assert "Reconnect recovery is paused for '${chatLabel(key)}'. Send a new message to try again." in stream_controller_js

    assert "const RECONNECT_PILL_DELAY_MS = 2200;" in runtime_helpers_js
    assert "const LIVE_LATENCY_TICK_MS = 1000;" in runtime_helpers_js
    assert "const liveLatencyStartedAtByChat = new Map();" in runtime_helpers_js
    assert "const reconnectDisplayTimerByChat = new Map();" in runtime_helpers_js
    assert "const chat = activeKey ? chats.get(activeKey) : null;" in runtime_helpers_js
    assert "const hasLiveController = activeKey && typeof hasLiveStreamController === 'function'" in runtime_helpers_js
    assert "if (activeKey && !hasLiveController) {" in runtime_helpers_js
    assert "clearLiveLatency(activeKey);" in runtime_helpers_js
    assert "function beginLiveLatency(chatId, { elapsedMs = null } = {})" in runtime_helpers_js
    assert "function markToolActivity(chatId)" in runtime_helpers_js
    assert "function markStreamComplete(chatId, latencyText = \"--\")" in runtime_helpers_js
    assert "setActivityChip?.(latencyChip, \"latency: --\");" in runtime_helpers_js
    assert "setChatLatency?.(key, \"--\");" in runtime_helpers_js
    assert "const timerId = setTimeout(() => {" in runtime_helpers_js
    assert "if (liveLatencyStartedAtByChat.has(key)) {" in runtime_helpers_js
    assert "tickLiveLatency();" in runtime_helpers_js
    assert "setChatLatency?.(key, \"reconnecting...\");" in runtime_helpers_js
    assert "setStreamStatus?.(\"Reconnect recovery paused — action needed\");" in runtime_helpers_js
    assert "setActivityChip?.(streamChip, \"stream: recovery paused\");" in runtime_helpers_js
    assert "function createHapticUnreadController({" in runtime_helpers_js
    assert "consumeStreamWithReconnect(key, response, builtReplyRef" in stream_controller_js
    assert "const queueLabel = Number.isFinite(queuedAhead) && queuedAhead > 0" in _read_static("stream_controller.js")
    assert "const queueLabel = Number.isFinite(normalizedQueuedAhead) && normalizedQueuedAhead > 0" in runtime_helpers_js
    assert "setChatLatency?.(key, queueLabel);" in runtime_helpers_js

    assert "await resumePendingChatStream(key, { force: true });" not in app_js
    assert "const reconnectResumeBlockedChats = new Set();" in app_js
    assert "const MAX_AUTO_RESUME_CYCLES_PER_CHAT = 6;" in app_js
    assert "const resumeCycleCountByChat = new Map();" in app_js
    assert "function resetReconnectResumeBudget(chatId)" in app_js
    assert "function consumeReconnectResumeBudget(chatId)" in app_js
    assert "const resumeAttemptedAtByChat = new Map();" in app_js
    assert "const resumeCooldownUntilByChat = new Map();" in app_js
    assert "const resumeInFlightByChat = new Set();" in app_js
    assert "if (isReconnectResumeBlocked?.(key)) {" in stream_controller_js
    assert "if (cooldownUntil > now) {" in stream_controller_js
    assert "if (resumeInFlightByChat?.has?.(key)) {" in stream_controller_js
    assert "if (lastAttemptAt > 0 && (now - lastAttemptAt) < RESUME_REATTACH_MIN_INTERVAL_MS) {" in stream_controller_js
    assert "appendInlineToolTrace," in app_js
    assert "const reconnectBudget = consumeReconnectResumeBudget?.(key) || {" in stream_controller_js
    assert "if (!reconnectBudget.allowed) {" in stream_controller_js
    assert "appendSystemMessage(`Auto-reconnect paused in '${chatLabel(key)}' after ${reconnectBudget.maxAttempts} failed resume cycles.`" in stream_controller_js
    assert "resumeInFlightByChat?.add?.(key);" in stream_controller_js
    assert "resumeAttemptedAtByChat?.set?.(key, now);" in stream_controller_js
    assert "resumeCooldownUntilByChat?.set?.(key, Date.now() + RESUME_COMPLETE_SETTLE_MS);" in stream_controller_js
    assert "appendSystemMessage(`Could not reconnect '${chatLabel(key)}': ${error.message}`, key);" in stream_controller_js
    assert "appendSystemMessage(`Reconnect recovery is paused for '${chatLabel(key)}'. Send a new message to try again.`, key);" in stream_controller_js
    assert "appendSystemMessage(`Auto-reconnect paused in '${chatLabel(key)}' after ${reconnectBudget.maxAttempts} failed resume cycles.`, key);" in stream_controller_js
    assert "function applyResumeCooldownPendingSuppression(chatId)" in chat_tabs_helper_js

    assert "const cooldownUntil = Number(resumeCooldownUntilByChat?.get?.(key) || 0);" in chat_tabs_helper_js
    assert "if (key > 0 && cooldownUntil > nowFn()) {" in chat_tabs_helper_js
    assert "function reapplyResumeCooldownPendingSuppression()" in chat_tabs_helper_js
    assert "for (const [chatId, until] of resumeCooldownUntilByChat?.entries?.() || []) {" in chat_tabs_helper_js
    assert "chat.pending = false;" in chat_tabs_helper_js
    assert "return chatTabsController.upsertChat(chat);" in app_js
    assert "return chatTabsController.syncChats(chatList);" in app_js
    assert "resumeInFlightByChat?.delete?.(key);" in stream_controller_js
    assert "let shouldResumeAfterFinally = false;" in stream_controller_js
    assert "shouldResumeAfterFinally = true;" in stream_controller_js
    assert "resetReconnectResumeBudget?.(chatId);" in stream_controller_js
    assert "resetReconnectResumeBudget?.(key);" in stream_controller_js
    assert "resumeAttemptedAtByChat?.delete?.(key);" in stream_controller_js
    assert "setTimeoutFn(() => {" in stream_controller_js
    assert "void resumePendingChatStream(key, { force: true });" in stream_controller_js
    assert "blockReconnectResume?.(key);" in stream_controller_js
    assert "clearReconnectResumeBlock?.(chatId);" in stream_controller_js
    assert "if (eventName === \"meta\" && payload?.stream_segment_end) {" in stream_controller_js
    assert "expectedSegmentEnd: Boolean(consumeResult?.expectedSegmentEnd)" in stream_controller_js
    assert "onEarlyClose: async ({ expectedSegmentEnd = false } = {}) => {" in stream_controller_js
    assert "if (expectedSegmentEnd) {" in stream_controller_js
    assert "console.warn(`[E_STREAM_RECONNECT_FAILED] chat=${key}`, error);" in stream_controller_js


def test_app_persists_pending_stream_snapshot_for_pre_resume_rehydrate():
    app_js = _read_static("app.js")
    controller_js = _read_static("stream_controller.js")
    stream_state_js = _read_static("stream_state_helpers.js")
    startup_bindings_js = _read_static("startup_bindings_helpers.js")

    assert "const PENDING_STREAM_SNAPSHOT_STORAGE_KEY = \"hermes_miniapp_pending_stream_snapshot_v1\";" in app_js
    assert "const streamPersistenceController = streamStateHelpers.createPersistenceController({" in app_js
    assert "function persistPendingStreamSnapshot(chatId)" in app_js
    assert "function restorePendingStreamSnapshot(chatId)" in app_js
    assert "streamPersistenceController.persistPendingStreamSnapshot(chatId)" in app_js
    assert "streamPersistenceController.restorePendingStreamSnapshot(chatId)" in app_js
    assert "function createPersistenceController({" in stream_state_js
    assert "tool_journal_lines" in stream_state_js
    assert "function mergeSnapshotToolJournalLines(existingLines, currentBody)" in stream_state_js
    assert "const toolTraceController = streamControllerHelpers.createToolTraceController({" in app_js
    assert "persistPendingStreamSnapshot," in app_js
    assert "persistPendingStreamSnapshot?.(key);" in controller_js
    assert "clearPendingStreamSnapshot(chatId);" in app_js
    assert "hasFreshPendingStreamSnapshot(activeChatId)" in startup_bindings_js
    assert "restorePendingStreamSnapshot(activeChatId)" in startup_bindings_js
    assert "clearPendingStreamSnapshot?.(chatId);" in controller_js
    assert "clearPendingStreamSnapshot?.(key);" in controller_js


def test_app_sanitizes_upstream_error_pages_before_rendering_ui_errors():
    app_js = _read_static("app.js")
    bootstrap_auth_js = _read_static("bootstrap_auth_helpers.js")
    stream_controller_js = _read_static("stream_controller.js")

    assert "function summarizeUiFailure(rawBody" in bootstrap_auth_js
    assert "normalizedStatus === 502 || normalizedStatus === 503 || normalizedStatus === 504" in bootstrap_auth_js
    assert "looksLikeHtml" in bootstrap_auth_js
    assert "looksLikeCss" in bootstrap_auth_js
    assert "Mini app backend temporarily unavailable. Please wait a moment and reopen if needed." in bootstrap_auth_js
    assert "bootstrapAuthController.summarizeUiFailure(rawBody, { status, fallback })" in app_js
    assert "sanitizedFallbackMessage" in stream_controller_js
    assert "sanitizedResumeFailure" in stream_controller_js



def test_routes_chat_stream_supports_mobile_segment_rollover_controls():
    stream_routes = Path("routes_chat_stream.py").read_text(encoding="utf-8")
    stream_service = Path("routes_chat_stream_service.py").read_text(encoding="utf-8")
    stream_generator = Path("routes_chat_stream_generator.py").read_text(encoding="utf-8")

    assert "build_stream_route_service(" in stream_routes
    assert "stream_segment_seconds_for_headers(request.headers)" in stream_routes
    assert "after_event_id_from_payload(payload)" in stream_routes
    assert "MINI_APP_STREAM_SEGMENT_SECONDS" in stream_service
    assert "MINI_APP_STREAM_SEGMENT_SECONDS_MOBILE" in stream_service
    assert "class StreamResponseFactory:" in stream_generator
    assert "event=\"stream_segment_rollover\"" in stream_generator
    assert "request_id=request_id" in stream_generator


def test_job_runtime_event_buffers_do_not_use_hardcoded_512_caps():
    runtime_source = Path("job_runtime.py").read_text(encoding="utf-8")

    assert "maxsize=512" not in runtime_source
    assert "len(history) > 512" not in runtime_source
