import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedUtils, streamState, streamController, buildControllerHarness } from './stream_controller_test_harness.mjs';

test('createResumeRecoveryPolicy exposes reconnect defaults and transient error detection', async () => {
  const timeoutCalls = [];
  const policy = streamController.createResumeRecoveryPolicy({
    setTimeoutFn: (callback, delay) => {
      timeoutCalls.push(Number(delay));
      callback();
      return timeoutCalls.length;
    },
    randomFn: () => 0.5,
  });

  assert.equal(policy.RESUME_RECOVERY_MAX_ATTEMPTS, 3);
  assert.equal(policy.RESUME_REATTACH_MIN_INTERVAL_MS, 1200);
  assert.equal(policy.RESUME_COMPLETE_SETTLE_MS, 2500);
  assert.equal(policy.nextResumeRecoveryDelayMs(2), 1890);
  assert.equal(policy.isTransientResumeRecoveryError(new Error('Network request failed')), true);
  assert.equal(policy.isTransientResumeRecoveryError(new Error('validation exploded')), false);

  await policy.delayMs(25);
  assert.deepEqual(timeoutCalls, [25]);
});

test('createResumeRecoveryPolicy clamps invalid delay input before scheduling', async () => {
  const timeoutCalls = [];
  const policy = streamController.createResumeRecoveryPolicy({
    setTimeoutFn: (callback, delay) => {
      timeoutCalls.push(Number(delay));
      callback();
    },
    randomFn: () => 0,
  });

  await policy.delayMs(-50);
  assert.deepEqual(timeoutCalls, [0]);
  assert.equal(policy.nextResumeRecoveryDelayMs(0), 900);
});

test('createStreamSessionController commits replay cursor only after processed events', () => {
  const persisted = [];
  const sessionController = streamController.createStreamSessionController({
    getActiveChatId: () => 9,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    persistStreamCursor: (chatId, eventId) => persisted.push({ chatId: Number(chatId), eventId: Number(eventId) }),
    triggerIncomingMessageHaptic: () => {},
    incrementUnread: () => {},
    renderTabs: () => {},
  });

  assert.equal(sessionController.shouldSkipReplayedEvent(9, { _event_id: 7 }), false);
  assert.deepEqual(persisted, []);
  sessionController.commitProcessedStreamEvent(9, { _event_id: 7 });
  assert.equal(sessionController.shouldSkipReplayedEvent(9, { _event_id: 7 }), true);
  assert.deepEqual(persisted, [{ chatId: 9, eventId: 7 }]);

  const aborted = [];
  const first = { signal: { aborted: false }, abort: () => aborted.push('first') };
  const second = { signal: { aborted: false }, abort: () => aborted.push('second') };
  sessionController.setStreamAbortController(9, first);
  sessionController.setStreamAbortController(9, second);
  assert.deepEqual(aborted, ['first']);
  assert.equal(sessionController.hasLiveStreamController(9), true);
  sessionController.clearStreamAbortController(9, second);
  assert.equal(sessionController.hasLiveStreamController(9), false);
});

test('createStreamTranscriptController owns transcript signatures and active-chat fallback scheduling', () => {
  const syncCalls = [];
  const scheduledCalls = [];
  const sessionController = streamController.createStreamSessionController({
    getActiveChatId: () => 9,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    persistStreamCursor: () => {},
    triggerIncomingMessageHaptic: () => {},
    incrementUnread: () => {},
    renderTabs: () => {},
  });
  const transcriptController = streamController.createStreamTranscriptController({
    formatLatency: sharedUtils.formatLatency,
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: () => streamState.STREAM_PHASES.IDLE,
    setStreamPhase: () => {},
    chats: new Map(),
    pendingChats: new Set(),
    chatLabel: (chatId) => `chat-${chatId}`,
    compactChatLabel: (chatId) => `#${chatId}`,
    finalizeInlineToolTrace: () => {},
    updatePendingAssistant: () => {},
    markStreamUpdate: () => {},
    patchVisiblePendingAssistant: () => false,
    patchVisibleToolTrace: () => false,
    renderTraceLog: () => {},
    syncActiveMessageView: (chatId, options = {}) => syncCalls.push({ chatId: Number(chatId), options }),
    scheduleActiveMessageView: (chatId) => scheduledCalls.push(Number(chatId)),
    setChatLatency: () => {},
    incrementUnread: () => {},
    getActiveChatId: () => 9,
    triggerIncomingMessageHaptic: () => {},
    renderTabs: () => {},
    loadChatHistory: async () => ({ chat: { id: 9, pending: false }, history: [] }),
    upsertChat: () => {},
    histories: new Map(),
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: () => {},
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
    finalizeStreamPendingState: () => {},
    parseSseEvent: sharedUtils.parseSseEvent,
    streamDebugLog: () => {},
  }, sessionController);

  assert.equal(
    transcriptController.latestAssistantRenderSignature([{ role: 'assistant', body: 'hi', pending: true, file_refs: [{ ref_id: 'r1', path: '/tmp/a', label: 'A' }] }]),
    'assistant::hi::pending::r1:/tmp/a:A',
  );
  assert.equal(
    transcriptController.transcriptRenderSignature([{ role: 'tool', body: 'trace', pending: false, collapsed: true }]),
    'tool::trace::final::collapsed::',
  );

  transcriptController.reconcileVisibleTranscriptFallback(9);
  transcriptController.reconcileVisibleTranscriptFallback(12);
  assert.deepEqual(syncCalls, [{ chatId: 9, options: { preserveViewport: true } }]);
  assert.deepEqual(scheduledCalls, [12]);
});

