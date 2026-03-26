import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtime = require('../static/runtime_helpers.js');

test('visibility resume only when pending chat has no active stream controller', () => {
  assert.equal(
    runtime.shouldResumeOnVisibilityChange({
      hidden: false,
      activeChatId: 7,
      pendingChats: new Set([7]),
      streamAbortControllers: new Map(),
    }),
    true,
  );

  assert.equal(
    runtime.shouldResumeOnVisibilityChange({
      hidden: false,
      activeChatId: 7,
      pendingChats: new Set([7]),
      streamAbortControllers: new Map([[7, {}]]),
    }),
    false,
  );

  assert.equal(
    runtime.shouldResumeOnVisibilityChange({
      hidden: false,
      activeChatId: 7,
      pendingChats: new Set(),
      streamAbortControllers: new Map(),
    }),
    false,
  );

  assert.equal(
    runtime.shouldResumeOnVisibilityChange({
      hidden: true,
      activeChatId: 7,
      pendingChats: new Set([7]),
      streamAbortControllers: new Map(),
    }),
    false,
  );
});

test('unread increments for backgrounded app even on active chat', () => {
  assert.equal(
    runtime.nextUnreadCount({
      currentUnreadCount: 0,
      targetChatId: 11,
      activeChatId: 11,
      hidden: true,
    }),
    1,
  );

  assert.equal(
    runtime.nextUnreadCount({
      currentUnreadCount: 2,
      targetChatId: 11,
      activeChatId: 11,
      hidden: false,
    }),
    2,
  );

  assert.equal(
    runtime.nextUnreadCount({
      currentUnreadCount: 2,
      targetChatId: 12,
      activeChatId: 11,
      hidden: false,
    }),
    3,
  );
});

test('latency chip only updates for active chat while preserving per-chat latency map', () => {
  const latencyByChat = new Map();

  const inactiveUpdate = runtime.nextLatencyState({
    latencyByChat,
    targetChatId: 44,
    text: '321ms',
    activeChatId: 7,
  });
  assert.equal(inactiveUpdate.chipText, null);
  assert.equal(latencyByChat.get(44), '321ms');

  const activeUpdate = runtime.nextLatencyState({
    latencyByChat,
    targetChatId: 7,
    text: '120ms',
    activeChatId: 7,
  });
  assert.equal(activeUpdate.chipText, 'latency: 120ms');
  assert.equal(latencyByChat.get(7), '120ms');
});

test('mergeHydratedHistory preserves local pending tool traces while chat is pending', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: true },
    { role: 'hermes', body: 'Working on it…', created_at: '2026-03-25T10:00:02Z', pending: true },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: true,
  });

  assert.equal(merged.length, 3);
  assert.equal(merged[1].role, 'tool');
  assert.equal(merged[1].pending, true);
  assert.equal(merged[2].role, 'hermes');
  assert.equal(merged[2].pending, true);
});

test('mergeHydratedHistory does not preserve local pending traces after chat is no longer pending', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: true },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { id: 2, role: 'hermes', body: 'done', created_at: '2026-03-25T10:00:04Z', pending: false },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: false,
  });

  assert.deepEqual(merged, hydrated);
});

test('mergeHydratedHistory avoids duplicating pending entries already present in hydrated history', () => {
  const pendingTool = { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: true };
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    pendingTool,
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { ...pendingTool },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: true,
  });

  const toolRows = merged.filter((item) => item.role === 'tool');
  assert.equal(toolRows.length, 1);
});

test('shouldUseAppendOnlyRender returns false when new history inserts before current tail', () => {
  const previousTail = {
    role: 'hermes',
    body: 'Working…',
    created_at: '2026-03-25T10:00:02Z',
    pending: true,
  };
  const nextHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'calling API', created_at: '2026-03-25T10:00:01Z', pending: true },
    previousTail,
  ];

  const renderedMessageKeys = [
    'id:1',
    'local:hermes:pending:2026-03-25T10:00:02Z:1',
  ];

  const canAppendOnly = runtime.shouldUseAppendOnlyRender({
    history: nextHistory,
    previouslyRenderedLength: 2,
    renderedMessageKeys,
  });

  assert.equal(canAppendOnly, false);
});

test('shouldUseAppendOnlyRender returns true for clean tail append', () => {
  const nextHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'hermes', body: 'Working…', created_at: '2026-03-25T10:00:02Z', pending: true },
    { role: 'tool', body: 'calling API', created_at: '2026-03-25T10:00:03Z', pending: true },
  ];

  const renderedMessageKeys = [
    'id:1',
    'local:hermes:pending:2026-03-25T10:00:02Z:1',
  ];

  const canAppendOnly = runtime.shouldUseAppendOnlyRender({
    history: nextHistory,
    previouslyRenderedLength: 2,
    renderedMessageKeys,
  });

  assert.equal(canAppendOnly, true);
});
