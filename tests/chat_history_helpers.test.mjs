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
  const restoredSnapshots = [];
  const abortedStreamChats = [];
  const markReadInFlight = new Set();
  const unseenStreamChats = new Set();
  const finalizedHydratedPendingChats = [];
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
    abortStreamController: (chatId) => {
      abortedStreamChats.push(Number(chatId));
    },
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    refreshTabNode: (chatId) => refreshedTabs.push(Number(chatId)),
    getActiveChatId: () => activeChatId,
    resumePendingChatStream: (chatId, options = {}) => resumedChats.push({ chatId: Number(chatId), options }),
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
    restoredSnapshots,
    abortedStreamChats,
    markReadInFlight,
    unseenStreamChats,
    messagesContainer,
    pendingChats,
    finalizedHydratedPendingChats,
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

  assert.deepEqual(harness.upsertedChats, [{ id: 7, pending: false }]);
  assert.deepEqual(harness.histories.get(7), [{ id: 1, role: 'assistant', body: 'hello' }]);
  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: { preserveViewport: false } }]);
  assert.deepEqual(harness.restoredSnapshots, []);
});

test('hydrateChatFromServer restores pending snapshot for pending chats before resuming', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      return {
        chat: { id: Number(payload.chat_id), pending: true },
        history: [{ id: 1, role: 'operator', body: 'working' }],
      };
    },
  });

  await harness.controller.hydrateChatFromServer(7, 0, false);

  assert.deepEqual(harness.restoredSnapshots, [7]);
  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: {} }]);
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
  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: { force: false } }]);
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

  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: { force: false } }]);
});

test('syncVisibleActiveChat forces resume when local pending traces exist without live stream', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    pendingChats: new Set(),
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: 7, pending: false },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.histories.set(7, [{ role: 'tool', body: 'read_file', pending: true }]);

  await harness.controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });

  assert.deepEqual(harness.restoredSnapshots, [7]);
  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: { force: true } }]);
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

function buildMetaHarness() {
  const chatScrollTop = new Map();
  const chatStickToBottom = new Map();
  const chats = new Map([
    [3, { id: 3, title: 'Current chat' }],
    [7, { id: 7, title: 'Target chat' }],
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

  harness.calls.scheduleTimeout[0].callback();
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [7]);
  assert.equal(harness.calls.syncActivePendingStatus, 1);
  assert.equal(harness.calls.syncActiveLatencyChip, 1);
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