test('stream controller exports transcript and lifecycle subcontrollers with stable ownership seams', () => {
  assert.equal(typeof streamController.createVisibleStreamStatusController, 'function');
  assert.equal(typeof streamController.createReplayCursorController, 'function');
  assert.equal(typeof streamController.createStreamAbortRegistry, 'function');
  assert.equal(typeof streamController.createFirstAssistantNotificationController, 'function');
  assert.equal(typeof streamController.createStreamEventDispatchController, 'function');
  assert.equal(typeof streamController.createSseStreamReadController, 'function');
  assert.equal(typeof streamController.createVisibleTranscriptFallbackController, 'function');
  assert.equal(typeof streamController.createStreamTerminalEventController, 'function');
  const terminalControllerExport = streamController.createStreamTerminalEventController;
  assert.equal(typeof terminalControllerExport, 'function');
  assert.equal(typeof streamController.createStreamMetaEventController, 'function');
  assert.equal(typeof streamController.createToolTraceEventController, 'function');
  assert.equal(typeof streamController.createAssistantChunkEventController, 'function');
  assert.equal(typeof streamController.createStreamErrorEventController, 'function');
  assert.equal(typeof streamController.createStreamNonTerminalEventController, 'function');
  assert.equal(typeof streamController.createStreamSendRequestController, 'function');
  assert.equal(typeof streamController.createStreamResumeAttemptController, 'function');
  assert.equal(typeof streamController.createTranscriptBufferController, 'function');
  assert.equal(typeof streamController.createTranscriptReadLoopController, 'function');

  const syncCalls = [];
  const scheduledCalls = [];
  const fallbackController = streamController.createVisibleTranscriptFallbackController({
    getActiveChatId: () => 9,
    syncActiveMessageView: (chatId, options = {}) => syncCalls.push({ chatId: Number(chatId), options }),
    scheduleActiveMessageView: (chatId) => scheduledCalls.push(Number(chatId)),
  });

  fallbackController.reconcileVisibleTranscriptFallback(9);
  fallbackController.reconcileVisibleTranscriptFallback(12);
  assert.deepEqual(syncCalls, [{ chatId: 9, options: { preserveViewport: true } }]);
  assert.deepEqual(scheduledCalls, [12]);

  const pendingAssistantUpdates = [];
  const latencyUpdates = [];
  const streamStatuses = [];
  const streamChips = [];
  const finalizedToolTraces = [];
  const patchedAssistantCalls = [];
  const patchedToolCalls = [];
  const hydrationCalls = [];
  const registeredHydrationPromises = [];
  const fallbackReconciles = [];
  const doneSessionController = {
    immediateFinalizedChats: new Set(),
    consumeFirstAssistantNotification: () => ({ messageKey: '', unreadIncremented: false }),
    setStreamStatusForVisibleChat: (chatId, text) => streamStatuses.push({ chatId: Number(chatId), text }),
    setStreamChipForVisibleChat: (chatId, text) => streamChips.push({ chatId: Number(chatId), text }),
    registerTerminalHydrationPromise: (chatId, promise) => {
      registeredHydrationPromises.push({ chatId: Number(chatId), hasPromise: Boolean(promise && typeof promise.then === 'function') });
      return promise;
    },
  };
  const terminalController = streamController.createStreamTerminalEventController({
    formatLatency: sharedUtils.formatLatency,
    getActiveChatId: () => 9,
    chatLabel: (chatId) => `chat-${chatId}`,
    compactChatLabel: (chatId) => `#${chatId}`,
    finalizeInlineToolTrace: (chatId) => finalizedToolTraces.push(Number(chatId)),
    updatePendingAssistant: (chatId, text, isStreaming) => pendingAssistantUpdates.push({ chatId: Number(chatId), text, isStreaming }),
    markStreamUpdate: () => {},
    patchVisiblePendingAssistant: (chatId, text, isStreaming) => {
      patchedAssistantCalls.push({ chatId: Number(chatId), text, isStreaming });
      return false;
    },
    patchVisibleToolTrace: (chatId) => {
      patchedToolCalls.push(Number(chatId));
      return false;
    },
    renderTraceLog: () => {},
    syncActiveMessageView: () => {
      throw new Error('terminal controller should use fallback controller when visible patching misses');
    },
    setChatLatency: (chatId, text) => latencyUpdates.push({ chatId: Number(chatId), text }),
    incrementUnread: () => {},
    triggerIncomingMessageHaptic: () => {},
    renderTabs: () => {},
    finalizeStreamPendingState: () => {},
    clearPendingStreamSnapshot: () => {},
  }, doneSessionController, {
    hydrateChatAfterGracefulResumeCompletion: async (chatId, options = {}) => hydrationCalls.push({ chatId: Number(chatId), options }),
  }, {
    reconcileVisibleTranscriptFallback: (chatId) => fallbackReconciles.push(Number(chatId)),
  });

  terminalController.applyDonePayload(9, { reply: 'done', latency_ms: 42 }, { value: '' });
  assert.equal(typeof terminalController.executeTerminalTransition, 'function');
  assert.equal(typeof terminalController.buildDoneTransition, 'function');
  assert.equal(typeof terminalController.buildEarlyCloseTransition, 'function');
  assert.deepEqual(finalizedToolTraces, [9]);
  assert.deepEqual(pendingAssistantUpdates, [{ chatId: 9, text: 'done', isStreaming: false }]);
  assert.deepEqual(patchedAssistantCalls, [{ chatId: 9, text: 'done', isStreaming: false }]);
  assert.deepEqual(patchedToolCalls, [9]);
  assert.deepEqual(fallbackReconciles, [9]);
  assert.deepEqual(hydrationCalls, [{ chatId: 9, options: { forceCompleted: true } }]);
  assert.deepEqual(registeredHydrationPromises, [{ chatId: 9, hasPromise: true }]);
  assert.deepEqual(latencyUpdates, [{ chatId: 9, text: '1s' }]);
  assert.deepEqual(streamStatuses, [{ chatId: 9, text: 'Reply received in chat-9' }]);
  assert.deepEqual(streamChips, [{ chatId: 9, text: 'stream: complete · #9' }]);
});

