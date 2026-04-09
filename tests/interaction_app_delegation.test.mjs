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

test('app.js interaction wrappers delegate through interactionController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.match(
    source,
    /const\s+interactionController\s*=\s*interactionHelpers\.createController\(\{/,
    'app.js should build interactionController from interactionHelpers.createController',
  );
  assert.doesNotMatch(
    source,
    /function\s+createSelectionQuoteController\s*\(/,
    'app.js should no longer keep a bespoke createSelectionQuoteController shim',
  );
  assert.doesNotMatch(
    source,
    /const\s+selectionQuoteController\s*=\s*createSelectionQuoteController\(\);/,
    'app.js should no longer allocate a redundant selectionQuoteController shim',
  );

  const handleComposerBody = extractFunctionBody(source, 'handleComposerSubmitShortcut');
  assert.match(
    handleComposerBody,
    /return\s+interactionController\.handleComposerSubmitShortcut\(event\);/,
    'handleComposerSubmitShortcut should delegate through interactionController',
  );

  const installSelectionBody = extractFunctionBody(source, 'installSelectionQuoteBindings');
  assert.match(
    installSelectionBody,
    /return\s+interactionController\.bindSelectionQuoteBindings\(\);/,
    'installSelectionQuoteBindings should delegate through interactionController',
  );

  assert.match(
    source,
    /installSelectionQuoteBindings\(\);/,
    'app.js should install selection quote bindings through the wrapper',
  );
});
