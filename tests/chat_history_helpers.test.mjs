import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chatHistory = require('../static/chat_history_helpers.js');
const runtimeHistory = require('../static/runtime_history_helpers.js');

function buildHarness(overrides = {}) {
  const histories = new Map();
  const chats = new Map([[7, { id: 7, unread_count: 2, pending: false }]]);
  const prefetchingHistories = new Set();
  const upsertedChats = [];
  const activeMeta = [];
  const renderedMessages = [];
  const refreshedTabs = [];
  const resumedChats = [];
  const apiCalls = [];
  const renderTraceLogs = [];
  const persistedSnapshots = [];
  const clearedSnapshots = [];
  const markReadCalls = [];
  const statusSyncCalls = [];
  const pinnedStatusSyncCalls = [];
  let renderPinnedChatsCalls = 0;
  const resumeVisibilityChecks = [];
  const restoredSnapshots = [];
  const abortedStreamChats = [];
  const markReadInFlight = new Set();
  const unseenStreamChats = new Set();
  const finalizedHydratedPendingChats = [];
  const renderedAssistantNodes = [];
  const messagesContainer = {
    scrollTop: 0,
    clientHeight: 0,
    appendedNodes: [],
    appendChild(node) {
      this.appendedNodes.push(node);
      return node;
    },
    querySelectorAll: (selector) => {
      if (selector === '.message[data-role="assistant"]:not(.message--pending), .message[data-role="hermes"]:not(.message--pending)') {
        return renderedAssistantNodes;
      }
      return [];
    },
  };
  const roleNode = { textContent: '' };
  const timeNode = { textContent: '' };
  const bodyNode = {};
  const systemMessageNode = {
    classList: { add() {} },
    querySelector(selector) {
      if (selector === '.message__role') return roleNode;
      if (selector === '.message__time') return timeNode;
      if (selector === '.message__body') return bodyNode;
      return null;
    },
  };
  const template = {
    content: {
      firstElementChild: {
        cloneNode() {
          return systemMessageNode;
        },
      },
    },
  };
  const pendingChats = new Set([7]);
  let renderTabsCalls = 0;
  let syncActivePendingStatusCalls = 0;
  let updateComposerStateCalls = 0;
  let isNearBottom = true;
  let isAuthenticated = true
  let lastOpenChatRequestId = 0;
  let activeChatId = 7;
  let nowMsValue = 1000;

  const deps = {
    apiPost: async (path, payload) => {
      apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      if (path === '/api/chats/open') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 2, role: 'assistant', body: 'opened' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        markReadCalls.push(Number(payload.chat_id));
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
        };
      }
      if (path === '/api/chats/status') {
        return {
          chats: [{ id: 7, unread_count: 1 }],
          pinned_chats: [{ id: 9, unread_count: 0 }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    histories,
    chats,
    prefetchingHistories,
    upsertChat: (chat) => upsertedChats.push(chat),
    setActiveChatMeta: (chatId, options = {}) => activeMeta.push({ chatId: Number(chatId), options }),
    renderMessages: (chatId, options = {}) => renderedMessages.push({ chatId: Number(chatId), options }),
    hasLiveStreamController: () => false,
    abortStreamController: (chatId) => {
      abortedStreamChats.push(Number(chatId));
    },
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    refreshTabNode: (chatId) => refreshedTabs.push(Number(chatId)),
    getActiveChatId: () => activeChatId,
    resumePendingChatStream: (chatId, options = {}) => resumedChats.push({ chatId: Number(chatId), options }),
    messagesEl: messagesContainer,
    template,
    nowStamp: () => '10:45',
    renderBody: (_container, text) => {
      bodyNode.textContent = String(text);
    },
    getLastOpenChatRequestId: () => lastOpenChatRequestId,
    setLastOpenChatRequestId: (value) => { lastOpenChatRequestId = Number(value); },
    scheduleTimeout: (callback) => callback(),
    requestIdle: null,
    runAfterUiMutation: (callback) => callback(),
    renderTraceLog: (eventName, details = null) => {
      renderTraceLogs.push({ eventName, details });
    },
    nowMs: () => {
      nowMsValue += 5;
      return nowMsValue;
    },
    getIsAuthenticated: () => isAuthenticated,
    isNearBottomFn: () => isNearBottom,
    messagesContainer,
    unseenStreamChats,
    markReadInFlight,
    renderTabs: () => {
      renderTabsCalls += 1;
    },
    syncChats: (items) => {
      statusSyncCalls.push(items);
    },
    syncPinnedChats: (items) => {
      pinnedStatusSyncCalls.push(items);
    },
    renderPinnedChats: () => {
      renderPinnedChatsCalls += 1;
    },
    syncActivePendingStatus: () => {
      syncActivePendingStatusCalls += 1;
    },
    updateComposerState: () => {
      updateComposerStateCalls += 1;
    },
    pendingChats,
    finalizeHydratedPendingState: (chatId) => {
      const key = Number(chatId);
      finalizedHydratedPendingChats.push(key);
      pendingChats.delete(key);
      const chat = chats.get(key);
      if (chat && typeof chat === 'object') {
        chat.pending = false;
      }
    },
    restorePendingStreamSnapshot: (chatId) => {
      restoredSnapshots.push(Number(chatId));
      return false;
    },
    hasFreshPendingStreamSnapshot: () => false,
    persistPendingStreamSnapshot: (chatId) => {
      persistedSnapshots.push(Number(chatId));
      return true;
    },
    clearPendingStreamSnapshot: (chatId) => {
      clearedSnapshots.push(Number(chatId));
      return true;
    },
    shouldResumeOnVisibilityChange: (args) => {
      resumeVisibilityChecks.push(args);
      return false;
    },
    ...overrides,
  };

  return {
    controller: chatHistory.createController(deps),
    histories,
    chats,
    prefetchingHistories,
    upsertedChats,
    activeMeta,
    renderedMessages,
    refreshedTabs,
    resumedChats,
    apiCalls,
    renderTraceLogs,
    persistedSnapshots,
    clearedSnapshots,
    markReadCalls,
    statusSyncCalls,
    pinnedStatusSyncCalls,
    resumeVisibilityChecks,
    restoredSnapshots,
    abortedStreamChats,
    markReadInFlight,
    unseenStreamChats,
    messagesContainer,
    pendingChats,
    finalizedHydratedPendingChats,
    renderedAssistantNodes,
    getRenderTabsCalls: () => renderTabsCalls,
    getRenderPinnedChatsCalls: () => renderPinnedChatsCalls,
    getSyncActivePendingStatusCalls: () => syncActivePendingStatusCalls,
    getUpdateComposerStateCalls: () => updateComposerStateCalls,
    setActiveChatId: (value) => { activeChatId = Number(value); },
    setIsNearBottom: (value) => { isNearBottom = Boolean(value); },
    setRenderedAssistantNodes: (nodes) => {
      renderedAssistantNodes.splice(0, renderedAssistantNodes.length, ...nodes);
    },
    setMessageViewport: ({ scrollTop = messagesContainer.scrollTop, clientHeight = messagesContainer.clientHeight } = {}) => {
      messagesContainer.scrollTop = Number(scrollTop);
      messagesContainer.clientHeight = Number(clientHeight);
    },
    setIsAuthenticated: (value) => { isAuthenticated = Boolean(value); },
  };
}

test('historiesDiffer only flags meaningful tail changes', () => {
  const harness = buildHarness();

  assert.equal(harness.controller.historiesDiffer([], []), false);
  assert.equal(harness.controller.historiesDiffer([{ id: 1, body: 'a', role: 'assistant' }], [{ id: 1, body: 'a', role: 'assistant' }]), false);
  assert.equal(harness.controller.historiesDiffer([{ id: 1, body: 'a', role: 'assistant' }], [{ id: 2, body: 'a', role: 'assistant' }]), true);
});

test('loadChatHistory falls back to /api/chats/open on 404 history path', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        throw new Error('Request failed: 404');
      }
      return {
        chat: { id: Number(payload.chat_id), pending: false },
        history: [{ id: 2, role: 'assistant', body: 'opened' }],
      };
    },
  });

  const data = await harness.controller.loadChatHistory(7, { activate: true });

  assert.equal(data.history[0].body, 'opened');
  assert.deepEqual(harness.apiCalls.map((call) => call.path), ['/api/chats/history', '/api/chats/open']);
});