test('createStreamNonTerminalEventController accepts canonical tool event names and preserves phase metadata', () => {
  const harness = buildControllerHarness();
  const builtReplyRef = { value: '' };

  const handled = harness.controller.handleStreamEvent(9, 'tool.completed', {
    tool_name: 'read_file',
    preview: 'done',
    args: { path: '/tmp/x' },
    tool_call_id: 'call-1',
    message_id: 44,
  }, builtReplyRef);

  assert.equal(handled, false);
  assert.deepEqual(harness.markToolActivityCalls, [9]);
  assert.deepEqual(harness.toolTraceLines, [{ chatId: 9, text: 'done' }]);
});

test('stream session helper bands expose replay-cursor, abort-registry, and first-assistant notification ownership directly', () => {
  const persisted = [];
  const replay = streamController.createReplayCursorController({
    persistStreamCursor: (chatId, eventId) => persisted.push({ chatId: Number(chatId), eventId: Number(eventId) }),
  });
  assert.equal(replay.shouldSkipReplayedEvent(5, { _event_id: 2 }), false);
  replay.commitProcessedStreamEvent(5, { _event_id: 2 });
  assert.equal(replay.shouldSkipReplayedEvent(5, { _event_id: 2 }), true);
  assert.deepEqual(persisted, [{ chatId: 5, eventId: 2 }]);

  const aborted = [];
  const abortRegistry = streamController.createStreamAbortRegistry();
  const first = { signal: { aborted: false }, abort: () => aborted.push('first') };
  const second = { signal: { aborted: false }, abort: () => aborted.push('second') };
  abortRegistry.setStreamAbortController(5, first);
  abortRegistry.setStreamAbortController(5, second);
  assert.deepEqual(aborted, ['first']);
  assert.equal(abortRegistry.hasLiveStreamController(5), true);
  abortRegistry.clearStreamAbortController(5, second);
  assert.equal(abortRegistry.hasLiveStreamController(5), false);

  const unread = [];
  const notification = streamController.createFirstAssistantNotificationController({
    getActiveChatId: () => 9,
    triggerIncomingMessageHaptic: () => {},
    incrementUnread: (chatId) => unread.push(Number(chatId)),
    renderTabs: () => unread.push('render'),
  });
  assert.equal(notification.notifyFirstAssistantChunk(12), true);
  assert.deepEqual(unread, [12, 'render']);
  assert.deepEqual(notification.consumeFirstAssistantNotification(12), {
    messageKey: 'chat:12:assistant-stream:1',
    unreadIncremented: true,
  });
});

