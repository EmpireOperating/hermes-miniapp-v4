import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const authority = require('../static/runtime_transcript_authority.js');

test('preserveLatestCompletedAssistantMessage collapses same-turn conflicts to one final output', () => {
  const previousHistory = [
    { role: 'user', body: 'question' },
    { role: 'assistant', body: 'local final reply', pending: false, created_at: '2026-04-12T10:00:00Z' },
  ];
  const incomingHistory = [
    { role: 'user', body: 'question' },
    { role: 'assistant', body: 'server stale final reply', pending: false, id: 77, created_at: '2026-04-12T10:00:01Z' },
  ];

  const resolved = authority.preserveLatestCompletedAssistantMessage(previousHistory, incomingHistory);

  assert.equal(resolved.length, 2);
  assert.equal(resolved[1].body, 'local final reply');
  assert.equal(Boolean(resolved[1].pending), false);
});

test('preserveLatestCompletedAssistantMessage keeps newer hydrated turns over older local replies', () => {
  const previousHistory = [
    { role: 'user', body: 'first' },
    { role: 'assistant', body: 'older local reply', pending: false },
  ];
  const incomingHistory = [
    { role: 'user', body: 'first' },
    { role: 'assistant', body: 'older local reply', pending: false },
    { role: 'user', body: 'second' },
    { role: 'assistant', body: 'newer hydrated reply', pending: false },
  ];

  const resolved = authority.preserveLatestCompletedAssistantMessage(previousHistory, incomingHistory);

  assert.equal(resolved.length, 4);
  assert.equal(resolved.at(-1).body, 'newer hydrated reply');
});

test('describeSpeculativeHistoryCommit reports inactive terminal reconcile skips when transcript does not advance and local state is still pending', () => {
  const decision = authority.describeSpeculativeHistoryCommit({
    currentChat: { id: 7, pending: true },
    incomingChat: { id: 7, pending: false },
    currentHistory: [{ role: 'assistant', body: 'old reply', pending: false }],
    incomingHistory: [{ role: 'assistant', body: 'old reply', pending: false }],
    source: 'inactive-terminal-reconcile',
    isActiveChat: false,
    localPending: true,
  });

  assert.equal(decision.commit, false);
  assert.equal(decision.reasons.unchangedWhilePending, true);
  assert.equal(authority.shouldCommitSpeculativeHistory({
    currentChat: { id: 7, pending: true },
    incomingChat: { id: 7, pending: false },
    currentHistory: [{ role: 'assistant', body: 'old reply', pending: false }],
    incomingHistory: [{ role: 'assistant', body: 'old reply', pending: false }],
    source: 'inactive-terminal-reconcile',
    isActiveChat: false,
    localPending: true,
  }), false);
});

test('describeSpeculativeHistoryCommit reports prefetch skips for active or lagging speculative results', () => {
  const activeDecision = authority.describeSpeculativeHistoryCommit({
    currentChat: { id: 7, unread_count: 0, newest_unread_message_id: 0, pending: false },
    incomingChat: { id: 7, unread_count: 0, newest_unread_message_id: 0, pending: false },
    currentHistory: [],
    incomingHistory: [{ role: 'assistant', body: 'prefetched reply', pending: false }],
    source: 'prefetch',
    isActiveChat: true,
    cacheFilledElsewhere: true,
  });
  assert.equal(activeDecision.commit, false);
  assert.equal(activeDecision.reasons.activeNow, true);
  assert.equal(activeDecision.reasons.cacheFilledElsewhere, true);

  const laggingDecision = authority.describeSpeculativeHistoryCommit({
    currentChat: { id: 7, unread_count: 1, newest_unread_message_id: 22, pending: true },
    incomingChat: { id: 7, unread_count: 0, newest_unread_message_id: 0, pending: false },
    currentHistory: [],
    incomingHistory: [{ role: 'assistant', body: 'stale prefetch reply', pending: false }],
    source: 'prefetch',
    isActiveChat: false,
    cacheFilledElsewhere: false,
  });

  assert.equal(laggingDecision.commit, false);
  assert.equal(laggingDecision.reasons.laggingMetadata, true);
  assert.equal(authority.shouldCommitSpeculativeHistory({
    currentChat: { id: 7, unread_count: 1, newest_unread_message_id: 22, pending: true },
    incomingChat: { id: 7, unread_count: 0, newest_unread_message_id: 0, pending: false },
    currentHistory: [],
    incomingHistory: [{ role: 'assistant', body: 'stale prefetch reply', pending: false }],
    source: 'prefetch',
    isActiveChat: false,
    cacheFilledElsewhere: false,
  }), false);
});

test('latestCompletedAssistantHydrationKey returns stable ids for latest completed assistant replies', () => {
  assert.equal(authority.latestCompletedAssistantHydrationKey(7, [
    { role: 'assistant', body: 'pending', pending: true },
    { role: 'assistant', id: 44, body: 'done', pending: false },
  ]), 'chat:7:msg:44');
});

