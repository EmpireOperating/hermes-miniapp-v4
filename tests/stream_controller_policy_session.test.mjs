import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedUtils, streamState, streamController } from './stream_controller_test_harness.mjs';

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

test('createStreamLifecycleController defers send-path resume handoff until after finalize to avoid recursive stack growth', async () => {
  const scheduled = [];
  const fetchCalls = [];
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
    setStreamPhase: () => {},
    chats: new Map([[7, { pending: false }]]),
    pendingChats: new Set(),
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
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 0);
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