test('stream event helper bands expose direct meta/chunk/error ownership', () => {
  const phaseChanges = [];
  const statuses = [];
  const chips = [];
  const latencies = [];
  const updates = [];
  const fallbacks = [];
  const phases = new Map([[7, streamState.STREAM_PHASES.IDLE]]);
  const metaController = streamController.createStreamMetaEventController({
    formatLatency: sharedUtils.formatLatency,
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: (chatId) => phases.get(Number(chatId)) || streamState.STREAM_PHASES.IDLE,
    setStreamPhase: (chatId, phase) => {
      phases.set(Number(chatId), phase);
      phaseChanges.push({ chatId: Number(chatId), phase });
    },
    chatLabel: (chatId) => `chat-${chatId}`,
    compactChatLabel: (chatId) => `#${chatId}`,
    renderTraceLog: () => {},
    setChatLatency: (chatId, text) => latencies.push({ chatId: Number(chatId), text }),
  }, {
    setStreamStatusForVisibleChat: (chatId, text) => statuses.push({ chatId: Number(chatId), text }),
    setStreamChipForVisibleChat: (chatId, text) => chips.push({ chatId: Number(chatId), text }),
    setLatencyChipForVisibleChat: (chatId, text) => chips.push({ chatId: Number(chatId), text }),
  });
  metaController.handleMetaEvent(7, { detail: 'Running now', source: 'queue', job_status: 'running', elapsed_ms: 950 });
  assert.deepEqual(phaseChanges, [{ chatId: 7, phase: streamState.STREAM_PHASES.PENDING_TOOL }]);
  assert.deepEqual(statuses, [{ chatId: 7, text: 'Queue update (chat-7): Running now' }]);
  assert.deepEqual(chips, [
    { chatId: 7, text: 'stream: Running now · #7' },
    { chatId: 7, text: 'latency: 1s · live' },
  ]);
  assert.deepEqual(latencies, [{ chatId: 7, text: '1s · live' }]);

  const chunkController = streamController.createAssistantChunkEventController({
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: () => streamState.STREAM_PHASES.STREAMING_ASSISTANT,
    setStreamPhase: (chatId, phase) => updates.push({ type: 'phase', chatId: Number(chatId), phase }),
    updatePendingAssistant: (chatId, text, pending) => updates.push({ type: 'assistant', chatId: Number(chatId), text, pending }),
    markStreamUpdate: (chatId) => updates.push({ type: 'mark', chatId: Number(chatId) }),
    patchVisiblePendingAssistant: () => false,
    renderTraceLog: () => {},
  }, {
    notifyFirstAssistantChunk: (chatId) => updates.push({ type: 'notify', chatId: Number(chatId) }),
  }, {
    reconcileVisibleTranscriptFallback: (chatId) => fallbacks.push(Number(chatId)),
  });
  const builtReplyRef = { value: '' };
  chunkController.handleChunkEvent(7, { text: 'hello' }, builtReplyRef);
  assert.equal(builtReplyRef.value, 'hello');
  assert.deepEqual(fallbacks, [7]);
  const notifyIndex = updates.findIndex((entry) => entry.type === 'notify');
  const assistantIndex = updates.findIndex((entry) => entry.type === 'assistant' && entry.text === 'hello' && entry.pending === true);
  assert.notEqual(notifyIndex, -1);
  assert.notEqual(assistantIndex, -1);
  assert.equal(assistantIndex < notifyIndex, true);

  const errorController = streamController.createStreamErrorEventController({
    STREAM_PHASES: streamState.STREAM_PHASES,
    setStreamPhase: (chatId, phase) => updates.push({ type: 'error-phase', chatId: Number(chatId), phase }),
    finalizeInlineToolTrace: (chatId) => updates.push({ type: 'finalize-tools', chatId: Number(chatId) }),
    updatePendingAssistant: (chatId, text, pending) => updates.push({ type: 'error-text', chatId: Number(chatId), text, pending }),
    markStreamUpdate: (chatId) => updates.push({ type: 'error-mark', chatId: Number(chatId) }),
    syncActiveMessageView: (chatId, options = {}) => updates.push({ type: 'sync', chatId: Number(chatId), options }),
    setChatLatency: (chatId, text) => updates.push({ type: 'latency', chatId: Number(chatId), text }),
  }, {
    consumeFirstAssistantNotification: (chatId) => updates.push({ type: 'consume', chatId: Number(chatId) }),
    setStreamStatusForVisibleChat: (chatId, text) => updates.push({ type: 'status', chatId: Number(chatId), text }),
    setStreamChipForVisibleChat: (chatId, text) => updates.push({ type: 'chip', chatId: Number(chatId), text }),
  });
  assert.equal(errorController.handleErrorEvent(7, { error: 'boom' }), true);
  assert.ok(updates.some((entry) => entry.type === 'error-text' && entry.text === 'boom' && entry.pending === false));
  assert.ok(updates.some((entry) => entry.type === 'status' && entry.text === 'Stream error'));
});

test('transcript buffer/read-loop helpers expose direct consume ownership', async () => {
  const dispatched = [];
  const bufferController = streamController.createTranscriptBufferController({
    parseSseEvent: sharedUtils.parseSseEvent,
    dispatchController: {
      dispatchParsedEvent: (eventName, payload, state) => {
        dispatched.push({ eventName, payload });
        if (eventName === 'done') {
          state.terminalReceived = true;
          return true;
        }
        return false;
      },
    },
    renderTraceLog: () => {},
    streamDebugLog: () => {},
    shouldSkipReplayedEvent: () => false,
    chatId: 7,
    key: 7,
    builtReplyRef: { value: 'hi' },
  });
  const state = bufferController.createConsumeState();
  const rawEvents = bufferController.appendChunk(state, 'event: chunk\ndata: {"text":"a"}\n\n');
  assert.equal(state.buffer, '');
  bufferController.drainBufferedEvents(state, rawEvents);
  assert.deepEqual(dispatched, [{ eventName: 'chunk', payload: { text: 'a' } }]);

  const readerEvents = [];
  const readLoopController = streamController.createTranscriptReadLoopController({
    readerController: {
      async readChunk() {
        if (readerEvents.length) {
          return { done: true, text: '' };
        }
        readerEvents.push('read');
        return { done: false, text: 'event: done\ndata: {"reply":"ok"}\n\n' };
      },
      logReaderClosed: ({ chatId, terminalReceived }) => readerEvents.push({ chatId: Number(chatId), terminalReceived }),
    },
    bufferController: streamController.createTranscriptBufferController({
      parseSseEvent: sharedUtils.parseSseEvent,
      dispatchController: {
        dispatchParsedEvent: (eventName, payload, nextState) => {
          readerEvents.push({ eventName, payload });
          if (eventName === 'done') {
            nextState.terminalReceived = true;
            return true;
          }
          return false;
        },
      },
      renderTraceLog: () => {},
      streamDebugLog: () => {},
      shouldSkipReplayedEvent: () => false,
      chatId: 11,
      key: 11,
      builtReplyRef: { value: 'ok' },
    }),
    renderTraceLog: () => {},
    chatId: 11,
    builtReplyRef: { value: 'ok' },
  });
  const loopState = { buffer: '', terminalReceived: false, expectedSegmentEnd: false };
  await readLoopController.readUntilTerminal(loopState);
  const consumeResult = readLoopController.buildConsumeResult(loopState, false, 'fallback', () => {
    throw new Error('fallback should not run after terminal event');
  });
  assert.equal(consumeResult.terminalReceived, true);
  assert.equal(consumeResult.earlyClosed, false);
  assert.ok(readerEvents.some((entry) => entry.eventName === 'done'));
});

