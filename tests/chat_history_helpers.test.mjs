import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chatHistory = require('../static/chat_history_helpers.js');

function buildHarness(overrides = {}) {
  const histories = new Map();
  const chats = new Map([[7, { id: 7, unread_count: 2, pending: false }]]);
  const prefetchingHistories = new Set();
  const upsertedChats = [];
  const activeMeta = [];
  const renderedMessages = [];
  const refreshedTabs = [];
  const resumedChats = [];
  const systemMessages = [];
  const apiCalls = [];
  const markReadCalls = [];
  const statusSyncCalls = [];
  const pinnedStatusSyncCalls = [];
  let renderPinnedChatsCalls = 0;
  const resumeVisibilityChecks = [];
  const markReadInFlight = new Set();
  const unseenStreamChats = new Set();
  const messagesContainer = {};
  const pendingChats = new Set([7]);
  let renderTabsCalls = 0;
  let syncActivePendingStatusCalls = 0;
  let updateComposerStateCalls = 0;
  let isNearBottom = true;
  let isAuthenticated = true
  let lastOpenChatRequestId = 0;
  let activeChatId = 7;

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
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    refreshTabNode: (chatId) => refreshedTabs.push(Number(chatId)),
    getActiveChatId: () => activeChatId,
    resumePendingChatStream: (chatId) => resumedChats.push(Number(chatId)),
    appendSystemMessage: (text) => systemMessages.push(String(text)),
    getLastOpenChatRequestId: () => lastOpenChatRequestId,
    setLastOpenChatRequestId: (value) => { lastOpenChatRequestId = Number(value); },
    scheduleTimeout: (callback) => callback(),
    requestIdle: null,
    runAfterUiMutation: (callback) => callback(),
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
    systemMessages,
    apiCalls,
    markReadCalls,
    statusSyncCalls,
    pinnedStatusSyncCalls,
    resumeVisibilityChecks,
    markReadInFlight,
    unseenStreamChats,
    messagesContainer,
    pendingChats,
    getRenderTabsCalls: () => renderTabsCalls,
    getRenderPinnedChatsCalls: () => renderPinnedChatsCalls,
    getSyncActivePendingStatusCalls: () => syncActivePendingStatusCalls,
    getUpdateComposerStateCalls: () => updateComposerStateCalls,
    setActiveChatId: (value) => { activeChatId = Number(value); },
    setIsNearBottom: (value) => { isNearBottom = Boolean(value); },
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

  assert.equal(harness.upsertedChats.length, 1);
  assert.deepEqual(harness.histories.get(7), [{ id: 1, role: 'assistant', body: 'hello' }]);
  assert.deepEqual(harness.renderedMessages.at(-1), { chatId: 7, options: { preserveViewport: false } });
  assert.deepEqual(harness.refreshedTabs, [7]);
});

test('openChat uses cached history path before background hydration', async () => {
  const harness = buildHarness();
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);

  await harness.controller.openChat(7);

  assert.deepEqual(harness.activeMeta.at(-1), { chatId: 7, options: { fullTabRender: false, deferNonCritical: true } });
  assert.deepEqual(harness.renderedMessages.at(0), { chatId: 7, options: {} });
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), true);
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
  assert.deepEqual(harness.resumedChats, [7]);
  assert.ok(harness.markReadCalls.includes(7));
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

  assert.deepEqual(harness.resumedChats, [7]);
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
  assert.equal(harness.upsertedChats.some((chat) => Boolean(chat?.pending)), false);
  assert.ok(harness.markReadCalls.includes(7));
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

test('updatePendingAssistant skips empty finalized writes without pending message', () => {
  const harness = buildHarness();

  harness.controller.updatePendingAssistant(7, '   ', false);

  assert.equal((harness.histories.get(7) || []).length, 0);
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
