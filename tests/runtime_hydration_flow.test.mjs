import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hydrationFlow = require('../static/runtime_hydration_flow.js');

test('createHydrationFlowController skips stale hydrate responses before mutating history', async () => {
  const traces = [];
  let now = 1000;
  const controller = hydrationFlow.createHydrationFlowController({
    nowMs: () => (now += 5),
    traceChatHistory: (eventName, details = {}) => traces.push({ eventName, details }),
    loadChatHistory: async () => ({ chat: { id: 7, pending: false }, history: [] }),
    getLastOpenChatRequestId: () => 9,
    getPreviousHistory: () => [{ id: 1, role: 'assistant', body: 'old' }],
    applyHydratedServerState: async () => {
      throw new Error('should not apply stale hydrate');
    },
    buildHydrationRenderState: () => {
      throw new Error('should not build render state for stale hydrate');
    },
    refreshTabNode: () => {
      throw new Error('should not refresh tab for stale hydrate');
    },
    isActiveChat: () => true,
    setActiveChatMeta: () => {
      throw new Error('should not set meta for stale hydrate');
    },
    renderMessages: () => {
      throw new Error('should not render stale hydrate');
    },
    resumePendingChatStream: () => {
      throw new Error('should not resume stale hydrate');
    },
  });

  const result = await controller.hydrateChatFromServer(7, 4, true);

  assert.equal(result, undefined);
  assert.deepEqual(traces.map((entry) => entry.eventName), ['hydrate-start', 'hydrate-skipped-stale-request']);
  assert.equal(traces[1].details.latestRequestId, 9);
});

test('createHydrationFlowController applies hydration and resumes pending inactive chats with force when required', async () => {
  const traces = [];
  const renders = [];
  const resumes = [];
  const refreshed = [];
  let now = 1000;
  const controller = hydrationFlow.createHydrationFlowController({
    nowMs: () => (now += 7),
    traceChatHistory: (eventName, details = {}) => traces.push({ eventName, details }),
    loadChatHistory: async () => ({
      chat: { id: 7, pending: false, unread_count: 1, newest_unread_message_id: 12 },
      history: [{ id: 12, role: 'assistant', body: 'fresh' }],
    }),
    getLastOpenChatRequestId: () => 4,
    getPreviousHistory: () => [{ id: 1, role: 'assistant', body: 'old' }],
    applyHydratedServerState: async () => ({
      data: { chat: { id: 7, pending: false, unread_count: 1, newest_unread_message_id: 12 } },
      restoredPendingSnapshot: false,
      finalHistory: [{ id: 12, role: 'assistant', body: 'fresh' }],
      historyChanged: true,
      pendingState: {
        shouldResumePending: true,
        shouldForceResumePending: true,
      },
    }),
    buildHydrationRenderState: () => ({
      shouldForceUnreadTranscriptRender: false,
      shouldForceStaleRenderedTranscriptRender: false,
    }),
    refreshTabNode: (chatId) => refreshed.push(Number(chatId)),
    isActiveChat: () => false,
    setActiveChatMeta: (chatId) => renders.push({ type: 'meta', chatId: Number(chatId) }),
    renderMessages: (chatId, options = {}) => renders.push({ type: 'render', chatId: Number(chatId), options }),
    resumePendingChatStream: (chatId, options = {}) => resumes.push({ chatId: Number(chatId), options }),
  });

  await controller.hydrateChatFromServer(7, 4, true);

  assert.deepEqual(refreshed, [7]);
  assert.deepEqual(renders, [
    { type: 'meta', chatId: 7 },
    { type: 'render', chatId: 7, options: {} },
  ]);
  assert.deepEqual(resumes, [{ chatId: 7, options: { force: true } }]);
  assert.equal(traces.at(-1).eventName, 'hydrate-applied');
  assert.equal(traces.at(-1).details.shouldResumePending, true);
});

test('createHydrationFlowController skips stale hydrate after apply returns before committing state', async () => {
  const traces = [];
  const commits = [];
  let now = 1000;
  let latestRequestId = 4;
  const controller = hydrationFlow.createHydrationFlowController({
    nowMs: () => (now += 7),
    traceChatHistory: (eventName, details = {}) => traces.push({ eventName, details }),
    loadChatHistory: async () => ({
      chat: { id: 7, pending: false, unread_count: 1, newest_unread_message_id: 12 },
      history: [{ id: 12, role: 'assistant', body: 'fresh' }],
    }),
    getLastOpenChatRequestId: () => latestRequestId,
    getPreviousHistory: () => [{ id: 1, role: 'assistant', body: 'old' }],
    applyHydratedServerState: async () => {
      latestRequestId = 9;
      return {
        data: { chat: { id: 7, pending: false, unread_count: 1, newest_unread_message_id: 12 } },
        restoredPendingSnapshot: false,
        finalHistory: [{ id: 12, role: 'assistant', body: 'fresh' }],
        historyChanged: true,
        pendingState: {
          shouldResumePending: false,
          shouldForceResumePending: false,
        },
        commitHydratedState: () => commits.push('commit'),
      };
    },
    buildHydrationRenderState: () => {
      throw new Error('should not build render state for stale hydrate after apply');
    },
    refreshTabNode: () => {
      throw new Error('should not refresh tab for stale hydrate after apply');
    },
    isActiveChat: () => true,
    setActiveChatMeta: () => {
      throw new Error('should not set meta for stale hydrate after apply');
    },
    renderMessages: () => {
      throw new Error('should not render stale hydrate after apply');
    },
    resumePendingChatStream: () => {
      throw new Error('should not resume stale hydrate after apply');
    },
  });

  const result = await controller.hydrateChatFromServer(7, 4, true);

  assert.equal(result, undefined);
  assert.deepEqual(commits, []);
  assert.equal(traces.at(-1).eventName, 'hydrate-skipped-stale-post-apply');
  assert.equal(traces.at(-1).details.latestRequestId, 9);
});

test('createHydrationFlowController active path obeys canonical shouldRenderActiveHistory decision', async () => {
  const renders = [];
  const controller = hydrationFlow.createHydrationFlowController({
    nowMs: () => 1000,
    traceChatHistory: () => {},
    loadChatHistory: async () => ({
      chat: { id: 7, pending: false, unread_count: 0, newest_unread_message_id: 0 },
      history: [{ id: 12, role: 'assistant', body: 'fresh' }],
    }),
    getLastOpenChatRequestId: () => 4,
    getPreviousHistory: () => [{ id: 1, role: 'assistant', body: 'old' }],
    applyHydratedServerState: async () => ({
      data: { chat: { id: 7, pending: false, unread_count: 0, newest_unread_message_id: 0 } },
      restoredPendingSnapshot: false,
      finalHistory: [{ id: 12, role: 'assistant', body: 'fresh' }],
      historyChanged: true,
      pendingState: {
        shouldResumePending: false,
        shouldForceResumePending: false,
      },
      commitHydratedState: () => {},
    }),
    buildHydrationRenderState: () => ({
      shouldForceUnreadTranscriptRender: false,
      shouldForceStaleRenderedTranscriptRender: false,
      shouldRenderActiveHistory: false,
    }),
    refreshTabNode: () => {},
    isActiveChat: () => true,
    setActiveChatMeta: () => {
      throw new Error('should not set inactive meta for active hydrate');
    },
    renderMessages: (chatId, options = {}) => renders.push({ chatId: Number(chatId), options }),
    resumePendingChatStream: () => {
      throw new Error('should not resume pending when not requested');
    },
  });

  await controller.hydrateChatFromServer(7, 4, false);

  assert.deepEqual(renders, []);
});