test('hydrateChatFromServer updates history and rerenders active chat', async () => {
  const harness = buildHarness();

  await harness.controller.hydrateChatFromServer(7, 0, false);

  assert.deepEqual(harness.upsertedChats, [{ id: 7, pending: false }]);
  assert.deepEqual(harness.histories.get(7), [{ id: 1, role: 'assistant', body: 'hello' }]);
  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: { preserveViewport: false } }]);
  assert.deepEqual(harness.restoredSnapshots, []);
});

test('hydrateChatFromServer preserves local unread count until mark-read threshold is reached', async () => {
  const harness = buildHarness();

  await harness.controller.hydrateChatFromServer(7, 0, false);

  assert.equal(harness.chats.get(7).unread_count, 2);
  assert.deepEqual(harness.refreshedTabs, [7]);
});

test('hydrateChatFromServer restores pending snapshot for pending chats before resuming', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      return {
        chat: { id: Number(payload.chat_id), pending: true },
        history: [{ id: 1, role: 'assistant', body: 'hello' }],
      };
    },
  });

  await harness.controller.hydrateChatFromServer(7, 0, false);

  assert.deepEqual(harness.restoredSnapshots, [7]);
  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: {} }]);
});

test('hydrateChatFromServer treats completed hydrate as terminal when local history only has stale pending tool activity', async () => {
  const harness = buildHarness({
    mergeHydratedHistory: runtimeHistory.mergeHydratedHistory,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      return {
        chat: { id: Number(payload.chat_id), pending: false },
        history: [
          { id: 10, role: 'tool', body: 'read_file\nsearch_files', created_at: '2026-04-09T18:15:00Z', pending: false },
          { id: 11, role: 'assistant', body: 'final answer', created_at: '2026-04-09T18:16:00Z', pending: false },
        ],
      };
    },
  });
  harness.histories.set(7, [
    { role: 'tool', body: 'read_file\nsearch_files', created_at: '2026-04-09T18:15:00Z', pending: true, collapsed: true },
  ]);
  harness.chats.set(7, { id: 7, unread_count: 2, pending: true });
  harness.pendingChats.add(7);

  await harness.controller.hydrateChatFromServer(7, 0, false);

  assert.deepEqual(harness.histories.get(7), [
    { id: 10, role: 'tool', body: 'read_file\nsearch_files', created_at: '2026-04-09T18:15:00Z', pending: false },
    { id: 11, role: 'assistant', body: 'final answer', created_at: '2026-04-09T18:16:00Z', pending: false },
  ]);
  assert.deepEqual(harness.finalizedHydratedPendingChats, [7]);
  assert.deepEqual(harness.resumedChats, []);
});

test('hydrateChatFromServer restores fresh pending snapshot even when server hydrate briefly says not pending', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      return {
        chat: { id: Number(payload.chat_id), pending: false },
        history: [{ id: 1, role: 'assistant', body: 'hello' }],
      };
    },
    hasFreshPendingStreamSnapshot: (chatId) => Number(chatId) === 7,
    restorePendingStreamSnapshot: (chatId) => {
      harness.restoredSnapshots.push(Number(chatId));
      harness.histories.set(Number(chatId), [
        { id: 1, role: 'assistant', body: 'hello' },
        { role: 'tool', body: 'missed tool', pending: true },
      ]);
      return true;
    },
  });

  await harness.controller.hydrateChatFromServer(7, 0, false);

  assert.deepEqual(harness.restoredSnapshots, [7]);
  assert.deepEqual(harness.histories.get(7), [
    { id: 1, role: 'assistant', body: 'hello' },
    { role: 'tool', body: 'missed tool', pending: true },
  ]);
  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: { force: true } }]);
});

test('hydrateChatFromServer rerenders active chat when restoring a pending snapshot mutates local history after merge', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      return {
        chat: { id: Number(payload.chat_id), pending: true },
        history: [{ id: 1, role: 'operator', body: 'working' }],
      };
    },
    restorePendingStreamSnapshot: (chatId) => {
      harness.restoredSnapshots.push(Number(chatId));
      harness.histories.set(Number(chatId), [
        { id: 1, role: 'operator', body: 'working' },
        { role: 'tool', body: 'missed tool', pending: true },
      ]);
      return true;
    },
  });

  await harness.controller.hydrateChatFromServer(7, 0, true);

  assert.deepEqual(harness.restoredSnapshots, [7]);
  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: { preserveViewport: true } }]);
  assert.deepEqual(harness.histories.get(7), [
    { id: 1, role: 'operator', body: 'working' },
    { role: 'tool', body: 'missed tool', pending: true },
  ]);
});


test('openChat uses cached history path before background hydration', async () => {
  const scheduledHydrations = [];
  const harness = buildHarness({
    shouldDeferNonCriticalCachedOpen: () => true,
    scheduleTimeout: (callback, delay) => {
      scheduledHydrations.push({ callback, delay });
      return callback();
    },
  });
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);

  await harness.controller.openChat(7);

  assert.deepEqual(harness.activeMeta[0], { chatId: 7, options: { fullTabRender: false, deferNonCritical: true } });
  assert.deepEqual(harness.renderedMessages.at(0), { chatId: 7, options: {} });
  assert.equal(scheduledHydrations.length, 1);
  assert.equal(scheduledHydrations[0].delay, 32);
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), true);
});

