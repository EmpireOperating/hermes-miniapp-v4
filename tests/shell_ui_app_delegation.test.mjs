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

test('app.js shell-ui wrappers delegate through shellUiController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.match(
    source,
    /const\s+shellUiController\s*=\s*shellUiHelpers\.createController\(\{/,
    'app.js should build shellUiController from shellUiHelpers.createController',
  );

  const delegateExpectations = [
    ['setElementHidden', 'shellUiController.setElementHidden(element, hidden)'],
    ['syncDebugOnlyPillVisibility', 'shellUiController.syncDebugOnlyPillVisibility()'],
    ['syncClosingConfirmation', 'shellUiController.syncClosingConfirmation()'],
    ['syncTelegramChromeForSkin', 'shellUiController.syncTelegramChromeForSkin(skin)'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to shellUiController`,
    );
  }
});