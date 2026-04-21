import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hydrationState = require('../static/runtime_hydration_state.js');

test('createHistoryPendingStateController derives pending preservation and forced resume from snapshot/local state', () => {
  const controller = hydrationState.createHistoryPendingStateController({
    histories: new Map(),
    hasLiveStreamController: () => false,
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    restorePendingStreamSnapshot: () => false,
    hasFreshPendingStreamSnapshot: (chatId) => Number(chatId) === 7,
    finalizeHydratedPendingState: () => {},
    hasLocalPendingWithoutLiveStream: (chatId) => Number(chatId) === 7,
    hydratedCompletionMatchesVisibleLocalPending: () => false,
    historiesDiffer: () => true,
  });

  const pendingState = controller.derivePendingState(7, [{ id: 1, role: 'assistant', body: 'partial', pending: true }], {
    chat: { id: 7, pending: false },
    history: [{ id: 2, role: 'assistant', body: 'final reply', pending: false }],
  });

  assert.deepEqual(pendingState, {
    serverPending: false,
    chatPending: false,
    localPendingWithoutLiveStream: true,
    localAssistantPendingWithoutLiveStream: true,
    snapshotPendingWithoutLiveStream: true,
    matchedVisibleHydratedCompletion: false,
    preserveLocalPending: true,
    allowSnapshotRestore: true,
    preservePendingState: true,
    shouldResumePending: true,
    shouldForceResumePending: true,
  });
});

test('createHistoryPendingStateController restoreActiveBootstrapPendingState centralizes bootstrap snapshot restore gating', () => {
  const restored = [];
  const controller = hydrationState.createHistoryPendingStateController({
    histories: new Map(),
    hasLiveStreamController: () => false,
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    restorePendingStreamSnapshot: (chatId) => {
      restored.push(Number(chatId));
      return Number(chatId) === 7;
    },
    hasFreshPendingStreamSnapshot: (chatId) => Number(chatId) === 7,
    finalizeHydratedPendingState: () => {},
    hasLocalPendingWithoutLiveStream: () => false,
    hydratedCompletionMatchesVisibleLocalPending: () => false,
    historiesDiffer: () => true,
  });

  const restoredCalls = [];
  assert.deepEqual(controller.restoreActiveBootstrapPendingState(7, {
    serverPending: false,
    onRestored: (chatId) => restoredCalls.push(Number(chatId)),
  }), {
    localPendingSnapshot: true,
    restoredPendingSnapshot: true,
  });
  assert.deepEqual(controller.restoreActiveBootstrapPendingState(9, {
    serverPending: true,
    onRestored: (chatId) => restoredCalls.push(Number(chatId)),
  }), {
    localPendingSnapshot: false,
    restoredPendingSnapshot: false,
  });
  assert.deepEqual(restored, [7, 9]);
  assert.deepEqual(restoredCalls, [7]);
});

test('createHistoryPendingStateController applies hydrated history with separated server/local pending semantics and finalizes only when nothing survives', () => {
  const histories = new Map([[7, [{ id: 1, role: 'assistant', body: 'old' }]]]);
  const finalized = [];
  const restored = [];
  const mergeCalls = [];
  const controller = hydrationState.createHistoryPendingStateController({
    histories,
    hasLiveStreamController: () => false,
    mergeHydratedHistory: ({ previousHistory, nextHistory, serverPending, preserveLocalPending }) => {
      mergeCalls.push({ previousHistory, nextHistory, serverPending, preserveLocalPending });
      return previousHistory.concat(nextHistory.map((entry) => ({
        ...entry,
        pending: Boolean(serverPending || preserveLocalPending),
      })));
    },
    restorePendingStreamSnapshot: (chatId) => {
      restored.push(Number(chatId));
      return true;
    },
    hasFreshPendingStreamSnapshot: () => false,
    finalizeHydratedPendingState: (chatId) => finalized.push(Number(chatId)),
    hasLocalPendingWithoutLiveStream: () => false,
    hydratedCompletionMatchesVisibleLocalPending: () => false,
    historiesDiffer: (previousHistory, nextHistory) => JSON.stringify(previousHistory) !== JSON.stringify(nextHistory),
  });

  const preserved = controller.applyHydratedHistory(7, [{ id: 1, role: 'assistant', body: 'old' }], [{ id: 2, role: 'assistant', body: 'fresh' }], {
    serverPending: false,
    preserveLocalPending: true,
    allowSnapshotRestore: true,
  });
  assert.equal(preserved.restoredPendingSnapshot, true);
  assert.deepEqual(restored, [7]);
  assert.deepEqual(finalized, []);
  assert.equal(preserved.historyChanged, true);
  assert.deepEqual(mergeCalls[0], {
    previousHistory: [{ id: 1, role: 'assistant', body: 'old' }],
    nextHistory: [{ id: 2, role: 'assistant', body: 'fresh' }],
    serverPending: false,
    preserveLocalPending: true,
  });

  restored.length = 0;
  const finalizedResult = controller.applyHydratedHistory(7, histories.get(7), [{ id: 3, role: 'assistant', body: 'done' }], {
    serverPending: false,
    preserveLocalPending: false,
    allowSnapshotRestore: false,
  });
  assert.equal(finalizedResult.restoredPendingSnapshot, false);
  assert.deepEqual(restored, []);
  assert.deepEqual(finalized, [7]);
});

