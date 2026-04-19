import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const visibleHistorySync = require('../static/runtime_visible_history_sync.js');

test('createVisibilityResumeController resumes pending chat with force when local pending lacks live stream', async () => {
  const resumed = [];
  const controller = visibleHistorySync.createVisibilityResumeController({
    hasLiveStreamController: () => false,
    resumePendingChatStream: (chatId, options = {}) => resumed.push({ chatId: Number(chatId), options }),
    shouldResumeOnVisibilityChange: () => false,
  });

  controller.maybeResumeVisibilitySync({
    activeChatId: 7,
    hidden: false,
    streamAbortControllers: new Map(),
    pendingChats: new Set([7]),
    chatPending: false,
    localPendingWithoutLiveStream: true,
    localAssistantPendingWithoutLiveStream: true,
    snapshotPendingWithoutLiveStream: false,
    matchedVisibleHydratedCompletion: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(resumed, [{ chatId: 7, options: { force: true } }]);
});

test('createVisibleSyncController skips stale response when active chat changes mid-request', async () => {
  const histories = new Map([[7, [{ id: 1, role: 'assistant', body: 'old' }]]]);
  let activeChatId = 7;
  const renderCalls = [];
  const markReadCalls = [];
  const visibilityResumeCalls = [];
  const visibleSyncGenerationRef = { value: 0, get() { return this.value; }, set(next) { this.value = Number(next) || 0; } };

  const controller = visibleHistorySync.createVisibleSyncController({
    histories,
    getActiveChatId: () => activeChatId,
    loadChatHistory: async () => {
      activeChatId = 9;
      return {
        chat: { id: 7, unread_count: 1 },
        history: [{ id: 2, role: 'assistant', body: 'fresh' }],
      };
    },
    hydrationApplyController: {
      applyHydratedServerState: async () => ({
        data: { chat: { id: 7, unread_count: 1 } },
        restoredPendingSnapshot: false,
        finalHistory: [{ id: 2, role: 'assistant', body: 'fresh' }],
        pendingState: {
          chatPending: false,
          localPendingWithoutLiveStream: false,
          snapshotPendingWithoutLiveStream: false,
          matchedVisibleHydratedCompletion: false,
        },
      }),
    },
    renderDecisionController: {
      buildHydrationRenderState: () => ({ shouldRenderActiveHistory: true }),
    },
    refreshTabNode: () => {
      throw new Error('should not refresh stale tab');
    },
    renderMessages: (chatId, options = {}) => renderCalls.push({ chatId: Number(chatId), options }),
    maybeTriggerVisibleHydrationHaptic: () => {
      throw new Error('should not haptic on stale response');
    },
    syncHydratedActiveReadState: (chatId, options = {}) => {
      markReadCalls.push({ chatId: Number(chatId), options });
    },
    pendingChats: new Set(),
    visibleSyncGenerationRef,
    visibilityResumeController: {
      maybeResumeVisibilitySync: (args) => visibilityResumeCalls.push(args),
    },
  });

  await controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });

  assert.deepEqual(renderCalls, []);
  assert.deepEqual(markReadCalls, []);
  assert.deepEqual(visibilityResumeCalls, []);
});

test('createVisibleSyncController resumes pending visibility state before clearing unread and triggers haptic afterward', async () => {
  const order = [];
  const visibleSyncGenerationRef = { value: 0, get() { return this.value; }, set(next) { this.value = Number(next) || 0; } };

  const controller = visibleHistorySync.createVisibleSyncController({
    histories: new Map([[7, [{ id: 1, role: 'assistant', body: 'old' }]]]),
    getActiveChatId: () => 7,
    loadChatHistory: async () => ({
      chat: { id: 7, unread_count: 1, pending: true },
      history: [{ id: 2, role: 'assistant', body: 'fresh pending state', pending: true }],
    }),
    hydrationApplyController: {
      applyHydratedServerState: async () => ({
        data: { chat: { id: 7, unread_count: 1, pending: true } },
        restoredPendingSnapshot: false,
        historyChanged: true,
        finalHistory: [{ id: 2, role: 'assistant', body: 'fresh pending state', pending: true }],
        pendingState: {
          chatPending: true,
          localPendingWithoutLiveStream: false,
          snapshotPendingWithoutLiveStream: true,
          matchedVisibleHydratedCompletion: false,
        },
      }),
    },
    renderDecisionController: {
      buildHydrationRenderState: () => ({ shouldRenderActiveHistory: false }),
    },
    refreshTabNode: () => {},
    renderMessages: () => {},
    maybeTriggerVisibleHydrationHaptic: () => order.push('haptic'),
    syncHydratedActiveReadState: (_chatId, options = {}) => {
      order.push('threshold');
      options.beforeMarkRead?.();
      order.push('mark-read');
    },
    pendingChats: new Set([7]),
    visibleSyncGenerationRef,
    visibilityResumeController: {
      maybeResumeVisibilitySync: () => order.push('resume'),
    },
  });

  await controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });

  assert.deepEqual(order, ['threshold', 'resume', 'mark-read', 'haptic']);
});

