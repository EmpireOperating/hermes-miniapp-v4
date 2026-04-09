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

  assert.match(
    source,
    /const\s+latencyPersistenceController\s*=\s*runtimeHelpers\.createLatencyPersistenceController\(\{/,
    'app.js should build latencyPersistenceController from runtimeHelpers.createLatencyPersistenceController',
  );
  assert.match(
    source,
    /const\s+latencyViewController\s*=\s*runtimeHelpers\.createLatencyController\(\{/,
    'app.js should build latencyViewController from runtimeHelpers.createLatencyController',
  );
  assert.match(
    source,
    /onLatencyMapMutated:\s*\(\)\s*=>\s*latencyPersistenceController\.persistLatencyByChatToStorage\(\)/,
    'latency view controller should persist latency storage through the runtime-owned persistence controller',
  );

  const delegateExpectations = [
    ['setChatLatency', 'latencyViewController.setChatLatency(chatId, text)'],
    ['syncActiveLatencyChip', 'latencyViewController.syncActiveLatencyChip()'],
    ['loadLatencyByChatFromStorage', 'latencyPersistenceController.loadLatencyByChatFromStorage()'],
    ['persistLatencyByChatToStorage', 'latencyPersistenceController.persistLatencyByChatToStorage()'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate through the runtime-owned controller`,
    );
  }

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