test('openChat defers cached transcript render by one UI turn when non-critical cached-open work is deferred', async () => {
  const uiCallbacks = [];
  const scheduledHydrations = [];
  const harness = buildHarness({
    shouldDeferNonCriticalCachedOpen: () => true,
    runAfterUiMutation: (callback) => {
      uiCallbacks.push(callback);
    },
    scheduleTimeout: (callback, delay) => {
      scheduledHydrations.push({ callback, delay });
    },
  });
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);

  await harness.controller.openChat(7);

  assert.deepEqual(harness.activeMeta.at(-1), { chatId: 7, options: { fullTabRender: false, deferNonCritical: true } });
  assert.equal(harness.renderedMessages.length, 0);
  assert.equal(uiCallbacks.length, 1);
  assert.equal(scheduledHydrations.length, 1);
  assert.equal(scheduledHydrations[0].delay, 32);
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);

  uiCallbacks[0]();

  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: {} }]);
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);

  await scheduledHydrations[0].callback();
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), true);
});

test('openChat emits cached-open timing breadcrumbs for deferred cached switches', async () => {
  const uiCallbacks = [];
  const scheduledHydrations = [];
  const harness = buildHarness({
    shouldDeferNonCriticalCachedOpen: () => true,
    runAfterUiMutation: (callback) => {
      uiCallbacks.push(callback);
    },
    scheduleTimeout: (callback, delay) => {
      scheduledHydrations.push({ callback, delay });
    },
  });
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);

  await harness.controller.openChat(7);
  uiCallbacks[0]();
  await scheduledHydrations[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    harness.renderTraceLogs.map((entry) => entry.eventName),
    [
      'chat-history-open-start',
      'chat-history-cached-hydrate-scheduled',
      'chat-history-cached-render-commit',
      'chat-history-cached-hydrate-begin',
      'chat-history-hydrate-start',
      'chat-history-history-fetch-start',
      'chat-history-history-fetch-finished',
      'chat-history-hydrate-applied',
    ],
  );
  assert.deepEqual(harness.renderTraceLogs[0].details, {
    chatId: 7,
    requestId: 1,
    hadCachedHistory: true,
  });
  assert.deepEqual(harness.renderTraceLogs[1].details, {
    chatId: 7,
    requestId: 1,
    mode: 'timeout',
    delayMs: 32,
  });
  assert.equal(harness.renderTraceLogs[2].details.deferred, true);
  assert.equal(harness.renderTraceLogs[3].details.chatId, 7);
  assert.equal(harness.renderTraceLogs.at(-1).details.hadCachedHistory, true);
  assert.equal(harness.renderTraceLogs.at(-1).details.durationMs > 0, true);
});

test('openChat skips deferred cached transcript render after a newer tab switch takes ownership', async () => {
  const uiCallbacks = [];
  const scheduledHydrations = [];
  const harness = buildHarness({
    shouldDeferNonCriticalCachedOpen: () => true,
    runAfterUiMutation: (callback) => {
      uiCallbacks.push(callback);
    },
    scheduleTimeout: (callback, delay) => {
      scheduledHydrations.push({ callback, delay });
    },
  });
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);

  await harness.controller.openChat(7);
  harness.setActiveChatId(8);

  assert.equal(uiCallbacks.length, 1);
  assert.equal(scheduledHydrations.length, 1);
  uiCallbacks[0]();

  assert.equal(harness.renderedMessages.length, 0);
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);

  await scheduledHydrations[0].callback();
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);
});

test('openChat emits cold-open timing breadcrumbs for first activation fetches', async () => {
  const harness = buildHarness();

  await harness.controller.openChat(8);

  assert.deepEqual(
    harness.renderTraceLogs.map((entry) => entry.eventName),
    [
      'chat-history-open-start',
      'chat-history-hydrate-start',
      'chat-history-history-fetch-start',
      'chat-history-history-fetch-finished',
      'chat-history-hydrate-applied',
    ],
  );
  assert.deepEqual(harness.renderTraceLogs[0].details, {
    chatId: 8,
    requestId: 1,
    hadCachedHistory: false,
  });
  assert.deepEqual(harness.renderTraceLogs[2].details, {
    chatId: 8,
    activate: true,
  });
  assert.equal(harness.renderTraceLogs[3].details.source, 'history');
  assert.equal(harness.renderTraceLogs[4].details.hadCachedHistory, false);
  assert.equal(harness.renderTraceLogs[4].details.durationMs > 0, true);
});

test('openChat disables deferred cached-chat meta on mobile-style contexts', async () => {
  const scheduledHydrations = [];
  const harness = buildHarness({
    shouldDeferNonCriticalCachedOpen: () => false,
    scheduleTimeout: (callback, delay) => {
      scheduledHydrations.push({ callback, delay });
    },
  });
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);

  await harness.controller.openChat(7);

  assert.deepEqual(harness.activeMeta.at(-1), { chatId: 7, options: { fullTabRender: false, deferNonCritical: false } });
  assert.deepEqual(harness.renderedMessages.at(0), { chatId: 7, options: {} });
  assert.equal(scheduledHydrations.length, 1);
  assert.equal(scheduledHydrations[0].delay, 0);
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);

  await scheduledHydrations[0].callback();
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), true);
});

test('openChat uses requestIdle to delay cached hydration when deferring non-critical cached-open work', async () => {
  const idleCallbacks = [];
  const harness = buildHarness({
    shouldDeferNonCriticalCachedOpen: () => true,
    requestIdle: (callback, options) => {
      idleCallbacks.push({ callback, options });
    },
    scheduleTimeout: () => {
      throw new Error('scheduleTimeout should not be used when requestIdle is available for deferred cached hydration');
    },
  });
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);

  await harness.controller.openChat(7);

  assert.equal(idleCallbacks.length, 1);
  assert.deepEqual(idleCallbacks[0].options, { timeout: 250 });
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);

  await idleCallbacks[0].callback();
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), true);
});

test('openChat keeps unread dot state while opening cached unread chat', async () => {
  const harness = buildHarness();
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);

  await harness.controller.openChat(7);

  assert.equal(harness.chats.get(7).unread_count, 2);
});

test('openChat does not clear unread just by switching into an unread chat that is already bottom-pinned', async () => {
  const harness = buildHarness();
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);
  harness.chats.get(7).unread_count = 1;
  harness.setRenderedAssistantNodes([{ offsetTop: 420, offsetHeight: 140 }]);
  harness.setMessageViewport({ scrollTop: 320, clientHeight: 260 });

  await harness.controller.openChat(7);
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, []);
  assert.equal(harness.chats.get(7).unread_count, 1);

  harness.setMessageViewport({ scrollTop: 120, clientHeight: 260 });
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.markReadCalls, []);

  harness.setMessageViewport({ scrollTop: 320, clientHeight: 260 });
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, [7]);
});

test('ensureActivationReadThreshold prevents bootstrap-resume mark-read from clearing unread before the operator re-hits bottom', async () => {
  const harness = buildHarness();
  harness.chats.get(7).unread_count = 1;
  harness.setRenderedAssistantNodes([{ offsetTop: 420, offsetHeight: 140 }]);
  harness.setMessageViewport({ scrollTop: 320, clientHeight: 260 });

  harness.controller.ensureActivationReadThreshold(7, 1);
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, []);
  assert.equal(harness.chats.get(7).unread_count, 1);

  harness.setMessageViewport({ scrollTop: 120, clientHeight: 260 });
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.markReadCalls, []);

  harness.setMessageViewport({ scrollTop: 320, clientHeight: 260 });
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, [7]);
});

