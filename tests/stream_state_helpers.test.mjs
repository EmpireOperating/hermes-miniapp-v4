import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const streamState = require('../static/stream_state_helpers.js');

test('normalize/get/set stream phase with safe defaults', () => {
  const phases = new Map();

  assert.equal(streamState.normalizeStreamPhase('STREAMING_TOOL'), streamState.STREAM_PHASES.STREAMING_TOOL);
  assert.equal(streamState.normalizeStreamPhase('unknown-phase'), streamState.STREAM_PHASES.IDLE);
  assert.equal(streamState.getStreamPhase({ streamPhaseByChat: phases, chatId: 7 }), streamState.STREAM_PHASES.IDLE);

  const next = streamState.setStreamPhase({
    streamPhaseByChat: phases,
    chatId: 7,
    phase: 'streaming_assistant',
  });

  assert.equal(next, streamState.STREAM_PHASES.STREAMING_ASSISTANT);
  assert.equal(phases.get(7), streamState.STREAM_PHASES.STREAMING_ASSISTANT);
});

test('patch phase guard only allows streaming lifecycle phases', () => {
  assert.equal(streamState.isPatchPhaseAllowed(streamState.STREAM_PHASES.PENDING_TOOL), true);
  assert.equal(streamState.isPatchPhaseAllowed(streamState.STREAM_PHASES.STREAMING_TOOL), true);
  assert.equal(streamState.isPatchPhaseAllowed(streamState.STREAM_PHASES.STREAMING_ASSISTANT), true);
  assert.equal(streamState.isPatchPhaseAllowed(streamState.STREAM_PHASES.FINALIZED), true);
  assert.equal(streamState.isPatchPhaseAllowed(streamState.STREAM_PHASES.ERROR), true);
  assert.equal(streamState.isPatchPhaseAllowed(streamState.STREAM_PHASES.IDLE), false);
});

test('markChatStreamPending marks both local and chat snapshot pending state', () => {
  const pendingChats = new Set();
  const chats = new Map([[11, { id: 11, pending: false }]]);
  const calls = [];

  const key = streamState.markChatStreamPending({
    chatId: 11,
    pendingChats,
    chats,
    setStreamPhase: (chatId, phase) => calls.push({ chatId, phase }),
  });

  assert.equal(key, 11);
  assert.equal(pendingChats.has(11), true);
  assert.equal(chats.get(11).pending, true);
  assert.deepEqual(calls, [{ chatId: 11, phase: streamState.STREAM_PHASES.PENDING_TOOL }]);
});

test('finalizeChatStreamState keeps pending flags on abort and clears on completion', () => {
  const pendingChats = new Set([9]);
  const chats = new Map([[9, { id: 9, pending: true }]]);
  const calls = [];

  streamState.finalizeChatStreamState({
    chatId: 9,
    wasAborted: true,
    pendingChats,
    chats,
    setStreamPhase: (chatId, phase) => calls.push({ chatId, phase }),
  });

  assert.equal(pendingChats.has(9), true);
  assert.equal(chats.get(9).pending, true);
  assert.deepEqual(calls, [{ chatId: 9, phase: streamState.STREAM_PHASES.IDLE }]);

  calls.length = 0;
  streamState.finalizeChatStreamState({
    chatId: 9,
    wasAborted: false,
    pendingChats,
    chats,
    setStreamPhase: (chatId, phase) => calls.push({ chatId, phase }),
  });

  assert.equal(pendingChats.has(9), false);
  assert.equal(chats.get(9).pending, false);
  assert.deepEqual(calls, [{ chatId: 9, phase: streamState.STREAM_PHASES.IDLE }]);
});

test('clearChatStreamState drops pending/phase/unseen markers together', () => {
  const pendingChats = new Set([3]);
  const unseenStreamChats = new Set([3]);
  const phases = new Map([[3, streamState.STREAM_PHASES.STREAMING_TOOL]]);

  const cleared = streamState.clearChatStreamState({
    chatId: 3,
    pendingChats,
    streamPhaseByChat: phases,
    unseenStreamChats,
  });

  assert.equal(cleared, true);
  assert.equal(pendingChats.has(3), false);
  assert.equal(phases.has(3), false);
  assert.equal(unseenStreamChats.has(3), false);
});
