import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const readState = require('../static/runtime_read_state.js');

test('createUnreadAnchorController measures newest unread assistant boundary before generic near-bottom fallback', () => {
  const chats = new Map([[7, { id: 7, unread_count: 1, newest_unread_message_id: 22 }]]);
  const assistantNode = {
    dataset: { messageId: '22' },
    offsetTop: 240,
    offsetHeight: 120,
  };
  const controller = readState.createUnreadAnchorController({
    chats,
    isNearBottomFn: () => false,
    messagesContainer: {
      scrollTop: 0,
      clientHeight: 300,
      querySelectorAll: () => [assistantNode],
    },
  });

  assert.equal(controller.getUnreadAnchorMessageId(7), 22);
  assert.equal(controller.hasReachedNewestUnreadMessageBottom(7, { tolerance: 40 }), false);
});

test('createActivationReadThresholdController requires dropping below then re-reaching newest unread boundary', () => {
  const chats = new Map([[7, { id: 7, unread_count: 1, newest_unread_message_id: 22 }]]);
  let reachedBottom = true;
  const controller = readState.createActivationReadThresholdController(
    { chats },
    {
      getUnreadAnchorMessageId: () => 22,
      hasReachedNewestUnreadMessageBottom: () => reachedBottom,
    },
  );

  assert.equal(controller.ensureActivationReadThreshold(7, 1), true);
  assert.equal(controller.hasActivationReadThreshold(7), true);
  assert.equal(controller.hasSatisfiedActivationReadThreshold(7, { reachedBottom: true }), false);

  reachedBottom = false;
  assert.equal(controller.hasSatisfiedActivationReadThreshold(7, { reachedBottom: false }), false);

  reachedBottom = true;
  assert.equal(controller.hasSatisfiedActivationReadThreshold(7, { reachedBottom: true }), true);
  assert.equal(controller.hasActivationReadThreshold(7), false);
});

test('createUnreadStateController preserves optimistic unread clear and restore lifecycle', () => {
  const chats = new Map([[7, { id: 7, unread_count: 3, newest_unread_message_id: 22 }]]);
  const upserts = [];
  const controller = readState.createUnreadStateController({
    chats,
    upsertChat: (chat) => upserts.push(chat),
    getActiveChatId: () => 7,
    hasReachedNewestUnreadMessageBottom: () => false,
  });

  assert.equal(controller.getCurrentUnreadCount(7), 3);
  controller.clearUnreadCount(7);
  assert.equal(chats.get(7).unread_count, 0);
  assert.equal(controller.getCurrentUnreadCount(7), 3);
  controller.restoreUnreadCount(7);
  assert.equal(chats.get(7).unread_count, 3);

  const preserved = controller.buildChatPreservingUnread({ id: 7, unread_count: 1, newest_unread_message_id: 11 }, { preserveActivationUnread: true });
  assert.equal(preserved.unread_count, 3);
  assert.equal(preserved.newest_unread_message_id, 22);
  assert.deepEqual(upserts, []);
});

test('createUnreadPreservationController keeps local unread when activation threshold is still armed', () => {
  const chats = new Map([[7, { id: 7, unread_count: 3, newest_unread_message_id: 22 }]]);
  const unreadStateController = {
    buildChatPreservingUnread: (chat) => ({ ...chat }),
    upsertChatPreservingUnread: (chat) => chat,
  };
  const thresholdController = {
    hasActivationReadThreshold: (chatId) => Number(chatId) === 7,
    hasReachedNewestUnreadMessageBottom: () => false,
  };
  const controller = readState.createUnreadPreservationController(
    { chats, getActiveChatId: () => 7 },
    unreadStateController,
    thresholdController,
  );

  const preserved = controller.buildChatPreservingUnread({ id: 7, unread_count: 1, newest_unread_message_id: 11 }, { preserveActivationUnread: true });
  assert.equal(preserved.unread_count, 3);
  assert.equal(preserved.newest_unread_message_id, 22);
});


test('createReadSyncController preserves local pending when mark-read response lags a live stream', async () => {
  const chats = new Map([[7, { id: 7, unread_count: 2, pending: true }]]);
  const pendingChats = new Set([7]);
  const unseenStreamChats = new Set();
  const markReadInFlight = new Set();
  const upsertedChats = [];
  let renderTabsCalls = 0;
  let syncActivePendingStatusCalls = 0;
  let updateComposerStateCalls = 0;
  const controller = readState.createReadSyncController({
    apiPost: async (path, payload) => {
      assert.equal(path, '/api/chats/mark-read');
      return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
    },
    chats,
    upsertChat: (chat) => {
      const next = { ...chat };
      upsertedChats.push(next);
      chats.set(Number(next.id), next);
      return next;
    },
    getActiveChatId: () => 7,
    getIsAuthenticated: () => true,
    isNearBottomFn: () => true,
    messagesContainer: { querySelectorAll: () => [] },
    unseenStreamChats,
    markReadInFlight,
    renderTabs: () => { renderTabsCalls += 1; },
    syncActivePendingStatus: () => { syncActivePendingStatusCalls += 1; },
    updateComposerState: () => { updateComposerStateCalls += 1; },
    pendingChats,
    hasLiveStreamController: (chatId) => Number(chatId) === 7,
    hasLocalPendingTranscript: (history) => Array.isArray(history) && history.some((message) => message?.pending),
  });

  controller.maybeMarkRead(7, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(upsertedChats, [{ id: 7, pending: true, unread_count: 0 }]);
  assert.equal(renderTabsCalls, 2);
  assert.equal(syncActivePendingStatusCalls, 2);
  assert.equal(updateComposerStateCalls, 2);
  assert.equal(markReadInFlight.has(7), false);
});

test('createReadSyncController exposes pending-without-live-stream detection through injected transcript check', () => {
  const controller = readState.createReadSyncController({
    apiPost: async () => ({ chat: { id: 7, unread_count: 0 } }),
    chats: new Map(),
    upsertChat: (chat) => chat,
    getActiveChatId: () => 7,
    getIsAuthenticated: () => true,
    isNearBottomFn: () => true,
    messagesContainer: { querySelectorAll: () => [] },
    unseenStreamChats: new Set(),
    markReadInFlight: new Set(),
    renderTabs: () => {},
    syncActivePendingStatus: () => {},
    updateComposerState: () => {},
    pendingChats: new Set(),
    hasLiveStreamController: () => false,
    hasLocalPendingTranscript: (history) => Array.isArray(history) && history.some((message) => message?.pending),
  });

  assert.equal(controller.hasLocalPendingWithoutLiveStream(7, [{ role: 'assistant', pending: true }]), true);
  assert.equal(controller.hasLocalPendingWithoutLiveStream(7, [{ role: 'assistant', pending: false }]), false);
});