test('createVisibleSyncController skips stale post-hydration commit when active chat changes during apply', async () => {
  const histories = new Map([[7, [{ id: 1, role: 'assistant', body: 'old' }]]]);
  let activeChatId = 7;
  const commits = [];
  const renderCalls = [];
  const markReadCalls = [];
  const visibleSyncGenerationRef = { value: 0, get() { return this.value; }, set(next) { this.value = Number(next) || 0; } };

  const controller = visibleHistorySync.createVisibleSyncController({
    histories,
    getActiveChatId: () => activeChatId,
    loadChatHistory: async () => ({
      chat: { id: 7, unread_count: 1 },
      history: [{ id: 2, role: 'assistant', body: 'fresh' }],
    }),
    hydrationApplyController: {
      applyHydratedServerState: async () => {
        activeChatId = 9;
        return {
          data: { chat: { id: 7, unread_count: 1 } },
          restoredPendingSnapshot: false,
          finalHistory: [{ id: 2, role: 'assistant', body: 'fresh' }],
          pendingState: {
            chatPending: false,
            localPendingWithoutLiveStream: false,
            snapshotPendingWithoutLiveStream: false,
            matchedVisibleHydratedCompletion: false,
          },
          commitHydratedState: () => commits.push('commit'),
        };
      },
    },
    renderDecisionController: {
      buildHydrationRenderState: () => ({ shouldRenderActiveHistory: true }),
    },
    refreshTabNode: () => {
      throw new Error('should not refresh stale post-hydration visible sync');
    },
    renderMessages: (chatId, options = {}) => renderCalls.push({ chatId: Number(chatId), options }),
    maybeTriggerVisibleHydrationHaptic: () => {
      throw new Error('should not haptic on stale post-hydration visible sync');
    },
    syncHydratedActiveReadState: (chatId, options = {}) => {
      markReadCalls.push({ chatId: Number(chatId), options });
    },
    pendingChats: new Set(),
    visibleSyncGenerationRef,
    visibilityResumeController: {
      maybeResumeVisibilitySync: () => {
        throw new Error('should not resume stale post-hydration visible sync');
      },
    },
  });

  await controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });

  assert.deepEqual(commits, []);
  assert.deepEqual(renderCalls, []);
  assert.deepEqual(markReadCalls, []);
});

test('createVisibleSyncController passes the actual hydration historyChanged result into render decisions', async () => {
  const renderDecisionCalls = [];
  const visibleSyncGenerationRef = { value: 0, get() { return this.value; }, set(next) { this.value = Number(next) || 0; } };

  const controller = visibleHistorySync.createVisibleSyncController({
    histories: new Map([[7, [{ id: 1, role: 'assistant', body: 'old' }]]]),
    getActiveChatId: () => 7,
    loadChatHistory: async () => ({
      chat: { id: 7, unread_count: 1 },
      history: [{ id: 2, role: 'assistant', body: 'fresh' }],
    }),
    hydrationApplyController: {
      applyHydratedServerState: async () => ({
        data: { chat: { id: 7, unread_count: 1 } },
        restoredPendingSnapshot: false,
        historyChanged: true,
        finalHistory: [{ id: 2, role: 'assistant', body: 'fresh' }],
        pendingState: {
          chatPending: false,
          localPendingWithoutLiveStream: false,
          snapshotPendingWithoutLiveStream: false,
          matchedVisibleHydratedCompletion: false,
        },
      }),
    },
    renderDecisionController: {
      buildHydrationRenderState: (args) => {
        renderDecisionCalls.push(args);
        return { shouldRenderActiveHistory: false };
      },
    },
    refreshTabNode: () => {},
    renderMessages: () => {},
    maybeTriggerVisibleHydrationHaptic: () => {},
    syncHydratedActiveReadState: () => {},
    pendingChats: new Set(),
    visibleSyncGenerationRef,
    visibilityResumeController: {
      maybeResumeVisibilitySync: () => {},
    },
  });

  await controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });

  assert.equal(renderDecisionCalls.length, 1);
  assert.equal(renderDecisionCalls[0].historyChanged, true);
});

test('createVisibleSyncController renders hydrated active history with suppressAutoStickAtBottom so visibility resumes do not auto-clear unread state', async () => {
  const renderCalls = [];
  const visibleSyncGenerationRef = { value: 0, get() { return this.value; }, set(next) { this.value = Number(next) || 0; } };

  const controller = visibleHistorySync.createVisibleSyncController({
    histories: new Map([[7, [{ id: 1, role: 'assistant', body: 'old' }]]]),
    getActiveChatId: () => 7,
    loadChatHistory: async () => ({
      chat: { id: 7, unread_count: 1, newest_unread_message_id: 2 },
      history: [
        { id: 1, role: 'assistant', body: 'old' },
        { id: 2, role: 'assistant', body: 'fresh unseen' },
      ],
    }),
    hydrationApplyController: {
      applyHydratedServerState: async () => ({
        data: { chat: { id: 7, unread_count: 1, newest_unread_message_id: 2 } },
        restoredPendingSnapshot: false,
        historyChanged: true,
        finalHistory: [
          { id: 1, role: 'assistant', body: 'old' },
          { id: 2, role: 'assistant', body: 'fresh unseen' },
        ],
        pendingState: {
          chatPending: false,
          localPendingWithoutLiveStream: false,
          localAssistantPendingWithoutLiveStream: false,
          snapshotPendingWithoutLiveStream: false,
          matchedVisibleHydratedCompletion: false,
        },
      }),
    },
    renderDecisionController: {
      buildHydrationRenderState: () => ({ shouldRenderActiveHistory: true }),
    },
    refreshTabNode: () => {},
    renderMessages: (chatId, options = {}) => renderCalls.push({ chatId: Number(chatId), options }),
    maybeTriggerVisibleHydrationHaptic: () => {},
    syncHydratedActiveReadState: () => {},
    pendingChats: new Set(),
    visibleSyncGenerationRef,
    visibilityResumeController: {
      maybeResumeVisibilitySync: () => {},
    },
  });

  await controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });

  assert.deepEqual(renderCalls, [{
    chatId: 7,
    options: {
      preserveViewport: true,
      suppressAutoStickAtBottom: true,
    },
  }]);
});
