import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildHarness, chatHistory, runtimeHistory } from './chat_history_test_harness.mjs';

const require = createRequire(import.meta.url);
const runtimeHydrationApply = require('../static/runtime_hydration_apply.js');
const runtimeHydrationState = require('../static/runtime_hydration_state.js');
const runtimeVisibleHydration = require('../static/runtime_visible_hydration.js');
const runtimeHydrationFlow = require('../static/runtime_hydration_flow.js');
const runtimeOpenFlow = require('../static/runtime_open_flow.js');

test('chat history exports hydration helper subcontrollers with stable ownership seams', () => {
  assert.equal(typeof chatHistory.createUnreadAnchorController, 'function');
  assert.equal(typeof chatHistory.createActivationReadThresholdController, 'function');
  assert.equal(typeof chatHistory.createUnreadPreservationController, 'function');
  assert.equal(typeof chatHistory.createHistoryPendingStateController, 'function');
  assert.equal(typeof chatHistory.createHistoryRenderDecisionController, 'function');
  assert.equal(typeof chatHistory.createHydrationApplyController, 'function');
  assert.equal(typeof chatHistory.createVisibilityResumeController, 'function');
  assert.equal(typeof chatHistory.createUnreadHydrationRetryController, 'function');
  assert.equal(typeof chatHistory.createCachedOpenController, 'function');
  assert.equal(typeof runtimeHydrationApply.createUnreadHydrationRetryController, 'function');
  assert.equal(typeof runtimeHydrationApply.createHydrationApplyController, 'function');
  assert.equal(typeof runtimeHydrationState.createHistoryPendingStateController, 'function');
  assert.equal(typeof runtimeHydrationState.createHistoryRenderDecisionController, 'function');
  assert.equal(typeof runtimeVisibleHydration.createVisibleHydrationEffectsController, 'function');
  assert.equal(typeof runtimeHydrationFlow.createHydrationFlowController, 'function');
  assert.equal(typeof runtimeOpenFlow.createCachedOpenController, 'function');
  assert.equal(typeof runtimeOpenFlow.createHistoryOpenController, 'function');

  const harness = buildHarness();
  assert.equal(typeof harness.controller.buildChatPreservingUnread, 'function');
});

test('visibility resume helper only forces resume for pending chats that still need recovery', async () => {
  const resumed = [];
  const visibilityChecks = [];
  const controller = chatHistory.createVisibilityResumeController({
    hasLiveStreamController: () => false,
    resumePendingChatStream: (chatId, options = {}) => resumed.push({ chatId: Number(chatId), options }),
    shouldResumeOnVisibilityChange: (args) => {
      visibilityChecks.push(args);
      return false;
    },
  });

  controller.maybeResumeVisibilitySync({
    activeChatId: 7,
    hidden: false,
    pendingChats: new Set([7]),
    streamAbortControllers: new Map(),
    chatPending: false,
    localPendingWithoutLiveStream: true,
    localAssistantPendingWithoutLiveStream: true,
    snapshotPendingWithoutLiveStream: false,
    matchedVisibleHydratedCompletion: false,
  });

  assert.deepEqual(visibilityChecks, [{
    hidden: false,
    activeChatId: 7,
    pendingChats: new Set([7]),
    streamAbortControllers: new Map(),
  }]);
  assert.deepEqual(resumed, [{ chatId: 7, options: { force: true } }]);
});

test('historiesDiffer detects meaningful transcript changes beyond the tail record', () => {
  const harness = buildHarness();

  assert.equal(harness.controller.historiesDiffer([], []), false);
  assert.equal(harness.controller.historiesDiffer([{ id: 1, body: 'a', role: 'assistant' }], [{ id: 1, body: 'a', role: 'assistant' }]), false);
  assert.equal(harness.controller.historiesDiffer([{ id: 1, body: 'a', role: 'assistant' }], [{ id: 2, body: 'a', role: 'assistant' }]), false);
  assert.equal(
    harness.controller.historiesDiffer(
      [
        { id: 1, body: 'question', role: 'user' },
        { id: 2, body: 'old tool trace', role: 'tool' },
        { id: 3, body: 'same tail', role: 'assistant' },
      ],
      [
        { id: 1, body: 'question', role: 'user' },
        { id: 2, body: 'new tool trace', role: 'tool' },
        { id: 3, body: 'same tail', role: 'assistant' },
      ],
    ),
    true,
  );
});

