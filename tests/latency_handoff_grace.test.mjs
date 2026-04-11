import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtime = require('../static/runtime_latency_helpers.js');
const sharedUtils = require('../static/app_shared_utils.js');

test('syncActivePendingStatus preserves live latency briefly during active stream handoff without a controller', () => {
  const chats = new Map([[7, { pending: true, title: 'Project Helios' }]]);
  const streamChip = { textContent: '', title: '' };
  const latencyChip = { textContent: '', title: '' };
  const streamStatus = { textContent: '' };
  let activeChatId = 7;
  let hasLive = true;
  const chipUpdates = [];
  const setChatLatencyCalls = [];
  const realNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const intervalCallbacks = [];
  Date.now = () => 2_000_000;
  globalThis.setInterval = (callback) => {
    intervalCallbacks.push(callback);
    return { id: intervalCallbacks.length, unref() {} };
  };
  globalThis.clearInterval = () => {};

  try {
    const controller = runtime.createStreamActivityController({
      chats,
      getActiveChatId: () => activeChatId,
      hasLiveStreamController: () => hasLive,
      getChatLatencyText: () => '12s · live',
      getStreamPhase: () => 'streaming_assistant',
      streamPhases: { STREAMING_ASSISTANT: 'streaming_assistant' },
      chatLabel: () => 'Project Helios',
      compactChatLabel: () => 'Project Helios',
      setStreamStatus: (text) => { streamStatus.textContent = text; },
      setActivityChip: (chip, text) => {
        chip.textContent = text;
        chipUpdates.push({ chip, text });
      },
      streamChip,
      latencyChip,
      setChatLatency: (chatId, text) => setChatLatencyCalls.push({ chatId, text }),
      syncActiveLatencyChip: () => {
        latencyChip.textContent = 'latency: --';
      },
      formatLatency: sharedUtils.formatLatency,
    });

    controller.markStreamActive(7, { elapsedMs: 12_000 });
    assert.equal(latencyChip.textContent, 'latency: 12s · live');

    hasLive = false;
    Date.now = () => 2_001_500;
    controller.syncActivePendingStatus();

    assert.equal(streamStatus.textContent, 'Waiting for Hermes in Project Helios');
    assert.equal(streamChip.textContent, 'stream: pending · Project Helios');
    assert.equal(latencyChip.textContent, 'latency: 14s · live');
    assert.equal(intervalCallbacks.length, 1);
    assert.ok(setChatLatencyCalls.some((entry) => String(entry.text).includes('· live')));
  } finally {
    Date.now = realNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});