test('ensureActivationReadThreshold allows first bottom-hit to clear unread when activation started above the newest unread message bottom', async () => {
  const harness = buildHarness();
  harness.chats.get(7).unread_count = 1;
  harness.setRenderedAssistantNodes([{ offsetTop: 420, offsetHeight: 140 }]);
  harness.setMessageViewport({ scrollTop: 40, clientHeight: 260 });

  harness.controller.ensureActivationReadThreshold(7, 1);
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, []);
  assert.equal(harness.chats.get(7).unread_count, 1);

  harness.setMessageViewport({ scrollTop: 320, clientHeight: 260 });
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, [7]);
});

test('openChat preserves local unread when activated history hydrate reports unread_count 0 before bottom threshold is met', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    upsertChat: (chat) => {
      harness.upsertedChats.push(chat);
      const current = harness.chats.get(Number(chat.id)) || {};
      harness.chats.set(Number(chat.id), {
        ...current,
        ...chat,
        id: Number(chat.id),
        unread_count: Number(chat.unread_count || 0),
        pending: Boolean(chat.pending),
      });
    },
  });
  harness.chats.set(7, { id: 7, unread_count: 1, pending: false });
  harness.setRenderedAssistantNodes([{ offsetTop: 420, offsetHeight: 140 }]);
  harness.setMessageViewport({ scrollTop: 320, clientHeight: 260 });

  await harness.controller.openChat(7);

  assert.equal(harness.chats.get(7).unread_count, 1);
  assert.deepEqual(harness.markReadCalls, []);
});

test('refreshChats syncs chat and pinned status with render/composer updates', async () => {
  const harness = buildHarness();

  await harness.controller.refreshChats();

  assert.deepEqual(harness.apiCalls.at(-1), {
    path: '/api/chats/status',
    payload: {},
  });
  assert.deepEqual(harness.statusSyncCalls, [[{ id: 7, unread_count: 1 }]]);
  assert.deepEqual(harness.pinnedStatusSyncCalls, [[{ id: 9, unread_count: 0 }]]);
  assert.equal(harness.getRenderTabsCalls(), 1);
  assert.equal(harness.getRenderPinnedChatsCalls(), 1);
  assert.equal(harness.getSyncActivePendingStatusCalls(), 1);
  assert.equal(harness.getUpdateComposerStateCalls(), 1);
});

test('refreshChats preserves local unread while activation threshold is still armed', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/status') {
        return {
          chats: [{ id: 7, unread_count: 0, pending: false }],
          pinned_chats: [{ id: 7, unread_count: 0, pending: false }],
        };
      }
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.chats.set(7, { id: 7, unread_count: 2, pending: false });
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);

  await harness.controller.openChat(7);
  await harness.controller.refreshChats();

  assert.deepEqual(harness.statusSyncCalls, [[{ id: 7, unread_count: 2, pending: false }]]);
  assert.deepEqual(harness.pinnedStatusSyncCalls, [[{ id: 7, unread_count: 2, pending: false }]]);
  assert.equal(harness.chats.get(7).unread_count, 2);
  assert.deepEqual(harness.markReadCalls, []);
});

test('refreshChats clears stale local pending state when server reports chat not pending and no live stream exists', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/status') {
        return {
          chats: [{ id: 7, unread_count: 0, pending: false }],
          pinned_chats: [],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  await harness.controller.refreshChats();

  assert.deepEqual(harness.finalizedHydratedPendingChats, [7]);
  assert.equal(harness.pendingChats.has(7), false);
});

test('refreshChats aborts stale live stream controllers before finalizing when server reports chat complete', async () => {
  const harness = buildHarness({
    hasLiveStreamController: (chatId) => Number(chatId) === 7,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/status') {
        return {
          chats: [{ id: 7, unread_count: 0, pending: false }],
          pinned_chats: [],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  await harness.controller.refreshChats();

  assert.deepEqual(harness.abortedStreamChats, [7]);
  assert.deepEqual(harness.finalizedHydratedPendingChats, [7]);
  assert.equal(harness.pendingChats.has(7), false);
});

test('refreshChats tolerates missing chat arrays by defaulting to empty collections', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/status') {
        return {};
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  await harness.controller.refreshChats();

  assert.deepEqual(harness.statusSyncCalls, [[]]);
  assert.deepEqual(harness.pinnedStatusSyncCalls, [[]]);
  assert.equal(harness.getRenderTabsCalls(), 1);
  assert.equal(harness.getRenderPinnedChatsCalls(), 1);
});

test('syncVisibleActiveChat hydrates active history and resumes pending streams when resume conditions match', async () => {
  const streamAbortControllers = new Map();
  const visibilityChecks = [];
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: (args) => {
      visibilityChecks.push(args);
      return true;
    },
  });

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.histories.get(7), [{ id: 1, role: 'assistant', body: 'hello' }]);
  assert.deepEqual(harness.renderedMessages.at(-1), { chatId: 7, options: { preserveViewport: true } });
  assert.deepEqual(visibilityChecks.at(-1), {
    hidden: false,
    activeChatId: 7,
    pendingChats: harness.pendingChats,
    streamAbortControllers,
  });
  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: {} }]);
  assert.deepEqual(harness.markReadCalls, []);
});

test('syncVisibleActiveChat resumes when server still reports pending and there is no live stream', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: true },
          history: [{ id: 11, role: 'assistant', body: 'pending' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: true, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: {} }]);
});

test('syncVisibleActiveChat finalizes stale local pending tool traces when hydrate already includes the completed assistant reply', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    pendingChats: new Set(),
    mergeHydratedHistory: runtimeHistory.mergeHydratedHistory,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: 7, pending: false },
          history: [
            { id: 10, role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: false },
            { id: 11, role: 'assistant', body: 'hello', created_at: '2026-04-09T18:16:00Z', pending: false },
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.histories.set(7, [{ role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: true }]);

  await harness.controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });

  assert.deepEqual(harness.restoredSnapshots, []);
  assert.deepEqual(harness.finalizedHydratedPendingChats, [7]);
  assert.deepEqual(harness.histories.get(7), [
    { id: 10, role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: false },
    { id: 11, role: 'assistant', body: 'hello', created_at: '2026-04-09T18:16:00Z', pending: false },
  ]);
  assert.deepEqual(harness.resumedChats, []);
});

test('syncVisibleActiveChat restores fresh pending snapshot even when local history is empty and server says not pending', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    pendingChats: new Set(),
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
    hasFreshPendingStreamSnapshot: (chatId) => Number(chatId) === 7,
    restorePendingStreamSnapshot: (chatId) => {
      harness.restoredSnapshots.push(Number(chatId));
      harness.histories.set(Number(chatId), [
        { id: 1, role: 'assistant', body: 'hello' },
        { role: 'tool', body: 'missed tool', pending: true },
      ]);
      return true;
    },
  });

  await harness.controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });

  assert.deepEqual(harness.restoredSnapshots, [7]);
  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: { preserveViewport: true } }]);
  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: { force: true } }]);
});

