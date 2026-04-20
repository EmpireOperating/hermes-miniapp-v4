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

  assert.ok(
    source.includes('function createToolTraceControllerDeps() {')
      && source.includes('persistPendingStreamSnapshot,')
      && source.includes('cleanDisplayText,'),
    'app.js should isolate tool-trace wiring in createToolTraceControllerDeps(...)',
  );
  assert.ok(
    source.includes('function createToolTraceController() {')
      && source.includes('return streamControllerHelpers.createToolTraceController(createToolTraceControllerDeps());'),
    'app.js should instantiate toolTraceController through createToolTraceController(...)',
  );
  assert.ok(
    source.includes('const toolTraceController = createToolTraceController();'),
    'app.js should allocate toolTraceController through the createToolTraceController wrapper',
  );

  const delegateExpectations = [
    ['appendInlineToolTrace', 'toolTraceController.appendInlineToolTrace(chatId, textOrPayload, payload)'],
    ['collapsePendingToolTrace', 'toolTraceController.collapsePendingToolTrace(chatId)'],
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
