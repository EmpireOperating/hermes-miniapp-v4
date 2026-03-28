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
    streamDebugLog: () => {},
    finalizeStreamPendingState: () => {},
    appendInlineToolTrace: () => {},
  };

  const controller = streamController.createController(deps);
  return {
    controller,
    phases,
    pendingAssistantUpdates,
    streamStatuses,
    streamChipUpdates,
    latencyUpdates,
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
