import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharedUtils = require('../static/app_shared_utils.js');
const streamState = require('../static/stream_state_helpers.js');
const streamController = require('../static/stream_controller.js');

function buildControllerHarness(overrides = {}) {
  const phases = new Map();
  const pendingAssistantUpdates = [];
  const streamStatuses = [];
  const streamChipUpdates = [];
  const latencyUpdates = [];
  const chatsUpserted = [];
  const renderedMessages = [];
  const toolTraceLines = [];
  const streamDebugEvents = [];
  const finalizeCalls = [];
  const syncedActiveRenders = [];
  const scheduledActiveRenders = [];
  const persistedCursors = [];
  const clearedCursors = [];
  const incomingHaptics = [];
  const unreadIncrements = [];
  const renderTabsCalls = [];
  const markStreamCompleteCalls = [];
  const markToolActivityCalls = [];
  const markStreamActiveCalls = [];
  const markStreamErrorCalls = [];
  const markStreamClosedEarlyCalls = [];
  const markNetworkFailureCalls = [];
  const markStreamReconnectingCalls = [];
  const markResumeAlreadyCompleteCalls = [];
  const markReconnectFailedCalls = [];
  const systemMessages = [];
  const localMessages = [];
  const draftUpdates = [];
  const droppedPendingToolTraceChats = [];
  const authPayloads = [];
  const fetchCalls = [];
  const pendingChatsMarked = [];
  const clearedReconnectBlocks = [];
  const suppressedBlockedChats = [];
  const blockedReconnectChats = [];
  const delayedMs = [];
  const timeoutCalls = [];
  const resumeAttemptedAtByChat = new Map();
  const resumeCooldownUntilByChat = new Map();
  const resumeInFlightByChat = new Set();
  const histories = new Map();
  let isAuthenticated = true;
  const authStatusEl = { textContent: '' };
  let promptFocusCalls = 0;
  const promptEl = {
    value: '',
    focus: () => {
      promptFocusCalls += 1;
    },
  };

  const deps = {
    parseSseEvent: sharedUtils.parseSseEvent,
    formatLatency: sharedUtils.formatLatency,
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: (chatId) => phases.get(Number(chatId)) || streamState.STREAM_PHASES.IDLE,
    setStreamPhase: (chatId, phase) => phases.set(Number(chatId), phase),
    isPatchPhaseAllowed: () => false,
    chats: new Map(),
    pendingChats: new Set(),
    chatLabel: (chatId) => `chat-${chatId}`,
    compactChatLabel: (chatId) => `#${chatId}`,
    setStreamStatus: (value) => streamStatuses.push(String(value)),
    setActivityChip: (chip, value) => {
      if (chip === 'stream-chip') {
        streamChipUpdates.push(String(value));
      }
    },
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    finalizeInlineToolTrace: () => {},
    updatePendingAssistant: (chatId, text, isStreaming) => {
      pendingAssistantUpdates.push({ chatId: Number(chatId), text: String(text), isStreaming: Boolean(isStreaming) });
    },
    markStreamUpdate: () => {},
    patchVisiblePendingAssistant: () => false,
    patchVisibleToolTrace: () => false,
    renderTraceLog: () => {},
    syncActiveMessageView: (chatId) => { syncedActiveRenders.push(Number(chatId)); },
    scheduleActiveMessageView: (chatId) => { scheduledActiveRenders.push(Number(chatId)); },
    setChatLatency: (chatId, text) => latencyUpdates.push({ chatId: Number(chatId), text: String(text) }),
    incrementUnread: (chatId) => unreadIncrements.push(Number(chatId)),
    getActiveChatId: () => 9,
    triggerIncomingMessageHaptic: (chatId, options = {}) => {
      incomingHaptics.push({ chatId: Number(chatId), options });
    },
    messagesEl: null,
    promptEl,
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    isNearBottom: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => { renderTabsCalls.push(true); },
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: (message, chatId = null) => {
      systemMessages.push({ message: String(message || ''), chatId: chatId == null ? null : Number(chatId) });
    },
    streamDebugLog: (eventName, details = null) => {
      streamDebugEvents.push({ eventName: String(eventName || ''), details });
    },
    finalizeStreamPendingState: (chatId, wasAborted) => {
      finalizeCalls.push({ chatId: Number(chatId), wasAborted: Boolean(wasAborted) });
    },
    appendInlineToolTrace: (chatId, text) => {
      toolTraceLines.push({ chatId: Number(chatId), text: String(text || '') });
    },
    loadChatHistory: async (chatId, { activate } = {}) => ({
      chat: { id: Number(chatId), pending: false, title: `chat-${chatId}` },
      history: [{ role: 'assistant', body: 'hydrated', pending: false }],
      activate: Boolean(activate),
    }),
    upsertChat: (chat) => chatsUpserted.push(chat),
    histories,
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: (chatId, options = {}) => renderedMessages.push({ chatId: Number(chatId), options }),
    persistStreamCursor: (chatId, eventId) => persistedCursors.push({ chatId: Number(chatId), eventId: Number(eventId) }),
    clearStreamCursor: (chatId) => clearedCursors.push(Number(chatId)),
    markStreamComplete: (chatId, latencyText) => {
      const key = Number(chatId);
      const normalizedLatency = String(latencyText);
      markStreamCompleteCalls.push({ chatId: key, latencyText: normalizedLatency });
      latencyUpdates.push({ chatId: key, text: normalizedLatency });
      streamStatuses.push(`Reply received in chat-${key}`);
      streamChipUpdates.push(`stream: complete · #${key}`);
    },
    markToolActivity: (chatId) => {
      const key = Number(chatId);
      markToolActivityCalls.push(key);
      streamStatuses.push(`Using tools in chat-${key}`);
      streamChipUpdates.push(`stream: tools active · #${key}`);
    },
    markStreamActive: (chatId, options = {}) => {
      const key = Number(chatId);
      markStreamActiveCalls.push({ chatId: key, options: { ...options } });
      if (Number.isFinite(Number(options?.elapsedMs)) && Number(options.elapsedMs) >= 0) {
        latencyUpdates.push({ chatId: key, text: `${sharedUtils.formatLatency(Number(options.elapsedMs))} · live` });
      }
    },
    markStreamError: (chatId) => {
      const key = Number(chatId);
      markStreamErrorCalls.push(key);
      latencyUpdates.push({ chatId: key, text: '--' });
      streamStatuses.push('Stream error');
      streamChipUpdates.push('stream: error');
    },
    markStreamClosedEarly: (chatId) => {
      const key = Number(chatId);
      markStreamClosedEarlyCalls.push(key);
      latencyUpdates.push({ chatId: key, text: '--' });
      streamStatuses.push('Stream closed early');
      streamChipUpdates.push('stream: closed early');
    },
    ...overrides,
  };

  const controller = streamController.createController(deps);
  return {
    controller,
    phases,
    pendingAssistantUpdates,
    streamStatuses,
    streamChipUpdates,
    latencyUpdates,
    chatsUpserted,
    renderedMessages,
    toolTraceLines,
    streamDebugEvents,
    finalizeCalls,
    syncedActiveRenders,
    scheduledActiveRenders,
    persistedCursors,
    clearedCursors,
    incomingHaptics,
    unreadIncrements,
    renderTabsCalls,
    markStreamCompleteCalls,
    markToolActivityCalls,
    markStreamActiveCalls,
    markStreamErrorCalls,
    markStreamClosedEarlyCalls,
    systemMessages,
    histories,
    getPromptFocusCalls: () => promptFocusCalls,
  };
}

