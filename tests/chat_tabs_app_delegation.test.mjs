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
  assert.ok(match, `expected to find function ${functionName}`);
  return match[1];
}

test('app.js chat tab wrappers delegate to chatTabsController', async () => {
  const source = await readFile(appJsUrl, 'utf8');
  const delegateExpectations = [
    ['upsertChat', /return\s+chatTabsController\.upsertChat\(chat\);/],
    ['syncPinnedChats', /return\s+chatTabsController\.syncPinnedChats\(chatList\);/],
    ['syncChats', /return\s+chatTabsController\.syncChats\(chatList\);/],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(body, delegatedCall, `${fnName} should delegate through chatTabsController`);
  }
});