test('mergeHydratedHistory does not weakly match a lone pending assistant by role alone', () => {
  const merged = runtimeHistory.mergeHydratedHistory({
    previousHistory: [
      { role: 'assistant', body: 'local partial reply', pending: true, created_at: '2026-04-12T06:00:00Z' },
    ],
    nextHistory: [
      { role: 'assistant', body: 'different server partial', pending: true, created_at: '2026-04-12T06:00:02Z' },
    ],
    serverPending: true,
    preserveLocalPending: true,
  });

  assert.deepEqual(merged, [
    { role: 'assistant', body: 'different server partial', pending: true, created_at: '2026-04-12T06:00:02Z' },
    { role: 'assistant', body: 'local partial reply', pending: true, created_at: '2026-04-12T06:00:00Z' },
  ]);
});

test('mergeHydratedHistory still merges a single pending tool row when the server extends the same tool journal', () => {
  const merged = runtimeHistory.mergeHydratedHistory({
    previousHistory: [
      { role: 'tool', body: 'read_file', pending: true, created_at: '2026-04-12T06:00:00Z', collapsed: true },
    ],
    nextHistory: [
      { role: 'tool', body: 'read_file\nsearch_files', pending: true, created_at: '2026-04-12T06:00:01Z', collapsed: false },
    ],
    serverPending: true,
    preserveLocalPending: true,
  });

  assert.deepEqual(merged, [
    { role: 'tool', body: 'read_file', pending: true, created_at: '2026-04-12T06:00:01Z', collapsed: true },
  ]);
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

test('loadChatHistory syncs unread notification presence for activated visible fetches only', async () => {
  const unreadPresenceCalls = [];
  const harness = buildHarness({
    syncUnreadNotificationPresence: (options = {}) => {
      unreadPresenceCalls.push({ ...options });
      return { ok: true };
    },
    getDocumentVisibilityState: () => 'visible',
  });

  await harness.controller.loadChatHistory(7, { activate: true });
  await harness.controller.loadChatHistory(7, { activate: false });

  assert.deepEqual(unreadPresenceCalls, [{ visible: true, chatId: 7 }]);
});

test('hydrateChatFromServer updates history and rerenders active chat', async () => {
  const harness = buildHarness();

  await harness.controller.hydrateChatFromServer(7, 0, false);

  assert.deepEqual(harness.upsertedChats, [{ id: 7, pending: false, newest_unread_message_id: 0 }]);
  assert.deepEqual(harness.histories.get(7), [{ id: 1, role: 'assistant', body: 'hello' }]);
  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: { preserveViewport: false } }]);
  assert.deepEqual(harness.restoredSnapshots, []);
  assert.deepEqual(harness.finalizedHydratedPendingChats, [7]);
});

test('hydrateChatFromServer preserves local unread count until mark-read threshold is reached', async () => {
  const harness = buildHarness();

  await harness.controller.hydrateChatFromServer(7, 0, false);

  assert.equal(harness.chats.get(7).unread_count, 2);
  assert.deepEqual(harness.refreshedTabs, [7]);
});

test('hydrateChatFromServer retries once when unread advances but first hydrate is transcript-identical', async () => {
  let historyCalls = 0;
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        historyCalls += 1;
        if (historyCalls === 1) {
          return {
            chat: { id: Number(payload.chat_id), pending: false, unread_count: 1, newest_unread_message_id: 2 },
            history: [{ id: 1, role: 'assistant', body: 'old reply' }],
          };
        }
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 1, newest_unread_message_id: 2 },
          history: [{ id: 2, role: 'assistant', body: 'fresh final reply' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.chats.set(7, { id: 7, unread_count: 0, pending: false });
  harness.histories.set(7, [{ id: 1, role: 'assistant', body: 'old reply' }]);

  await harness.controller.hydrateChatFromServer(7, 0, true);

  assert.equal(historyCalls, 2);
  assert.deepEqual(harness.histories.get(7), [{ id: 2, role: 'assistant', body: 'fresh final reply' }]);
  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: { preserveViewport: true } }]);
});

test('late terminal finalize does not duplicate a hydrated completed assistant reply after unread catch-up', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 1, newest_unread_message_id: 12 },
          history: [{ id: 12, role: 'assistant', body: 'fresh final reply', pending: false }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.histories.set(7, [{ id: 1, role: 'assistant', body: 'stale cached reply', pending: false }]);
  harness.chats.set(7, { id: 7, unread_count: 0, newest_unread_message_id: 0, pending: false });

  await harness.controller.hydrateChatFromServer(7, 0, true);
  harness.controller.updatePendingAssistant(7, 'fresh final reply', false);

  assert.deepEqual(harness.histories.get(7), [
    { id: 12, role: 'assistant', body: 'fresh final reply', pending: false },
  ]);
  assert.deepEqual(harness.clearedSnapshots, [7]);
});