function makeSseResponse(rawFrame) {
  const bytes = new TextEncoder().encode(rawFrame);
  let index = 0;
  let cancelCalls = 0;
  const reader = {
    async read() {
      if (index === 0) {
        index += 1;
        return { value: bytes, done: false };
      }
      return { value: undefined, done: true };
    },
    async cancel() {
      cancelCalls += 1;
    },
  };

  return {
    response: {
      body: {
        getReader: () => reader,
      },
    },
    getCancelCalls: () => cancelCalls,
  };
}

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

test('createStreamSessionController owns replay cursor persistence and abort-controller lifecycle', () => {
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

test('consumeStreamResponse treats terminal error event as terminal and avoids early-close fallback', async () => {
  const harness = buildControllerHarness();
  const { response } = makeSseResponse('event: error\ndata: {"error":"backend boom"}\n\n');

  await harness.controller.consumeStreamResponse(9, response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(harness.phases.get(9), streamState.STREAM_PHASES.ERROR);
  assert.equal(harness.pendingAssistantUpdates.length, 1);
  assert.equal(harness.pendingAssistantUpdates[0].text, 'backend boom');
  assert.equal(harness.pendingAssistantUpdates[0].isStreaming, false);
  assert.equal(harness.pendingAssistantUpdates[0].text.includes('The response ended before completion.'), false);
  assert.equal(harness.streamStatuses.at(-1), 'Stream error');
  assert.equal(harness.streamChipUpdates.at(-1), 'stream: error');
  assert.deepEqual(harness.latencyUpdates.at(-1), { chatId: 9, text: '--' });
});

test('consumeStreamResponse stops on first terminal event and ignores trailing terminal frames', async () => {
  const harness = buildControllerHarness();
  const payload = [
    'event: done',
    'data: {"reply":"final answer","latency_ms":42,"turn_count":2}',
    '',
    'event: error',
    'data: {"error":"should-not-override"}',
    '',
  ].join('\n');
  const stream = makeSseResponse(payload);

  const result = await harness.controller.consumeStreamResponse(9, stream.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(result.terminalReceived, true);
  assert.equal(result.earlyClosed, false);
  assert.equal(harness.phases.get(9), streamState.STREAM_PHASES.FINALIZED);
  assert.equal(harness.pendingAssistantUpdates.length, 1);
  assert.equal(harness.pendingAssistantUpdates[0].text, 'final answer');
  assert.equal(harness.streamStatuses.at(-1), 'Reply received in chat-9');
  assert.equal(harness.streamChipUpdates.at(-1), 'stream: complete · #9');
  assert.deepEqual(harness.latencyUpdates.at(-1), { chatId: 9, text: '1s' });
  assert.deepEqual(harness.syncedActiveRenders, [9]);
  assert.deepEqual(harness.scheduledActiveRenders, []);
  assert.equal(stream.getCancelCalls(), 1);
  assert.equal(harness.pendingAssistantUpdates[0].text.includes('The response ended before completion.'), false);
  assert.deepEqual(harness.markStreamCompleteCalls, [{ chatId: 9, latencyText: '1s' }]);
  assert.deepEqual(harness.finalizeCalls, [{ chatId: 9, wasAborted: false }]);
});

test('consumeStreamResponse routes stream errors through markStreamError when available', async () => {
  const harness = buildControllerHarness();
  const payload = [
    'event: error',
    'data: {"error":"Hermes stream failed."}',
    '',
  ].join('\n');
  const stream = makeSseResponse(payload);

  const result = await harness.controller.consumeStreamResponse(42, stream.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(result.terminalReceived, true);
  assert.deepEqual(harness.markStreamErrorCalls, [42]);
  assert.deepEqual(harness.latencyUpdates.at(-1), { chatId: 42, text: '--' });
  assert.equal(harness.streamStatuses.at(-1), 'Stream error');
  assert.equal(harness.streamChipUpdates.at(-1), 'stream: error');
});

test('consumeStreamResponse routes tool activity through markToolActivity when available', async () => {
  const harness = buildControllerHarness();
  const payload = [
    'event: tool',
    'data: {"display":"running tool"}',
    '',
    'event: done',
    'data: {"reply":"done","latency_ms":42,"turn_count":2}',
    '',
  ].join('\n');
  const stream = makeSseResponse(payload);

  const result = await harness.controller.consumeStreamResponse(42, stream.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(result.terminalReceived, true);
  assert.deepEqual(harness.markToolActivityCalls, [42]);
});

test('consumeStreamResponse does not mark unseen/new-below for tool-only stream updates', async () => {
  const markStreamUpdateCalls = [];
  const harness = buildControllerHarness({
    markStreamUpdate: (chatId) => markStreamUpdateCalls.push(Number(chatId)),
  });
  const payload = [
    'event: tool',
    'data: {"display":"running tool"}',
    '',
    'event: done',
    'data: {"reply":"done","latency_ms":42,"turn_count":2}',
    '',
  ].join('\n');
  const stream = makeSseResponse(payload);

  const result = await harness.controller.consumeStreamResponse(42, stream.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(result.terminalReceived, true);
  assert.deepEqual(markStreamUpdateCalls, [42]);
});

test('consumeStreamResponse routes queue running latency through markStreamActive when available', async () => {
  const harness = buildControllerHarness();
  const payload = [
    'event: meta',
    'data: {"detail":"running","source":"queue","job_status":"running","elapsed_ms":4200}',
    '',
    'event: done',
    'data: {"reply":"done","latency_ms":4200,"turn_count":2}',
    '',
  ].join('\n');
  const stream = makeSseResponse(payload);

  const result = await harness.controller.consumeStreamResponse(42, stream.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(result.terminalReceived, true);
  assert.deepEqual(harness.markStreamActiveCalls, [{ chatId: 42, options: { elapsedMs: 4200 } }]);
});

test('consumeStreamResponse does not repaint visible queue status for inactive chats during queue meta updates', async () => {
  const harness = buildControllerHarness({
    markStreamComplete: () => {},
  });
  const payload = [
    'event: meta',
    'data: {"detail":"running","source":"queue","job_status":"running","elapsed_ms":4200}',
    '',
  ].join('\n');
  const { response } = makeSseResponse(payload);

  const result = await harness.controller.consumeStreamResponse(42, response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
    suppressEarlyCloseFallback: true,
  });

  assert.equal(result.terminalReceived, false);
  assert.deepEqual(harness.markStreamActiveCalls, [{ chatId: 42, options: { elapsedMs: 4200 } }]);
  assert.deepEqual(harness.streamStatuses, []);
  assert.deepEqual(harness.streamChipUpdates, []);
});

test('consumeStreamResponse tool fallback does not repaint visible stream pill for inactive chats', async () => {
  const harness = buildControllerHarness({
    markToolActivity: undefined,
  });
  const payload = [
    'event: tool',
    'data: {"display":"Running command"}',
    '',
  ].join('\n');
  const { response } = makeSseResponse(payload);

  const result = await harness.controller.consumeStreamResponse(42, response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
    suppressEarlyCloseFallback: true,
  });

  assert.equal(result.terminalReceived, false);
  assert.deepEqual(harness.streamStatuses, []);
  assert.deepEqual(harness.streamChipUpdates, []);
});

test('consumeStreamResponse preserves existing latency when queue running elapsed time is missing', async () => {
  const harness = buildControllerHarness({
    markStreamActive: undefined,
  });
  const payload = [
    'event: meta',
    'data: {"detail":"running","source":"queue","job_status":"running"}',
    '',
    'event: done',
    'data: {"reply":"done","latency_ms":4200,"turn_count":2}',
    '',
  ].join('\n');
  const { response } = makeSseResponse(payload);

  await harness.controller.consumeStreamResponse(42, response, { persistFinalState: false });

  assert.equal(harness.latencyUpdates.some((entry) => String(entry.text) === '--'), false);
  assert.equal(harness.latencyUpdates.some((entry) => /calculating/i.test(String(entry.text))), false);
});

test('consumeStreamResponse immediately reconciles active visible transcript when tool patching misses', async () => {
  const harness = buildControllerHarness();
  const payload = [
    'event: tool',
    'data: {"display":"running tool"}',
    '',
    'event: done',
    'data: {"reply":"done","latency_ms":42,"turn_count":2}',
    '',
  ].join('\n');
  const stream = makeSseResponse(payload);

  const result = await harness.controller.consumeStreamResponse(9, stream.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(result.terminalReceived, true);
  assert.deepEqual(harness.syncedActiveRenders, [9, 9]);
  assert.deepEqual(harness.scheduledActiveRenders, []);
});

test('consumeStreamResponse immediately reconciles active visible transcript when assistant patching misses', async () => {
  const harness = buildControllerHarness({
    patchVisibleToolTrace: () => true,
  });
  const payload = [
    'event: chunk',
    'data: {"text":"hello"}',
    '',
    'event: done',
    'data: {"reply":"hello","latency_ms":42,"turn_count":2}',
    '',
  ].join('\n');
  const stream = makeSseResponse(payload);

  const result = await harness.controller.consumeStreamResponse(9, stream.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(result.terminalReceived, true);
  assert.deepEqual(harness.syncedActiveRenders, [9, 9]);
  assert.deepEqual(harness.scheduledActiveRenders, []);
});

test('consumeStreamResponse still immediately reconciles active chat when document.visibilityState is hidden', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { visibilityState: 'hidden' };
  try {
    const harness = buildControllerHarness({
      patchVisibleToolTrace: () => true,
    });
    const payload = [
      'event: chunk',
      'data: {"text":"hello"}',
      '',
      'event: done',
      'data: {"reply":"hello","latency_ms":42,"turn_count":2}',
      '',
    ].join('\n');
    const stream = makeSseResponse(payload);

    const result = await harness.controller.consumeStreamResponse(9, stream.response, { value: '' }, {
      fallbackTraceEvent: 'stream-fallback-patch',
    });

    assert.equal(result.terminalReceived, true);
    assert.deepEqual(harness.syncedActiveRenders, [9, 9]);
    assert.deepEqual(harness.scheduledActiveRenders, []);
  } finally {
    if (typeof originalDocument === 'undefined') {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }
});

test('consumeStreamResponse skips immediate full reconcile on done when visible patching succeeds', async () => {
  const phases = new Map();
  const syncedActiveRenders = [];
  const renderedMessages = [];
  const controller = streamController.createController({
    parseSseEvent: sharedUtils.parseSseEvent,
    formatLatency: sharedUtils.formatLatency,
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: (chatId) => phases.get(Number(chatId)) || streamState.STREAM_PHASES.IDLE,
    setStreamPhase: (chatId, phase) => phases.set(Number(chatId), phase),
    isPatchPhaseAllowed: () => true,
    chats: new Map(),
    pendingChats: new Set(),
    chatLabel: (chatId) => `chat-${chatId}`,
    compactChatLabel: (chatId) => `#${chatId}`,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    finalizeInlineToolTrace: () => {},
    updatePendingAssistant: () => {},
    markStreamUpdate: () => {},
    patchVisiblePendingAssistant: () => true,
    patchVisibleToolTrace: () => true,
    renderTraceLog: () => {},
    syncActiveMessageView: (chatId) => { syncedActiveRenders.push(Number(chatId)); },
    scheduleActiveMessageView: () => {},
    setChatLatency: () => {},
    incrementUnread: () => {},
    getActiveChatId: () => 9,
    triggerIncomingMessageHaptic: () => {},
    messagesEl: null,
    promptEl: { focus: () => {} },
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: () => {},
    streamDebugLog: () => {},
    finalizeStreamPendingState: () => {},
    appendInlineToolTrace: () => {},
    loadChatHistory: async () => ({ chat: { id: 9, pending: false }, history: [{ role: 'assistant', body: 'final answer', pending: false }] }),
    upsertChat: () => {},
    histories: new Map([[9, [{ role: 'assistant', body: 'final answer', pending: false }]]]),
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: (chatId, options = {}) => renderedMessages.push({ chatId: Number(chatId), options }),
    persistStreamCursor: () => {},
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
    markStreamComplete: () => {},
  });

  const payload = [
    'event: done',
    'data: {"reply":"final answer","latency_ms":42,"turn_count":2}',
    '',
  ].join('\n');
  const stream = makeSseResponse(payload);
  const result = await controller.consumeStreamResponse(9, stream.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.terminalReceived, true);
  assert.deepEqual(syncedActiveRenders, []);
  assert.deepEqual(renderedMessages, []);
});

test('consumeStreamResponse notifies background chats on first assistant chunk without duplicating unread/haptic on done', async () => {
  const harness = buildControllerHarness();
  const payload = [
    'event: chunk',
    'data: {"text":"hello"}',
    '',
    'event: done',
    'data: {"reply":"hello","latency_ms":42,"turn_count":2}',
    '',
  ].join('\n');
  const stream = makeSseResponse(payload);

  const result = await harness.controller.consumeStreamResponse(42, stream.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(result.terminalReceived, true);
  assert.equal(harness.pendingAssistantUpdates.length, 2);
  assert.deepEqual(harness.unreadIncrements, [42]);
  assert.equal(harness.incomingHaptics.length, 1);
  assert.equal(harness.incomingHaptics[0].chatId, 42);
  assert.match(String(harness.incomingHaptics[0].options?.messageKey || ''), /^chat:42:assistant-stream:/);
  assert.equal(harness.renderTabsCalls.length, 1);
});

test('consumeStreamResponse does not refire haptic on done when first assistant chunk already fired one before operator switches away', async () => {
  let activeChatId = 42;
  const phases = new Map();
  const unreadIncrements = [];
  const incomingHaptics = [];
  const controller = streamController.createController({
    parseSseEvent: sharedUtils.parseSseEvent,
    formatLatency: sharedUtils.formatLatency,
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: (chatId) => phases.get(Number(chatId)) || streamState.STREAM_PHASES.IDLE,
    setStreamPhase: (chatId, phase) => phases.set(Number(chatId), phase),
    isPatchPhaseAllowed: () => false,
    chats: new Map(),
    pendingChats: new Set(),
    chatLabel: (chatId) => `chat-${chatId}`,
    compactChatLabel: (chatId) => `#${chatId}`,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    sourceChip: 'source-chip',
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    finalizeInlineToolTrace: () => {},
    updatePendingAssistant: () => {
      activeChatId = 99;
    },
    markStreamUpdate: () => {},
    patchVisiblePendingAssistant: () => false,
    patchVisibleToolTrace: () => false,
    renderTraceLog: () => {},
    syncActiveMessageView: () => {},
    scheduleActiveMessageView: () => {},
    setChatLatency: () => {},
    incrementUnread: (chatId) => unreadIncrements.push(Number(chatId)),
    getActiveChatId: () => activeChatId,
    triggerIncomingMessageHaptic: (chatId, options = {}) => incomingHaptics.push({ chatId: Number(chatId), options }),
    messagesEl: null,
    promptEl: { focus: () => {} },
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: () => {},
    streamDebugLog: () => {},
    finalizeStreamPendingState: () => {},
    appendInlineToolTrace: () => {},
    loadChatHistory: async () => ({ chat: { id: 42, pending: false }, history: [] }),
    upsertChat: () => {},
    histories: new Map(),
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: () => {},
    persistStreamCursor: () => {},
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
  });

  const payload = [
    'event: chunk',
    'data: {"text":"hello"}',
    '',
    'event: done',
    'data: {"reply":"hello","latency_ms":42,"turn_count":2}',
    '',
  ].join('\n');
  const stream = makeSseResponse(payload);
  const result = await controller.consumeStreamResponse(42, stream.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(result.terminalReceived, true);
  assert.deepEqual(unreadIncrements, [42]);
  assert.equal(incomingHaptics.length, 1);
  assert.match(String(incomingHaptics[0].options?.messageKey || ''), /^chat:42:assistant-stream:/);
});

test('consumeStreamResponse does not increment unread for visible active chat replies when first chunk already fired haptic', async () => {
  let activeChatId = 42;
  const phases = new Map();
  const unreadIncrements = [];
  const incomingHaptics = [];
  const controller = streamController.createController({
    parseSseEvent: sharedUtils.parseSseEvent,
    formatLatency: sharedUtils.formatLatency,
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: (chatId) => phases.get(Number(chatId)) || streamState.STREAM_PHASES.IDLE,
    setStreamPhase: (chatId, phase) => phases.set(Number(chatId), phase),
    isPatchPhaseAllowed: () => false,
    chats: new Map(),
    pendingChats: new Set(),
    chatLabel: (chatId) => `chat-${chatId}`,
    compactChatLabel: (chatId) => `#${chatId}`,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    sourceChip: 'source-chip',
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    finalizeInlineToolTrace: () => {},
    updatePendingAssistant: () => {},
    markStreamUpdate: () => {},
    patchVisiblePendingAssistant: () => false,
    patchVisibleToolTrace: () => false,
    renderTraceLog: () => {},
    syncActiveMessageView: () => {},
    scheduleActiveMessageView: () => {},
    setChatLatency: () => {},
    incrementUnread: (chatId) => unreadIncrements.push(Number(chatId)),
    getActiveChatId: () => activeChatId,
    triggerIncomingMessageHaptic: (chatId, options = {}) => incomingHaptics.push({ chatId: Number(chatId), options }),
    messagesEl: null,
    promptEl: { focus: () => {} },
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: () => {},
    streamDebugLog: () => {},
    finalizeStreamPendingState: () => {},
    appendInlineToolTrace: () => {},
    loadChatHistory: async () => ({ chat: { id: 42, pending: false }, history: [] }),
    upsertChat: () => {},
    histories: new Map(),
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: () => {},
    persistStreamCursor: () => {},
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
  });

  const payload = [
    'event: chunk',
    'data: {"text":"hello"}',
    '',
    'event: done',
    'data: {"reply":"hello","latency_ms":42,"turn_count":2}',
    '',
  ].join('\n');
  const stream = makeSseResponse(payload);
  const result = await controller.consumeStreamResponse(42, stream.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(result.terminalReceived, true);
  assert.deepEqual(unreadIncrements, []);
  assert.equal(incomingHaptics.length, 1);
  assert.match(String(incomingHaptics[0].options?.messageKey || ''), /^chat:42:assistant-stream:/);
});

test('consumeStreamResponse routes early-close fallback through markStreamClosedEarly when available', async () => {
  const harness = buildControllerHarness();
  const { response } = makeSseResponse('event: meta\ndata: {"detail":"running","source":"queue"}\n\n');

  const result = await harness.controller.consumeStreamResponse(9, response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
  });

  assert.equal(result.terminalReceived, false);
  assert.equal(result.earlyClosed, true);
  assert.deepEqual(harness.markStreamClosedEarlyCalls, [9]);
  assert.equal(harness.streamStatuses.includes('Stream closed early'), true);
  assert.equal(harness.streamChipUpdates.includes('stream: closed early'), true);
});

test('consumeStreamResponse can suppress early-close fallback and report non-terminal close', async () => {
  const harness = buildControllerHarness();
  const { response } = makeSseResponse('event: meta\ndata: {"detail":"running","source":"queue"}\n\n');

  const result = await harness.controller.consumeStreamResponse(9, response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
    suppressEarlyCloseFallback: true,
  });

  assert.equal(result.terminalReceived, false);
  assert.equal(result.earlyClosed, true);
  assert.equal(harness.pendingAssistantUpdates.length, 0);
  assert.equal(harness.streamStatuses.includes('Stream closed early'), false);
  assert.equal(harness.streamChipUpdates.includes('stream: closed early'), false);
});

test('consumeStreamResponse persists replay cursor and clears it on terminal done', async () => {
  const harness = buildControllerHarness();
  const { response } = makeSseResponse([
    'event: tool\n',
    'data: {"display":"read_file","_event_id":3}\n',
    '\n',
    'event: done\n',
    'data: {"reply":"ok","latency_ms":5,"turn_count":1,"_event_id":4}\n',
    '\n',
  ].join(''));

  const result = await harness.controller.consumeStreamResponse(9, response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
    resetReplayCursor: true,
  });

  assert.equal(result.terminalReceived, true);
  assert.deepEqual(harness.persistedCursors, [
    { chatId: 9, eventId: 3 },
    { chatId: 9, eventId: 4 },
  ]);
  assert.deepEqual(harness.clearedCursors, [9, 9]);
});

test('consumeStreamResponse parses CRLF-framed SSE events incrementally', async () => {
  const harness = buildControllerHarness();
  const { response } = makeSseResponse([
    'event: tool\r\n',
    'data: {"display":"read_file"}\r\n',
    '\r\n',
    'event: chunk\r\n',
    'data: {"text":"hello"}\r\n',
    '\r\n',
    'event: done\r\n',
    'data: {"reply":"hello","latency_ms":7,"turn_count":3}\r\n',
    '\r\n',
  ].join(''));

  const result = await harness.controller.consumeStreamResponse(9, response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
    suppressEarlyCloseFallback: true,
  });

  assert.equal(result.terminalReceived, true);
  assert.equal(result.earlyClosed, false);
  assert.equal(harness.pendingAssistantUpdates.at(-1)?.text, 'hello');
  assert.equal(harness.pendingAssistantUpdates.at(-1)?.isStreaming, false);
  assert.equal(harness.streamStatuses.at(-1), 'Reply received in chat-9');
  assert.equal(harness.streamChipUpdates.at(-1), 'stream: complete · #9');
  assert.deepEqual(harness.latencyUpdates.at(-1), { chatId: 9, text: '1s' });
});

test('hydrateChatAfterGracefulResumeCompletion merges hydrated history and rerenders active chat', async () => {
  const harness = buildControllerHarness();

  await harness.controller.hydrateChatAfterGracefulResumeCompletion(9);

  assert.equal(harness.chatsUpserted.length, 1);
  assert.deepEqual(harness.histories.get(9), [{ role: 'assistant', body: 'hydrated', pending: false }]);
  assert.deepEqual(harness.renderedMessages.at(-1), { chatId: 9, options: { preserveViewport: true } });
});

test('hydrateChatAfterGracefulResumeCompletion skips rerender when hydrated assistant only gains a server id', async () => {
  const phases = new Map();
  const renderedMessages = [];
  const histories = new Map([[9, [{ role: 'assistant', body: 'same reply', pending: false }]]]);
  const controller = streamController.createController({
    parseSseEvent: sharedUtils.parseSseEvent,
    formatLatency: sharedUtils.formatLatency,
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: (chatId) => phases.get(Number(chatId)) || streamState.STREAM_PHASES.IDLE,
    setStreamPhase: (chatId, phase) => phases.set(Number(chatId), phase),
    isPatchPhaseAllowed: () => false,
    chats: new Map([[9, { id: 9, pending: false }]]),
    pendingChats: new Set(),
    chatLabel: (chatId) => `chat-${chatId}`,
    compactChatLabel: (chatId) => `#${chatId}`,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    finalizeInlineToolTrace: () => {},
    updatePendingAssistant: () => {},
    markStreamUpdate: () => {},
    patchVisiblePendingAssistant: () => false,
    patchVisibleToolTrace: () => false,
    renderTraceLog: () => {},
    syncActiveMessageView: () => {},
    scheduleActiveMessageView: () => {},
    setChatLatency: () => {},
    incrementUnread: () => {},
    getActiveChatId: () => 9,
    triggerIncomingMessageHaptic: () => {},
    messagesEl: null,
    promptEl: { focus: () => {} },
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: () => {},
    streamDebugLog: () => {},
    finalizeStreamPendingState: () => {},
    appendInlineToolTrace: () => {},
    loadChatHistory: async () => ({
      chat: { id: 9, pending: false, title: 'chat-9' },
      history: [{ id: 101, role: 'assistant', body: 'same reply', pending: false }],
    }),
    upsertChat: () => {},
    histories,
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: (chatId, options = {}) => renderedMessages.push({ chatId: Number(chatId), options }),
    persistStreamCursor: () => {},
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
  });

  await controller.hydrateChatAfterGracefulResumeCompletion(9);

  assert.deepEqual(renderedMessages, []);
  assert.deepEqual(histories.get(9), [{ id: 101, role: 'assistant', body: 'same reply', pending: false }]);
});

test('hydrateChatAfterGracefulResumeCompletion rerenders when hydrated transcript removes stale trailing tool activity after identical final assistant text', async () => {
  const phases = new Map();
  const renderedMessages = [];
  const histories = new Map([[9, [
    { role: 'tool', body: 'Preparing final answer', pending: false, collapsed: true },
    { role: 'assistant', body: 'same reply', pending: false },
    { role: 'tool', body: 'Finishing…', pending: false, collapsed: true },
  ]]]);
  const controller = streamController.createController({
    parseSseEvent: sharedUtils.parseSseEvent,
    formatLatency: sharedUtils.formatLatency,
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: (chatId) => phases.get(Number(chatId)) || streamState.STREAM_PHASES.IDLE,
    setStreamPhase: (chatId, phase) => phases.set(Number(chatId), phase),
    isPatchPhaseAllowed: () => false,
    chats: new Map([[9, { id: 9, pending: false }]]),
    pendingChats: new Set(),
    chatLabel: (chatId) => `chat-${chatId}`,
    compactChatLabel: (chatId) => `#${chatId}`,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    finalizeInlineToolTrace: () => {},
    updatePendingAssistant: () => {},
    markStreamUpdate: () => {},
    patchVisiblePendingAssistant: () => false,
    patchVisibleToolTrace: () => false,
    renderTraceLog: () => {},
    syncActiveMessageView: () => {},
    scheduleActiveMessageView: () => {},
    setChatLatency: () => {},
    incrementUnread: () => {},
    getActiveChatId: () => 9,
    triggerIncomingMessageHaptic: () => {},
    messagesEl: null,
    promptEl: { focus: () => {} },
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: () => {},
    streamDebugLog: () => {},
    finalizeStreamPendingState: () => {},
    appendInlineToolTrace: () => {},
    loadChatHistory: async () => ({
      chat: { id: 9, pending: false, title: 'chat-9' },
      history: [
        { role: 'tool', body: 'Preparing final answer', pending: false, collapsed: true },
        { id: 101, role: 'assistant', body: 'same reply', pending: false },
      ],
    }),
    upsertChat: () => {},
    histories,
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: (chatId, options = {}) => renderedMessages.push({ chatId: Number(chatId), options }),
    persistStreamCursor: () => {},
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
  });

  await controller.hydrateChatAfterGracefulResumeCompletion(9);

  assert.deepEqual(renderedMessages, [{ chatId: 9, options: { preserveViewport: true } }]);
  assert.deepEqual(histories.get(9), [
    { role: 'tool', body: 'Preparing final answer', pending: false, collapsed: true },
    { id: 101, role: 'assistant', body: 'same reply', pending: false },
  ]);
});

test('hydrateChatAfterGracefulResumeCompletion can force completed chat state during terminal reconciliation', async () => {
  const phases = new Map();
  const chatsUpserted = [];
  const renderedMessages = [];
  const histories = new Map([[9, [{ role: 'assistant', body: 'partial', pending: true }]]]);
  const controller = streamController.createController({
    parseSseEvent: sharedUtils.parseSseEvent,
    formatLatency: sharedUtils.formatLatency,
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: (chatId) => phases.get(Number(chatId)) || streamState.STREAM_PHASES.IDLE,
    setStreamPhase: (chatId, phase) => phases.set(Number(chatId), phase),
    isPatchPhaseAllowed: () => false,
    chats: new Map([[9, { id: 9, pending: true }]]),
    pendingChats: new Set([9]),
    chatLabel: (chatId) => `chat-${chatId}`,
    compactChatLabel: (chatId) => `#${chatId}`,
    setStreamStatus: () => {},
    setActivityChip: () => {},
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    finalizeInlineToolTrace: () => {},
    updatePendingAssistant: () => {},
    markStreamUpdate: () => {},
    patchVisiblePendingAssistant: () => false,
    patchVisibleToolTrace: () => false,
    renderTraceLog: () => {},
    syncActiveMessageView: () => {},
    scheduleActiveMessageView: () => {},
    setChatLatency: () => {},
    incrementUnread: () => {},
    getActiveChatId: () => 9,
    triggerIncomingMessageHaptic: () => {},
    messagesEl: null,
    promptEl: { focus: () => {} },
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    maybeMarkRead: () => {},
    refreshChats: async () => {},
    renderTabs: () => {},
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: () => {},
    streamDebugLog: () => {},
    finalizeStreamPendingState: () => {},
    appendInlineToolTrace: () => {},
    loadChatHistory: async (chatId, { activate } = {}) => ({
      chat: { id: Number(chatId), pending: true, title: `chat-${chatId}` },
      history: [{ role: 'assistant', body: 'hydrated', pending: false }],
      activate: Boolean(activate),
    }),
    upsertChat: (chat) => chatsUpserted.push(chat),
    histories,
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: (chatId, options = {}) => renderedMessages.push({ chatId: Number(chatId), options }),
    persistStreamCursor: () => {},
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
  });

  await controller.hydrateChatAfterGracefulResumeCompletion(9, { forceCompleted: true });

  assert.deepEqual(chatsUpserted.at(-1), { id: 9, pending: false, title: 'chat-9' });
  assert.deepEqual(histories.get(9), [{ role: 'assistant', body: 'hydrated', pending: false }]);
  assert.deepEqual(renderedMessages.at(-1), { chatId: 9, options: { preserveViewport: true } });
});

test('consumeStreamWithReconnect invokes reconnect callback only on early close', async () => {
  const harness = buildControllerHarness();
  let earlyCloseCalls = 0;
  let earlyCloseDetails = null;
  const { response } = makeSseResponse('event: meta\ndata: {"detail":"running","source":"queue"}\n\n');

  const resumed = await harness.controller.consumeStreamWithReconnect(9, response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
    onEarlyClose: async (details = null) => {
      earlyCloseCalls += 1;
      earlyCloseDetails = details;
    },
  });

  assert.equal(resumed, true);
  assert.equal(earlyCloseCalls, 1);
  assert.equal(Boolean(earlyCloseDetails?.expectedSegmentEnd), false);
});

test('consumeStreamWithReconnect reports expected segment rollovers to the reconnect callback', async () => {
  const harness = buildControllerHarness();
  let earlyCloseDetails = null;
  const { response } = makeSseResponse('event: meta\ndata: {"detail":"stream segment rollover","source":"queue","stream_segment_end":true,"resume_recommended":true}\n\n');

  const resumed = await harness.controller.consumeStreamWithReconnect(9, response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
    onEarlyClose: async (details = null) => {
      earlyCloseDetails = details;
    },
  });

  assert.equal(resumed, true);
  assert.equal(Boolean(earlyCloseDetails?.expectedSegmentEnd), true);
});

test('consumeStreamResponse skips replayed events using monotonic _event_id across reconnects', async () => {
  const harness = buildControllerHarness();

  const first = makeSseResponse([
    'event: tool\n',
    'data: {"display":"read_file","_event_id":1}\n',
    '\n',
  ].join(''));

  const firstResult = await harness.controller.consumeStreamResponse(9, first.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
    suppressEarlyCloseFallback: true,
    resetReplayCursor: true,
  });

  assert.equal(firstResult.terminalReceived, false);
  assert.equal(firstResult.earlyClosed, true);
  assert.equal(harness.toolTraceLines.length, 1);
  assert.equal(harness.toolTraceLines[0].text, 'read_file');

  const second = makeSseResponse([
    'event: tool\n',
    'data: {"display":"read_file","_event_id":1}\n',
    '\n',
    'event: tool\n',
    'data: {"display":"search_files","_event_id":2}\n',
    '\n',
    'event: done\n',
    'data: {"reply":"ok","latency_ms":9,"turn_count":4,"_event_id":3}\n',
    '\n',
  ].join(''));

  const secondResult = await harness.controller.consumeStreamResponse(9, second.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
    suppressEarlyCloseFallback: true,
  });

  assert.equal(secondResult.terminalReceived, true);
  assert.equal(secondResult.earlyClosed, false);
  assert.deepEqual(
    harness.toolTraceLines.map((entry) => entry.text),
    ['read_file', 'search_files'],
  );
  assert.equal(harness.pendingAssistantUpdates.at(-1)?.text, 'ok');

});

test('finalizeStreamLifecycle skips stale controller handoff cleanup when stream ownership changed', async () => {
  const harness = buildControllerHarness();
  const previousController = new AbortController();
  const replacementController = new AbortController();

  harness.controller.setStreamAbortController(9, previousController);
  harness.controller.setStreamAbortController(9, replacementController);

  await harness.controller.finalizeStreamLifecycle(9, previousController, { wasAborted: false });

  assert.equal(harness.finalizeCalls.length, 0);
  assert.equal(harness.controller.hasLiveStreamController(9), true);
});

test('finalizeStreamLifecycle does not clear pending state for owning aborted controller handoff', async () => {
  const harness = buildControllerHarness();
  const owningController = new AbortController();

  harness.controller.setStreamAbortController(9, owningController);
  await harness.controller.finalizeStreamLifecycle(9, owningController, { wasAborted: true });

  assert.deepEqual(harness.finalizeCalls, []);
  assert.equal(harness.controller.hasLiveStreamController(9), false);
});

test('finalizeStreamLifecycle finalizes pending state for owning non-aborted stream controller', async () => {
  const harness = buildControllerHarness();
  const owningController = new AbortController();

  harness.controller.setStreamAbortController(9, owningController);
  await harness.controller.finalizeStreamLifecycle(9, owningController, { wasAborted: false });

  assert.deepEqual(harness.finalizeCalls, [{ chatId: 9, wasAborted: false }]);
  assert.equal(harness.controller.hasLiveStreamController(9), false);
});

test('finalizeStreamLifecycle does not refocus the composer on completion', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  try {
    const harness = buildControllerHarness({
      isDesktopViewport: () => false,
      messagesEl: {
        scrollHeight: 100,
        clientHeight: 100,
        scrollTop: 0,
      },
    });
    const owningController = new AbortController();

    harness.controller.setFocusRestoreEligibility(9, true);
    harness.controller.setStreamAbortController(9, owningController);
    await harness.controller.finalizeStreamLifecycle(9, owningController, { wasAborted: false });

    assert.equal(harness.getPromptFocusCalls(), 0);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('createToolTraceController upserts tool deltas by message_id + tool_call_id + phase', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);
  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, '📖 read_file: opening', {
    message_id: 'm-1',
    tool_call_id: 'tc-1',
    phase: 'started',
  });
  toolTrace.appendInlineToolTrace(7, '📖 read_file: loaded 100 bytes', {
    message_id: 'm-1',
    tool_call_id: 'tc-1',
    phase: 'started',
  });
  toolTrace.appendInlineToolTrace(7, '📖 read_file: done', {
    message_id: 'm-1',
    tool_call_id: 'tc-1',
    phase: 'completed',
  });

  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.body, '📖 read_file: loaded 100 bytes\n📖 read_file: done');

  toolTrace.finalizeInlineToolTrace(7);
  const finalized = histories.get(7)[0];
  assert.equal(finalized.body, '📖 read_file: loaded 100 bytes\n📖 read_file: done');
  assert.equal('_toolTraceOrder' in finalized, false);
  assert.equal('_toolTraceLines' in finalized, false);
});

test('createToolTraceController appends pending tool traces and preserves open state across finalize', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, 'read_file');
  toolTrace.appendInlineToolTrace(7, 'search_files');

  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.body, 'read_file\nsearch_files');
  assert.equal(pending.collapsed, false);

  toolTrace.finalizeInlineToolTrace(7);
  const finalized = histories.get(7)[0];
  assert.equal(finalized.role, 'tool');
  assert.equal(finalized.pending, false);
  assert.equal(finalized.collapsed, false);
  assert.equal(finalized.body, 'read_file\nsearch_files');
});

