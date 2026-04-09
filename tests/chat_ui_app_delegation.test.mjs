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

test('app.js chat tab wrappers delegate through chatTabsController', async () => {
  const source = await readFile(appJsUrl, 'utf8');
  assert.doesNotMatch(
    source,
    /const\s+chatUiController\s*=\s*chatUiHelpers\.createController\(/,
    'app.js should no longer build a redundant chatUiController shim',
  );

  const delegateExpectations = [
    ['getOrCreateTabNode', /return\s+chatTabsController\.getOrCreateTabNode\(chatId\);/],
    ['getTabBadgeState', /return\s+chatTabsController\.getTabBadgeState\(chat\);/],
    ['applyTabBadgeState', /return\s+chatTabsController\.applyTabBadgeState\(badge, badgeState\);/],
    ['applyTabNodeState', /return\s+chatTabsController\.applyTabNodeState\(node, chat\);/],
    ['removeMissingTabNodes', /return\s+chatTabsController\.removeMissingTabNodes\(nextIds\);/],
    ['renderTabs', /return\s+chatTabsController\.renderTabs\(\);/],
    ['renderPinnedChats', /return\s+chatTabsController\.renderPinnedChats\(\);/],
    ['refreshTabNode', /return\s+chatTabsController\.refreshTabNode\(chatId\);/],
    ['syncActiveTabSelection', /return\s+chatTabsController\.syncActiveTabSelection\(previousChatId, nextChatId\);/],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(body, delegatedCall, `${fnName} should delegate through chatTabsController`);
  }
});