test('reconcilePendingAssistantUpdate appends pending assistant rows and finalizes them in place', () => {
  const appended = authority.reconcilePendingAssistantUpdate([], {
    nextBody: 'streaming',
    pendingState: true,
    defaultRole: 'hermes',
    createdAt: '2026-04-12T10:00:00Z',
  });
  assert.equal(appended.changed, true);
  assert.equal(appended.action, 'append-pending');
  assert.equal(appended.shouldPersistSnapshot, true);
  assert.equal(appended.shouldClearSnapshot, false);
  assert.deepEqual(appended.history, [
    { role: 'hermes', body: 'streaming', created_at: '2026-04-12T10:00:00Z', pending: true },
  ]);

  const finalized = authority.reconcilePendingAssistantUpdate(appended.history, {
    nextBody: 'final answer',
    pendingState: false,
  });
  assert.equal(finalized.changed, true);
  assert.equal(finalized.action, 'finalize-pending');
  assert.equal(finalized.shouldPersistSnapshot, true);
  assert.equal(finalized.shouldClearSnapshot, true);
  assert.deepEqual(finalized.history, [
    { role: 'hermes', body: 'final answer', created_at: '2026-04-12T10:00:00Z', pending: false },
  ]);
});

test('reconcilePendingAssistantUpdate treats repeated finalized assistant text as an idempotent no-op when no pending row exists', () => {
  const mutation = authority.reconcilePendingAssistantUpdate([
    { id: 11, role: 'assistant', body: 'final answer', pending: false, created_at: '2026-04-12T06:00:00Z' },
  ], {
    nextBody: ' final   answer ',
    pendingState: false,
  });

  assert.equal(mutation.changed, false);
  assert.equal(mutation.action, 'noop-duplicate-final');
  assert.equal(mutation.shouldPersistSnapshot, false);
  assert.equal(mutation.shouldClearSnapshot, true);
  assert.deepEqual(mutation.history, [
    { id: 11, role: 'assistant', body: 'final answer', pending: false, created_at: '2026-04-12T06:00:00Z' },
  ]);
});

test('reconcilePendingAssistantUpdate drops stale pending assistant rows when a completed duplicate already exists', () => {
  const mutation = authority.reconcilePendingAssistantUpdate([
    { id: 11, role: 'assistant', body: 'final answer with artifact link', pending: false, created_at: '2026-04-12T06:00:00Z' },
    { role: 'assistant', body: 'final answer with artifact lin', pending: true, created_at: '2026-04-12T06:00:01Z' },
  ], {
    nextBody: 'final answer with artifact link',
    pendingState: false,
  });

  assert.equal(mutation.changed, true);
  assert.equal(mutation.action, 'drop-pending-duplicate-final');
  assert.equal(mutation.shouldPersistSnapshot, false);
  assert.equal(mutation.shouldClearSnapshot, true);
  assert.deepEqual(mutation.history, [
    { id: 11, role: 'assistant', body: 'final answer with artifact link', pending: false, created_at: '2026-04-12T06:00:00Z' },
  ]);
});

test('describeActiveTranscriptRender forces rerender when cached unread hydrate reveals a visible assistant reply without changing local history shape', () => {
  const decision = authority.describeActiveTranscriptRender({
    previousHistory: [{ id: 1, role: 'assistant', body: 'same reply', pending: false }],
    incomingHistory: [{ id: 1, role: 'assistant', body: 'same reply', pending: false }],
    hadCachedHistory: true,
    historyChanged: false,
    restoredPendingSnapshot: false,
    unreadCount: 2,
  });

  assert.equal(decision.shouldForceUnreadTranscriptRender, true);
  assert.equal(decision.shouldForceStaleRenderedTranscriptRender, false);
  assert.equal(decision.shouldRenderActiveHistory, true);
});


test('describeActiveTranscriptRender forces rerender when the visible transcript signature is stale even if in-memory history matches', () => {
  const decision = authority.describeActiveTranscriptRender({
    previousHistory: [{ id: 1, role: 'assistant', body: 'same reply', pending: false }],
    incomingHistory: [{ id: 1, role: 'assistant', body: 'same reply', pending: false }],
    renderedTranscriptSignature: '0::assistant::older visible reply::final::::',
  });

  assert.equal(decision.shouldForceUnreadTranscriptRender, false);
  assert.equal(decision.shouldForceStaleRenderedTranscriptRender, true);
  assert.equal(decision.shouldRenderActiveHistory, true);
});


test('didTranscriptMateriallyAdvance distinguishes real assistant output changes', () => {
  assert.equal(authority.didTranscriptMateriallyAdvance(
    [{ role: 'assistant', body: 'old', pending: false }],
    [{ role: 'assistant', body: 'new', pending: false }],
  ), true);
  assert.equal(authority.didTranscriptMateriallyAdvance(
    [{ role: 'assistant', body: 'same', pending: false }],
    [{ role: 'assistant', body: 'same', pending: false }],
  ), false);
});