test('hydrateChatFromServer treats a long local pending prefix as matched completion and avoids preserving a duplicate pending assistant', async () => {
  const harness = buildHarness({
    mergeHydratedHistory: runtimeHistory.mergeHydratedHistory,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 1, newest_unread_message_id: 12 },
          history: [{ id: 12, role: 'assistant', body: 'fresh final reply with artifact link', pending: false }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.histories.set(7, [
    { role: 'assistant', body: 'fresh final reply with artifact', pending: true, created_at: '2026-04-12T06:00:00Z' },
  ]);
  harness.chats.set(7, { id: 7, unread_count: 1, newest_unread_message_id: 12, pending: true });
  harness.pendingChats.add(7);

  await harness.controller.hydrateChatFromServer(7, 0, true);

  assert.deepEqual(harness.histories.get(7), [
    { id: 12, role: 'assistant', body: 'fresh final reply with artifact link', pending: false },
  ]);
  assert.deepEqual(harness.finalizedHydratedPendingChats, [7]);
  assert.deepEqual(harness.resumedChats, []);
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
    hasFreshPendingStreamSnapshot: (chatId) => Number(chatId) === 7,
    readPendingStreamSnapshotMap: () => ({
      7: {
        tool: { role: 'tool', body: 'missed tool', pending: true },
        tool_journal_lines: ['missed tool'],
      },
    }),
    mergePendingSnapshotIntoHistory: (history) => {
      harness.restoredSnapshots.push(7);
      return {
        history: [...history, { role: 'tool', body: 'missed tool', pending: true }],
        changed: true,
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
    readPendingStreamSnapshotMap: () => ({
      7: {
        tool: { role: 'tool', body: 'missed tool', pending: true },
        tool_journal_lines: ['missed tool'],
      },
    }),
    mergePendingSnapshotIntoHistory: (history) => {
      harness.restoredSnapshots.push(7);
      return {
        history: [
          ...history,
          { role: 'tool', body: 'missed tool', pending: true },
        ],
        changed: true,
      };
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
    hasFreshPendingStreamSnapshot: (chatId) => Number(chatId) === 7,
    readPendingStreamSnapshotMap: () => ({
      7: {
        tool: { role: 'tool', body: 'missed tool', pending: true },
        tool_journal_lines: ['missed tool'],
      },
    }),
    mergePendingSnapshotIntoHistory: (history) => {
      harness.restoredSnapshots.push(7);
      return {
        history: [
          ...history,
          { role: 'tool', body: 'missed tool', pending: true },
        ],
        changed: true,
      };
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
  harness.chats.get(7).unread_count = 0;
  harness.chats.get(7).newest_unread_message_id = 0;
  harness.chats.get(7).pending = false;

  await harness.controller.openChat(7);

  assert.deepEqual(harness.activeMeta[0], { chatId: 7, options: { fullTabRender: false, deferNonCritical: true } });
  assert.deepEqual(harness.renderedMessages.at(0), { chatId: 7, options: {} });
  assert.equal(scheduledHydrations.length, 1);
  assert.equal(scheduledHydrations[0].delay, 0);
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
  harness.chats.get(7).unread_count = 0;
  harness.chats.get(7).newest_unread_message_id = 0;
  harness.chats.get(7).pending = false;

  await harness.controller.openChat(7);

  assert.deepEqual(harness.activeMeta.at(-1), { chatId: 7, options: { fullTabRender: false, deferNonCritical: true } });
  assert.equal(harness.renderedMessages.length, 0);
  assert.equal(uiCallbacks.length, 1);
  assert.equal(scheduledHydrations.length, 1);
  assert.equal(scheduledHydrations[0].delay, 0);
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
  harness.chats.get(7).unread_count = 0;
  harness.chats.get(7).newest_unread_message_id = 0;
  harness.chats.get(7).pending = false;

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
    suppressColdOpenRender: false,
  });
  assert.deepEqual(harness.renderTraceLogs[1].details, {
    chatId: 7,
    requestId: 1,
    mode: 'timeout',
    delayMs: 0,
    prioritizeHydration: false,
    allowIdleHydration: true,
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

  assert.equal(uiCallbacks.length, 0);
  assert.equal(scheduledHydrations.length, 2);
  assert.deepEqual(scheduledHydrations.map((entry) => entry.delay), [24, 0]);

  await scheduledHydrations[0].callback();
  assert.equal(harness.renderedMessages.length, 0);
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);

  await scheduledHydrations[1].callback();
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);
});

test('openChat optimistically switches active meta and clears transcript before cold-open hydration finishes', async () => {
  let resolveHistory;
  const historyPromise = new Promise((resolve) => {
    resolveHistory = resolve;
  });
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        await historyPromise;
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  const openPromise = harness.controller.openChat(8);

  assert.deepEqual(harness.activeMeta[0], { chatId: 8, options: { fullTabRender: false, deferNonCritical: true } });
  assert.deepEqual(harness.renderedMessages[0], { chatId: 8, options: {} });
  assert.equal(harness.renderTraceLogs[0].eventName, 'chat-history-open-start');
  assert.equal(harness.renderTraceLogs[1].eventName, 'chat-history-hydrate-start');

  resolveHistory();
  await openPromise;

  assert.deepEqual(harness.renderedMessages, [
    { chatId: 8, options: {} },
    { chatId: 8, options: {} },
  ]);
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
    suppressColdOpenRender: false,
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

test('openChat uses timeout to start cached hydration immediately for fully read selected chats', async () => {
  const idleCallbacks = [];
  const scheduledHydrations = [];
  const harness = buildHarness({
    shouldDeferNonCriticalCachedOpen: () => true,
    requestIdle: (callback, options) => {
      idleCallbacks.push({ callback, options });
    },
    scheduleTimeout: (callback, delay) => {
      scheduledHydrations.push({ callback, delay });
    },
  });
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);
  harness.chats.get(7).unread_count = 0;
  harness.chats.get(7).newest_unread_message_id = 0;
  harness.chats.get(7).pending = false;

  await harness.controller.openChat(7);

  assert.equal(idleCallbacks.length, 0);
  assert.equal(scheduledHydrations.length, 1);
  assert.equal(scheduledHydrations[0].delay, 0);
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);

  await scheduledHydrations[0].callback();
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), true);
});

test('openChat uses timeout for deferred cached hydration even when idle hydration is disabled', async () => {
  const idleCallbacks = [];
  const scheduledHydrations = [];
  const harness = buildHarness({
    shouldDeferNonCriticalCachedOpen: () => true,
    shouldUseIdleForDeferredCachedHydration: () => false,
    requestIdle: (callback, options) => {
      idleCallbacks.push({ callback, options });
    },
    scheduleTimeout: (callback, delay) => {
      scheduledHydrations.push({ callback, delay });
    },
  });
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);
  harness.chats.get(7).unread_count = 0;
  harness.chats.get(7).newest_unread_message_id = 0;
  harness.chats.get(7).pending = false;

  await harness.controller.openChat(7);

  assert.equal(idleCallbacks.length, 0);
  assert.equal(scheduledHydrations.length, 1);
  assert.equal(scheduledHydrations[0].delay, 0);
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);

  await scheduledHydrations[0].callback();
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), true);
});

