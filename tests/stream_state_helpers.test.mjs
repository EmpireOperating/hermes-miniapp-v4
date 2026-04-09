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

test('createPhaseController resolves safe defaults and emits render-trace updates', () => {
  const streamPhaseByChat = new Map();
  const calls = [];
  const controller = streamState.createPhaseController({
    streamPhaseByChat,
    renderTraceLog: (eventName, details) => calls.push({ eventName, details }),
  });

  assert.equal(controller.getStreamPhase(99), streamState.STREAM_PHASES.IDLE);
  assert.equal(controller.setStreamPhase(99, 'streaming_tool'), streamState.STREAM_PHASES.STREAMING_TOOL);
  assert.equal(controller.getStreamPhase(99), streamState.STREAM_PHASES.STREAMING_TOOL);
  assert.deepEqual(calls, [{
    eventName: 'stream-phase',
    details: { chatId: 99, phase: streamState.STREAM_PHASES.STREAMING_TOOL },
  }]);
  assert.equal(controller.setStreamPhase(null, 'error'), streamState.STREAM_PHASES.IDLE);
});

test('createPersistenceController stores monotonic resume cursors and clears them safely', () => {
  const storage = new Map();
  const localStorageRef = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };

  const controller = streamState.createPersistenceController({
    localStorageRef,
    streamResumeCursorStorageKey: 'resume-key',
    pendingStreamSnapshotStorageKey: 'snapshot-key',
    pendingStreamSnapshotMaxAgeMs: 15 * 60 * 1000,
    histories: new Map(),
    chats: new Map(),
  });

  assert.equal(controller.getStoredStreamCursor(4), 0);
  assert.equal(controller.setStoredStreamCursor(4, 11), 11);
  assert.equal(controller.setStoredStreamCursor(4, 7), 11);
  assert.equal(controller.getStoredStreamCursor(4), 11);
  assert.equal(controller.clearStoredStreamCursor(4), true);
  assert.equal(controller.clearStoredStreamCursor(4), false);
  assert.equal(controller.getStoredStreamCursor(4), 0);
});

test('createPersistenceController persists and restores pending stream snapshots', () => {
  const storage = new Map();
  const localStorageRef = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
  const histories = new Map([[5, [
    { role: 'tool', body: 'first line\nsecond line', pending: true, collapsed: false, created_at: '2026-04-02T00:00:00Z' },
    { role: 'hermes', body: 'partial answer', pending: true, created_at: '2026-04-02T00:00:01Z' },
  ]]]);
  const chats = new Map([[5, { id: 5, pending: true }]]);

  const controller = streamState.createPersistenceController({
    localStorageRef,
    streamResumeCursorStorageKey: 'resume-key',
    pendingStreamSnapshotStorageKey: 'snapshot-key',
    pendingStreamSnapshotMaxAgeMs: 15 * 60 * 1000,
    histories,
    chats,
    nowFn: () => 1_000,
    dateNowFn: () => 1_000,
  });

  const snapshot = controller.persistPendingStreamSnapshot(5);
  assert.deepEqual(snapshot.tool_journal_lines, ['first line', 'second line']);

  histories.set(5, []);
  const restored = controller.restorePendingStreamSnapshot(5);
  assert.equal(restored, true);
  assert.deepEqual(histories.get(5), [
    {
      role: 'tool',
      body: 'first line\nsecond line',
      created_at: '2026-04-02T00:00:00Z',
      pending: true,
      collapsed: false,
    },
    {
      role: 'hermes',
      body: 'partial answer',
      created_at: '2026-04-02T00:00:01Z',
      pending: true,
    },
  ]);
});

test('createPersistenceController preserves collapsed pending tool traces across snapshot restore', () => {
  const storage = new Map();
  const localStorageRef = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
  const histories = new Map([[6, [
    { role: 'tool', body: 'tool A', pending: true, collapsed: true, created_at: '2026-04-02T00:00:00Z' },
  ]]]);
  const chats = new Map([[6, { id: 6, pending: true }]]);

  const controller = streamState.createPersistenceController({
    localStorageRef,
    streamResumeCursorStorageKey: 'resume-key',
    pendingStreamSnapshotStorageKey: 'snapshot-key',
    pendingStreamSnapshotMaxAgeMs: 15 * 60 * 1000,
    histories,
    chats,
    nowFn: () => 1_000,
    dateNowFn: () => 1_000,
  });

  const snapshot = controller.persistPendingStreamSnapshot(6);
  assert.equal(snapshot.tool.collapsed, true);

  histories.set(6, []);
  const restored = controller.restorePendingStreamSnapshot(6);
  assert.equal(restored, true);
  assert.equal(histories.get(6)[0].collapsed, true);
});

test('mergeSnapshotToolJournalLines preserves repeated identical tool lines in order', () => {
  const storage = new Map();
  const localStorageRef = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
  const histories = new Map([[12, [
    { role: 'tool', body: 'read_file\nsearch_files\nread_file', pending: true, collapsed: false, created_at: '2026-04-02T00:00:00Z' },
  ]]]);
  const chats = new Map([[12, { id: 12, pending: true }]]);

  const controller = streamState.createPersistenceController({
    localStorageRef,
    streamResumeCursorStorageKey: 'resume-key',
    pendingStreamSnapshotStorageKey: 'snapshot-key',
    pendingStreamSnapshotMaxAgeMs: 15 * 60 * 1000,
    histories,
    chats,
    nowFn: () => 2_000,
    dateNowFn: () => 2_000,
  });

  const snapshot = controller.persistPendingStreamSnapshot(12);
  assert.deepEqual(snapshot.tool_journal_lines, ['read_file', 'search_files', 'read_file']);

  histories.set(12, []);
  const restored = controller.restorePendingStreamSnapshot(12);
  assert.equal(restored, true);
  assert.equal(histories.get(12)[0].body, 'read_file\nsearch_files\nread_file');
});

test('createPersistenceController drops expired snapshots and clears storage when chat is no longer pending', () => {
  const storage = new Map();
  const localStorageRef = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
  const histories = new Map([[9, []]]);
  const chats = new Map([[9, { id: 9, pending: false }]]);

  const controller = streamState.createPersistenceController({
    localStorageRef,
    streamResumeCursorStorageKey: 'resume-key',
    pendingStreamSnapshotStorageKey: 'snapshot-key',
    pendingStreamSnapshotMaxAgeMs: 100,
    histories,
    chats,
    nowFn: () => 5_000,
    dateNowFn: () => 5_000,
  });

  storage.set('snapshot-key', JSON.stringify({
    '9': {
      ts: 1,
      tool_journal_lines: ['stale line'],
      tool: { role: 'tool', body: 'stale line', pending: true, collapsed: false, created_at: '2026-04-02T00:00:00Z' },
      assistant: null,
    },
  }));

  assert.equal(controller.restorePendingStreamSnapshot(9), false);
  assert.equal(JSON.parse(storage.get('snapshot-key') || '{}')['9'], undefined);
  assert.equal(controller.persistPendingStreamSnapshot(9), null);
  assert.equal(JSON.parse(storage.get('snapshot-key') || '{}')['9'], undefined);
});
