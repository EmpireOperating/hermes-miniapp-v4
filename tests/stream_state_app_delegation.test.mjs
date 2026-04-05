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

test('app.js stream-state persistence wrappers keep delegating to streamPersistenceController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  const delegateExpectations = [
    ['readStreamResumeCursorMap', 'streamPersistenceController.readStreamResumeCursorMap()'],
    ['writeStreamResumeCursorMap', 'streamPersistenceController.writeStreamResumeCursorMap(nextMap)'],
    ['getStoredStreamCursor', 'streamPersistenceController.getStoredStreamCursor(chatId)'],
    ['setStoredStreamCursor', 'streamPersistenceController.setStoredStreamCursor(chatId, eventId)'],
    ['clearStoredStreamCursor', 'streamPersistenceController.clearStoredStreamCursor(chatId)'],
    ['readPendingStreamSnapshotMap', 'streamPersistenceController.readPendingStreamSnapshotMap()'],
    ['writePendingStreamSnapshotMap', 'streamPersistenceController.writePendingStreamSnapshotMap(nextMap)'],
    ['clearPendingStreamSnapshot', 'streamPersistenceController.clearPendingStreamSnapshot(chatId)'],
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
