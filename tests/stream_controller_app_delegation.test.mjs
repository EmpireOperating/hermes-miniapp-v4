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

test('app.js tool-trace wrappers delegate through helper-owned snapshot-aware controller', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.match(
    source,
    /const toolTraceController = streamControllerHelpers\.createToolTraceController\(\{[\s\S]*persistPendingStreamSnapshot,[\s\S]*\}\);/m,
    'app.js should inject persistPendingStreamSnapshot into toolTraceController',
  );

  const delegateExpectations = [
    ['appendInlineToolTrace', 'toolTraceController.appendInlineToolTrace(chatId, textOrPayload, payload)'],
    ['dropPendingToolTraceMessages', 'toolTraceController.dropPendingToolTraceMessages(chatId)'],
    ['finalizeInlineToolTrace', 'toolTraceController.finalizeInlineToolTrace(chatId)'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to toolTraceController`,
    );
    assert.doesNotMatch(
      body,
      /persistPendingStreamSnapshot\(chatId\)/,
      `${fnName} should not keep inline snapshot persistence glue in app.js`,
    );
  }
});