test('createToolTraceController preserves restored tool lines when resumed tool events gain dedupe ids', () => {
  const histories = new Map([[7, [{ role: 'tool', body: 'read_file\nsearch_files', pending: true, collapsed: false }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, 'apply_patch', {
    message_id: 'm-2',
    tool_call_id: 'tc-3',
    phase: 'started',
  });

  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.body, 'read_file\nsearch_files\napply_patch');
  assert.deepEqual(pending._toolTraceOrder, ['__restored__0', '__restored__1', 'm-2::tc-3::started']);
  assert.equal(pending._toolTraceLines['__restored__0'], 'read_file');
  assert.equal(pending._toolTraceLines['__restored__1'], 'search_files');
  assert.equal(pending._toolTraceLines['m-2::tc-3::started'], 'apply_patch');
});

test('createToolTraceController preserves repeated restored tool lines before resumed deduped events', () => {
  const histories = new Map([[7, [{ role: 'tool', body: 'read_file\nsearch_files\nread_file', pending: true, collapsed: false }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, 'apply_patch', {
    message_id: 'm-2',
    tool_call_id: 'tc-4',
    phase: 'started',
  });

  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.body, 'read_file\nsearch_files\nread_file\napply_patch');
});

test('createToolTraceController preserves explicit collapsed state across finalize', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, 'read_file');
  const pending = toolTrace.findPendingToolTraceMessage(7);
  pending.collapsed = true;

  toolTrace.finalizeInlineToolTrace(7);
  const finalized = histories.get(7)[0];
  assert.equal(finalized.pending, false);
  assert.equal(finalized.collapsed, true);
});

test('createToolTraceController tolerates detached tool stream UI removal', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, 'read_file');
  toolTrace.appendInlineToolTrace(7, 'search_files');

  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(pending.body, 'read_file\nsearch_files');
  assert.doesNotThrow(() => toolTrace.resetToolStream());
});

