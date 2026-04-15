import test from 'node:test';
import assert from 'node:assert/strict';
import { buildControllerHarness, makeSseResponse, sharedUtils, streamState, streamController } from './stream_controller_test_harness.mjs';

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

test('consumeStreamResponse increments unread for the selected active chat when the document is hidden', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { visibilityState: 'hidden' };
  try {
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

    const result = await harness.controller.consumeStreamResponse(9, stream.response, { value: '' }, {
      fallbackTraceEvent: 'stream-fallback-patch',
    });

    assert.equal(result.terminalReceived, true);
    assert.deepEqual(harness.unreadIncrements, [9]);
  } finally {
    if (typeof originalDocument === 'undefined') {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }
});

test('consumeStreamResponse immediately reconciles active chat on done even when visible patching succeeds', async () => {
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
  assert.deepEqual(syncedActiveRenders, [9]);
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

test('consumeStreamResponse fires unread and haptic together on done when operator switches away after an active first chunk', async () => {
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
  assert.equal(String(incomingHaptics[0].options?.messageKey || ''), 'chat:42:turn:2');
});

test('consumeStreamResponse does not fire early unread or haptic for visible active chat replies', async () => {
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
  assert.equal(incomingHaptics.length, 0);
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

test('consumeStreamResponse persists replay cursor only after non-terminal events and clears it on terminal done', async () => {
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
  ]);
  assert.deepEqual(harness.clearedCursors, [9, 9]);
});

test('consumeStreamResponse does not advance replay cursor when tool handling fails before local state is persisted', async () => {
  const appendCalls = [];
  let shouldThrow = true;
  const harness = buildControllerHarness({
    appendInlineToolTrace: (chatId, text) => {
      appendCalls.push({ chatId: Number(chatId), text: String(text || '') });
      if (shouldThrow) {
        throw new Error('tool append failed');
      }
    },
  });
  const first = makeSseResponse([
    'event: tool\n',
    'data: {"display":"read_file","_event_id":3}\n',
    '\n',
  ].join(''));

  await assert.rejects(
    harness.controller.consumeStreamResponse(9, first.response, { value: '' }, {
      fallbackTraceEvent: 'stream-fallback-patch',
      resetReplayCursor: true,
      suppressEarlyCloseFallback: true,
    }),
    /tool append failed/
  );

  assert.deepEqual(appendCalls, [{ chatId: 9, text: 'read_file' }]);
  assert.deepEqual(harness.persistedCursors, []);

  shouldThrow = false;
  const second = makeSseResponse([
    'event: tool\n',
    'data: {"display":"read_file","_event_id":3}\n',
    '\n',
  ].join(''));
  const result = await harness.controller.consumeStreamResponse(9, second.response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
    suppressEarlyCloseFallback: true,
  });

  assert.equal(result.terminalReceived, false);
  assert.equal(result.earlyClosed, true);
  assert.deepEqual(appendCalls, [
    { chatId: 9, text: 'read_file' },
    { chatId: 9, text: 'read_file' },
  ]);
  assert.deepEqual(harness.persistedCursors, [{ chatId: 9, eventId: 3 }]);
});
