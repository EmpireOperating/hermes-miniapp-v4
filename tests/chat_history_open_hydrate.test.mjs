import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHarness, runtimeHistory } from './chat_history_test_harness.mjs';

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