test('createToolTraceController can drop stale pending tool traces before a new run starts', () => {
  const histories = new Map([[7, [
    { role: 'tool', body: 'old run tool A', pending: true, collapsed: false },
    { role: 'tool', body: 'old run tool B', pending: true, collapsed: false },
    { role: 'assistant', body: 'completed reply', pending: false },
  ]]]);
  const persisted = [];

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
    persistPendingStreamSnapshot: (chatId) => persisted.push(Number(chatId)),
  });

  const changed = toolTrace.dropPendingToolTraceMessages(7);

  assert.equal(changed, true);
  assert.deepEqual(histories.get(7), [
    { role: 'assistant', body: 'completed reply', pending: false },
  ]);
  assert.equal(toolTrace.findPendingToolTraceMessage(7), null);
  assert.deepEqual(persisted, [7]);

  toolTrace.appendInlineToolTrace(7, 'new run tool');
  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.body, 'new run tool');
  assert.deepEqual(persisted, [7, 7]);
});

test('createToolTraceController snapshots pending trace mutations inside the helper owner', () => {
  const histories = new Map([[9, [{ role: 'assistant', body: 'pending', pending: true }]]]);
  const persisted = [];

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
    persistPendingStreamSnapshot: (chatId) => persisted.push(Number(chatId)),
  });

  toolTrace.appendInlineToolTrace(9, 'read_file');
  toolTrace.appendInlineToolTrace(9, 'search_files');
  toolTrace.finalizeInlineToolTrace(9);

  assert.deepEqual(persisted, [9, 9, 9]);
  assert.equal(histories.get(9)[0].pending, false);
  assert.equal(histories.get(9)[0].body, 'read_file\nsearch_files');
});

test('createToolTraceController drops empty finalized traces after detached tool stream removal', () => {
  const histories = new Map([[5, [{ role: 'tool', body: '   ', pending: true, collapsed: false }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.finalizeInlineToolTrace(5);
  assert.equal(histories.get(5).length, 0);

  assert.doesNotThrow(() => toolTrace.resetToolStream());
});