test('createStreamLifecycleController owns sendPrompt auth guard', async () => {
  const messages = [];
  const sessionController = streamController.createStreamSessionController({
    getActiveChatId: () => null,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    persistStreamCursor: () => {},
    triggerIncomingMessageHaptic: () => {},
    incrementUnread: () => {},
    renderTabs: () => {},
  });
  const transcriptController = {
    hydrateChatAfterGracefulResumeCompletion: async () => {},
    consumeStreamWithReconnect: async () => false,
  };
  const lifecycleController = streamController.createStreamLifecycleController({
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: () => streamState.STREAM_PHASES.IDLE,
    setStreamPhase: () => {},
    chats: new Map(),
    pendingChats: new Set(),
    chatLabel: (chatId) => `chat-${chatId}`,
    updatePendingAssistant: () => {},
    markStreamUpdate: () => {},
    syncActiveMessageView: () => {},
    getActiveChatId: () => null,
    messagesEl: null,
    promptEl: null,
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: (message) => messages.push(String(message)),
    finalizeStreamPendingState: () => {},
    renderTraceLog: () => {},
    authPayload: (payload) => payload,
    parseStreamErrorPayload: () => ({}),
    summarizeUiFailure: () => 'failed',
    getIsAuthenticated: () => false,
    setIsAuthenticated: () => {},
    authStatusEl: { textContent: '' },
    dropPendingToolTraceMessages: () => {},
    addLocalMessage: () => {},
    setDraft: () => {},
    resetToolStream: () => {},
    clearReconnectResumeBlock: () => {},
    resetReconnectResumeBudget: () => {},
    consumeReconnectResumeBudget: () => ({ allowed: true, attempts: 1, maxAttempts: 6 }),
    suppressBlockedChatPending: () => {},
    blockReconnectResume: () => {},
    isReconnectResumeBlocked: () => false,
    resumeAttemptedAtByChat: new Map(),
    resumeCooldownUntilByChat: new Map(),
    resumeInFlightByChat: new Set(),
    isTransientResumeRecoveryError: () => false,
    nextResumeRecoveryDelayMs: () => 0,
    delayMs: async () => {},
    markChatStreamPending: () => {},
    getStoredStreamCursor: () => null,
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
    isNearBottom: () => true,
    fetchImpl: async () => ({ ok: true, body: null, text: async () => '' }),
    setTimeoutFn: (fn) => fn(),
    finalizeInlineToolTrace: () => {},
    triggerIncomingMessageHaptic: () => {},
  }, sessionController, transcriptController);

  await lifecycleController.sendPrompt('hello');
  assert.deepEqual(messages, ['Still signing you in. Try again in a moment.']);
});

