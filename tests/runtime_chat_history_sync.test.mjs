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
    buildChatPreservingUnread: (chat, options = {}) => ({ ...chat, preserved: Boolean(options.preserveActivationUnread) }),
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

  assert.deepEqual(syncChatsCalls, [[{ id: 7, unread_count: 1, pending: false, preserved: true }]]);
  assert.deepEqual(syncPinnedChatsCalls, [[{ id: 9, unread_count: 0, pending: false, preserved: true }]]);
  assert.deepEqual(abortedChats, [7]);
  assert.deepEqual(finalizedChats, [7]);
});
