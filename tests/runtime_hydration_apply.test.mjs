import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hydrationApply = require('../static/runtime_hydration_apply.js');

test('createUnreadHydrationRetryController retries only when unread anchor is missing from hydrated history without preserved pending state', () => {
  const controller = hydrationApply.createUnreadHydrationRetryController();

  assert.equal(
    controller.shouldRetryUnreadHydrate({
      incomingUnreadAnchorMessageId: 12,
      nextHistory: [{ id: 3, role: 'assistant', body: 'stale' }],
      preservePendingState: false,
      restoredPendingSnapshot: false,
    }),
    true,
  );

  assert.equal(
    controller.shouldRetryUnreadHydrate({
      incomingUnreadAnchorMessageId: 12,
      nextHistory: [{ id: 12, role: 'assistant', body: 'fresh' }],
      preservePendingState: false,
      restoredPendingSnapshot: false,
    }),
    false,
  );

  assert.equal(
    controller.shouldRetryUnreadHydrate({
      incomingUnreadAnchorMessageId: 12,
      nextHistory: [{ id: 3, role: 'assistant', body: 'stale' }],
      preservePendingState: true,
      restoredPendingSnapshot: false,
    }),
    false,
  );
});

test('createHydrationApplyController rehydrates once when unread anchor is still absent after the first hydrate', async () => {
  const loadCalls = [];
  const upserts = [];
  const traces = [];
  const deriveCalls = [];
  const applyCalls = [];

  const controller = hydrationApply.createHydrationApplyController({
    loadChatHistory: async (chatId, options = {}) => {
      loadCalls.push({ chatId: Number(chatId), options });
      return {
        chat: { id: Number(chatId), newest_unread_message_id: 15 },
        history: [{ id: 15, role: 'assistant', body: 'fresh final reply' }],
      };
    },
    upsertChatPreservingUnread: (chat, options = {}) => upserts.push({ chat, options }),
    traceChatHistory: (eventName, details = {}) => traces.push({ eventName, details }),
  }, {
    derivePendingState: (chatId, previousHistory, data) => {
      deriveCalls.push({ chatId: Number(chatId), previousHistory, data });
      return {
        preservePendingState: false,
        serverPending: false,
        preserveLocalPending: false,
        allowSnapshotRestore: false,
      };
    },
    applyHydratedHistory: (chatId, previousHistory, nextHistory, pendingState) => {
      applyCalls.push({ chatId: Number(chatId), previousHistory, nextHistory, pendingState });
      const firstPass = applyCalls.length === 1;
      return {
        restoredPendingSnapshot: false,
        finalHistory: firstPass ? [{ id: 9, role: 'assistant', body: 'stale cached reply' }] : nextHistory,
      };
    },
  }, hydrationApply.createUnreadHydrationRetryController());

  const result = await controller.applyHydratedServerState({
    targetChatId: 7,
    previousHistory: [{ id: 9, role: 'assistant', body: 'stale cached reply' }],
    data: {
      chat: { id: 7, newest_unread_message_id: 15 },
      history: [{ id: 9, role: 'assistant', body: 'stale cached reply' }],
    },
    requestId: 4,
    retryEventName: 'hydrate-unread-retry',
    retryActivate: true,
  });

  assert.deepEqual(loadCalls, [{ chatId: 7, options: { activate: true } }]);
  assert.equal(upserts.length, 0);
  assert.equal(deriveCalls.length, 2);
  assert.equal(applyCalls.length, 2);
  assert.deepEqual(applyCalls[0].pendingState, {
    preservePendingState: false,
    serverPending: false,
    preserveLocalPending: false,
    allowSnapshotRestore: false,
  });
  assert.deepEqual(traces, [{
    eventName: 'hydrate-unread-retry',
    details: { chatId: 7, requestId: 4, incomingUnreadAnchorMessageId: 15 },
  }]);
  assert.deepEqual(result.finalHistory, [{ id: 15, role: 'assistant', body: 'fresh final reply' }]);
  assert.equal(result.restoredPendingSnapshot, false);

  result.commitHydratedState();

  assert.deepEqual(upserts, [{
    chat: { id: 7, newest_unread_message_id: 15 },
    options: { preserveActivationUnread: true },
  }]);
});

test('createHydrationApplyController stays pure until commitHydratedState is invoked', async () => {
  const loadCalls = [];
  const upserts = [];
  const finalized = [];
  const preparedHydrations = [];
  const controller = hydrationApply.createHydrationApplyController({
    loadChatHistory: async (chatId, options = {}) => {
      loadCalls.push({ chatId: Number(chatId), options });
      return {
        chat: { id: Number(chatId), newest_unread_message_id: 12, unread_count: 1, pending: false },
        history: [{ id: 12, role: 'assistant', body: 'fresh final reply' }],
      };
    },
    buildChatPreservingUnread: (chat, options = {}) => ({ ...chat, preserved: Boolean(options.preserveActivationUnread) }),
    upsertChatPreservingUnread: (chat, options = {}) => upserts.push({ chat, options }),
    traceChatHistory: () => {},
  }, {
    derivePendingState: () => ({
      preservePendingState: false,
      serverPending: false,
      preserveLocalPending: false,
      allowSnapshotRestore: false,
    }),
    prepareHydratedHistory: (chatId, previousHistory, nextHistory) => {
      preparedHydrations.push({ chatId: Number(chatId), previousHistory, nextHistory });
      return {
        restoredPendingSnapshot: false,
        finalHistory: nextHistory,
        historyChanged: true,
        commitHydratedHistory: () => finalized.push(Number(chatId)),
      };
    },
  }, hydrationApply.createUnreadHydrationRetryController());

  const result = await controller.applyHydratedServerState({
    targetChatId: 7,
    previousHistory: [{ id: 9, role: 'assistant', body: 'stale cached reply' }],
    data: {
      chat: { id: 7, newest_unread_message_id: 12, unread_count: 1, pending: false },
      history: [{ id: 9, role: 'assistant', body: 'stale cached reply' }],
    },
    requestId: 4,
    retryEventName: 'hydrate-unread-retry',
    retryActivate: true,
  });

  assert.deepEqual(loadCalls, [{ chatId: 7, options: { activate: true } }]);
  assert.equal(typeof result.commitHydratedState, 'function');
  assert.equal(upserts.length, 0);
  assert.deepEqual(finalized, []);
  assert.equal(result.data.chat.preserved, true);
  assert.deepEqual(preparedHydrations.map((entry) => entry.chatId), [7, 7]);

  result.commitHydratedState();

  assert.deepEqual(upserts, [{
    chat: { id: 7, newest_unread_message_id: 12, unread_count: 1, pending: false, preserved: true },
    options: { preserveActivationUnread: true },
  }]);
  assert.deepEqual(finalized, [7]);
});
