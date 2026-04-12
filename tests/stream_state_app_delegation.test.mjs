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

  assert.ok(
    source.includes('function createStreamPersistenceControllerDeps() {')
      && source.includes('streamResumeCursorStorageKey: STREAM_RESUME_CURSOR_STORAGE_KEY,')
      && source.includes('pendingStreamSnapshotStorageKey: PENDING_STREAM_SNAPSHOT_STORAGE_KEY,'),
    'app.js should isolate stream persistence wiring in createStreamPersistenceControllerDeps(...)',
  );
  assert.ok(
    source.includes('function createStreamPersistenceController() {')
      && source.includes('return streamStateHelpers.createPersistenceController(createStreamPersistenceControllerDeps());'),
    'app.js should instantiate streamPersistenceController through createStreamPersistenceController(...)',
  );
  assert.ok(
    source.includes('const streamPersistenceController = createStreamPersistenceController();'),
    'app.js should allocate streamPersistenceController through the createStreamPersistenceController wrapper',
  );
  assert.ok(
    source.includes('function createStreamPhaseControllerDeps() {')
      && source.includes('streamPhaseByChat,')
      && source.includes('renderTraceLog,'),
    'app.js should isolate stream phase wiring in createStreamPhaseControllerDeps(...)',
  );
  assert.ok(
    source.includes('function createStreamPhaseController() {')
      && source.includes('return streamStateHelpers.createPhaseController(createStreamPhaseControllerDeps());'),
    'app.js should instantiate streamPhaseController through createStreamPhaseController(...)',
  );
  assert.ok(
    source.includes('const streamPhaseController = createStreamPhaseController();'),
    'app.js should allocate streamPhaseController through the createStreamPhaseController wrapper',
  );
  assert.ok(
    source.includes('function createStreamLifecycleControllerDeps() {')
      && source.includes('pendingChats,')
      && source.includes('unseenStreamChats,')
      && source.includes('refreshTabNode,'),
    'app.js should isolate stream lifecycle wiring in createStreamLifecycleControllerDeps(...)',
  );
  assert.ok(
    source.includes('function createStreamLifecycleController() {')
      && source.includes('return streamStateHelpers.createLifecycleController(createStreamLifecycleControllerDeps());'),
    'app.js should instantiate streamLifecycleController through createStreamLifecycleController(...)',
  );
  assert.ok(
    source.includes('const streamLifecycleController = createStreamLifecycleController();'),
    'app.js should allocate streamLifecycleController through the createStreamLifecycleController wrapper',
  );
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