test('syncVisibleActiveChat rerenders active chat with completed transcript instead of restoring stale pending snapshot when hydrate already completed', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    pendingChats: new Set(),
    mergeHydratedHistory: runtimeHistory.mergeHydratedHistory,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: 7, pending: false },
          history: [
            { id: 10, role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: false },
            { id: 11, role: 'assistant', body: 'hello', created_at: '2026-04-09T18:16:00Z', pending: false },
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    restorePendingStreamSnapshot: (chatId) => {
      harness.restoredSnapshots.push(Number(chatId));
      harness.histories.set(Number(chatId), [
        { id: 10, role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: false },
        { id: 11, role: 'assistant', body: 'hello', created_at: '2026-04-09T18:16:00Z', pending: false },
        { role: 'tool', body: 'missed tool', pending: true },
      ]);
      return true;
    },
  });
  harness.histories.set(7, [{ role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: true }]);

  await harness.controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.restoredSnapshots, []);
  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: { preserveViewport: true } }]);
  assert.deepEqual(harness.histories.get(7), [
    { id: 10, role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: false },
    { id: 11, role: 'assistant', body: 'hello', created_at: '2026-04-09T18:16:00Z', pending: false },
  ]);
  assert.deepEqual(harness.resumedChats, []);
});

test('syncVisibleActiveChat forces resume when local pending assistant traces exist without live stream', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    pendingChats: new Set(),
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 41, role: 'assistant', body: 'stale snapshot' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.histories.set(7, [
    { role: 'hermes', body: 'Working…', pending: true },
  ]);

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.restoredSnapshots, [7]);
  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: { force: true } }]);
});

test('syncVisibleActiveChat skips rerender when hydrated active history is render-identical', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.histories.set(7, [{ id: 1, role: 'assistant', body: 'hello' }]);

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.renderedMessages, []);
  assert.deepEqual(harness.resumedChats, []);
  assert.deepEqual(harness.refreshedTabs, [7]);
});

test('syncVisibleActiveChat skips rerender when hydrated active history only adds a server id to the same assistant text', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 101, role: 'assistant', body: 'hello' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.histories.set(7, [{ role: 'assistant', body: 'hello' }]);

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.renderedMessages, []);
  assert.deepEqual(harness.refreshedTabs, [7]);
});

test('syncVisibleActiveChat finalizes local pending immediately when hydrated completed assistant matches already-visible local pending reply', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 99, role: 'assistant', body: 'final answer', pending: false }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.unseenStreamChats.add(7);
  harness.histories.set(7, [
    { role: 'assistant', body: 'final answer', pending: true },
  ]);

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.finalizedHydratedPendingChats, [7]);
  assert.equal(harness.pendingChats.has(7), false);
  assert.deepEqual(harness.resumedChats, []);
  assert.deepEqual(harness.refreshedTabs, [7]);
  assert.deepEqual(harness.renderedMessages.at(-1), { chatId: 7, options: { preserveViewport: true } });
});

test('syncVisibleActiveChat ignores stale history responses when active chat changes mid-request', async () => {
  let resolveHistory;
  const historyGate = new Promise((resolve) => {
    resolveHistory = resolve;
  });
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        await historyGate;
        return {
          chat: { id: Number(payload.chat_id), pending: true },
          history: [{ id: 21, role: 'assistant', body: 'stale response' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  const syncPromise = harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  harness.setActiveChatId(8);
  resolveHistory();
  await historyGate;
  await syncPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.histories.has(7), false);
  assert.deepEqual(harness.renderedMessages, []);
  assert.deepEqual(harness.resumedChats, []);
  assert.deepEqual(harness.upsertedChats, []);
  assert.deepEqual(harness.markReadCalls, []);
});

test('syncVisibleActiveChat is a no-op when there is no active chat', async () => {
  const harness = buildHarness();
  harness.setActiveChatId(0);

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });

  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);
  assert.deepEqual(harness.renderedMessages, []);
  assert.deepEqual(harness.resumedChats, []);
  assert.deepEqual(harness.markReadCalls, []);
});

test('addLocalMessage and updatePendingAssistant mutate chat history in place', () => {
  const harness = buildHarness();

  harness.controller.addLocalMessage(7, { role: 'user', body: 'hello' });
  harness.controller.updatePendingAssistant(7, 'streaming', true);
  harness.controller.updatePendingAssistant(7, 'done', false);

  const history = harness.histories.get(7) || [];
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { role: 'user', body: 'hello' });
  assert.equal(history[1].role, 'hermes');
  assert.equal(history[1].body, 'done');
  assert.equal(history[1].pending, false);
});

test('updatePendingAssistant reuses pending assistant role from hydrated history instead of appending duplicate hermes message', () => {
  const harness = buildHarness();
  harness.histories.set(7, [
    { role: 'assistant', body: 'partial', pending: true, created_at: '2026-04-04T12:00:00Z' },
  ]);

  harness.controller.updatePendingAssistant(7, 'completed', false);

  const history = harness.histories.get(7) || [];
  assert.equal(history.length, 1);
  assert.equal(history[0].role, 'assistant');
  assert.equal(history[0].body, 'completed');
  assert.equal(history[0].pending, false);
});

test('updatePendingAssistant skips empty finalized writes without pending message', () => {
  const harness = buildHarness();

  harness.controller.updatePendingAssistant(7, '   ', false);

  assert.equal((harness.histories.get(7) || []).length, 0);
  assert.deepEqual(harness.persistedSnapshots, []);
  assert.deepEqual(harness.clearedSnapshots, []);
});

test('updatePendingAssistant persists and clears pending stream snapshots inside helper ownership', () => {
  const harness = buildHarness();

  harness.controller.updatePendingAssistant(7, 'streaming', true);
  harness.controller.updatePendingAssistant(7, 'completed', false);

  assert.deepEqual(harness.persistedSnapshots, [7, 7]);
  assert.deepEqual(harness.clearedSnapshots, [7]);
});

test('appendSystemMessage appends inline system card when no active chat is selected', () => {
  const harness = buildHarness();
  harness.setActiveChatId(0);

  harness.controller.appendSystemMessage('Waiting for sign-in');

  assert.equal(harness.messagesContainer.appendedNodes.length, 1);
  assert.equal(harness.messagesContainer.appendedNodes[0].querySelector('.message__role').textContent, 'system');
  assert.equal(harness.messagesContainer.appendedNodes[0].querySelector('.message__time').textContent, '10:45');
  assert.equal(harness.messagesContainer.appendedNodes[0].querySelector('.message__body').textContent, 'Waiting for sign-in');
});

test('appendSystemMessage stores active-chat system notice in history and rerenders active chat', () => {
  const harness = buildHarness();

  harness.controller.appendSystemMessage('Resume failed');

  const history = harness.histories.get(7) || [];
  assert.equal(history.length, 1);
  assert.equal(history[0].role, 'system');
  assert.equal(history[0].body, 'Resume failed');
  assert.equal(harness.renderedMessages.at(-1)?.chatId, 7);
});

