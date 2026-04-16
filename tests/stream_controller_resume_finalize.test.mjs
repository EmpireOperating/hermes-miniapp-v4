import test from 'node:test';
import assert from 'node:assert/strict';
import { buildControllerHarness, makeSseResponse, sharedUtils, streamState, streamController } from './stream_controller_test_harness.mjs';

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

test('hydrateChatAfterGracefulResumeCompletion rerenders when rendered active transcript is stale even if hydrated history matches in-memory history', async () => {
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
    getRenderedTranscriptSignature: () => '0::assistant::older visible reply::final::::',
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

  assert.deepEqual(renderedMessages, [{ chatId: 9, options: { preserveViewport: true } }]);
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

test('hydrateChatAfterGracefulResumeCompletion can force completed chat state during terminal reconciliation without duplicating a pending local assistant', async () => {
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
  assert.deepEqual(histories.get(9), [
    { role: 'assistant', body: 'hydrated', pending: false },
  ]);
  assert.deepEqual(renderedMessages.at(-1), { chatId: 9, options: { preserveViewport: true } });
});

test('hydrateChatAfterGracefulResumeCompletion clears reconnect recovery state when terminal reconciliation is forced', async () => {
  const harness = buildControllerHarness({
    loadChatHistory: async (chatId) => ({
      chat: { id: Number(chatId), pending: true, title: `chat-${chatId}` },
      history: [{ role: 'assistant', body: 'hydrated', pending: true }],
    }),
  });

  await harness.controller.hydrateChatAfterGracefulResumeCompletion(9, { forceCompleted: true });

  assert.deepEqual(harness.clearedReconnectBlocks, [9]);
  assert.deepEqual(
    harness.timeoutCalls.filter((entry) => entry.type === 'reset-budget'),
    [{ type: 'reset-budget', chatId: 9 }],
  );
});

test('hydrateChatAfterGracefulResumeCompletion does not let inactive terminal reconciliation clear pending or overwrite unchanged transcript', async () => {
  const phases = new Map();
  const histories = new Map([[9, [{ role: 'assistant', body: 'old cached reply', pending: false }]]]);
  const chats = new Map([[9, { id: 9, pending: true, unread_count: 1 }]]);
  const pendingChats = new Set([9]);
  const chatsUpserted = [];
  const renderTraceLogs = [];
  const controller = streamController.createController({
    parseSseEvent: sharedUtils.parseSseEvent,
    formatLatency: sharedUtils.formatLatency,
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: (chatId) => phases.get(Number(chatId)) || streamState.STREAM_PHASES.IDLE,
    setStreamPhase: (chatId, phase) => phases.set(Number(chatId), phase),
    isPatchPhaseAllowed: () => false,
    chats,
    pendingChats,
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
    renderTraceLog: (eventName, details = {}) => renderTraceLogs.push({ eventName, details }),
    syncActiveMessageView: () => {},
    scheduleActiveMessageView: () => {},
    setChatLatency: () => {},
    incrementUnread: () => {},
    getActiveChatId: () => 0,
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
      chat: { id: 9, pending: false, unread_count: 0, title: 'chat-9' },
      history: [{ role: 'assistant', body: 'old cached reply', pending: false }],
    }),
    upsertChat: (chat) => chatsUpserted.push(chat),
    histories,
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: () => {},
    persistStreamCursor: () => {},
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
    clearReconnectResumeBlock: () => {},
    resetReconnectResumeBudget: () => {},
  });

  await controller.hydrateChatAfterGracefulResumeCompletion(9, { forceCompleted: true });

  assert.deepEqual(histories.get(9), [{ role: 'assistant', body: 'old cached reply', pending: false }]);
  assert.deepEqual(chatsUpserted, []);
  assert.equal(chats.get(9).pending, true);
  assert.equal(renderTraceLogs.at(-1)?.eventName, 'stream-done-hydrate-commit-check');
  assert.equal(renderTraceLogs.at(-1)?.details.skipped, true);
});

test('hydrateChatAfterGracefulResumeCompletion replaces a stale same-turn hydrated assistant with the completed local final reply instead of appending a duplicate', async () => {
  const phases = new Map();
  const histories = new Map([[9, [{ role: 'assistant', body: 'final local reply', pending: false }]]]);
  const renderedMessages = [];
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
    loadChatHistory: async () => ({
      chat: { id: 9, pending: false, title: 'chat-9' },
      history: [{ role: 'assistant', body: 'older server reply', pending: false }],
    }),
    upsertChat: () => {},
    histories,
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: (chatId, options = {}) => renderedMessages.push({ chatId: Number(chatId), options }),
    persistStreamCursor: () => {},
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
  });

  await controller.hydrateChatAfterGracefulResumeCompletion(9, { forceCompleted: true });

  assert.deepEqual(histories.get(9), [
    { role: 'assistant', body: 'final local reply', pending: false },
  ]);
  assert.deepEqual(renderedMessages, []);
});

test('hydrateChatAfterGracefulResumeCompletion keeps a newer hydrated assistant turn instead of reviving an older completed local reply', async () => {
  const phases = new Map();
  const histories = new Map([[9, [
    { role: 'user', body: 'older question', pending: false },
    { role: 'assistant', body: 'older local reply', pending: false },
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
        { role: 'user', body: 'older question', pending: false },
        { role: 'assistant', body: 'older server reply', pending: false },
        { role: 'user', body: 'newer question', pending: false },
        { role: 'assistant', body: 'newer hydrated reply', pending: false },
      ],
    }),
    upsertChat: () => {},
    histories,
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: () => {},
    persistStreamCursor: () => {},
    clearStreamCursor: () => {},
    clearPendingStreamSnapshot: () => {},
  });

  await controller.hydrateChatAfterGracefulResumeCompletion(9, { forceCompleted: true });

  assert.deepEqual(histories.get(9), [
    { role: 'user', body: 'older question', pending: false },
    { role: 'assistant', body: 'older server reply', pending: false },
    { role: 'user', body: 'newer question', pending: false },
    { role: 'assistant', body: 'newer hydrated reply', pending: false },
  ]);
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
  assert.deepEqual(harness.syncActiveViewportReadStateCalls, [[9, { atBottom: true }]]);
  assert.equal(harness.controller.hasLiveStreamController(9), false);
});

test('finalizeStreamLifecycle uses the shared viewport-read helper for active off-bottom completion', async () => {
  const harness = buildControllerHarness({
    isNearBottom: () => false,
  });
  const owningController = new AbortController();

  harness.controller.setStreamAbortController(9, owningController);
  await harness.controller.finalizeStreamLifecycle(9, owningController, { wasAborted: false });

  assert.deepEqual(harness.syncActiveViewportReadStateCalls, [[9, { atBottom: false }]]);
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
