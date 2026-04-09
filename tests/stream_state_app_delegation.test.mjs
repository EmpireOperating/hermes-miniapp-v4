import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appJsUrl = new URL('../static/app.js', import.meta.url);

function extractFunctionBody(source, functionName) {
  const fnPattern = new RegExp(
    String.raw`function\s+${functionName}\s*\([^)]*\)\s*\{([\s\S]*?)\n\}`,
    'm',
  );
  const match = source.match(fnPattern);
  assert.ok(match, `${functionName} wrapper should exist in app.js`);
  return match[1] || '';
}

test('app.js stream-state wrappers keep delegating to helper-owned controllers', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.match(source, /const streamPhaseController = streamStateHelpers\.createPhaseController\(\{/, 'app.js should compose streamPhaseController');
  assert.match(source, /const streamLifecycleController = streamStateHelpers\.createLifecycleController\(\{/, 'app.js should compose streamLifecycleController');
  assert.doesNotMatch(source, /getStreamPhaseFromState/, 'app.js should not keep raw getStreamPhase helper aliases');
  assert.doesNotMatch(source, /setStreamPhaseInState/, 'app.js should not keep raw setStreamPhase helper aliases');

  const phaseDelegates = [
    ['getStreamPhase', 'streamPhaseController.getStreamPhase(chatId)'],
    ['setStreamPhase', 'streamPhaseController.setStreamPhase(chatId, phase)'],
  ];

  for (const [fnName, delegatedCall] of phaseDelegates) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to streamPhaseController`,
    );
  }

  const delegateExpectations = [
    ['finalizeStreamPendingState', 'streamLifecycleController.finalizeStreamPendingState(chatId, wasAborted)'],
    ['readStreamResumeCursorMap', 'streamPersistenceController.readStreamResumeCursorMap()'],
    ['writeStreamResumeCursorMap', 'streamPersistenceController.writeStreamResumeCursorMap(nextMap)'],
    ['getStoredStreamCursor', 'streamPersistenceController.getStoredStreamCursor(chatId)'],
    ['setStoredStreamCursor', 'streamPersistenceController.setStoredStreamCursor(chatId, eventId)'],
    ['clearStoredStreamCursor', 'streamPersistenceController.clearStoredStreamCursor(chatId)'],
    ['readPendingStreamSnapshotMap', 'streamPersistenceController.readPendingStreamSnapshotMap()'],
    ['writePendingStreamSnapshotMap', 'streamPersistenceController.writePendingStreamSnapshotMap(nextMap)'],
    ['clearPendingStreamSnapshot', 'streamPersistenceController.clearPendingStreamSnapshot(chatId)'],
    ['hasFreshPendingStreamSnapshot', 'streamPersistenceController.hasFreshPendingStreamSnapshot(chatId)'],
    ['normalizeSnapshotLines', 'streamPersistenceController.normalizeSnapshotLines(value)'],
    ['mergeSnapshotToolJournalLines', 'streamPersistenceController.mergeSnapshotToolJournalLines(existingLines, currentBody)'],
    ['persistPendingStreamSnapshot', 'streamPersistenceController.persistPendingStreamSnapshot(chatId)'],
    ['restorePendingStreamSnapshot', 'streamPersistenceController.restorePendingStreamSnapshot(chatId)'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to controller`,
    );
  }
});