test('openChat prioritizes cached hydration over requestIdle when the cached chat has unread messages', async () => {
  const idleCallbacks = [];
  const scheduledHydrations = [];
  const harness = buildHarness({
    shouldDeferNonCriticalCachedOpen: () => true,
    requestIdle: (callback, options) => {
      idleCallbacks.push({ callback, options });
    },
    scheduleTimeout: (callback, delay) => {
      scheduledHydrations.push({ callback, delay });
    },
  });
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);
  harness.chats.get(7).unread_count = 2;
  harness.chats.get(7).newest_unread_message_id = 11;

  await harness.controller.openChat(7);

  assert.equal(idleCallbacks.length, 0);
  assert.deepEqual(scheduledHydrations.map((entry) => entry.delay), [24, 0]);
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);

  await scheduledHydrations[1].callback();
  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), true);
});

test('openChat keeps unread dot state while opening cached unread chat', async () => {
  const harness = buildHarness();
  harness.histories.set(7, [{ id: 9, role: 'assistant', body: 'cached' }]);

  await harness.controller.openChat(7);

  assert.equal(harness.chats.get(7).unread_count, 2);
});

test('hydrateChatFromServer rerenders identical active history when unread is preserved for cached open', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.histories.set(7, [{ id: 1, role: 'assistant', body: 'hello' }]);
  harness.setIsNearBottom(false);

  await harness.controller.hydrateChatFromServer(7, 0, true);

  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: { preserveViewport: true } }]);
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

