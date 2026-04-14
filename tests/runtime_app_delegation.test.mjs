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

test('app.js runtime latency wrappers delegate through runtime-owned controllers', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.ok(
    source.includes('function createLatencyPersistenceControllerDeps() {')
      && source.includes('storageKey: LATENCY_STORAGE_KEY,')
      && source.includes('maxAgeMs: LATENCY_MAX_AGE_MS,'),
    'app.js should isolate latency persistence wiring in createLatencyPersistenceControllerDeps(...)',
  );
  assert.ok(
    source.includes('function createLatencyPersistenceController() {')
      && source.includes('return runtimeHelpers.createLatencyPersistenceController(createLatencyPersistenceControllerDeps());'),
    'app.js should instantiate latencyPersistenceController through createLatencyPersistenceController(...)',
  );
  assert.ok(
    source.includes('latencyPersistenceControllerInstance = createLatencyPersistenceController();'),
    'getLatencyPersistenceController should allocate the runtime persistence controller through createLatencyPersistenceController()',
  );
  assert.ok(
    source.includes('function createDraftControllerDeps() {')
      && source.includes('draftStorageKey: DRAFT_STORAGE_KEY,')
      && source.includes('draftByChat,'),
    'app.js should isolate draft storage wiring in createDraftControllerDeps(...)',
  );
  assert.ok(
    source.includes('function createDraftController() {')
      && source.includes('return composerStateHelpers.createDraftController(createDraftControllerDeps());'),
    'app.js should instantiate draftController through createDraftController(...)',
  );
  assert.ok(
    source.includes('const draftController = createDraftController();'),
    'app.js should allocate draftController through the createDraftController wrapper',
  );
  assert.ok(
    source.includes('function createLatencyViewControllerDeps() {')
      && source.includes('onLatencyMapMutated: () => persistLatencyByChatToStorage(),'),
    'latency view controller should persist latency storage through the latency persistence wrapper',
  );

  const delegateExpectations = [
    ['setChatLatency', 'getLatencyViewController().setChatLatency(chatId, text)'],
    ['syncActiveLatencyChip', 'getLatencyViewController().syncActiveLatencyChip()'],
    ['persistLatencyByChatToStorage', 'getLatencyPersistenceController().persistLatencyByChatToStorage()'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate through the runtime-owned controller`,
    );
  }

  const loadLatencyBody = extractFunctionBody(source, 'loadLatencyByChatFromStorage');
  assert.match(
    loadLatencyBody,
    /latencyStorageLoaded\s*=\s*false;/,
    'loadLatencyByChatFromStorage should clear the loaded flag before reloading persisted latency state',
  );
  assert.match(
    loadLatencyBody,
    /return\s+ensureLatencyStorageLoaded\(\);/,
    'loadLatencyByChatFromStorage should reload via ensureLatencyStorageLoaded()',
  );

  assert.doesNotMatch(
    extractFunctionBody(source, 'setChatLatency'),
    /renderTraceLog\(/,
    'setChatLatency wrapper should no longer own latency render-trace logging',
  );
  assert.doesNotMatch(
    extractFunctionBody(source, 'persistLatencyByChatToStorage'),
    /runtimeHelpers\.persistLatencyByChatToStorage\s*\?\.\s*\(/,
    'persistLatencyByChatToStorage wrapper should no longer wire runtimeHelpers storage args inline',
  );
});

test('app.js haptic/unread wrappers delegate through attentionEffectsController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.ok(
    source.includes('function getAttentionEffectsController() {')
      && source.includes('attentionEffectsControllerInstance = runtimeHelpers.createAttentionEffectsController({')
      && source.includes('renderTraceLog,'),
    'app.js should build attentionEffectsController from runtimeHelpers.createAttentionEffectsController with runtime trace logging injected',
  );

  const delegateExpectations = [
    ['latestCompletedAssistantHapticKey', 'getAttentionEffectsController().latestCompletedAssistantHapticKey(chatId)'],
    ['triggerIncomingMessageHaptic', 'getAttentionEffectsController().triggerIncomingMessageHaptic(chatId, { messageKey, fallbackToLatestHistory })'],
    ['incrementUnread', 'getAttentionEffectsController().incrementUnread(chatId)'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate through hapticUnreadController`,
    );
  }

  assert.doesNotMatch(
    extractFunctionBody(source, 'incrementUnread'),
    /renderTraceLog\(/,
    'incrementUnread wrapper should no longer own unread render-trace logging',
  );
});
