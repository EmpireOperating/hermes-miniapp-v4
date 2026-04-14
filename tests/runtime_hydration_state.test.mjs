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
    chatPending: false,
    localPendingWithoutLiveStream: true,
    snapshotPendingWithoutLiveStream: true,
    matchedVisibleHydratedCompletion: false,
    preservePendingState: true,
    shouldResumePending: true,
    shouldForceResumePending: true,
  });
});

test('createHistoryPendingStateController applies hydrated history and finalizes pending state only when preservation is not needed', () => {
  const histories = new Map([[7, [{ id: 1, role: 'assistant', body: 'old' }]]]);
  const finalized = [];
  const restored = [];
  const controller = hydrationState.createHistoryPendingStateController({
    histories,
    hasLiveStreamController: () => false,
    mergeHydratedHistory: ({ previousHistory, nextHistory, chatPending }) => previousHistory.concat(nextHistory.map((entry) => ({ ...entry, pending: Boolean(chatPending) }))),
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

  const preserved = controller.applyHydratedHistory(7, [{ id: 1, role: 'assistant', body: 'old' }], [{ id: 2, role: 'assistant', body: 'fresh' }], true);
  assert.equal(preserved.restoredPendingSnapshot, true);
  assert.deepEqual(restored, [7]);
  assert.deepEqual(finalized, []);
  assert.equal(preserved.historyChanged, true);

  restored.length = 0;
  const finalizedResult = controller.applyHydratedHistory(7, histories.get(7), [{ id: 3, role: 'assistant', body: 'done' }], false);
  assert.equal(finalizedResult.restoredPendingSnapshot, false);
  assert.deepEqual(restored, []);
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
  }]);
});