test('appendSystemMessage can target a non-active chat without rerendering the active view', () => {
  const harness = buildHarness();

  harness.controller.appendSystemMessage('Refactor failed', 8);

  const targetHistory = harness.histories.get(8) || [];
  assert.equal(targetHistory.length, 1);
  assert.equal(targetHistory[0].role, 'system');
  assert.equal(targetHistory[0].body, 'Refactor failed');
  assert.equal(harness.histories.get(7), undefined);
  assert.equal(harness.renderedMessages.length, 0);
});

test('openChat failure stays attached to the requested chat instead of the newly active chat', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history' && Number(payload.chat_id) === 8) {
        throw new Error('Failed to open chat 8');
      }
      return {
        chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
        history: [],
      };
    },
  });
  harness.setActiveChatId(7);

  await harness.controller.openChat(8);

  const targetHistory = harness.histories.get(8) || [];
  const activeHistory = harness.histories.get(7) || [];
  assert.equal(targetHistory.at(-1)?.role, 'system');
  assert.equal(targetHistory.at(-1)?.body, 'Failed to open chat 8');
  assert.equal(activeHistory.length, 0);
});

test('sync and schedule active message view only render active chat', () => {
  const mutations = [];
  const harness = buildHarness({
    runAfterUiMutation: (callback) => {
      mutations.push('queued');
      callback();
    },
  });

  harness.controller.syncActiveMessageView(8, { preserveViewport: true });
  harness.controller.syncActiveMessageView(7, { preserveViewport: true });
  harness.controller.scheduleActiveMessageView(8);
  harness.controller.scheduleActiveMessageView(7);

  assert.deepEqual(harness.renderedMessages, [
    { chatId: 7, options: { preserveViewport: true } },
    { chatId: 7, options: { preserveViewport: true } },
  ]);
  assert.deepEqual(mutations, ['queued']);
});

test('markRead syncs unread state and active-chat composer status', async () => {
  const harness = buildHarness();

  await harness.controller.markRead(7);

  assert.deepEqual(harness.apiCalls.at(-1), {
    path: '/api/chats/mark-read',
    payload: { chat_id: 7 },
  });
  assert.equal(harness.upsertedChats.length, 1);
  assert.equal(harness.getRenderTabsCalls(), 1);
  assert.equal(harness.getSyncActivePendingStatusCalls(), 1);
  assert.equal(harness.getUpdateComposerStateCalls(), 1);
});

test('markRead skips active-chat UI sync when target chat is inactive', async () => {
  const harness = buildHarness();
  harness.setActiveChatId(99);

  await harness.controller.markRead(7);

  assert.equal(harness.getRenderTabsCalls(), 1);
  assert.equal(harness.getSyncActivePendingStatusCalls(), 0);
  assert.equal(harness.getUpdateComposerStateCalls(), 0);
});

test('syncVisibleActiveChat preserves local unread when active history sync reports unread_count 0 before bottom threshold is met', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 1, role: 'assistant', body: 'hello again' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    upsertChat: (chat) => {
      harness.upsertedChats.push(chat);
      const current = harness.chats.get(Number(chat.id)) || {};
      harness.chats.set(Number(chat.id), {
        ...current,
        ...chat,
        id: Number(chat.id),
        unread_count: Number(chat.unread_count || 0),
        pending: Boolean(chat.pending),
      });
    },
  });
  harness.chats.set(7, { id: 7, unread_count: 1, pending: false });
  harness.setRenderedAssistantNodes([{ offsetTop: 420, offsetHeight: 140 }]);
  harness.setMessageViewport({ scrollTop: 320, clientHeight: 260 });

  await harness.controller.openChat(7);
  await harness.controller.syncVisibleActiveChat();

  assert.equal(harness.chats.get(7).unread_count, 1);
  assert.deepEqual(harness.markReadCalls, []);
});

test('syncVisibleActiveChat preserves local unread for the active chat even if activation threshold state was lost but newest unread message is still below viewport', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 1, role: 'assistant', body: 'hello again' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    upsertChat: (chat) => {
      harness.upsertedChats.push(chat);
      const current = harness.chats.get(Number(chat.id)) || {};
      harness.chats.set(Number(chat.id), {
        ...current,
        ...chat,
        id: Number(chat.id),
        unread_count: Number(chat.unread_count || 0),
        pending: Boolean(chat.pending),
      });
    },
  });
  harness.chats.set(7, { id: 7, unread_count: 1, pending: false });
  harness.setRenderedAssistantNodes([{ offsetTop: 420, offsetHeight: 140 }]);
  harness.setMessageViewport({ scrollTop: 320, clientHeight: 260 });

  await harness.controller.syncVisibleActiveChat();

  assert.equal(harness.chats.get(7).unread_count, 1);
  assert.deepEqual(harness.markReadCalls, []);
});

test('maybeMarkRead enforces active/auth/visibility gating before calling markRead', async () => {
  const nearBottomCalls = [];
  let isAuthenticated = true;
  const harness = buildHarness({
    getIsAuthenticated: () => isAuthenticated,
    isNearBottomFn: (container, threshold) => {
      nearBottomCalls.push({ container, threshold });
      return true;
    },
  });

  isAuthenticated = false;
  harness.controller.maybeMarkRead(7);
  isAuthenticated = true;

  harness.setActiveChatId(8);
  harness.controller.maybeMarkRead(7);
  harness.setActiveChatId(7);

  harness.setIsNearBottom(false);
  harness.controller.maybeMarkRead(7);
  harness.setIsNearBottom(true);

  harness.unseenStreamChats.add(7);
  harness.controller.maybeMarkRead(7);
  harness.unseenStreamChats.clear();

  harness.chats.get(7).unread_count = 0;
  harness.controller.maybeMarkRead(7);

  harness.markReadCalls.length = 0;
  harness.chats.get(7).unread_count = 2;
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.markReadCalls.length, 1);
  assert.deepEqual(harness.markReadCalls, [7]);
  assert.ok(nearBottomCalls.length >= 4);
  assert.deepEqual(nearBottomCalls[0], { container: harness.messagesContainer, threshold: 40 });
});

test('maybeMarkRead force mode bypasses near-bottom/unread gates', async () => {
  const harness = buildHarness({
    isNearBottomFn: () => false,
  });

  harness.chats.get(7).unread_count = 0;
  harness.controller.maybeMarkRead(7, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, [7]);
});

test('maybeMarkRead waits for the bottom of the newest unread assistant message, not generic chat bottom proximity', async () => {
  const nearBottomCalls = [];
  const harness = buildHarness({
    isNearBottomFn: (container, threshold) => {
      nearBottomCalls.push({ container, threshold });
      return true;
    },
  });

  harness.chats.get(7).unread_count = 1;
  harness.setRenderedAssistantNodes([
    { offsetTop: 120, offsetHeight: 80 },
    { offsetTop: 420, offsetHeight: 140 },
  ]);
  harness.setMessageViewport({ scrollTop: 240, clientHeight: 240 });

  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.markReadCalls, []);

  harness.setMessageViewport({ scrollTop: 300, clientHeight: 240 });
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, [7]);
  assert.deepEqual(nearBottomCalls, []);
});

