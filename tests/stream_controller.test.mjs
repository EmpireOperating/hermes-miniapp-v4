import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharedUtils = require('../static/app_shared_utils.js');
const streamState = require('../static/stream_state_helpers.js');
const streamController = require('../static/stream_controller.js');

function buildControllerHarness() {
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
  const persistedCursors = [];
  const clearedCursors = [];
  const histories = new Map();

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
    sourceChip: 'source-chip',
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
    syncActiveMessageView: () => {},
    scheduleActiveMessageView: () => {},
    setChatLatency: (chatId, text) => latencyUpdates.push({ chatId: Number(chatId), text: String(text) }),
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
    persistedCursors,
    clearedCursors,
    histories,
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
  assert.deepEqual(harness.latencyUpdates.at(-1), { chatId: 9, text: '42 ms' });
  assert.equal(stream.getCancelCalls(), 1);
  assert.equal(harness.pendingAssistantUpdates[0].text.includes('The response ended before completion.'), false);
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
  assert.deepEqual(harness.latencyUpdates.at(-1), { chatId: 9, text: '7 ms' });
});

test('hydrateChatAfterGracefulResumeCompletion merges hydrated history and rerenders active chat', async () => {
  const harness = buildControllerHarness();

  await harness.controller.hydrateChatAfterGracefulResumeCompletion(9);

  assert.equal(harness.chatsUpserted.length, 1);
  assert.deepEqual(harness.histories.get(9), [{ role: 'assistant', body: 'hydrated', pending: false }]);
  assert.deepEqual(harness.renderedMessages.at(-1), { chatId: 9, options: { preserveViewport: true } });
});

test('consumeStreamWithReconnect invokes reconnect callback only on early close', async () => {
  const harness = buildControllerHarness();
  let earlyCloseCalls = 0;
  const { response } = makeSseResponse('event: meta\ndata: {"detail":"running","source":"queue"}\n\n');

  const resumed = await harness.controller.consumeStreamWithReconnect(9, response, { value: '' }, {
    fallbackTraceEvent: 'stream-fallback-patch',
    onEarlyClose: async () => {
      earlyCloseCalls += 1;
    },
  });

  assert.equal(resumed, true);
  assert.equal(earlyCloseCalls, 1);
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

test('createToolTraceController upserts tool deltas by message_id + tool_call_id + phase', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);
  const toolTrace = streamController.createToolTraceController({
    toolStreamEl: { hidden: false },
    toolStreamLinesEl: { innerHTML: '' },
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

test('createToolTraceController appends pending tool traces and finalizes collapsed state', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);
  const toolStreamEl = { hidden: false };
  const toolStreamLinesEl = { innerHTML: 'existing lines' };

  const toolTrace = streamController.createToolTraceController({
    toolStreamEl,
    toolStreamLinesEl,
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, 'read_file');
  toolTrace.appendInlineToolTrace(7, 'search_files');

  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.body, 'read_file\nsearch_files');
  assert.equal(toolStreamEl.hidden, false);
  assert.equal(toolStreamLinesEl.innerHTML, 'read_file\nsearch_files');

  toolTrace.finalizeInlineToolTrace(7);
  const finalized = histories.get(7)[0];
  assert.equal(finalized.role, 'tool');
  assert.equal(finalized.pending, false);
  assert.equal(finalized.collapsed, true);
  assert.equal(finalized.body, 'read_file\nsearch_files');
  assert.equal(toolStreamEl.hidden, true);
});

test('createToolTraceController keeps live tool stream position when user is reading older tool entries', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);
  const toolStreamEl = { hidden: true };
  const toolStreamLinesEl = {
    innerHTML: '',
    scrollTop: 120,
    scrollHeight: 600,
    clientHeight: 200,
    children: [],
    appendChild(node) {
      this.children.push(node);
      this.scrollHeight = 800;
    },
  };
  const documentObject = {
    createElement: () => ({ className: '', textContent: '' }),
  };

  const toolTrace = streamController.createToolTraceController({
    toolStreamEl,
    toolStreamLinesEl,
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
    documentObject,
  });

  toolTrace.appendInlineToolTrace(7, 'read_file');
  toolTrace.appendInlineToolTrace(7, 'search_files');

  assert.equal(toolStreamEl.hidden, false);
  assert.equal(toolStreamLinesEl.scrollTop, 120);
});

test('createToolTraceController keeps following live tool stream when already near the bottom', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);
  const toolStreamEl = { hidden: true };
  const toolStreamLinesEl = {
    innerHTML: '',
    scrollTop: 365,
    scrollHeight: 600,
    clientHeight: 200,
    children: [],
    appendChild(node) {
      this.children.push(node);
      this.scrollHeight = 800;
    },
  };
  const documentObject = {
    createElement: () => ({ className: '', textContent: '' }),
  };

  const toolTrace = streamController.createToolTraceController({
    toolStreamEl,
    toolStreamLinesEl,
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
    documentObject,
  });

  toolTrace.appendInlineToolTrace(7, 'read_file');
  toolTrace.appendInlineToolTrace(7, 'search_files');

  assert.equal(toolStreamEl.hidden, false);
  assert.equal(toolStreamLinesEl.scrollTop, 800);
});

test('createToolTraceController drops empty finalized traces and resets tool stream UI', () => {
  const histories = new Map([[5, [{ role: 'tool', body: '   ', pending: true, collapsed: false }]]]);
  const toolStreamEl = { hidden: false };
  const toolStreamLinesEl = { innerHTML: 'line 1\nline 2' };

  const toolTrace = streamController.createToolTraceController({
    toolStreamEl,
    toolStreamLinesEl,
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.finalizeInlineToolTrace(5);
  assert.equal(histories.get(5).length, 0);

  toolTrace.resetToolStream();
  assert.equal(toolStreamLinesEl.innerHTML, '');
  assert.equal(toolStreamEl.hidden, true);
});