test('createHistoryPendingStateController finalizes when snapshot restore was allowed but stale and no local/server pending remains', () => {
  const histories = new Map([[7, [{ id: 1, role: 'assistant', body: 'old' }]]]);
  const finalized = [];
  const restored = [];
  const controller = hydrationState.createHistoryPendingStateController({
    histories,
    hasLiveStreamController: () => false,
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    restorePendingStreamSnapshot: (chatId) => {
      restored.push(Number(chatId));
      return false;
    },
    hasFreshPendingStreamSnapshot: () => false,
    finalizeHydratedPendingState: (chatId) => finalized.push(Number(chatId)),
    hasLocalPendingWithoutLiveStream: () => false,
    hydratedCompletionMatchesVisibleLocalPending: () => false,
    historiesDiffer: () => true,
  });

  const result = controller.applyHydratedHistory(7, [{ id: 1, role: 'assistant', body: 'old' }], [{ id: 2, role: 'assistant', body: 'fresh' }], {
    serverPending: false,
    preserveLocalPending: false,
    allowSnapshotRestore: true,
  });

  assert.equal(result.restoredPendingSnapshot, false);
  assert.deepEqual(restored, [7]);
  assert.deepEqual(finalized, [7]);
});

test('createHistoryRenderDecisionController reads unread count and rendered transcript signature through transcript authority', () => {
  const calls = [];
  const controller = hydrationState.createHistoryRenderDecisionController({
    chats: new Map([[7, { id: 7, unread_count: 3 }]]),
    getRenderedTranscriptSignature: (chatId) => `rendered:${chatId}`,
    describeActiveTranscriptRender: (args) => {
      calls.push(args);
      return { shouldRenderActiveHistory: true, shouldForceUnreadTranscriptRender: true };
    },
  });

  const result = controller.buildHydrationRenderState({
    targetChatId: 7,
    previousHistory: [{ id: 1, role: 'assistant', body: 'old' }],
    finalHistory: [{ id: 2, role: 'assistant', body: 'fresh' }],
    hadCachedHistory: true,
    historyChanged: true,
    restoredPendingSnapshot: false,
  });

  assert.equal(result.currentUnread, 3);
  assert.equal(result.shouldRenderActiveHistory, true);
  assert.equal(result.shouldForceUnreadTranscriptRender, true);
  assert.deepEqual(calls, [{
    previousHistory: [{ id: 1, role: 'assistant', body: 'old' }],
    incomingHistory: [{ id: 2, role: 'assistant', body: 'fresh' }],
    renderedTranscriptSignature: 'rendered:7',
    restoredPendingSnapshot: false,
    historyChanged: true,
    hadCachedHistory: true,
    unreadCount: 3,
    isRenderedChatActiveTarget: false,
    isChatStuckToBottom: true,
    shouldVirtualizeIncomingHistory: false,
  }]);
});

test('createHistoryRenderDecisionController exposes viewport preservation context for virtualized append-only hydrates', () => {
  const calls = [];
  const controller = hydrationState.createHistoryRenderDecisionController({
    chats: new Map([[7, { id: 7, unread_count: 1 }]]),
    getRenderedTranscriptSignature: (chatId) => `rendered:${chatId}`,
    getRenderedChatId: () => 7,
    isChatStuckToBottom: (chatId) => Number(chatId) === 9,
    shouldVirtualizeHistory: (count) => Number(count) >= 2,
    describeActiveTranscriptRender: (args) => {
      calls.push(args);
      return { shouldRenderActiveHistory: false, shouldSkipOffscreenAppendOnlyHydrateRender: true };
    },
  });

  const result = controller.buildHydrationRenderState({
    targetChatId: 7,
    previousHistory: [{ id: 1, role: 'assistant', body: 'old' }],
    finalHistory: [
      { id: 1, role: 'assistant', body: 'old' },
      { id: 2, role: 'assistant', body: 'fresh' },
    ],
    hadCachedHistory: true,
    historyChanged: true,
    restoredPendingSnapshot: false,
  });

  assert.equal(result.currentUnread, 1);
  assert.equal(result.shouldRenderActiveHistory, false);
  assert.equal(result.shouldSkipOffscreenAppendOnlyHydrateRender, true);
  assert.deepEqual(calls, [{
    previousHistory: [{ id: 1, role: 'assistant', body: 'old' }],
    incomingHistory: [
      { id: 1, role: 'assistant', body: 'old' },
      { id: 2, role: 'assistant', body: 'fresh' },
    ],
    renderedTranscriptSignature: 'rendered:7',
    restoredPendingSnapshot: false,
    historyChanged: true,
    hadCachedHistory: true,
    unreadCount: 1,
    isRenderedChatActiveTarget: true,
    isChatStuckToBottom: false,
    shouldVirtualizeIncomingHistory: true,
  }]);
});