test('maybeMarkRead falls back to generic near-bottom gating when newest unread message cannot be measured', async () => {
  const nearBottomCalls = [];
  const harness = buildHarness({
    isNearBottomFn: (container, threshold) => {
      nearBottomCalls.push({ container, threshold });
      return true;
    },
  });

  harness.chats.get(7).unread_count = 1;
  harness.setRenderedAssistantNodes([{ offsetTop: Number.NaN, offsetHeight: Number.NaN }]);
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, [7]);
  assert.deepEqual(nearBottomCalls, [{ container: harness.messagesContainer, threshold: 40 }]);
});

test('maybeMarkRead clears unread optimistically as soon as bottom-threshold read sync starts', async () => {
  let resolveMarkRead;
  const markReadStarted = new Promise((resolve) => {
    resolveMarkRead = resolve;
  });
  let releaseMarkRead;
  const markReadSettled = new Promise((resolve) => {
    releaseMarkRead = resolve;
  });

  const harness = buildHarness({
    apiPost: async (path, payload) => {
      if (path === '/api/chats/mark-read') {
        resolveMarkRead();
        await markReadSettled;
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
        };
      }
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      if (path === '/api/chats/open') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 2, role: 'assistant', body: 'opened' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.chats.get(7).unread_count = 2;
  harness.controller.maybeMarkRead(7);
  await markReadStarted;

  assert.equal(harness.chats.get(7).unread_count, 0);
  assert.equal(harness.getRenderTabsCalls(), 1);

  releaseMarkRead();
  await markReadSettled;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.chats.get(7).unread_count, 0);
  assert.equal(harness.getRenderTabsCalls(), 2);
});

test('maybeMarkRead preserves local pending when mark-read response is stale during a live stream', async () => {
  const harness = buildHarness({
    hasLiveStreamController: (chatId) => Number(chatId) === 7,
    apiPost: async (path, payload) => {
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.chats.set(7, { id: 7, unread_count: 2, pending: true });
  harness.pendingChats.add(7);
  harness.controller.maybeMarkRead(7, { force: true });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, [7]);
  assert.deepEqual(harness.upsertedChats, [{ id: 7, pending: true, unread_count: 0 }]);
});

test('maybeMarkRead retries once after in-flight call settles when a second intent arrived', async () => {
  let resolveFirstMarkRead;
  let markReadCallCount = 0;
  const markReadStarted = [];
  const firstMarkReadPromise = new Promise((resolve) => {
    resolveFirstMarkRead = resolve;
  });

  const harness = buildHarness({
    apiPost: async (path, payload) => {
      if (path === '/api/chats/mark-read') {
        markReadCallCount += 1;
        markReadStarted.push(Number(payload.chat_id));
        if (markReadCallCount === 1) {
          await firstMarkReadPromise;
        }
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
        };
      }
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      if (path === '/api/chats/open') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 2, role: 'assistant', body: 'opened' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.chats.get(7).unread_count = 2;
  harness.controller.maybeMarkRead(7);
  harness.controller.maybeMarkRead(7);

  assert.deepEqual(markReadStarted, [7]);
  assert.equal(harness.markReadInFlight.has(7), true);

  resolveFirstMarkRead();
  await firstMarkReadPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(markReadStarted, [7, 7]);
  assert.equal(harness.markReadInFlight.has(7), false);
});

test('maybeMarkRead clears in-flight state when markRead fails', async () => {
  const harness = buildHarness({
    apiPost: async (path) => {
      if (path === '/api/chats/mark-read') {
        throw new Error('mark-read failed');
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.controller.maybeMarkRead(7, { force: true });
  assert.equal(harness.markReadInFlight.has(7), true);

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.markReadInFlight.has(7), false);
});

test('maybeMarkRead restores unread dot if optimistic mark-read sync fails', async () => {
  const harness = buildHarness({
    apiPost: async (path) => {
      if (path === '/api/chats/mark-read') {
        throw new Error('mark-read failed');
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.chats.get(7).unread_count = 2;
  harness.controller.maybeMarkRead(7);

  assert.equal(harness.chats.get(7).unread_count, 0);

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.chats.get(7).unread_count, 2);
  assert.equal(harness.getRenderTabsCalls(), 2);
});

function buildMetaHarness() {
  const chatScrollTop = new Map();
  const chatStickToBottom = new Map();
  const chats = new Map([
    [3, { id: 3, title: 'Current chat' }],
    [7, { id: 7, title: 'Target chat' }],
    [8, { id: 8, title: 'Second target chat' }],
  ]);
  let activeChatId = 3;
  let renderedChatId = 3;
  const promptEl = { value: 'draft text' };
  const activeChatName = { textContent: '' };
  const panelTitle = { textContent: '' };
  const historyCount = { textContent: '' };
  const messagesEl = {
    scrollTop: 42,
    innerHTML: '<existing />',
    appendChild(node) {
      this.lastAppendedNode = node;
    },
  };

  const roleNode = { textContent: '' };
  const timeNode = { textContent: '' };
  const bodyNode = {};
  const cloneNode = {
    classList: { add() {} },
    querySelector(selector) {
      if (selector === '.message__role') return roleNode;
      if (selector === '.message__time') return timeNode;
      if (selector === '.message__body') return bodyNode;
      return null;
    },
  };
  const template = {
    content: {
      firstElementChild: {
        cloneNode() {
          return cloneNode;
        },
      },
    },
  };

  const calls = {
    setDraft: [],
    renderBody: [],
    updateComposerState: 0,
    syncPinChatButton: 0,
    renderTabs: 0,
    syncActiveTabSelection: [],
    syncLiveToolStreamForChat: [],
    syncActivePendingStatus: 0,
    syncActiveLatencyChip: 0,
    updateJumpLatestVisibility: 0,
    scheduleTimeout: [],
  };

  const controller = chatHistory.createMetaController({
    getActiveChatId: () => activeChatId,
    setActiveChatId: (value) => {
      activeChatId = value == null ? null : Number(value);
    },
    getRenderedChatId: () => renderedChatId,
    setRenderedChatId: (value) => {
      renderedChatId = value == null ? null : Number(value);
    },
    chatScrollTop,
    chatStickToBottom,
    messagesEl,
    isNearBottomFn: () => true,
    setDraft: (chatId, value) => calls.setDraft.push({ chatId: Number(chatId), value }),
    promptEl,
    activeChatName,
    panelTitle,
    template,
    nowStamp: () => '10:30',
    renderBody: (_container, text) => calls.renderBody.push(String(text)),
    historyCount,
    updateComposerState: () => {
      calls.updateComposerState += 1;
    },
    syncPinChatButton: () => {
      calls.syncPinChatButton += 1;
    },
    renderTabs: () => {
      calls.renderTabs += 1;
    },
    syncActiveTabSelection: (previousChatId, nextChatId) => {
      calls.syncActiveTabSelection.push({ previousChatId, nextChatId });
    },
    syncLiveToolStreamForChat: (chatId) => {
      calls.syncLiveToolStreamForChat.push(chatId == null ? null : Number(chatId));
    },
    syncActivePendingStatus: () => {
      calls.syncActivePendingStatus += 1;
    },
    syncActiveLatencyChip: () => {
      calls.syncActiveLatencyChip += 1;
    },
    updateJumpLatestVisibility: () => {
      calls.updateJumpLatestVisibility += 1;
    },
    getDraft: (chatId) => (Number(chatId) === 7 ? 'saved draft' : ''),
    chats,
    scheduleTimeout: (callback, delay) => {
      calls.scheduleTimeout.push({ callback, delay });
    },
  });

  return {
    controller,
    calls,
    chatScrollTop,
    chatStickToBottom,
    promptEl,
    activeChatName,
    panelTitle,
    historyCount,
    messagesEl,
    getActiveChatId: () => activeChatId,
    getRenderedChatId: () => renderedChatId,
    roleNode,
    timeNode,
  };
}

test('createMetaController defers non-critical active-chat updates and preserves prior draft/scroll state', () => {
  const harness = buildMetaHarness();

  harness.controller.setActiveChatMeta(7, { fullTabRender: false, deferNonCritical: true });

  assert.deepEqual(harness.calls.setDraft, [{ chatId: 3, value: 'draft text' }]);
  assert.equal(harness.chatScrollTop.get(3), 42);
  assert.equal(harness.chatStickToBottom.get(3), true);
  assert.equal(harness.getActiveChatId(), 7);
  assert.equal(harness.promptEl.value, 'saved draft');
  assert.equal(harness.activeChatName.textContent, 'Target chat');
  assert.equal(harness.panelTitle.textContent, 'Conversation · Target chat');
  assert.equal(harness.calls.renderTabs, 0);
  assert.deepEqual(harness.calls.syncActiveTabSelection, [{ previousChatId: 3, nextChatId: 7 }]);
  assert.equal(harness.calls.scheduleTimeout.length, 1);
  assert.equal(harness.calls.syncLiveToolStreamForChat.length, 0);
  assert.equal(harness.calls.syncActivePendingStatus, 1);
  assert.equal(harness.calls.syncActiveLatencyChip, 1);
  assert.equal(harness.calls.updateJumpLatestVisibility, 0);

  harness.calls.scheduleTimeout[0].callback();
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [7]);
  assert.equal(harness.calls.syncActivePendingStatus, 1);
  assert.equal(harness.calls.syncActiveLatencyChip, 1);
  assert.equal(harness.calls.updateJumpLatestVisibility, 1);
});

test('createMetaController ignores stale deferred finalize callbacks after a newer tab switch', () => {
  const harness = buildMetaHarness();

  harness.controller.setActiveChatMeta(7, { fullTabRender: false, deferNonCritical: true });
  harness.controller.setActiveChatMeta(3, { fullTabRender: false, deferNonCritical: false });

  assert.equal(harness.calls.scheduleTimeout.length, 1);
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [3]);
  assert.equal(harness.calls.updateJumpLatestVisibility, 1);

  harness.calls.scheduleTimeout[0].callback();

  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [3]);
  assert.equal(harness.calls.updateJumpLatestVisibility, 1);
});

test('createMetaController skips stale deferred non-critical updates after a later tab switch', () => {
  const harness = buildMetaHarness();

  harness.controller.setActiveChatMeta(7, { fullTabRender: false, deferNonCritical: true });
  harness.controller.setActiveChatMeta(8, { fullTabRender: false, deferNonCritical: true });

  assert.equal(harness.calls.scheduleTimeout.length, 2);
  assert.equal(harness.getActiveChatId(), 8);

  harness.calls.scheduleTimeout[0].callback();
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, []);
  assert.equal(harness.calls.updateJumpLatestVisibility, 0);

  harness.calls.scheduleTimeout[1].callback();
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [8]);
  assert.equal(harness.calls.updateJumpLatestVisibility, 1);
});

test('createMetaController setNoActiveChatMeta clears active state and renders empty-chat system card', () => {
  const harness = buildMetaHarness();

  harness.controller.setNoActiveChatMeta();

  assert.equal(harness.getActiveChatId(), null);
  assert.equal(harness.getRenderedChatId(), null);
  assert.equal(harness.promptEl.value, '');
  assert.equal(harness.activeChatName.textContent, 'None');
  assert.equal(harness.panelTitle.textContent, 'Conversation');
  assert.equal(harness.messagesEl.innerHTML, '');
  assert.equal(harness.historyCount.textContent, '0');
  assert.deepEqual(harness.calls.renderBody, ['No chats open. Start a new chat to continue.']);
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [null]);
  assert.equal(harness.calls.renderTabs, 1);
  assert.equal(harness.calls.updateComposerState, 1);
});

test('warmChatHistoryCache prefetches the first uncached tab immediately before idle warming the rest', () => {
  const idleCallbacks = [];
  const scheduledCallbacks = [];
  const harness = buildHarness({
    chats: new Map([
      [7, { id: 7, pending: false }],
      [8, { id: 8, pending: false }],
      [9, { id: 9, pending: false }],
      [10, { id: 10, pending: false }],
    ]),
    requestIdle: (callback, options = {}) => {
      idleCallbacks.push({ callback, options });
    },
    scheduleTimeout: (callback) => {
      scheduledCallbacks.push(callback);
      return scheduledCallbacks.length;
    },
  });
  harness.histories.set(9, [{ id: 1, role: 'assistant', body: 'cached' }]);

  harness.controller.warmChatHistoryCache();

  assert.deepEqual(
    harness.apiCalls.map((call) => [call.path, Number(call.payload?.chat_id)]),
    [['/api/chats/history', 8]],
  );
  assert.equal(idleCallbacks.length, 1);
  assert.deepEqual(idleCallbacks[0].options, { timeout: 1200 });

  idleCallbacks[0].callback();

  assert.deepEqual(
    harness.apiCalls.map((call) => [call.path, Number(call.payload?.chat_id)]),
    [['/api/chats/history', 8], ['/api/chats/history', 10]],
  );
  assert.equal(scheduledCallbacks.length, 1);
});

test('warmChatHistoryCache prefetches the first uncached tab immediately without requestIdle support', () => {
  const scheduledCallbacks = [];
  const harness = buildHarness({
    chats: new Map([
      [7, { id: 7, pending: false }],
      [8, { id: 8, pending: false }],
      [9, { id: 9, pending: false }],
    ]),
    scheduleTimeout: (callback) => {
      scheduledCallbacks.push(callback);
      return scheduledCallbacks.length;
    },
  });

  harness.controller.warmChatHistoryCache();

  assert.deepEqual(
    harness.apiCalls.map((call) => [call.path, Number(call.payload?.chat_id)]),
    [['/api/chats/history', 8]],
  );
  assert.equal(scheduledCallbacks.length, 1);

  scheduledCallbacks[0]();

  assert.deepEqual(
    harness.apiCalls.map((call) => [call.path, Number(call.payload?.chat_id)]),
    [['/api/chats/history', 8], ['/api/chats/history', 9]],
  );
});