test('syncBootstrapActivationReadState prevents bootstrap-resume mark-read from clearing unread before the operator re-hits bottom', async () => {
  const harness = buildHarness();
  harness.chats.get(7).unread_count = 1;
  harness.setRenderedAssistantNodes([{ offsetTop: 420, offsetHeight: 140 }]);
  harness.setMessageViewport({ scrollTop: 320, clientHeight: 260 });

  harness.controller.syncBootstrapActivationReadState(7, { unreadCount: 1 });
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

test('syncBootstrapActivationReadState allows first bottom-hit to clear unread when activation started above the newest unread message bottom', async () => {
  const harness = buildHarness();
  harness.chats.get(7).unread_count = 1;
  harness.setRenderedAssistantNodes([{ offsetTop: 420, offsetHeight: 140 }]);
  harness.setMessageViewport({ scrollTop: 40, clientHeight: 260 });

  harness.controller.syncBootstrapActivationReadState(7, { unreadCount: 1 });
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
  assert.deepEqual(harness.statusSyncCalls, [[{ id: 7, unread_count: 2, newest_unread_message_id: 0 }]]);
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

  assert.deepEqual(harness.statusSyncCalls, [[{ id: 7, unread_count: 2, pending: false, newest_unread_message_id: 0 }]]);
  assert.deepEqual(harness.pinnedStatusSyncCalls, [[{ id: 7, unread_count: 2, pending: false, newest_unread_message_id: 0 }]]);
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

test('warmChatHistoryCache leaves cached unread or pending inactive chats to live unread ownership and only warms cold inactive tabs', () => {
  const idleCallbacks = [];
  const scheduledCallbacks = [];
  const harness = buildHarness({
    chats: new Map([
      [7, { id: 7, pending: false }],
      [8, { id: 8, pending: false, unread_count: 0, newest_unread_message_id: 0 }],
      [9, { id: 9, pending: false, unread_count: 2, newest_unread_message_id: 19 }],
      [10, { id: 10, pending: true, unread_count: 0, newest_unread_message_id: 0 }],
      [11, { id: 11, pending: false, unread_count: 0, newest_unread_message_id: 0 }],
      [12, { id: 12, pending: false, unread_count: 1, newest_unread_message_id: 22 }],
    ]),
    requestIdle: (callback, options = {}) => {
      idleCallbacks.push({ callback, options });
    },
    scheduleTimeout: (callback) => {
      scheduledCallbacks.push(callback);
      return scheduledCallbacks.length;
    },
  });
  harness.histories.set(9, [{ id: 19, role: 'assistant', body: 'cached unread', pending: false }]);
  harness.histories.set(10, [{ id: 20, role: 'assistant', body: 'cached pending', pending: false }]);

  harness.controller.warmChatHistoryCache();

  assert.deepEqual(
    harness.apiCalls.map((call) => [call.path, Number(call.payload?.chat_id)]),
    [['/api/chats/history', 12], ['/api/chats/history', 8]],
  );
  assert.equal(idleCallbacks.length, 1);
  assert.deepEqual(idleCallbacks[0].options, { timeout: 1200 });
  assert.equal(scheduledCallbacks.length, 0);
});

test('warmChatHistoryCache prefetches the first two uncached tabs immediately before idle warming the rest', () => {
  const idleCallbacks = [];
  const scheduledCallbacks = [];
  const harness = buildHarness({
    chats: new Map([
      [7, { id: 7, pending: false }],
      [8, { id: 8, pending: false }],
      [9, { id: 9, pending: false }],
      [10, { id: 10, pending: false }],
      [11, { id: 11, pending: false }],
    ]),
    requestIdle: (callback, options = {}) => {
      idleCallbacks.push({ callback, options });
    },
    scheduleTimeout: (callback) => {
      scheduledCallbacks.push(callback);
      return scheduledCallbacks.length;
    },
  });
  harness.histories.set(10, [{ id: 1, role: 'assistant', body: 'cached' }]);

  harness.controller.warmChatHistoryCache();

  assert.deepEqual(
    harness.apiCalls.map((call) => [call.path, Number(call.payload?.chat_id)]),
    [['/api/chats/history', 8], ['/api/chats/history', 9]],
  );
  assert.equal(idleCallbacks.length, 1);
  assert.deepEqual(idleCallbacks[0].options, { timeout: 1200 });

  idleCallbacks[0].callback();

  assert.deepEqual(
    harness.apiCalls.map((call) => [call.path, Number(call.payload?.chat_id)]),
    [['/api/chats/history', 8], ['/api/chats/history', 9], ['/api/chats/history', 11]],
  );
  assert.equal(scheduledCallbacks.length, 1);
});

test('warmChatHistoryCache prefetches the first two uncached tabs immediately without requestIdle support', () => {
  const scheduledCallbacks = [];
  const harness = buildHarness({
    chats: new Map([
      [7, { id: 7, pending: false }],
      [8, { id: 8, pending: false }],
      [9, { id: 9, pending: false }],
      [10, { id: 10, pending: false }],
    ]),
    scheduleTimeout: (callback) => {
      scheduledCallbacks.push(callback);
      return scheduledCallbacks.length;
    },
  });

  harness.controller.warmChatHistoryCache();

  assert.deepEqual(
    harness.apiCalls.map((call) => [call.path, Number(call.payload?.chat_id)]),
    [['/api/chats/history', 8], ['/api/chats/history', 9]],
  );
  assert.equal(scheduledCallbacks.length, 1);

  scheduledCallbacks[0]();

  assert.deepEqual(
    harness.apiCalls.map((call) => [call.path, Number(call.payload?.chat_id)]),
    [['/api/chats/history', 8], ['/api/chats/history', 9], ['/api/chats/history', 10]],
  );
});


test('prefetchChatHistory does not clobber a chat that became active while the prefetch was in flight', async () => {
  let resolveHistory;
  const historyPromise = new Promise((resolve) => {
    resolveHistory = resolve;
  });
  const harness = buildHarness({
    chats: new Map([
      [7, { id: 7, pending: false }],
      [8, { id: 8, pending: false, unread_count: 0, newest_unread_message_id: 0 }],
    ]),
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history' && Number(payload.chat_id) === 8) {
        return historyPromise;
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.controller.prefetchChatHistory(8);
  harness.setActiveChatId(8);
  harness.histories.set(8, [{ id: 22, role: 'assistant', body: 'fresh active hydrate' }]);
  resolveHistory({
    chat: { id: 8, pending: false, unread_count: 0, newest_unread_message_id: 0 },
    history: [{ id: 11, role: 'assistant', body: 'stale prefetched history' }],
  });
  await historyPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.histories.get(8), [{ id: 22, role: 'assistant', body: 'fresh active hydrate' }]);
  assert.equal(harness.renderTraceLogs.at(-1)?.eventName, 'chat-history-prefetch-skipped-commit');
  assert.equal(harness.renderTraceLogs.at(-1)?.details?.chatId, 8);
  assert.equal(harness.renderTraceLogs.at(-1)?.details?.activeNow, true);
  assert.equal(harness.renderTraceLogs.at(-1)?.details?.cacheFilledElsewhere, true);
  assert.equal(harness.renderTraceLogs.at(-1)?.details?.laggingPrefetchResult, false);
});


test('prefetchChatHistory skips warming stale history when local unread or pending metadata is ahead of the non-activating fetch', async () => {
  const harness = buildHarness({
    chats: new Map([
      [7, { id: 7, pending: false }],
      [8, { id: 8, pending: true, unread_count: 1, newest_unread_message_id: 99 }],
    ]),
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history' && Number(payload.chat_id) === 8) {
        return {
          chat: { id: 8, pending: false, unread_count: 0, newest_unread_message_id: 0 },
          history: [{ id: 11, role: 'assistant', body: 'stale prefetched history' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.controller.prefetchChatHistory(8);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.histories.has(8), false);
  assert.equal(harness.upsertedChats.length, 0);
  assert.equal(harness.renderTraceLogs.at(-1)?.eventName, 'chat-history-prefetch-skipped-commit');
  assert.equal(harness.renderTraceLogs.at(-1)?.details?.chatId, 8);
  assert.equal(harness.renderTraceLogs.at(-1)?.details?.activeNow, false);
  assert.equal(harness.renderTraceLogs.at(-1)?.details?.cacheFilledElsewhere, false);
  assert.equal(harness.renderTraceLogs.at(-1)?.details?.laggingPrefetchResult, true);
});

