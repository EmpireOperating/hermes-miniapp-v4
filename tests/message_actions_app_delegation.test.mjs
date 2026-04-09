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

test('app.js message action binding wrapper delegates to messageActionsController', async () => {
  const source = await readFile(appJsUrl, 'utf8');
  assert.match(
    source,
    /const\s+messageActionsController\s*=\s*messageActionsHelpers\.createController\(\{[\s\S]*?copyTextToClipboard,[\s\S]*?\}\);/m,
    'app.js should build message actions controller from helper module',
  );

  const body = extractFunctionBody(source, 'installMessageActionBindings');
  assert.match(
    body,
    /return\s+messageActionsController\.bindMessageCopyBindings\(\);/,
    'installMessageActionBindings should delegate through messageActionsController',
  );
});
