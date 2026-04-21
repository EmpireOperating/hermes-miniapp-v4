import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const historySync = require('../static/runtime_chat_history_sync.js');

test('createHistoryFetchController falls back to /api/chats/open on 404 history fetches', async () => {
  const apiCalls = [];
  const controller = historySync.createHistoryFetchController({
    apiPost: async (path, payload) => {
      apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        throw new Error('request failed: 404');
      }
      return {
        chat: { id: 7, title: 'Recovered' },
        history: [{ role: 'assistant', body: 'hello', pending: false }],
      };
    },
    histories: new Map(),
    chats: new Map(),
    prefetchingHistories: new Set(),
    upsertChatPreservingUnread: () => {},
    traceChatHistory: () => {},
    nowMs: () => 1000,
    isActiveChat: () => false,
    scheduleTimeout: () => {},
  });

  const data = await controller.loadChatHistory(7, { activate: true });

  assert.deepEqual(apiCalls, [
    { path: '/api/chats/history', payload: { chat_id: 7, activate: true } },
    { path: '/api/chats/open', payload: { chat_id: 7 } },
  ]);
  assert.equal(data.chat.id, 7);
  assert.equal(data.history.length, 1);
});

test('createHistoryFetchController skips speculative prefetch commits when the chat is already active', async () => {
  const histories = new Map();
  const chats = new Map([[7, { id: 7, unread_count: 0, newest_unread_message_id: 0, pending: false }]]);
  const upsertedChats = [];
  const tracedEvents = [];
  const controller = historySync.createHistoryFetchController({
    apiPost: async () => ({
      chat: { id: 7, unread_count: 0, newest_unread_message_id: 0, pending: false },
      history: [{ role: 'assistant', body: 'prefetched reply', pending: false }],
    }),
    histories,
    chats,
    prefetchingHistories: new Set(),
    upsertChatPreservingUnread: (chat) => upsertedChats.push(chat),
    traceChatHistory: (eventName, details) => tracedEvents.push({ eventName, details }),
    nowMs: () => 1000,
    isActiveChat: (chatId) => Number(chatId) === 7,
    scheduleTimeout: () => {},
  });

  controller.prefetchChatHistory(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(upsertedChats.length, 0);
  assert.equal(histories.has(7), false);
  assert.equal(
    tracedEvents.some((entry) => entry.eventName === 'prefetch-skipped-commit' && entry.details?.activeNow === true),
    true,
  );
});

test('createHistoryFetchController ignores force-refresh for already-cached chats so speculative warming does not rewrite unread-owned inactive history', async () => {
  const histories = new Map([[8, [{ id: 1, role: 'assistant', body: 'cached older reply', pending: false }]]]);
  const chats = new Map([[8, { id: 8, unread_count: 2, newest_unread_message_id: 55, pending: true }]]);
  const upsertCalls = [];
  const tracedEvents = [];
  const controller = historySync.createHistoryFetchController({
    apiPost: async () => {
      throw new Error('force-refresh should not fetch already-cached unread/pending chats');
    },
    histories,
    chats,
    prefetchingHistories: new Set(),
    upsertChatPreservingUnread: (chat, options = {}) => upsertCalls.push({ chat, options }),
    traceChatHistory: (eventName, details) => tracedEvents.push({ eventName, details }),
    nowMs: () => 1000,
    isActiveChat: () => false,
    scheduleTimeout: () => {},
  });

  controller.prefetchChatHistory(8, { forceRefresh: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(histories.get(8), [
    { id: 1, role: 'assistant', body: 'cached older reply', pending: false },
  ]);
  assert.deepEqual(upsertCalls, []);
  assert.deepEqual(tracedEvents, []);
});

test('createHistoryFetchController warmChatHistoryCache only warms cold inactive chats and leaves cached unread or pending chats to live unread ownership', async () => {
  const apiCalls = [];
  const controller = historySync.createHistoryFetchController({
    apiPost: async (path, payload) => {
      apiCalls.push({ path, payload });
      return {
        chat: { id: Number(payload.chat_id), unread_count: 0, newest_unread_message_id: 0, pending: false },
        history: [{ id: Number(payload.chat_id), role: 'assistant', body: `chat ${payload.chat_id}`, pending: false }],
      };
    },
    histories: new Map([
      [8, [{ id: 1, role: 'assistant', body: 'stale cached unread chat', pending: false }]],
      [10, [{ id: 2, role: 'assistant', body: 'stale cached pending chat', pending: false }]],
    ]),
    chats: new Map([
      [7, { id: 7, unread_count: 0, newest_unread_message_id: 0, pending: false }],
      [8, { id: 8, unread_count: 2, newest_unread_message_id: 44, pending: false }],
      [9, { id: 9, unread_count: 0, newest_unread_message_id: 0, pending: false }],
      [10, { id: 10, unread_count: 0, newest_unread_message_id: 0, pending: true }],
      [11, { id: 11, unread_count: 1, newest_unread_message_id: 51, pending: false }],
    ]),
    prefetchingHistories: new Set(),
    upsertChatPreservingUnread: () => {},
    traceChatHistory: () => {},
    nowMs: () => 1000,
    isActiveChat: (chatId) => Number(chatId) === 7,
    requestIdle: null,
    scheduleTimeout: (callback) => callback(),
  });

  controller.warmChatHistoryCache();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(apiCalls.map((call) => call.payload), [
    { chat_id: 11, activate: false },
    { chat_id: 9, activate: false },
  ]);
});

test('createHistoryStatusController refreshChats preserves unread-aware status and finalizes completed non-pending chats', async () => {
  const syncChatsCalls = [];
  const syncPinnedChatsCalls = [];
  const finalizedChats = [];
  const abortedChats = [];
  const controller = historySync.createHistoryStatusController({
    apiPost: async (path) => {
      assert.equal(path, '/api/chats/status');
      return {
        chats: [{ id: 7, unread_count: 1, pending: false }],
        pinned_chats: [{ id: 9, unread_count: 0, pending: false }],
      };
    },
    buildChatPreservingUnread: (chat, options = {}) => ({ ...chat, preserved: Boolean(options.preserveActivationUnread), preserveLaggingLocalState: Boolean(options.preserveLaggingLocalState) }),
    syncChats: (entries) => syncChatsCalls.push(entries),
    syncPinnedChats: (entries) => syncPinnedChatsCalls.push(entries),
    renderTabs: () => {},
    renderPinnedChats: () => {},
    syncActivePendingStatus: () => {},
    updateComposerState: () => {},
    hasLiveStreamController: (chatId) => Number(chatId) === 7,
    abortStreamController: (chatId) => abortedChats.push(Number(chatId)),
    finalizeHydratedPendingState: (chatId) => finalizedChats.push(Number(chatId)),
  });

  await controller.refreshChats();

  assert.deepEqual(syncChatsCalls, [[{ id: 7, unread_count: 1, pending: false, preserved: true, preserveLaggingLocalState: true }]]);
  assert.deepEqual(syncPinnedChatsCalls, [[{ id: 9, unread_count: 0, pending: false, preserved: true, preserveLaggingLocalState: true }]]);
  assert.deepEqual(abortedChats, [7]);
  assert.deepEqual(finalizedChats, [7]);
});

test('createHistoryStatusController refreshChats asks preservation helper to keep lagging local unread state for background chats', async () => {
  const buildCalls = [];
  const syncChatsCalls = [];
  const controller = historySync.createHistoryStatusController({
    apiPost: async () => ({
      chats: [{ id: 11, unread_count: 0, pending: true }],
      pinned_chats: [],
    }),
    buildChatPreservingUnread: (chat, options = {}) => {
      buildCalls.push({ chat, options });
      return { ...chat, unread_count: options.preserveLaggingLocalState ? 1 : chat.unread_count };
    },
    syncChats: (entries) => syncChatsCalls.push(entries),
    syncPinnedChats: () => {},
    renderTabs: () => {},
    renderPinnedChats: () => {},
    syncActivePendingStatus: () => {},
    updateComposerState: () => {},
    hasLiveStreamController: () => false,
    abortStreamController: () => {},
    finalizeHydratedPendingState: () => {},
  });

  await controller.refreshChats();

  assert.deepEqual(buildCalls, [{
    chat: { id: 11, unread_count: 0, pending: true },
    options: { preserveActivationUnread: true, preserveLaggingLocalState: true },
  }]);
  assert.deepEqual(syncChatsCalls, [[{ id: 11, unread_count: 1, pending: true }]]);
});

test('createHistoryStatusController refreshChats still finalizes completed chats from raw status even when preserved local state stays pending', async () => {
  const abortedChats = [];
  const finalizedChats = [];
  const controller = historySync.createHistoryStatusController({
    apiPost: async () => ({
      chats: [{ id: 12, unread_count: 0, pending: false }],
      pinned_chats: [],
    }),
    buildChatPreservingUnread: () => ({ id: 12, unread_count: 1, pending: true }),
    syncChats: () => {},
    syncPinnedChats: () => {},
    renderTabs: () => {},
    renderPinnedChats: () => {},
    syncActivePendingStatus: () => {},
    updateComposerState: () => {},
    hasLiveStreamController: (chatId) => Number(chatId) === 12,
    abortStreamController: (chatId) => abortedChats.push(Number(chatId)),
    finalizeHydratedPendingState: (chatId) => finalizedChats.push(Number(chatId)),
  });

  await controller.refreshChats();

  assert.deepEqual(abortedChats, [12]);
  assert.deepEqual(finalizedChats, [12]);
});
