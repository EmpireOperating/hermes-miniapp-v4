import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const openFlow = require('../static/runtime_open_flow.js');

test('createCachedOpenController prioritizes hydration immediately for unread cached chats', () => {
  const traces = [];
  const scheduled = [];
  const idleCalls = [];
  const hydrationCalls = [];
  const controller = openFlow.createCachedOpenController({
    normalizeChatId: (chatId) => Number(chatId),
    histories: new Map([[7, [{ id: 1, body: 'cached reply' }]]]),
    setActiveChatMeta: () => {},
    renderMessages: () => {},
    getActiveChatId: () => 7,
    getLastOpenChatRequestId: () => 4,
    scheduleTimeout: (callback, delay = 0) => {
      scheduled.push(Number(delay));
      callback();
    },
    requestIdle: (callback, options = {}) => {
      idleCalls.push(options);
      callback();
    },
    enqueueUiMutation: (callback) => callback(),
    shouldDeferNonCriticalCachedOpen: () => true,
    traceChatHistory: (eventName, details = {}) => traces.push({ eventName, details }),
    nowMs: () => 1000,
    isActiveChat: () => true,
    chats: new Map([[7, { id: 7, unread_count: 1, newest_unread_message_id: 12, pending: false }]]),
  }, {
    hydrateChatFromServer: async (...args) => {
      hydrationCalls.push(args);
    },
  });

  controller.openCachedChat(7, 4, 900);

  assert.deepEqual(idleCalls, []);
  assert.deepEqual(scheduled, [0]);
  assert.deepEqual(hydrationCalls, [[7, 4, true]]);
  assert.equal(traces.find((entry) => entry.eventName === 'cached-hydrate-scheduled')?.details?.prioritizeHydration, true);
});

test('createCachedOpenController avoids requestIdle for deferred cached hydration when idle hydration is disabled', () => {
  const traces = [];
  const scheduled = [];
  const idleCalls = [];
  const hydrationCalls = [];
  const controller = openFlow.createCachedOpenController({
    normalizeChatId: (chatId) => Number(chatId),
    setActiveChatMeta: () => {},
    renderMessages: () => {},
    getActiveChatId: () => 7,
    getLastOpenChatRequestId: () => 4,
    scheduleTimeout: (callback, delay = 0) => {
      scheduled.push(Number(delay));
      callback();
    },
    requestIdle: (callback, options = {}) => {
      idleCalls.push(options);
      callback();
    },
    enqueueUiMutation: (callback) => callback(),
    shouldDeferNonCriticalCachedOpen: () => true,
    shouldUseIdleForDeferredCachedHydration: () => false,
    traceChatHistory: (eventName, details = {}) => traces.push({ eventName, details }),
    nowMs: () => 1000,
    isActiveChat: () => true,
    chats: new Map([[7, { id: 7, unread_count: 0, newest_unread_message_id: 0, pending: false }]]),
  }, {
    hydrateChatFromServer: async (...args) => {
      hydrationCalls.push(args);
    },
  });

  controller.openCachedChat(7, 4, 900);

  assert.deepEqual(idleCalls, []);
  assert.deepEqual(scheduled, [32]);
  assert.deepEqual(hydrationCalls, [[7, 4, true]]);
  assert.equal(traces.find((entry) => entry.eventName === 'cached-hydrate-scheduled')?.details?.allowIdleHydration, false);
});

test('createHistoryOpenController delegates open threshold arming to read-state authority when available', async () => {
  const traces = [];
  const activeMeta = [];
  const rendered = [];
  const syncedOpenReadState = [];
  let lastOpenRequestId = 0;
  const controller = openFlow.createHistoryOpenController({
    normalizeChatId: (chatId) => Number(chatId),
    histories: new Map([[8, [{ id: 1, role: 'assistant', body: 'cached' }]]]),
    getLastOpenChatRequestId: () => lastOpenRequestId,
    setLastOpenChatRequestId: (value) => { lastOpenRequestId = Number(value); },
    nowMs: () => 1000,
    traceChatHistory: (eventName, details = {}) => traces.push({ eventName, details }),
    syncOpenActivationReadState: (chatId, options = {}) => {
      syncedOpenReadState.push({ chatId: Number(chatId), options: { ...options } });
    },
    setActiveChatMeta: (chatId, options = {}) => activeMeta.push({ chatId: Number(chatId), options }),
    renderMessages: (chatId, options = {}) => rendered.push({ chatId: Number(chatId), options }),
    appendSystemMessage: () => {},
    fetchController: {
      loadChatHistory: async () => ({ chat: { id: 8 }, history: [] }),
      prefetchChatHistory: () => {},
      warmChatHistoryCache: () => {},
    },
    hydrationController: {
      hydrateChatFromServer: async () => {},
      syncVisibleActiveChat: () => {},
    },
    cachedOpenController: {
      openCachedChat: () => {},
    },
    statusController: {
      refreshChats: () => {},
    },
  });

  await controller.openChat(8);

  assert.deepEqual(syncedOpenReadState, [{ chatId: 8, options: {} }]);
  assert.equal(traces[0].eventName, 'open-start');
  assert.deepEqual(activeMeta, []);
  assert.deepEqual(rendered, []);
});

test('createHistoryOpenController reports open failures only for the latest request', async () => {
  const traces = [];
  const systemMessages = [];
  const activeMeta = [];
  const rendered = [];
  let lastOpenRequestId = 0;
  const controller = openFlow.createHistoryOpenController({
    normalizeChatId: (chatId) => Number(chatId),
    histories: new Map(),
    getLastOpenChatRequestId: () => lastOpenRequestId,
    setLastOpenChatRequestId: (value) => { lastOpenRequestId = Number(value); },
    nowMs: () => 1000,
    traceChatHistory: (eventName, details = {}) => traces.push({ eventName, details }),
    syncOpenActivationReadState: () => {},
    setActiveChatMeta: (chatId, options = {}) => activeMeta.push({ chatId: Number(chatId), options }),
    renderMessages: (chatId, options = {}) => rendered.push({ chatId: Number(chatId), options }),
    appendSystemMessage: (message, chatId) => systemMessages.push({ message, chatId: Number(chatId) }),
    fetchController: {
      loadChatHistory: async () => ({ chat: { id: 8 }, history: [] }),
      prefetchChatHistory: () => {},
      warmChatHistoryCache: () => {},
    },
    hydrationController: {
      hydrateChatFromServer: async () => {
        throw new Error('boom');
      },
      syncVisibleActiveChat: () => {},
    },
    cachedOpenController: {
      openCachedChat: () => {
        throw new Error('should not use cached path');
      },
    },
    statusController: {
      refreshChats: () => {},
    },
  });

  await controller.openChat(8);

  assert.deepEqual(activeMeta, [{ chatId: 8, options: { fullTabRender: false, deferNonCritical: true } }]);
  assert.deepEqual(rendered, [{ chatId: 8, options: {} }]);
  assert.deepEqual(systemMessages, [{ message: 'boom', chatId: 8 }]);
  assert.equal(traces[0].eventName, 'open-start');
  assert.equal(traces.at(-1).eventName, 'open-failed');
});
