import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const openFlow = require('../static/runtime_open_flow.js');

test('createCachedOpenController prioritizes hydration immediately for unread cached chats and delays stale cached fallback render', () => {
  const traces = [];
  const scheduled = [];
  const idleCalls = [];
  const hydrationCalls = [];
  const renderCalls = [];
  const controller = openFlow.createCachedOpenController({
    normalizeChatId: (chatId) => Number(chatId),
    histories: new Map([[7, [{ id: 1, body: 'cached reply' }]]]),
    setActiveChatMeta: () => {},
    renderMessages: (...args) => {
      renderCalls.push(args);
    },
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
  assert.deepEqual(scheduled, [24, 0]);
  assert.deepEqual(renderCalls, [[7]]);
  assert.deepEqual(hydrationCalls, [[7, 4, true]]);
  assert.equal(traces.find((entry) => entry.eventName === 'cached-render-scheduled')?.details?.delayMs, 24);
  assert.equal(traces.find((entry) => entry.eventName === 'cached-hydrate-scheduled')?.details?.prioritizeHydration, true);
});

test('createCachedOpenController hydrates the selected cached chat on a timeout instead of waiting for idle', () => {
  const traces = [];
  const scheduled = [];
  const idleCalls = [];
  const hydrationCalls = [];
  const renderCalls = [];
  const enqueueCalls = [];
  const controller = openFlow.createCachedOpenController({
    normalizeChatId: (chatId) => Number(chatId),
    setActiveChatMeta: () => {},
    renderMessages: (...args) => {
      renderCalls.push(args);
    },
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
    enqueueUiMutation: (callback) => {
      enqueueCalls.push(true);
      callback();
    },
    shouldDeferNonCriticalCachedOpen: () => true,
    shouldUseIdleForDeferredCachedHydration: () => true,
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
  assert.deepEqual(enqueueCalls, [true]);
  assert.deepEqual(renderCalls, [[7]]);
  assert.deepEqual(scheduled, [0]);
  assert.deepEqual(hydrationCalls, [[7, 4, true]]);
  const hydrateTrace = traces.find((entry) => entry.eventName === 'cached-hydrate-scheduled');
  assert.equal(hydrateTrace?.details?.allowIdleHydration, true);
  assert.equal(hydrateTrace?.details?.mode, 'timeout');
  assert.equal(hydrateTrace?.details?.delayMs, 0);
});

test('createCachedOpenController skips delayed stale cached fallback when prioritized hydration settles first', async () => {
  const traces = [];
  const scheduled = [];
  const hydrationCalls = [];
  const renderCalls = [];
  const controller = openFlow.createCachedOpenController({
    normalizeChatId: (chatId) => Number(chatId),
    setActiveChatMeta: () => {},
    renderMessages: (...args) => {
      renderCalls.push(args);
    },
    getActiveChatId: () => 7,
    getLastOpenChatRequestId: () => 4,
    scheduleTimeout: (callback, delay = 0) => {
      scheduled.push({ delay: Number(delay), callback });
      return scheduled.length;
    },
    requestIdle: () => {
      throw new Error('requestIdle should not be used for prioritized hydration');
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

  assert.deepEqual(scheduled.map((entry) => entry.delay), [24, 0]);
  await scheduled[1].callback();
  await Promise.resolve();
  scheduled[0].callback();

  assert.deepEqual(hydrationCalls, [[7, 4, true]]);
  assert.deepEqual(renderCalls, []);
  assert.equal(traces.find((entry) => entry.eventName === 'cached-render-skipped-hydrate-settled')?.details?.chatId, 7);
});

test('createCachedOpenController skips deferred cached paint when ordinary cached hydration settles before the UI mutation commits', async () => {
  const traces = [];
  const scheduled = [];
  const hydrationCalls = [];
  const renderCalls = [];
  const uiCallbacks = [];
  const controller = openFlow.createCachedOpenController({
    normalizeChatId: (chatId) => Number(chatId),
    setActiveChatMeta: () => {},
    renderMessages: (...args) => {
      renderCalls.push(args);
    },
    getActiveChatId: () => 7,
    getLastOpenChatRequestId: () => 4,
    scheduleTimeout: (callback, delay = 0) => {
      scheduled.push({ delay: Number(delay), callback });
      return scheduled.length;
    },
    requestIdle: () => {
      throw new Error('requestIdle should not be used for selected cached hydration');
    },
    enqueueUiMutation: (callback) => {
      uiCallbacks.push(callback);
    },
    shouldDeferNonCriticalCachedOpen: () => true,
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

  assert.equal(uiCallbacks.length, 1);
  assert.deepEqual(scheduled.map((entry) => entry.delay), [0]);
  await scheduled[0].callback();
  await Promise.resolve();
  uiCallbacks[0]();

  assert.deepEqual(hydrationCalls, [[7, 4, true]]);
  assert.deepEqual(renderCalls, []);
  assert.equal(traces.find((entry) => entry.eventName === 'cached-render-skipped-hydrate-settled')?.details?.chatId, 7);
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

test('createHistoryOpenController appends a system message when cold-open hydration fails for the latest request', async () => {
  const traces = [];
  const activeMeta = [];
  const rendered = [];
  const systemMessages = [];
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

test('createHistoryOpenController can suppress the cold-open placeholder render until hydration settles', async () => {
  const traces = [];
  const activeMeta = [];
  const rendered = [];
  let resolveHydration;
  const hydrationPromise = new Promise((resolve) => {
    resolveHydration = resolve;
  });
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
    appendSystemMessage: () => {},
    fetchController: {
      loadChatHistory: async () => ({ chat: { id: 8 }, history: [] }),
      prefetchChatHistory: () => {},
      warmChatHistoryCache: () => {},
    },
    hydrationController: {
      hydrateChatFromServer: async () => {
        await hydrationPromise;
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

  const openPromise = controller.openChat(8, { suppressColdOpenRender: true });
  await Promise.resolve();

  assert.deepEqual(activeMeta, [{ chatId: 8, options: { fullTabRender: false, deferNonCritical: true } }]);
  assert.deepEqual(rendered, []);
  assert.equal(traces[0].eventName, 'open-start');

  resolveHydration();
  await openPromise;

  assert.deepEqual(rendered, []);
});