test('createStreamLifecycleController marks replacement sends with interrupt when chat is already pending', async () => {
  const fetchBodies = [];
  const previousDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible', activeElement: null };
  const sessionController = streamController.createStreamSessionController({
    getActiveChatId: () => 7,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    persistStreamCursor: () => {},
    triggerIncomingMessageHaptic: () => {},
    incrementUnread: () => {},
    renderTabs: () => {},
  });
  const transcriptController = {
    hydrateChatAfterGracefulResumeCompletion: async () => {},
    consumeStreamWithReconnect: async () => false,
  };
  const lifecycleController = streamController.createStreamLifecycleController({
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: () => streamState.STREAM_PHASES.PENDING_TOOL,
    setStreamPhase: () => {},
    chats: new Map([[7, { pending: true }]]),
    pendingChats: new Set([7]),
    chatLabel: (chatId) => `chat-${chatId}`,
    updatePendingAssistant: () => {},
    markStreamUpdate: () => {},
    syncActiveMessageView: () => {},
    getActiveChatId: () => 7,
    messagesEl: { scrollHeight: 0, clientHeight: 0, scrollTop: 0, focus: () => {} },
    promptEl: { value: '', selectionStart: 0, selectionEnd: 0 },
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: () => {},
    finalizeStreamPendingState: () => {},
    renderTraceLog: () => {},
    authPayload: (payload) => payload,
    parseStreamErrorPayload: () => ({}),
    summarizeUiFailure: () => 'failed',
    getIsAuthenticated: () => true,
    setIsAuthenticated: () => {},
    authStatusEl: { textContent: '' },
    dropPendingToolTraceMessages: () => {},
    addLocalMessage: () => {},
    setDraft: () => {},
    resetToolStream: () => {},
    clearReconnectResumeBlock: () => {},
    resetReconnectResumeBudget: () => {},
    consumeReconnectResumeBudget: () => ({ allowed: true, attempts: 1, maxAttempts: 6 }),
    suppressBlockedChatPending: () => {},
    blockReconnectResume: () => {},
    isReconnectResumeBlocked: () => false,
    resumeAttemptedAtByChat: new Map(),
    resumeCooldownUntilByChat: new Map(),
    resumeInFlightByChat: new Set(),
    isTransientResumeRecoveryError: () => false,
    nextResumeRecoveryDelayMs: () => 0,
    delayMs: async () => {},
    markChatStreamPending: () => {},
    getStoredStreamCursor: () => null,
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
    isNearBottom: () => true,
    fetchImpl: async (_url, options) => {
      fetchBodies.push(JSON.parse(String(options?.body || '{}')));
      return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) }, text: async () => '' };
    },
    setTimeoutFn: (fn) => fn(),
    finalizeInlineToolTrace: () => {},
    triggerIncomingMessageHaptic: () => {},
  }, sessionController, transcriptController);

  try {
    await lifecycleController.sendPrompt('replacement');

    assert.deepEqual(fetchBodies, [{ chat_id: 7, message: 'replacement', interrupt: true }]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('createStreamLifecycleController fails fast on unexpected send-path early close instead of auto-resuming recursively', async () => {
  const scheduled = [];
  const fetchCalls = [];
  const pendingAssistantUpdates = [];
  const streamPhases = [];
  const previousDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  const sessionController = streamController.createStreamSessionController({
    getActiveChatId: () => 7,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    persistStreamCursor: () => {},
    triggerIncomingMessageHaptic: () => {},
    incrementUnread: () => {},
    renderTabs: () => {},
  });
  const transcriptController = {
    hydrateChatAfterGracefulResumeCompletion: async () => {},
    consumeStreamWithReconnect: async (_chatId, _response, _builtReplyRef, options = {}) => {
      await options.onEarlyClose?.({ expectedSegmentEnd: false });
      return false;
    },
  };
  const lifecycleController = streamController.createStreamLifecycleController({
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: () => streamState.STREAM_PHASES.IDLE,
    setStreamPhase: (_chatId, phase) => { streamPhases.push(String(phase)); },
    chats: new Map([[7, { pending: false }]]),
    pendingChats: new Set(),
    chatLabel: (chatId) => `chat-${chatId}`,
    updatePendingAssistant: (_chatId, text) => { pendingAssistantUpdates.push(String(text)); },
    markStreamUpdate: () => {},
    syncActiveMessageView: () => {},
    getActiveChatId: () => 7,
    messagesEl: { scrollHeight: 0, clientHeight: 0, scrollTop: 0, focus: () => {} },
    promptEl: { value: '', selectionStart: 0, selectionEnd: 0 },
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: () => {},
    finalizeStreamPendingState: () => {},
    renderTraceLog: () => {},
    authPayload: (payload) => payload,
    parseStreamErrorPayload: () => ({}),
    summarizeUiFailure: (_message, { fallback } = {}) => String(fallback || 'failed'),
    getIsAuthenticated: () => true,
    setIsAuthenticated: () => {},
    authStatusEl: { textContent: '' },
    dropPendingToolTraceMessages: () => {},
    addLocalMessage: () => {},
    setDraft: () => {},
    resetToolStream: () => {},
    clearReconnectResumeBlock: () => {},
    resetReconnectResumeBudget: () => {},
    consumeReconnectResumeBudget: () => ({ allowed: true, attempts: 1, maxAttempts: 6 }),
    suppressBlockedChatPending: () => {},
    blockReconnectResume: () => {},
    isReconnectResumeBlocked: () => false,
    resumeAttemptedAtByChat: new Map(),
    resumeCooldownUntilByChat: new Map(),
    resumeInFlightByChat: new Set(),
    isTransientResumeRecoveryError: () => false,
    nextResumeRecoveryDelayMs: () => 0,
    delayMs: async () => {},
    markChatStreamPending: () => {},
    getStoredStreamCursor: () => null,
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
    isNearBottom: () => true,
    fetchImpl: async () => {
      fetchCalls.push('fetch');
      return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) }, text: async () => '' };
    },
    setTimeoutFn: (fn, delay) => {
      scheduled.push({ fn, delay });
      return scheduled.length;
    },
    finalizeInlineToolTrace: () => {},
    triggerIncomingMessageHaptic: () => {},
  }, sessionController, transcriptController);

  try {
    await lifecycleController.sendPrompt('hello');

    assert.equal(fetchCalls.length, 1);
    assert.equal(scheduled.length, 0);
    assert.equal(streamPhases.includes(streamState.STREAM_PHASES.ERROR), true);
    assert.equal(pendingAssistantUpdates.some((text) => /closed before completion/i.test(text)), true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('createStreamLifecycleController fails fast on unexpected resume early close and blocks reconnect churn', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible', activeElement: null };
  const sessionController = streamController.createStreamSessionController({
    getActiveChatId: () => 7,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    persistStreamCursor: () => {},
    triggerIncomingMessageHaptic: () => {},
    incrementUnread: () => {},
    renderTabs: () => {},
  });
  const chat = { pending: true };
  const blockedChats = [];
  const systemMessages = [];
  const finalizeCalls = [];
  const streamPhases = [];
  const transcriptController = {
    hydrateChatAfterGracefulResumeCompletion: async () => {},
    consumeStreamWithReconnect: async (_chatId, _response, _builtReplyRef, options = {}) => {
      await options.onEarlyClose?.({ expectedSegmentEnd: false });
      return false;
    },
  };
  const lifecycleController = streamController.createStreamLifecycleController({
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: () => streamState.STREAM_PHASES.PENDING_TOOL,
    setStreamPhase: (_chatId, phase) => { streamPhases.push(String(phase)); },
    chats: new Map([[7, chat]]),
    pendingChats: new Set([7]),
    chatLabel: (chatId) => `chat-${chatId}`,
    updatePendingAssistant: () => {},
    markStreamUpdate: () => {},
    syncActiveMessageView: () => {},
    getActiveChatId: () => 7,
    messagesEl: { scrollHeight: 0, clientHeight: 0, scrollTop: 0, focus: () => {} },
    promptEl: { value: '', selectionStart: 0, selectionEnd: 0 },
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: (text) => { systemMessages.push(String(text)); },
    finalizeStreamPendingState: (chatId, wasAborted) => {
      finalizeCalls.push({ chatId: Number(chatId), wasAborted: Boolean(wasAborted) });
      if (!wasAborted) {
        chat.pending = false;
      }
    },
    renderTraceLog: () => {},
    authPayload: (payload) => payload,
    parseStreamErrorPayload: () => ({}),
    summarizeUiFailure: (_message, { fallback } = {}) => String(fallback || 'failed'),
    getIsAuthenticated: () => true,
    setIsAuthenticated: () => {},
    authStatusEl: { textContent: '' },
    dropPendingToolTraceMessages: () => {},
    addLocalMessage: () => {},
    setDraft: () => {},
    resetToolStream: () => {},
    clearReconnectResumeBlock: () => {},
    resetReconnectResumeBudget: () => {},
    consumeReconnectResumeBudget: () => ({ allowed: true, attempts: 1, maxAttempts: 6 }),
    suppressBlockedChatPending: () => {},
    blockReconnectResume: (chatId) => { blockedChats.push(Number(chatId)); },
    isReconnectResumeBlocked: () => false,
    resumeAttemptedAtByChat: new Map(),
    resumeCooldownUntilByChat: new Map(),
    resumeInFlightByChat: new Set(),
    isTransientResumeRecoveryError: () => false,
    nextResumeRecoveryDelayMs: () => 0,
    delayMs: async () => {},
    markChatStreamPending: () => {},
    getStoredStreamCursor: () => null,
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
    isNearBottom: () => true,
    fetchImpl: async () => ({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) }, text: async () => '' }),
    setTimeoutFn: () => 0,
    finalizeInlineToolTrace: () => {},
    triggerIncomingMessageHaptic: () => {},
    syncActivePendingStatus: () => {},
    markReconnectFailed: () => {},
    markStreamReconnecting: () => {},
  }, sessionController, transcriptController);

  try {
    await lifecycleController.resumePendingChatStream(7, { force: true });

    assert.deepEqual(blockedChats, [7]);
    assert.equal(streamPhases.includes(streamState.STREAM_PHASES.ERROR), true);
    assert.equal(systemMessages.some((text) => /closed before completion/i.test(text)), true);
    assert.equal(systemMessages.some((text) => /paused/i.test(text)), true);
    assert.deepEqual(finalizeCalls, [{ chatId: 7, wasAborted: false }]);
    assert.equal(chat.pending, false);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('createStreamLifecycleController keeps pending state during transient resume retry backoff', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible', activeElement: null };
  const sessionController = streamController.createStreamSessionController({
    getActiveChatId: () => 7,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    persistStreamCursor: () => {},
    triggerIncomingMessageHaptic: () => {},
    incrementUnread: () => {},
    renderTabs: () => {},
  });
  const chat = { pending: true };
  const finalizeCalls = [];
  const reconnectCalls = [];
  const delayCalls = [];
  const pendingStatesDuringDelay = [];
  let fetchCount = 0;
  const lifecycleController = streamController.createStreamLifecycleController({
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: () => streamState.STREAM_PHASES.PENDING_TOOL,
    setStreamPhase: () => {},
    chats: new Map([[7, chat]]),
    pendingChats: new Set([7]),
    chatLabel: (chatId) => `chat-${chatId}`,
    updatePendingAssistant: () => {},
    markStreamUpdate: () => {},
    syncActiveMessageView: () => {},
    getActiveChatId: () => 7,
    messagesEl: { scrollHeight: 0, clientHeight: 0, scrollTop: 0, focus: () => {} },
    promptEl: { value: '', selectionStart: 0, selectionEnd: 0 },
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: () => {},
    finalizeStreamPendingState: (chatId, wasAborted) => {
      finalizeCalls.push({ chatId: Number(chatId), wasAborted: Boolean(wasAborted) });
      if (!wasAborted) {
        chat.pending = false;
      }
    },
    renderTraceLog: () => {},
    authPayload: (payload) => payload,
    parseStreamErrorPayload: () => ({}),
    summarizeUiFailure: () => 'failed',
    getIsAuthenticated: () => true,
    setIsAuthenticated: () => {},
    authStatusEl: { textContent: '' },
    dropPendingToolTraceMessages: () => {},
    addLocalMessage: () => {},
    setDraft: () => {},
    resetToolStream: () => {},
    clearReconnectResumeBlock: () => {},
    resetReconnectResumeBudget: () => {},
    consumeReconnectResumeBudget: () => ({ allowed: true, attempts: 1, maxAttempts: 6 }),
    suppressBlockedChatPending: () => {},
    blockReconnectResume: () => {},
    isReconnectResumeBlocked: () => false,
    resumeAttemptedAtByChat: new Map(),
    resumeCooldownUntilByChat: new Map(),
    resumeInFlightByChat: new Set(),
    isTransientResumeRecoveryError: (error) => /load failed/i.test(String(error?.message || '')),
    nextResumeRecoveryDelayMs: () => 0,
    delayMs: async (ms) => {
      delayCalls.push(Number(ms));
      pendingStatesDuringDelay.push(Boolean(chat.pending));
    },
    markChatStreamPending: () => {},
    getStoredStreamCursor: () => null,
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
    isNearBottom: () => true,
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        throw new Error('Load failed');
      }
      return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) }, text: async () => '' };
    },
    setTimeoutFn: () => 0,
    finalizeInlineToolTrace: () => {},
    triggerIncomingMessageHaptic: () => {},
    markStreamReconnecting: (chatId, details = {}) => {
      reconnectCalls.push({ chatId: Number(chatId), details: { ...details } });
    },
  }, sessionController, {
    hydrateChatAfterGracefulResumeCompletion: async () => {},
    consumeStreamWithReconnect: async () => false,
  });

  try {
    await lifecycleController.resumePendingChatStream(7, { force: true });

    assert.equal(fetchCount, 2);
    assert.deepEqual(delayCalls, [0]);
    assert.deepEqual(pendingStatesDuringDelay, [true]);
    assert.deepEqual(reconnectCalls, [
      {
        chatId: 7,
        details: { attempt: 1, maxAttempts: 3 },
      },
      {
        chatId: 7,
        details: { attempt: 2, maxAttempts: 3 },
      },
    ]);
    assert.deepEqual(finalizeCalls, [
      { chatId: 7, wasAborted: false },
    ]);
    assert.equal(chat.pending, false);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('createStreamLifecycleController reconciles transient send-path network failures to completed history before surfacing an error', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible', activeElement: null };
  const sessionController = streamController.createStreamSessionController({
    getActiveChatId: () => 7,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    persistStreamCursor: () => {},
    triggerIncomingMessageHaptic: () => {},
    incrementUnread: () => {},
    renderTabs: () => {},
  });
  const chat = { pending: false };
  let hydrateCalls = 0;
  const pendingAssistantUpdates = [];
  const scheduled = [];
  const transcriptController = {
    hydrateChatAfterGracefulResumeCompletion: async () => {
      hydrateCalls += 1;
      chat.pending = false;
    },
    consumeStreamWithReconnect: async () => false,
  };
  const lifecycleController = streamController.createStreamLifecycleController({
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: () => streamState.STREAM_PHASES.IDLE,
    setStreamPhase: () => {},
    chats: new Map([[7, chat]]),
    pendingChats: new Set(),
    chatLabel: (chatId) => `chat-${chatId}`,
    updatePendingAssistant: (_chatId, text) => { pendingAssistantUpdates.push(String(text)); },
    markStreamUpdate: () => {},
    syncActiveMessageView: () => {},
    getActiveChatId: () => 7,
    messagesEl: { scrollHeight: 0, clientHeight: 0, scrollTop: 0, focus: () => {} },
    promptEl: { value: '', selectionStart: 0, selectionEnd: 0 },
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: () => {},
    finalizeStreamPendingState: () => {},
    renderTraceLog: () => {},
    authPayload: (payload) => payload,
    parseStreamErrorPayload: () => ({}),
    summarizeUiFailure: () => 'failed',
    getIsAuthenticated: () => true,
    setIsAuthenticated: () => {},
    authStatusEl: { textContent: '' },
    dropPendingToolTraceMessages: () => {},
    addLocalMessage: () => {},
    setDraft: () => {},
    resetToolStream: () => {},
    clearReconnectResumeBlock: () => {},
    resetReconnectResumeBudget: () => {},
    consumeReconnectResumeBudget: () => ({ allowed: true, attempts: 1, maxAttempts: 6 }),
    suppressBlockedChatPending: () => {},
    blockReconnectResume: () => {},
    isReconnectResumeBlocked: () => false,
    resumeAttemptedAtByChat: new Map(),
    resumeCooldownUntilByChat: new Map(),
    resumeInFlightByChat: new Set(),
    isTransientResumeRecoveryError: (error) => /load failed/i.test(String(error?.message || '')),
    nextResumeRecoveryDelayMs: () => 0,
    delayMs: async () => {},
    markChatStreamPending: () => {},
    getStoredStreamCursor: () => null,
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
    isNearBottom: () => true,
    fetchImpl: async () => {
      throw new Error('Load failed');
    },
    setTimeoutFn: (fn, delay) => {
      scheduled.push({ fn, delay });
      return scheduled.length;
    },
    finalizeInlineToolTrace: () => {},
    triggerIncomingMessageHaptic: () => {},
  }, sessionController, transcriptController);

  try {
    await lifecycleController.sendPrompt('hello');

    assert.equal(hydrateCalls, 1);
    assert.deepEqual(pendingAssistantUpdates, []);
    assert.equal(scheduled.length, 0);
    assert.equal(chat.pending, false);
  } finally {
    globalThis.document = previousDocument;
  }
});
