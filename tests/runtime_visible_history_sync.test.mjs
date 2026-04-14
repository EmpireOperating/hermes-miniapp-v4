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
    ensureActivationReadThreshold: () => {
      throw new Error('should not update read threshold on stale response');
    },
    maybeMarkRead: (chatId) => markReadCalls.push(Number(chatId)),
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
